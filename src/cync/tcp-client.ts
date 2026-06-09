// src/cync/tcp-client.ts

import { CyncCloudConfig, CyncLogger } from './config-client.js';
import net from 'net';
import tls from 'tls';

const defaultLogger: CyncLogger = {
	debug: (...args: unknown[]) => console.debug('[cync-tcp]', ...args),
	info: (...args: unknown[]) => console.info('[cync-tcp]', ...args),
	warn: (...args: unknown[]) => console.warn('[cync-tcp]', ...args),
	error: (...args: unknown[]) => console.error('[cync-tcp]', ...args),
};

export type DeviceUpdateCallback = (payload: unknown) => void;
export type RawFrameListener = (frame: Buffer) => void;

type TransportMode = 'tls_strict' | 'tls_relaxed' | 'tcp';

function clampNumber(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, n));
}

function hkBrightnessToPct100Byte(hkBrightness: number): number {
	const hk = clampNumber(Math.round(hkBrightness), 0, 100);

	if (hk <= 0) {
		return 0;
	}

	// enforce 1–100 for ON state
	return clampNumber(hk, 1, 100);
}

function scaleToByte(value: number, inMin: number, inMax: number, invert: boolean): number {
	const v = clampNumber(value, inMin, inMax);
	const t = (v - inMin) / (inMax - inMin); // 0..1
	const u = invert ? (1 - t) : t;
	return clampNumber(Math.round(u * 255), 0, 255);
}
// TCP Hex Formatter: Makes packet dumps easier to compare byte-by-byte
// Formats buffers as spaced hex so working and failing packets can be visually diffed.
function formatHex(buffer: Buffer): string {
	return buffer.toString('hex').match(/.{1,2}/g)?.join(' ') ?? '';
}

export type LanDeviceUpdate = {
	deviceId: string;
	on: boolean;
	brightnessPct?: number;
	rgb?: { r: number; g: number; b: number };
};

export type LanDeviceUpdateListener = (update: LanDeviceUpdate) => void;

export class TcpClient {
	private transportMode: TransportMode | null = null;

	private resetCommandSessionState(reason: string): void {
		const pendingCount = this.pendingPowerCommands.size;

		for (const pending of this.pendingPowerCommands.values()) {
			pending.resolve?.(false);
		}

		this.pendingPowerCommands.clear();
		this.seq = 0;
		this.readBuffer = Buffer.alloc(0);

		this.log.debug(
			'[Cync TCP] Reset command session state (%s): clearedPending=%d seq=0',
			reason,
			pendingCount,
		);
	}

	public registerSwitchMapping(controllerId: number, deviceId: string): void {
		if (!Number.isFinite(controllerId)) {
			return;
		}
		this.controllerToDevice.set(controllerId, deviceId);
	}
	private preferredControllerByDevice = new Map<string, number>();
	private commandChain: Promise<void> = Promise.resolve();
	private homeDevices: Record<string, string[]> = {};
	private switchIdToHomeId = new Map<number, string>();
	private readonly log: CyncLogger;
	private loginCode: Uint8Array | null = null;
	private config: CyncCloudConfig | null = null;
	private deviceUpdateCb: DeviceUpdateCallback | null = null;
	private roomUpdateCb: DeviceUpdateCallback | null = null;
	private motionUpdateCb: DeviceUpdateCallback | null = null;
	private ambientUpdateCb: DeviceUpdateCallback | null = null;
	private socket: net.Socket | null = null;
	private seq = 0;
	private readBuffer = Buffer.alloc(0);
	private heartbeatTimer: NodeJS.Timeout | null = null;
	private rawFrameListeners: RawFrameListener[] = [];
	private controllerToDevice = new Map<number, string>();
	private reconnectTimer: NodeJS.Timeout | null = null;
	private reconnectAttempt = 0;
	private connectInFlight: Promise<void> | null = null;
	private shuttingDown = false;
	private readonly lanDeviceUpdateListeners: LanDeviceUpdateListener[] = [];
	private pendingPowerCommands = new Map<string, {
		deviceId: string;
		on: boolean;
		controllerId: number;
		meshIndex: number;
		seq: number;
		sentAt: number;
		packetHex: string;
		resolve?: (confirmed: boolean) => void;
	}>();
	public onLanDeviceUpdate(listener: LanDeviceUpdateListener): void {
		this.lanDeviceUpdateListeners.push(listener);
	}
	private emitLanDeviceUpdate(update: LanDeviceUpdate): void {
		for (const listener of this.lanDeviceUpdateListeners) {
			try {
				listener(update);
			} catch (err) {
				this.log.error('[Cync TCP] lan device update listener threw: %s', String(err));
			}
		}
	}

	private enqueueCommand<T>(fn: () => Promise<T>): Promise<T> {
		let resolveWrapper: (value: T | PromiseLike<T>) => void;
		let rejectWrapper: (reason?: unknown) => void;

		const p = new Promise<T>((resolve, reject) => {
			resolveWrapper = resolve;
			rejectWrapper = reject;
		});

		// Chain onto the existing promise
		this.commandChain = this.commandChain
			.then(async () => {
				try {
					const result = await fn();
					resolveWrapper(result);
				} catch (err) {
					rejectWrapper(err);
				}
			})
			.catch(() => {
				// Swallow errors in the chain so a failed command
				// doesn't permanently block the queue.
			});

		return p;
	}

	private parseSwitchStateFrame(frame: Buffer): {
		controllerId: number;
		on: boolean;
		brightnessPct: number;
	} | null {
		if (frame.length < 16) {
			return null;
		}

		const controllerId = frame.readUInt32BE(0);

		const marker = Buffer.from('db110201', 'hex');
		const idx = frame.indexOf(marker);

		if (idx === -1) {
			return null;
		}

		const onIndex = idx + marker.length;
		const levelIndex = onIndex + 1;

		if (levelIndex >= frame.length) {
			return null;
		}

		const onFlag = frame[onIndex];
		const levelByte = frame[levelIndex]; // device sends a byte; treat as pct
		const on = onFlag === 0x01 && levelByte > 0;
		if (on && levelByte > 100) {
			this.log.debug(
				'[Cync TCP] Legacy parse: brightness byte >100 (%d); clamping to 100',
				levelByte,
			);
		}

		// Treat the byte as 0–100 percent; clamp hard.
		const brightnessPct = on ? clampNumber(levelByte, 1, 100) : 0;

		this.log.debug(
			'[Cync TCP] Legacy parse: controllerId=%d onFlag=%d levelByte=%d -> hkPct=%d',
			controllerId,
			onFlag,
			levelByte,
			brightnessPct,
		);

		return { controllerId, on, brightnessPct };
	}

	private parseLanSwitchUpdate(
		frame: Buffer,
	): {
		controllerId: number;
		deviceId?: string;
		on: boolean;
		brightnessPct: number;
	} | null {
		if (frame.length < 29) {
			return null;
		}

		const controllerId = frame.readUInt32BE(0);

		const homeId = this.switchIdToHomeId.get(controllerId);
		if (!homeId) {
			return null;
		}

		const devices = this.homeDevices[homeId];
		if (!devices || devices.length === 0) {
			return null;
		}

		const typeByte = frame[13];
		if (typeByte !== 0xdb) {
			return null;
		}

		const deviceIndex = frame[21];
		const stateByte = frame[27];
		const levelByte = frame[28];

		const deviceId = deviceIndex < devices.length ? devices[deviceIndex] : undefined;

		const on = stateByte > 0;
		if (on && levelByte > 100) {
			this.log.debug(
				'[Cync TCP] LAN parse: brightness byte >100 (%d); clamping to 100',
				levelByte,
			);
		}

		// Treat the byte as 0–100 percent; clamp hard.
		const brightnessPct = on ? clampNumber(levelByte, 1, 100) : 0;

		this.log.debug(
			'[Cync TCP] LAN parse bytes: typeByte=0x%s stateByte=%d levelByte=%d -> hkPct=%d',
			typeByte.toString(16).padStart(2, '0'),
			stateByte,
			levelByte,
			brightnessPct,
		);

		return { controllerId, deviceId, on, brightnessPct };
	}


	constructor(logger?: CyncLogger) {
		this.log = logger ?? defaultLogger;
	}

	private tryParseRgbFrom83(frame: Buffer): { r: number; g: number; b: number } | undefined {
		// Look for: db110201 01 012bfe R G B ...
		// We already know db110201 exists in these payloads (same marker used by legacy parse)
		const marker = Buffer.from('db110201', 'hex');
		const idx = frame.indexOf(marker);
		if (idx === -1) {
			return undefined;
		}

		// After marker: [onFlag][level][...]
		// We’ve observed a sub-marker "2bfe" right before RGB in your samples.
		const rgbMarker = Buffer.from('2bfe', 'hex');
		const rgbIdx = frame.indexOf(rgbMarker, idx + marker.length);
		if (rgbIdx === -1) {
			return undefined;
		}

		const start = rgbIdx + rgbMarker.length;
		if (start + 2 >= frame.length) {
			return undefined;
		}

		const r = frame[start];
		const g = frame[start + 1];
		const b = frame[start + 2];

		return { r, g, b };
	}

	public async connect(
		loginCode: Uint8Array,
		config: CyncCloudConfig,
	): Promise<void> {
		this.shuttingDown = false;
		this.loginCode = loginCode;
		this.config = config;

		if (!loginCode.length) {
			this.log.warn(
				'[Cync TCP] connect() called with empty loginCode; LAN control will remain disabled.',
			);
			return;
		}

		// Open the socket eagerly so the plugin receives unsolicited state
		// broadcasts and can emit a startup state query (see requestMeshState).
		// Previously the socket only opened on the first user-initiated SET,
		// which left HomeKit showing stale "off" state until the user toggled.
		await this.ensureConnected();
	}

	public applyLanTopology(topology: {
		homeDevices: Record<string, string[]>;
		switchIdToHomeId: Record<number, string>;
	}): void {
		this.homeDevices = topology.homeDevices ?? {};

		this.switchIdToHomeId = new Map<number, string>();
		for (const [key, homeId] of Object.entries(topology.switchIdToHomeId ?? {})) {
			const num = Number(key);
			if (Number.isFinite(num)) {
				this.switchIdToHomeId.set(num, homeId);
			}
		}

		this.log.info(
			'[Cync TCP] LAN topology applied: homes=%d controllers=%d',
			Object.keys(this.homeDevices).length,
			this.switchIdToHomeId.size,
		);

		// If the socket is already connected when topology arrives, re-fire the
		// mesh-state query so HomeKit converges. This decouples requestMeshState
		// from the connect()→applyLanTopology() call order: whichever lands last
		// triggers the query, and an empty topology is a no-op (see requestMeshState).
		if (
			this.socket &&
			!this.socket.destroyed &&
			this.switchIdToHomeId.size > 0
		) {
			void this.requestMeshState();
		}
	}

	private async ensureConnected(): Promise<boolean> {
		if (this.socket && !this.socket.destroyed) {
			return true;
		}

		if (!this.loginCode || !this.loginCode.length || !this.config) {
			this.log.warn('[Cync TCP] ensureConnected() called without loginCode/config; cannot open socket.');
			return false;
		}

		if (this.connectInFlight) {
			await this.connectInFlight;
			return !!(this.socket && !this.socket.destroyed);
		}

		this.connectInFlight = this.establishSocket()
			.finally(() => {
				this.connectInFlight = null;
			});

		await this.connectInFlight;
		return !!(this.socket && !this.socket.destroyed);
	}

	private scheduleReconnect(reason: string): void {
		if (this.shuttingDown) {
			this.log.debug('[Cync TCP] Not scheduling reconnect (shutting down): %s', reason);
			return;
		}

		if (this.reconnectTimer) {
			return;
		}

		if (!this.loginCode || !this.loginCode.length || !this.config) {
			return;
		}

		const attempt = this.reconnectAttempt;
		const delayMs = Math.min(30_000, 1_000 * Math.pow(2, attempt));
		this.reconnectAttempt++;

		this.log.debug('[Cync TCP] Scheduling reconnect in %dms (%s)', delayMs, reason);

		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;

			// Fire and forget; ensureConnected() logs failures already
			void this.ensureConnected().catch((err: unknown) => {
				this.log.debug('[Cync TCP] Reconnect attempt failed: %s', String(err));
				this.scheduleReconnect('retry');
			});
		}, delayMs);
	}

	private async establishSocket(): Promise<void> {
		const host = 'cm.gelighting.com';
		const portTLS = 23779;
		const portTCP = 23778;

		this.log.info('[Cync TCP] Connecting to %s…', host);

		this.resetCommandSessionState('establishSocket');

		let socket: net.Socket | null = null;
		if (this.socket) {
			this.cleanupSocket(this.socket);
			this.socket.destroy();
			this.socket = null;
		}
		try {
			// If we already learned the best mode, reuse it.
			if (this.transportMode === 'tls_relaxed') {
				socket = await this.openTlsSocket(host, portTLS, false);
			} else if (this.transportMode === 'tcp') {
				socket = await this.openTcpSocket(host, portTCP);
			} else {
				// Default path: strict once, then downgrade and remember.
				try {
					socket = await this.openTlsSocket(host, portTLS, true);
					this.transportMode = 'tls_strict';
				} catch {
					this.log.debug('[Cync TCP] TLS strict failed; trying relaxed TLS…');
					try {
						socket = await this.openTlsSocket(host, portTLS, false);
						this.transportMode = 'tls_relaxed';
					} catch {
						this.log.debug('[Cync TCP] TLS relaxed failed; falling back to plain TCP…');
						socket = await this.openTcpSocket(host, portTCP);
						this.transportMode = 'tcp';
					}
				}
			}
		} catch (err) {
			this.log.error('[Cync TCP] Failed to connect to %s: %s', host, String(err));
			this.socket = null;
			return;
		}

		this.socket = socket;
		this.attachSocketListeners(this.socket);

		if (this.loginCode && this.loginCode.length > 0) {
			this.socket.write(Buffer.from(this.loginCode));
			this.log.info('[Cync TCP] Login code sent (%d bytes).', this.loginCode.length);
		} else {
			this.log.warn('[Cync TCP] establishSocket() reached with no loginCode; skipping auth write.');
		}

		this.startHeartbeat();
		this.reconnectAttempt = 0;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		// Brief delay so the server finishes processing the login write
		// before we ask it to dump mesh state. Runs on every reconnect, so
		// HomeKit resyncs after a network blip without user intervention.
		setTimeout(() => {
			if (!this.shuttingDown && this.socket && !this.socket.destroyed) {
				void this.requestMeshState();
			}
		}, 500);
	}

	private cleanupSocket(sock: net.Socket | null): void {
		if (!sock) {
			return;
		}

		sock.removeAllListeners('data');
		sock.removeAllListeners('close');
		sock.removeAllListeners('error');

		// Note: caller decides whether to destroy()
	}

	private openTlsSocket(host: string, port: number, strict: boolean): Promise<net.Socket> {
		return new Promise((resolve, reject) => {
			const sock = tls.connect({ host, port, rejectUnauthorized: strict });

			const onError = (err: Error) => {
				// 'secureConnect' is registered with once(); no need to remove it here.
				reject(err);
			};

			const onSecure = () => {
				sock.removeListener('error', onError);
				resolve(sock);
			};

			sock.once('error', onError);
			sock.once('secureConnect', onSecure);
		});
	}

	private openTcpSocket(host: string, port: number): Promise<net.Socket> {
		return new Promise((resolve, reject) => {
			const sock = net.createConnection({ host, port });

			const onError = (err: Error) => {
				// 'connect' is registered with once(); no need to remove it here.
				reject(err);
			};

			const onConnect = () => {
				sock.removeListener('error', onError);
				resolve(sock);
			};

			sock.once('error', onError);
			sock.once('connect', onConnect);
		});
	}

	private startHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
		}
		this.heartbeatTimer = setInterval(() => {
			if (!this.socket || this.socket.destroyed) {
				return;
			}
			this.socket.write(Buffer.from('d300000000', 'hex'));
		}, 180_000);
	}

	private getControllerCandidates(deviceId: string, primaryControllerId: number): number[] {
		const preferred = this.preferredControllerByDevice.get(deviceId);

		let homeId = this.switchIdToHomeId.get(primaryControllerId);

		if (!homeId) {
			for (const [candidateHomeId, devices] of Object.entries(this.homeDevices)) {
				if (devices.includes(deviceId)) {
					homeId = candidateHomeId;
					break;
				}
			}
		}

		if (!homeId && primaryControllerId === 0 && this.switchIdToHomeId.size === 1) {
			homeId = [...this.switchIdToHomeId.values()][0];
		}

		if (!homeId) {
			return primaryControllerId > 0 ? [primaryControllerId] : [];
		}

		const controllers = [...this.switchIdToHomeId.entries()]
			.filter(([, candidateHomeId]) => candidateHomeId === homeId)
			.map(([controllerId]) => controllerId)
			.filter((controllerId) => controllerId > 0);

		const ordered = [
			preferred,
			primaryControllerId > 0 ? primaryControllerId : undefined,
			...controllers,
		].filter((controllerId): controllerId is number => controllerId !== undefined);

		const candidates = [...new Set(ordered)];

		this.log.debug(
			'[Cync TCP] controller resolution: device=%s home=%s primary=0x%s preferred=%s candidates=%s knownControllers=%s',
			deviceId,
			homeId,
			primaryControllerId.toString(16).padStart(8, '0'),
			preferred === undefined ? 'none' : `0x${preferred.toString(16).padStart(8, '0')}`,
			candidates.map((controllerId) => `0x${controllerId.toString(16).padStart(8, '0')}`).join(', '),
			[...this.switchIdToHomeId.entries()]
				.map(([controllerId, controllerHomeId]) => `0x${controllerId.toString(16).padStart(8, '0')}=>${controllerHomeId}`)
				.join(', '),
		);

		return candidates;
	}
	// LAN Controller Resolver: Infers controller when cloud device record has no switchID
	private resolvePrimaryControllerId(deviceId: string, rawControllerId: unknown): number | undefined {
		const controllerId = Number(rawControllerId);

		if (Number.isFinite(controllerId) && controllerId > 0) {
			return controllerId;
		}

		for (const [homeId, devices] of Object.entries(this.homeDevices)) {
			if (!devices.includes(deviceId)) {
				continue;
			}

			const controllers = [...this.switchIdToHomeId.entries()]
				.filter(([, controllerHomeId]) => controllerHomeId === homeId)
				.map(([candidateControllerId]) => candidateControllerId)
				.filter((candidateControllerId) => candidateControllerId > 0);

			if (controllers.length === 1) {
				const fallbackControllerId = controllers[0];

				this.log.debug(
					'[Cync TCP] inferred controller for device=%s from topology: home=%s controller=0x%s',
					deviceId,
					homeId,
					fallbackControllerId.toString(16).padStart(8, '0'),
				);

				return fallbackControllerId;
			}
		}
		if (this.switchIdToHomeId.size === 1) {
			const fallbackControllerId = [...this.switchIdToHomeId.keys()][0];

			this.log.debug(
				'[Cync TCP] inferred controller for device=%s from single global controller: controller=0x%s',
				deviceId,
				fallbackControllerId.toString(16).padStart(8, '0'),
			);

			return fallbackControllerId;
		}
		return undefined;
	}
	// Reliable Controller Sender: Retries LAN packets through alternate controllers until state confirmation
	// Centralizes controller failover so power, brightness, color temperature, and RGB commands use the same resilient routing.
	private async sendWithControllerRetry(
		deviceId: string,
		record: Record<string, unknown>,
		expectedOn: boolean,
		packetBuilder: (controllerId: number, seq: number) => Buffer,
		logLabel: string,
	): Promise<void> {
		const controllerId = this.resolvePrimaryControllerId(deviceId, record.switch_controller);
		const meshIndex = Number(record.mesh_id);

		if (controllerId === undefined || !Number.isFinite(meshIndex)) {
			this.log.warn(
				'[Cync TCP] %s: device %s missing LAN fields (switch_controller=%o mesh_id=%o)',
				logLabel,
				deviceId,
				record.switch_controller,
				record.mesh_id,
			);
			return;
		}

		const socket = this.socket;
		if (!socket || socket.destroyed) {
			this.log.warn('[Cync TCP] %s: socket disappeared before command send.', logLabel);
			return;
		}

		const controllerCandidates = this.getControllerCandidates(deviceId, controllerId);

		this.log.debug(
			'[Cync TCP] %s controller candidates for device=%s primary=0x%s candidates=%s',
			logLabel,
			deviceId,
			controllerId.toString(16).padStart(8, '0'),
			controllerCandidates.map((candidate) => `0x${candidate.toString(16).padStart(8, '0')}`).join(', '),
		);

		for (const candidateControllerId of controllerCandidates) {
			const seq = this.nextSeq();
			const packet = packetBuilder(candidateControllerId, seq);

			const rejected = await new Promise<boolean>((resolve) => {
				this.pendingPowerCommands.set(`${candidateControllerId}:${seq}`, {
					deviceId,
					on: expectedOn,
					controllerId: candidateControllerId,
					meshIndex,
					seq,
					sentAt: Date.now(),
					packetHex: packet.toString('hex'),
					resolve: (confirmed) => resolve(!confirmed),
				});

				socket.write(packet);

				this.log.info(
					'[Cync TCP] Sent %s packet: device=%s on=%s seq=%d controller=0x%s',
					logLabel,
					deviceId,
					String(expectedOn),
					seq,
					candidateControllerId.toString(16).padStart(8, '0'),
				);

				setTimeout(() => resolve(false), 300);
			});

			if (!rejected) {
				this.preferredControllerByDevice.set(deviceId, candidateControllerId);

				this.log.debug(
					'[Cync TCP] %s command accepted/no immediate rejection: device=%s controller=0x%s',
					logLabel,
					deviceId,
					candidateControllerId.toString(16).padStart(8, '0'),
				);

				return;
			}
		}
		this.log.warn(
			'[Cync TCP] %s command not confirmed for device=%s on=%s after trying %d controller(s).',
			logLabel,
			deviceId,
			String(expectedOn),
			controllerCandidates.length,
		);
	}
	private nextSeq(): number {
		if (this.seq === 65535) {
			this.seq = 1;
		} else {
			this.seq++;
		}
		return this.seq;
	}

	private buildPowerPacket(
		controllerId: number,
		meshId: number,
		on: boolean,
		seq: number,
	): Buffer {
		const header = Buffer.from('730000001f', 'hex');

		const switchBytes = Buffer.alloc(4);
		switchBytes.writeUInt32BE(controllerId, 0);

		const seqBytes = Buffer.alloc(2);
		seqBytes.writeUInt16BE(seq, 0);

		const middle = Buffer.from('007e00000000f8d00d000000000000', 'hex');

		const meshBytes = Buffer.alloc(2);
		meshBytes.writeUInt16LE(meshId, 0);

		const tail = Buffer.from(on ? 'd00000010000' : 'd00000000000', 'hex');

		const checksumSeed = on ? 430 : 429;
		const checksumByte =
			(checksumSeed + meshBytes[0] + meshBytes[1]) & 0xff;
		const checksum = Buffer.from([checksumByte]);

		const end = Buffer.from('7e', 'hex');

		return Buffer.concat([
			header,
			switchBytes,
			seqBytes,
			middle,
			meshBytes,
			tail,
			checksum,
			end,
		]);
	}

	private buildComboPacket(
		controllerId: number,
		meshId: number,
		on: boolean,
		brightnessLevel: number,
		colorTone: number,
		rgb: { r: number; g: number; b: number },
		seq: number,
	): Buffer {
		const header = Buffer.from('7300000022', 'hex');

		const switchBytes = Buffer.alloc(4);
		switchBytes.writeUInt32BE(controllerId, 0);

		const seqBytes = Buffer.alloc(2);
		seqBytes.writeUInt16BE(seq, 0);

		const middle = Buffer.from('007e00000000f8f010000000000000', 'hex');

		const meshBytes = Buffer.alloc(2);
		meshBytes.writeUInt16LE(meshId, 0);

		const tailPrefix = Buffer.from('f00000', 'hex');

		const onByte = on ? 1 : 0;
		const brightnessByte = Math.max(0, Math.min(255, Math.round(brightnessLevel)));
		const colorToneByte = Math.max(0, Math.min(255, Math.round(colorTone)));

		const r = Math.max(0, Math.min(255, Math.round(rgb.r)));
		const g = Math.max(0, Math.min(255, Math.round(rgb.g)));
		const b = Math.max(0, Math.min(255, Math.round(rgb.b)));

		const rgbBytes = Buffer.from([r, g, b]);

		const checksumSeed =
				496 +
				meshBytes[0] +
				meshBytes[1] +
				onByte +
				brightnessByte +
				colorToneByte +
				r +
				g +
				b;

		const checksum = Buffer.from([checksumSeed & 0xff]);
		const end = Buffer.from('7e', 'hex');

		return Buffer.concat([
			header,
			switchBytes,
			seqBytes,
			middle,
			meshBytes,
			tailPrefix,
			Buffer.from([onByte]),
			Buffer.from([brightnessByte]),
			Buffer.from([colorToneByte]),
			rgbBytes,
			checksum,
			end,
		]);
	}
	// Mesh State Query: requests a snapshot of every device's on/off, brightness, CT, and RGB
	// from a controller. Used on each successful TCP connect so HomeKit shows the correct
	// state without waiting for the user to toggle a light.
	//
	//   outer: 73 00 00 00 18                 (type=0x73, inner length=24)
	//   inner: <ctrl:4> <seq:2>
	//          00 7e 00 00 00 00 f8 52 06    (pipe wrapper + subtype 0x52 + payload len 6)
	//          00 00 00 ff ff 00              (payload)
	//          00 56 7e                       (pad + checksum 0x56 + frame terminator 0x7e)
	private buildMeshInfoRequest(controllerId: number, seq: number): Buffer {
		const header = Buffer.from('7300000018', 'hex');

		const switchBytes = Buffer.alloc(4);
		switchBytes.writeUInt32BE(controllerId, 0);

		const seqBytes = Buffer.alloc(2);
		seqBytes.writeUInt16BE(seq, 0);

		const body = Buffer.from('007e00000000f85206000000ffff0000567e', 'hex');

		return Buffer.concat([header, switchBytes, seqBytes, body]);
	}

	// Connection Warm-Up Ping: Sends 0xa3 to every controller before asking for mesh state.
	// The cloud appears to require this handshake — without it,
	// the 0x52 GetStatusPaginated query is answered with a 0x7b/0x01 rejection.
	private buildControllerPing(controllerId: number, seq: number): Buffer {
		const header = Buffer.from('a300000007', 'hex');

		const switchBytes = Buffer.alloc(4);
		switchBytes.writeUInt32BE(controllerId, 0);

		const seqBytes = Buffer.alloc(2);
		seqBytes.writeUInt16BE(seq, 0);

		const tail = Buffer.from('00', 'hex');

		return Buffer.concat([header, switchBytes, seqBytes, tail]);
	}

	private async requestMeshState(): Promise<void> {
		const socket = this.socket;
		if (!socket || socket.destroyed) {
			return;
		}

		// Topology may not be applied yet if connect() raced ahead of
		// applyLanTopology(). In that case bail out — applyLanTopology() will
		// re-fire this once it has the controller/home maps.
		if (this.switchIdToHomeId.size === 0) {
			this.log.debug(
				'[Cync TCP] requestMeshState skipped: LAN topology not yet applied.',
			);
			return;
		}

		// Step 1: ping every known controller ~150ms apart.
		for (const controllerId of this.switchIdToHomeId.keys()) {
			const seq = this.nextSeq();
			const packet = this.buildControllerPing(controllerId, seq);
			socket.write(packet);

			this.log.debug(
				'[Cync TCP] Mesh-state warm-up ping: controller=0x%s seq=%d',
				controllerId.toString(16).padStart(8, '0'),
				seq,
			);

			await new Promise((resolve) => setTimeout(resolve, 150));
		}

		// Step 2: give the cloud a moment to mark the connection as active before asking
		// for state.
		await new Promise((resolve) => setTimeout(resolve, 500));

		if (!this.socket || this.socket.destroyed) {
			return;
		}

		// Step 3: one 0x52 query per home — the response covers all devices in that mesh.
		const seenHomes = new Set<string>();
		for (const [controllerId, homeId] of this.switchIdToHomeId.entries()) {
			if (seenHomes.has(homeId)) {
				continue;
			}
			seenHomes.add(homeId);

			const seq = this.nextSeq();
			const packet = this.buildMeshInfoRequest(controllerId, seq);
			this.socket.write(packet);

			this.log.info(
				'[Cync TCP] Requested mesh state: controller=0x%s home=%s seq=%d packet=%s',
				controllerId.toString(16).padStart(8, '0'),
				homeId,
				seq,
				formatHex(packet),
			);
		}
	}

	// Mesh State Response Parser: decodes the paginated 0x52 response into per-device updates.
	//
	// Frame layout (after the outer 5-byte header has already been stripped by processIncoming):
	//   [ctrl:4] [seq:2] 00 7e 00 00 00 00 f8 52 <innerLen> 00 00 00 00 00 00 <records...> <chk> 7e
	// Records start at body offset 22 and are 24 bytes each.
	//   [0]=deviceIndex, [8]=isOn, [12]=brightness(0-100),
	//   [16]=colorTone (0xfe means RGB mode), [20..22]=R,G,B
	private parsePaginatedStateResponse(frame: Buffer): void {
		if (frame.length < 51 || frame[13] !== 0x52) {
			return;
		}

		const controllerId = frame.readUInt32BE(0);
		const homeId = this.switchIdToHomeId.get(controllerId);
		if (!homeId) {
			return;
		}

		const devices = this.homeDevices[homeId];
		if (!devices || devices.length === 0) {
			return;
		}

		const recordsStart = 22;
		// Trailing checksum (1 byte) + frame terminator (0x7e) sit after the records,
		// so require strictly more than 24 bytes remaining.
		for (let off = recordsStart; off + 24 < frame.length; off += 24) {
			const rec = frame.subarray(off, off + 24);
			const deviceIndex = rec[0];
			const on = rec[8] > 0;
			const levelByte = rec[12];
			const colorTone = rec[16];

			const deviceId = deviceIndex < devices.length ? devices[deviceIndex] : undefined;
			if (!deviceId) {
				continue;
			}

			const brightnessPct = on ? clampNumber(levelByte, 1, 100) : 0;
			const rgb = colorTone === 0xfe
				? { r: rec[20], g: rec[21], b: rec[22] }
				: undefined;

			this.log.debug(
				'[Cync TCP] mesh state record: device=%s index=%d on=%s level=%d ct=%d rgb=%o',
				deviceId,
				deviceIndex,
				String(on),
				levelByte,
				colorTone,
				rgb,
			);

			this.emitLanDeviceUpdate({
				deviceId,
				on,
				brightnessPct,
				rgb,
			});
		}
	}

	public async disconnect(): Promise<void> {
		this.log.info('[Cync TCP] disconnect() called.');
		this.shuttingDown = true;
		this.resetCommandSessionState('establishSocket');

		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.reconnectAttempt = 0;

		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}

		if (this.socket) {
			this.cleanupSocket(this.socket);
			this.socket.destroy();
			this.socket = null;
		}
	}

	public onDeviceUpdate(cb: DeviceUpdateCallback): void {
		this.log.info('[Cync TCP] device update subscriber registered.');
		this.deviceUpdateCb = cb;
	}

	public onRoomUpdate(cb: DeviceUpdateCallback): void {
		this.roomUpdateCb = cb;
	}

	public onMotionUpdate(cb: DeviceUpdateCallback): void {
		this.motionUpdateCb = cb;
	}

	public onAmbientUpdate(cb: DeviceUpdateCallback): void {
		this.ambientUpdateCb = cb;
	}

	public onRawFrame(listener: RawFrameListener): void {
		this.rawFrameListeners.push(listener);
	}

	public async setSwitchState(
		deviceId: string,
		params: { on: boolean },
	): Promise<void> {
		return this.enqueueCommand(async () => {
			if (!this.config) {
				this.log.warn('[Cync TCP] No config available.');
				return;
			}

			const connected = await this.ensureConnected();
			if (!connected || !this.socket || this.socket.destroyed) {
				this.log.warn(
					'[Cync TCP] Cannot send, socket not ready even after reconnect attempt.',
				);
				return;
			}

			const device = this.findDevice(deviceId);
			if (!device) {
				this.log.warn('[Cync TCP] Unknown deviceId=%s', deviceId);
				return;
			}

			const record = device as Record<string, unknown>;
			const meshIndex = Number(record.mesh_id);

			if (!Number.isFinite(meshIndex)) {
				this.log.warn(
					'[Cync TCP] Device %s is missing mesh_id=%o',
					deviceId,
					record.mesh_id,
				);
				return;
			}

			await this.sendWithControllerRetry(
				deviceId,
				record,
				params.on,
				(candidateControllerId, seq) => this.buildPowerPacket(
					candidateControllerId,
					meshIndex,
					params.on,
					seq,
				),
				'power',
			);
		});
	}

	/**
	 * Color Temperature Sender: Drives tunable-white via the combo_control tone byte (HomeKit mired → 0–255)
	 */
	public async setColorTemperature(
		deviceId: string,
		params: { mired: number; brightnessPct?: number; ctMinMired?: number; ctMaxMired?: number; invertTone?: boolean },
		_deviceType?: number,
	): Promise<void> {
		return this.enqueueCommand(async () => {
			void _deviceType;
			if (!this.config) {
				this.log.warn('[Cync TCP] setColorTemperature: no config available.');
				return;
			}

			const connected = await this.ensureConnected();
			if (!connected || !this.socket || this.socket.destroyed) {
				this.log.warn(
					'[Cync TCP] setColorTemperature: socket not ready even after reconnect attempt.',
				);
				return;
			}

			const device = this.findDevice(deviceId);
			if (!device) {
				this.log.warn('[Cync TCP] setColorTemperature: unknown deviceId=%s', deviceId);
				return;
			}

			const record = device as Record<string, unknown>;
			const meshIndex = Number(record.mesh_id);

			if (!Number.isFinite(meshIndex)) {
				this.log.warn(
					'[Cync TCP] setColorTemperature: device %s missing LAN fields (switch_controller=%o mesh_id=%o)',
					deviceId,
					record.switch_controller,
					record.mesh_id,
				);
				return;
			}

			const ctMinMired = Number.isFinite(Number(params.ctMinMired)) ? Number(params.ctMinMired) : 153; // ~6500K
			const ctMaxMired = Number.isFinite(Number(params.ctMaxMired)) ? Number(params.ctMaxMired) : 500; // ~2000K

			const mired = clampNumber(Number(params.mired), ctMinMired, ctMaxMired);
			if (!Number.isFinite(mired)) {
				this.log.warn('[Cync TCP] setColorTemperature: invalid mired=%o', params.mired);
				return;
			}

			const hkBrightness = Math.max(0, Math.min(100, Math.round(params.brightnessPct ?? 100)));
			const on = hkBrightness > 0;
			const level = hkBrightnessToPct100Byte(hkBrightness);

			const invertTone = params.invertTone === true;
			const tone = scaleToByte(mired, ctMinMired, ctMaxMired, invertTone);

			await this.sendWithControllerRetry(
				deviceId,
				record,
				on,
				(candidateControllerId, seq) => this.buildComboPacket(
					candidateControllerId,
					meshIndex,
					on,
					level,
					tone,
					{ r: 255, g: 255, b: 255 },
					seq,
				),
				'combo CT',
			);
		});
	}

	/**
	 * Brightness Sender: Sends brightness-only combo_control without touching RGB mode
	 */
	public async setBrightness(
		deviceId: string,
		brightnessPct: number,
		_deviceType?: number,
		colorState?: {
			colorActive?: boolean;
			rgb?: { r: number; g: number; b: number };
		},
	): Promise<void> {
		return this.enqueueCommand(async () => {
			void _deviceType;
			if (!this.config) {
				this.log.warn('[Cync TCP] setBrightness: no config available.');
				return;
			}

			const connected = await this.ensureConnected();
			if (!connected || !this.socket || this.socket.destroyed) {
				this.log.warn(
					'[Cync TCP] setBrightness: socket not ready even after reconnect attempt.',
				);
				return;
			}

			const device = this.findDevice(deviceId);
			if (!device) {
				this.log.warn('[Cync TCP] setBrightness: unknown deviceId=%s', deviceId);
				return;
			}

			const record = device as Record<string, unknown>;
			const meshIndex = Number(record.mesh_id);

			if (!Number.isFinite(meshIndex)) {
				this.log.warn(
					'[Cync TCP] setBrightness: device %s missing LAN fields (switch_controller=%o mesh_id=%o)',
					deviceId,
					record.switch_controller,
					record.mesh_id,
				);
				return;
			}

			const clamped = Math.max(0, Math.min(100, Number(brightnessPct)));
			if (!Number.isFinite(clamped)) {
				this.log.warn('[Cync TCP] setBrightness: invalid brightnessPct=%o', brightnessPct);
				return;
			}

			const on = clamped > 0;
			const level = hkBrightnessToPct100Byte(clamped);

			const fallbackRgb = { r: 255, g: 255, b: 255 };

			const rgbToSend: { r: number; g: number; b: number } =
				colorState?.colorActive === true && colorState.rgb
					? colorState.rgb
					: fallbackRgb;

			await this.sendWithControllerRetry(
				deviceId,
				record,
				on,
				(candidateControllerId, seq) => this.buildComboPacket(
					candidateControllerId,
					meshIndex,
					on,
					level,
					254,
					rgbToSend,
					seq,
				),
				'combo brightness',
			);
		});
	}

	public async setColor(
		deviceId: string,
		rgb: { r: number; g: number; b: number },
		brightnessPct?: number,
		_deviceType?: number,
	): Promise<void> {
		return this.enqueueCommand(async () => {
			void _deviceType;
			if (!this.config) {
				this.log.warn('[Cync TCP] setColor: no config available.');
				return;
			}

			const connected = await this.ensureConnected();
			if (!connected || !this.socket || this.socket.destroyed) {
				this.log.warn(
					'[Cync TCP] setColor: socket not ready even after reconnect attempt.',
				);
				return;
			}

			const device = this.findDevice(deviceId);
			if (!device) {
				this.log.warn('[Cync TCP] setColor: unknown deviceId=%s', deviceId);
				return;
			}

			const record = device as Record<string, unknown>;
			this.log.debug(
				'[Cync TCP] device type candidates: device_type=%o deviceType=%o device_type_id=%o deviceTypeId=%o',
				record.device_type,
				record.deviceType,
				record.device_type_id,
				record.deviceTypeId,
			);
			const meshIndex = Number(record.mesh_id);

			if (!Number.isFinite(meshIndex)) {
				this.log.warn(
					'[Cync TCP] setColor: device %s missing LAN fields (switch_controller=%o mesh_id=%o)',
					deviceId,
					record.switch_controller,
					record.mesh_id,
				);
				return;
			}

			const hkBrightness = Math.max(0, Math.min(100, Math.round(brightnessPct ?? 100)));
			const on = hkBrightness > 0;

			const level = hkBrightnessToPct100Byte(hkBrightness);

			const r = Math.max(0, Math.min(255, Math.round(rgb.r)));
			const g = Math.max(0, Math.min(255, Math.round(rgb.g)));
			const b = Math.max(0, Math.min(255, Math.round(rgb.b)));

			await this.sendWithControllerRetry(
				deviceId,
				record,
				on,
				(candidateControllerId, seq) => this.buildComboPacket(
					candidateControllerId,
					meshIndex,
					on,
					level,
					254,
					{ r, g, b },
					seq,
				),
				'combo color',
			);
		});
	}

	private findDevice(deviceId: string) {
		for (const mesh of this.config?.meshes ?? []) {
			for (const dev of mesh.devices ?? []) {
				const record = dev as Record<string, unknown>;
				const devDeviceId = record.device_id !== undefined && record.device_id !== null
					? String(record.device_id)
					: undefined;
				const devId = record.id !== undefined && record.id !== null
					? String(record.id)
					: undefined;

				if (devDeviceId === deviceId || devId === deviceId) {
					return dev;
				}
			}
		}
		return null;
	}

	private attachSocketListeners(socket: net.Socket): void {
		socket.on('data', (chunk) => {
			this.log.debug(
				'[Cync TCP] RX raw chunk bytes=%d hex=%s',
				chunk.byteLength,
				formatHex(chunk),
			);

			this.log.debug('[Cync TCP] received %d bytes from server', chunk.byteLength);

			this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
			this.processIncoming();
		});

		socket.on('close', () => {
			this.log.warn('[Cync TCP] Socket closed.');
			this.resetCommandSessionState('establishSocket');

			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
				this.heartbeatTimer = null;
			}

			this.cleanupSocket(socket);
			if (this.socket === socket) {
				this.socket = null;
			}

			this.reconnectAttempt = 0;

			if (this.reconnectTimer) {
				clearTimeout(this.reconnectTimer);
				this.reconnectTimer = null;
			}
		});

		socket.on('error', (err) => {
			this.log.error('[Cync TCP] Socket error:', String(err));
		});
	}


	private processIncoming(): void {
		while (this.readBuffer.length >= 5) {
			const type = this.readBuffer.readUInt8(0);
			const len = this.readBuffer.readUInt32BE(1);
			const total = 5 + len;

			if (this.readBuffer.length < total) {
				return;
			}

			const body = this.readBuffer.subarray(5, total);

			// Debug log with full hex dump so we can reverse-engineer the protocol
			this.log.debug(
				'[Cync TCP] frame type=0x%s len=%d body=%s',
				type.toString(16).padStart(2, '0'),
				len,
				body.toString('hex'),
			);

			if (type === 0x7b && body.length >= 6) {
				const controllerId = body.readUInt32BE(0);
				const seq = body.readUInt16BE(4);
				const pendingKey = `${controllerId}:${seq}`;
				const pending = this.pendingPowerCommands.get(pendingKey);
				const ageMs = pending ? Date.now() - pending.sentAt : undefined;

				this.log.debug(
					'[Cync TCP] ACK frame: controller=%d controllerHex=0x%s seq=%d device=%s on=%s ageMs=%s body=%s',
					controllerId,
					controllerId.toString(16).padStart(8, '0'),
					seq,
					pending?.deviceId ?? 'unknown',
					pending ? String(pending.on) : 'unknown',
					ageMs !== undefined ? String(ageMs) : 'unknown',
					formatHex(body),
				);

			} else if (type === 0x78 && body.length >= 7) {
				const controllerId = body.readUInt32BE(0);
				const seq = body.readUInt16BE(4);
				const status = body[6];

				const pendingKey = `${controllerId}:${seq}`;
				const pending = this.pendingPowerCommands.get(pendingKey);
				const ageMs = pending ? Date.now() - pending.sentAt : undefined;

				const logFn = this.log.debug;
				const label = pending
					? 'Command status frame'
					: 'ACK frame (non-command)';

				logFn.call(
					this.log,
					'[Cync TCP] %s: controller=%d controllerHex=0x%s seq=%d status=0x%s device=%s on=%s ageMs=%s body=%s packet=%s',
					label,
					controllerId,
					controllerId.toString(16).padStart(8, '0'),
					seq,
					status.toString(16).padStart(2, '0'),
					pending?.deviceId ?? 'unknown',
					pending ? String(pending.on) : 'unknown',
					ageMs !== undefined ? String(ageMs) : 'unknown',
					formatHex(body),
					pending?.packetHex ?? 'unknown',
				);

				pending?.resolve?.(false);
				this.pendingPowerCommands.delete(pendingKey);
				this.handleIncomingFrame(body, type);
			} else {
				this.handleIncomingFrame(body, type);
			}

			this.readBuffer = this.readBuffer.subarray(total);
		}
	}

	// Incoming Frame Handler: routes LAN messages to raw + parsed callbacks
	private handleIncomingFrame(frame: Buffer, type: number): void {
		// Fan out raw frame to higher layers (CyncClient) for debugging
		for (const listener of this.rawFrameListeners) {
			try {
				listener(frame);
			} catch (err) {
				this.log.error(
					'[Cync TCP] raw frame listener threw: %s',
					String(err),
				);
			}
		}

		let payload: unknown = frame;

		// 0x73 or 0x83 with inner subtype 0x52 is a paginated mesh-state response
		// (reply to the request emitted by requestMeshState on connect). The cloud
		// returns the response as 0x83 in practice.
		if (
			(type === 0x73 || type === 0x83) &&
			frame.length >= 14 &&
			frame[13] === 0x52
		) {
			this.parsePaginatedStateResponse(frame);
			return;
		}

		if (type === 0x73 || type === 0x83) {
			const lanParsed = this.parseLanSwitchUpdate(frame);

			if (lanParsed && lanParsed.deviceId) {
				payload = lanParsed;

				const rgb = type === 0x83 ? this.tryParseRgbFrom83(frame) : undefined;

				const devId = lanParsed.deviceId;
				const brightnessPct = lanParsed.brightnessPct;

				this.emitLanDeviceUpdate({
					deviceId: devId,
					on: lanParsed.on,
					brightnessPct,
					rgb,
				});
				for (const [key, pending] of this.pendingPowerCommands.entries()) {
					if (pending.deviceId === devId && pending.on === lanParsed.on) {
						this.preferredControllerByDevice.set(devId, pending.controllerId);
						pending.resolve?.(true);
						this.pendingPowerCommands.delete(key);

						this.log.info(
							'[Cync TCP] Power command confirmed: device=%s on=%s controller=0x%s',
							devId,
							String(lanParsed.on),
							pending.controllerId.toString(16).padStart(8, '0'),
						);
					}
				}

			} else if (type === 0x83) {
				// Fallback to legacy controller-level parsing only for 0x83
				const parsed = this.parseSwitchStateFrame(frame);
				if (parsed) {
					const deviceId = this.controllerToDevice.get(parsed.controllerId);
					payload = {
						...parsed,
						deviceId,
					};
				}
			}
		}

		if (this.deviceUpdateCb) {
			this.deviceUpdateCb(payload);
		} else {
			this.log.debug(
				'[Cync TCP] Dropping device update frame (no subscriber).',
			);
		}
	}
}
