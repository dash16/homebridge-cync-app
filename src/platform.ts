// src/platform.ts
import type {
	API,
	DynamicPlatformPlugin,
	Logger,
	PlatformAccessory,
	PlatformConfig,
} from 'homebridge';
import type { LanDeviceUpdate } from './cync/tcp-client.js';
import { PLATFORM_NAME } from './settings.js';
import { CyncClient } from './cync/cync-client.js';
import { ConfigClient } from './cync/config-client.js';
import type { CyncCloudConfig } from './cync/config-client.js';
import { TcpClient } from './cync/tcp-client.js';
import type { CyncLogger } from './cync/config-client.js';
import {
	type CyncAccessoryContext,
	type CyncAccessoryEnv,
	type CyncCapabilityProfile,
	type CyncLightShowKind,
	resolveDeviceType,
	rgbToHsv,
} from './cync/cync-accessory-helpers.js';
import { configureCyncLightAccessory } from './cync/cync-light-accessory.js';
import { configureCyncSwitchAccessory } from './cync/cync-switch-accessory.js';
import { configureCyncOutletAccessory } from './cync/cync-outlet-accessory.js';
import { configureCyncFanAccessory } from './cync/cync-fan-accessory.js';
import {
	BUILT_IN_CYNC_LIGHT_SHOWS,
	configureCyncLightShowAccessory,
} from './cync/cync-light-show-accessory.js';
import {
	BUILT_IN_CYNC_MUSIC_SHOWS,
	configureCyncMusicShowAccessory,
} from './cync/cync-music-show-accessory.js';
import { classifyCyncDevice } from './cync/device-classifier.js';

const toCyncLogger = (log: Logger): CyncLogger => ({
	debug: log.debug.bind(log),
	info: log.info.bind(log),
	warn: log.warn.bind(log),
	error: log.error.bind(log),
});

const CYNC_LIGHT_SHOW_DEVICE_TYPES = new Set<number>([
	76, // Outdoor 48" dynamic light strip
	123, // Light strip
]);

type CyncShowKind =
	| 'built-in-light'
	| 'built-in-music'
	| 'custom-light'
	| 'custom-multicolor'
	| 'custom-music';

function getDefaultCapabilitiesForDeviceType(): CyncCapabilityProfile {
	const isLight = false;

	return {
		isLight,
		supportsBrightness: false,
		supportsColor: false,
		supportsCt: false,
		source: 'deviceType',
	};
}

function promoteCapabilitiesFromLan(
	current: CyncCapabilityProfile,
	update: LanDeviceUpdate,
): boolean {
	let changed = false;

	if (typeof update.brightnessPct === 'number' && Number.isFinite(update.brightnessPct)) {
		if (!current.supportsBrightness) {
			current.supportsBrightness = true;
			current.source = 'lan';
			changed = true;
		}
	}

	if (update.rgb && !current.supportsColor) {
		current.supportsColor = true;
		current.source = 'lan';
		changed = true;
	}

	return changed;
}

export class CyncAppPlatform implements DynamicPlatformPlugin {
	public readonly accessories: PlatformAccessory[] = [];
	public configureAccessory(accessory: PlatformAccessory): void {
		this.log.info('Restoring cached accessory', accessory.displayName);
		this.accessories.push(accessory);
	}
	private readonly log: Logger;
	private readonly api: API;
	private readonly config: PlatformConfig;
	private readonly client: CyncClient;
	private readonly tcpClient: TcpClient;
	private readonly accessoryEnv: CyncAccessoryEnv;

	private cloudConfig: CyncCloudConfig | null = null;
	private readonly deviceIdToAccessory = new Map<string, PlatformAccessory>();
	private readonly deviceLastSeen = new Map<string, number>();
	private readonly devicePollTimers = new Map<string, NodeJS.Timeout>();

	private readonly offlineTimeoutMs = 30 * 60 * 1000;
	private readonly pollIntervalMs = 60_000; // 60 seconds

	private setMainAccessoryOnForDevice(deviceId: string, on: boolean): void {
		const accessory = this.deviceIdToAccessory.get(deviceId);
		if (!accessory) {
			return;
		}

		const Service = this.api.hap.Service;
		const Characteristic = this.api.hap.Characteristic;

		const service =
			accessory.getService(Service.Lightbulb) ??
			accessory.getService(Service.Outlet) ??
			accessory.getService(Service.Switch);

		service?.updateCharacteristic(Characteristic.On, on);
	}

	private clearActiveShowsForDevice(deviceId: string): void {
		this.markActiveLightShowForDevice(deviceId, null);
		this.markActiveMusicShowForDevice(deviceId, null);
	}

	private shouldExposeCustomShows(): boolean {
		const raw = this.config as Record<string, unknown>;
		return raw.exposeCustomShows === true;
	}

	private readonly musicShowServicesByDeviceId = new Map<string, Array<{
		accessory: PlatformAccessory;
		showIndex: number;
	}>>();

	private registerMusicShowAccessoryForDevice(
		deviceId: string,
		accessory: PlatformAccessory,
		showIndex: number,
	): void {
		const existing = this.musicShowServicesByDeviceId.get(deviceId) ?? [];

		const withoutDuplicate = existing.filter(
			entry => entry.accessory.UUID !== accessory.UUID,
		);

		withoutDuplicate.push({ accessory, showIndex });

		this.musicShowServicesByDeviceId.set(deviceId, withoutDuplicate);
	}

	private markActiveMusicShowForDevice(
		deviceId: string,
		activeShowIndex: number | null,
	): void {
		const musicEntries = this.musicShowServicesByDeviceId.get(deviceId) ?? [];
		const lightEntries = this.lightShowServicesByDeviceId.get(deviceId) ?? [];
		const Characteristic = this.api.hap.Characteristic;
		const Service = this.api.hap.Service;

		for (const entry of musicEntries) {
			const active = activeShowIndex !== null && entry.showIndex === activeShowIndex;

			entry.accessory.context.musicShowActive = active;

			const service = entry.accessory.getService(Service.Switch);
			service?.updateCharacteristic(Characteristic.On, active);
		}

		if (activeShowIndex !== null) {
			for (const entry of lightEntries) {
				entry.accessory.context.lightShowActive = false;

				const service = entry.accessory.getService(Service.Switch);
				service?.updateCharacteristic(Characteristic.On, false);
			}
		}
	}

	private readonly lightShowServicesByDeviceId = new Map<string, Array<{
		accessory: PlatformAccessory;
		showIndex: number;
		showKind: CyncLightShowKind;
	}>>();

	private shouldExposeLightShows(): boolean {
		const raw = this.config as Record<string, unknown>;
		return raw.exposeLightShows === true;
	}

	private getEnabledLightShowIndexes(): Set<number> | null {
		const raw = this.config as Record<string, unknown>;
		const value = raw.enabledLightShowIndexes;

		if (!Array.isArray(value)) {
			return null;
		}

		return new Set(
			value
				.map(Number)
				.filter((index) => Number.isFinite(index)),
		);
	}

	private shouldExposeMusicShows(): boolean {
		const raw = this.config as Record<string, unknown>;
		return raw.exposeMusicShows === true;
	}

	private getEnabledMusicShowIndexes(): Set<number> | null {
		const raw = this.config as Record<string, unknown>;
		const value = raw.enabledMusicShowIndexes;

		if (!Array.isArray(value)) {
			return null;
		}

		return new Set(
			value
				.map(Number)
				.filter((index) => Number.isFinite(index)),
		);
	}

	private markDeviceSeen(deviceId: string): void {
		this.deviceLastSeen.set(deviceId, Date.now());
	}

	private registerLightShowAccessoryForDevice(
		deviceId: string,
		accessory: PlatformAccessory,
		showIndex: number,
		showKind: CyncLightShowKind,
	): void {
		const existing = this.lightShowServicesByDeviceId.get(deviceId) ?? [];

		const withoutDuplicate = existing.filter(
			entry => entry.accessory.UUID !== accessory.UUID,
		);

		withoutDuplicate.push({ accessory, showIndex, showKind });

		this.lightShowServicesByDeviceId.set(deviceId, withoutDuplicate);
	}

	private markActiveLightShowForDevice(
		deviceId: string,
		activeShow: { index: number; kind: CyncLightShowKind } | null,
	): void {
		const lightEntries = this.lightShowServicesByDeviceId.get(deviceId) ?? [];
		const musicEntries = this.musicShowServicesByDeviceId.get(deviceId) ?? [];
		const Characteristic = this.api.hap.Characteristic;
		const Service = this.api.hap.Service;

		for (const entry of lightEntries) {
			const active =
				activeShow !== null &&
				entry.showIndex === activeShow.index &&
				entry.showKind === activeShow.kind;

			entry.accessory.context.lightShowActive = active;

			const service = entry.accessory.getService(Service.Switch);
			service?.updateCharacteristic(Characteristic.On, active);
		}

		if (activeShow !== null) {
			for (const entry of musicEntries) {
				entry.accessory.context.musicShowActive = false;

				const service = entry.accessory.getService(Service.Switch);
				service?.updateCharacteristic(Characteristic.On, false);
			}
		}
	}

	private isDeviceProbablyOffline(deviceId: string): boolean {
		const last = this.deviceLastSeen.get(deviceId);
		if (!last) {
			// No data yet; treat as online until we know better
			return false;
		}
		return Date.now() - last > this.offlineTimeoutMs;
	}

	private cleanupDisabledShowAccessoriesForDevice(
		meshId: string,
		deviceId: string,
		enabledShowIndexes: Set<number>,
		showKind: CyncShowKind,
		uuidPrefix: string,
		logLabel: string,
	): void {
		const expectedUuids = new Set(
			[...enabledShowIndexes].map((showIndex) =>
				this.api.hap.uuid.generate(`${uuidPrefix}-${meshId}-${deviceId}-${showIndex}`),
			),
		);

		const staleAccessories = this.accessories.filter((accessory) => {
			const ctx = accessory.context as Record<string, unknown>;

			return (
				ctx.parentDeviceId === deviceId &&
				ctx.showKind === showKind &&
				!expectedUuids.has(accessory.UUID)
			);
		});

		if (staleAccessories.length === 0) {
			return;
		}

		this.log.info(
			'Cync: removing %d disabled %s accessory/accessories for deviceId=%s',
			staleAccessories.length,
			logLabel,
			deviceId,
		);

		this.api.unregisterPlatformAccessories(
			'homebridge-cync-app',
			'CyncAppPlatform',
			staleAccessories,
		);

		for (const staleAccessory of staleAccessories) {
			const index = this.accessories.indexOf(staleAccessory);
			if (index >= 0) {
				this.accessories.splice(index, 1);
			}
		}
	}

	private startPollingDevice(deviceId: string): void {
		const existing = this.devicePollTimers.get(deviceId);
		if (existing) {
			clearInterval(existing);
		}

		const timer = setInterval(() => {
			// Optional future hook:
			// - Call a "getDeviceState" or similar on tcpClient/client
			// - On success, call this.markDeviceSeen(deviceId)
			// - On failure, optionally log or mark offline
		}, this.pollIntervalMs);

		this.devicePollTimers.set(deviceId, timer);
	}

	private handleLanUpdate(update: LanDeviceUpdate): void {
		// Parsed LAN frames may look like:
		// { controllerId: number, deviceId?: string, on: boolean, level: number, brightnessPct?: number }
		const accessory = this.deviceIdToAccessory.get(update.deviceId);
		this.markDeviceSeen(update.deviceId);

		if (!accessory) {
			this.log.debug(
				'Cync: LAN update for unknown deviceId=%s; no accessory mapping',
				update.deviceId,
			);
			return;
		}

		const Service = this.api.hap.Service;
		const Characteristic = this.api.hap.Characteristic;

		const lightService = accessory.getService(Service.Lightbulb);
		const fanService = accessory.getService(Service.Fanv2);
		const outletService = accessory.getService(Service.Outlet);
		const switchService = accessory.getService(Service.Switch);
		const primaryService = lightService || fanService || outletService || switchService;

		if (!primaryService) {
			this.log.debug(
				'Cync: accessory %s has no Lightbulb, Fan, Outlet, or Switch service for deviceId=%s',
				accessory.displayName,
				update.deviceId,
			);
			return;
		}

		// Update cached context state
		const ctx = accessory.context as CyncAccessoryContext;
		ctx.cync = ctx.cync ?? { meshId: '', deviceId: update.deviceId };
		if (!ctx.cync.capabilities) {
			ctx.cync.capabilities = getDefaultCapabilitiesForDeviceType();
		}
		const promoted = promoteCapabilitiesFromLan(ctx.cync.capabilities, update);
		if (promoted) {
			this.log.debug(
				'Cync: capabilities promoted for %s (deviceId=%s) -> %o',
				accessory.displayName,
				update.deviceId,
				ctx.cync.capabilities,
			);
		}

		// ----- On/off -----
		if (typeof update.on === 'boolean') {
			ctx.cync.on = update.on;

			this.log.info(
				'Cync: LAN update -> %s is now %s (deviceId=%s)',
				accessory.displayName,
				update.on ? 'ON' : 'OFF',
				update.deviceId,
			);

			if (lightService || outletService || switchService) {
				primaryService.updateCharacteristic(Characteristic.On, update.on);
			}
			if (!update.on) {
				this.clearActiveShowsForDevice(update.deviceId);
			}
			if (outletService && outletService.testCharacteristic(Characteristic.OutletInUse)) {
				outletService.updateCharacteristic(Characteristic.OutletInUse, update.on);
			}
			if (fanService && fanService.testCharacteristic(Characteristic.Active)) {
				fanService.updateCharacteristic(
					Characteristic.Active,
					update.on ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE,
				);
			}
		}
		// ---- Fan Speed ----
		if (fanService) {
			let speedPct: number | undefined;

			if (typeof update.brightnessPct === 'number' && Number.isFinite(update.brightnessPct)) {
				speedPct = Math.max(0, Math.min(100, Math.round(update.brightnessPct)));
			}

			if (speedPct !== undefined) {
				ctx.cync.brightness = speedPct;

				if (fanService.testCharacteristic(Characteristic.RotationSpeed)) {
					fanService.updateCharacteristic(Characteristic.RotationSpeed, speedPct);
				}
			}
		}

		// ----- Brightness -----
		if (lightService) {
			let brightnessPct: number | undefined;
			let lastNonZeroBrightnessPct: number | undefined;

			if (typeof update.brightnessPct === 'number' && Number.isFinite(update.brightnessPct)) {
				brightnessPct = Math.max(0, Math.min(100, Math.round(update.brightnessPct)));
			}
			if (
				typeof update.lastNonZeroBrightnessPct === 'number' &&
				Number.isFinite(update.lastNonZeroBrightnessPct)
			) {
				lastNonZeroBrightnessPct = Math.max(
					1,
					Math.min(100, Math.round(update.lastNonZeroBrightnessPct)),
				);
			}

			if (lastNonZeroBrightnessPct !== undefined) {
				ctx.cync.lastNonZeroBrightness = lastNonZeroBrightnessPct;
			}

			if (brightnessPct !== undefined) {
				ctx.cync.brightness = brightnessPct;
				if (brightnessPct > 0) {
					ctx.cync.lastNonZeroBrightness = brightnessPct;
				}

				this.log.debug(
					'Cync: LAN update -> %s brightness=%d (deviceId=%s)',
					accessory.displayName,
					brightnessPct,
					update.deviceId,
				);

				if (lightService.testCharacteristic(Characteristic.Brightness)) {
					const homeKitBrightness =
						brightnessPct > 0
							? brightnessPct
							: ctx.cync.lastNonZeroBrightness;
					if (typeof homeKitBrightness === 'number') {
						lightService.updateCharacteristic(
							Characteristic.Brightness,
							homeKitBrightness,
						);
					}
				}
			}
		}
		// ----- Color (Hue/Sat) -----
		if (lightService && update.rgb) {
			const hsv = rgbToHsv(update.rgb.r, update.rgb.g, update.rgb.b);

			// Cache (optional, but helps keep internal state consistent)
			ctx.cync.hue = hsv.h;
			ctx.cync.saturation = hsv.s;

			if (lightService.testCharacteristic(Characteristic.Hue)) {
				lightService.updateCharacteristic(Characteristic.Hue, hsv.h);
			}
			if (lightService.testCharacteristic(Characteristic.Saturation)) {
				lightService.updateCharacteristic(Characteristic.Saturation, hsv.s);
			}

			this.log.debug(
				'Cync: LAN update -> %s color rgb=(%d,%d,%d) hsv=(%d,%d) (deviceId=%s)',
				accessory.displayName,
				update.rgb.r,
				update.rgb.g,
				update.rgb.b,
				Math.round(hsv.h),
				Math.round(hsv.s),
				update.deviceId,
			);
		}
	}


	constructor(log: Logger, config: PlatformConfig, api: API) {
		this.log = log;
		this.config = config;
		this.api = api;

		// Extract login config from platform config
		const raw = this.config as Record<string, unknown>;

		// Canonical config keys: username, password, twoFactor
		const username =
			typeof raw.username === 'string'
				? raw.username
				: typeof raw.email === 'string'
					? raw.email
					: '';

		const password =
			typeof raw.password === 'string'
				? raw.password
				: '';

		const twoFactor =
			typeof raw.twoFactor === 'string'
				? raw.twoFactor
				: undefined;

		const cyncLogger = toCyncLogger(this.log);
		const tcpClient = new TcpClient(cyncLogger);

		this.client = new CyncClient(
			new ConfigClient(cyncLogger),
			tcpClient,
			{
				username,
				password,
				twoFactor,
			},
			this.api.user.storagePath(),
			cyncLogger,
		);

		this.tcpClient = tcpClient;

		// Bridge LAN updates into Homebridge (directly from TcpClient)
		this.tcpClient.onLanDeviceUpdate((update) => {
			this.handleLanUpdate(update);
		});

		this.log.info(this.config.name ?? PLATFORM_NAME, 'initialized');

		this.api.on('didFinishLaunching', () => {
			this.log.info(PLATFORM_NAME, 'didFinishLaunching');
			void this.loadCync();
		});
		this.accessoryEnv = {
		  log: this.log,
		  api: this.api,
		  tcpClient: this.tcpClient,
		  isDeviceProbablyOffline: this.isDeviceProbablyOffline.bind(this),
		  markDeviceSeen: this.markDeviceSeen.bind(this),
		  startPollingDevice: this.startPollingDevice.bind(this),
		  registerLightShowAccessoryForDevice: this.registerLightShowAccessoryForDevice.bind(this),
		  registerMusicShowAccessoryForDevice: this.registerMusicShowAccessoryForDevice.bind(this),
		  markActiveMusicShowForDevice: this.markActiveMusicShowForDevice.bind(this),
		  markActiveLightShowForDevice: this.markActiveLightShowForDevice.bind(this),
		  setMainAccessoryOnForDevice: this.setMainAccessoryOnForDevice.bind(this),
		  clearActiveShowsForDevice: this.clearActiveShowsForDevice.bind(this),
		  registerAccessoryForDevice: (deviceId, accessory) => {
				this.deviceIdToAccessory.set(deviceId, accessory);
		  },
		};
	}

	private async loadCync(): Promise<void> {
		try {
			const raw = this.config as Record<string, unknown>;

			const username =
				typeof raw.username === 'string'
					? raw.username
					: typeof raw.email === 'string'
						? raw.email
						: '';

			const password =
				typeof raw.password === 'string'
					? raw.password
					: '';

			if (!username || !password) {
				this.log.warn('Cync: credentials missing in config.json; skipping cloud login.');
				return;
			}

			// Let CyncClient handle 2FA bootstrap + token persistence.
			const loggedIn = await this.client.ensureLoggedIn();
			if (!loggedIn) {
				// We either just requested a 2FA code or hit a credential error.
				// In the "code requested" case, the log already tells the user
				// to add it to config and restart.
				return;
			}

			const cloudConfig = await this.client.loadConfiguration();
			this.cloudConfig = cloudConfig;

			this.log.info(
				'Cync: cloud configuration loaded; mesh count=%d',
				cloudConfig.meshes.length,
			);

			// Ask the CyncClient for the LAN login code derived from stored session.
			let loginCode: Uint8Array = new Uint8Array();
			try {
				loginCode = this.client.getLanLoginCode();
			} catch (err) {
				this.log.warn(
					'Cync: getLanLoginCode() failed: %s',
					(err as Error).message ?? String(err),
				);
			}

			if (loginCode.length > 0) {
				this.log.info(
					'Cync: LAN login code available (%d bytes); starting TCP transport…',
					loginCode.length,
				);

				await this.client.startTransport(cloudConfig, loginCode);
			} else {
				this.log.info(
					'Cync: LAN login code unavailable; TCP control disabled (cloud-only).',
				);
			}

			this.discoverDevices(cloudConfig);

		} catch (err) {
			this.log.error(
				'Cync: cloud login failed: %s',
				(err as Error).message ?? String(err),
			);
		}
	}

	private discoverDevices(cloudConfig: CyncCloudConfig): void {
		if (!cloudConfig.meshes?.length) {
			this.log.warn('Cync: no meshes returned from cloud; nothing to discover.');
			return;
		}

		for (const mesh of cloudConfig.meshes) {
			const meshName = mesh.name || mesh.id;
			this.log.info('Cync: processing mesh %s', meshName);

			const devices = mesh.devices ?? [];
			if (!devices.length) {
				this.log.info('Cync: mesh %s has no devices.', meshName);
				continue;
			}

			for (const device of devices) {
				const record = device as unknown as Record<string, unknown>;

				const deviceId =
					typeof record.device_id === 'string'
						? record.device_id
						: typeof record.device_id === 'number'
							? String(record.device_id)
							: typeof record.id === 'string'
								? record.id
								: typeof record.id === 'number'
									? String(record.id)
									: typeof record.mac === 'string'
										? record.mac
										: typeof record.sn === 'string'
											? record.sn
											: `${mesh.id}-${String(record.product_id ?? 'unknown')}`;

				const preferredName =
					(typeof record.name === 'string' ? record.name : undefined) ??
					(typeof record.displayName === 'string' ? record.displayName : undefined) ??
					undefined;

				const deviceName = preferredName || `Cync Device ${deviceId}`;
				const uuidSeed = `cync-${mesh.id}-${deviceId}`;
				const uuid = this.api.hap.uuid.generate(uuidSeed);

				const deviceType = resolveDeviceType(device);
				const classification = classifyCyncDevice(device, deviceType);

				this.log.debug(
					'Cync device classification: ' +
					`name="${deviceName}" ` +
					`deviceId=${deviceId} ` +
					`deviceType=${classification.deviceType ?? 'unknown'} ` +
					`capabilities=${classification.capabilities.join(',') || 'none'} ` +
					`accessoryType=${classification.accessoryType} ` +
					`reason="${classification.reason}"`,
				);

				const rawDevice =
					record.raw && typeof record.raw === 'object'
						? record.raw as Record<string, unknown>
						: undefined;

				const meshRecord = mesh as unknown as Record<string, unknown>;

				if (this.log.debug) {
					this.log.debug(
						'Cync raw mesh keys for %s: %s',
						meshName,
						JSON.stringify(Object.keys(meshRecord).sort()),
					);

					this.log.debug(
						'Cync raw device keys for %s: %s',
						deviceName,
						JSON.stringify(Object.keys(record).sort()),
					);

					if (rawDevice) {
						this.log.debug(
							'Cync raw inner device keys for %s: %s',
							deviceName,
							JSON.stringify(Object.keys(rawDevice).sort()),
						);
					}
				}

				const possibleMultiColorFields = [
					'multiColorSchemes',
					'multicolorSchemes',
					'multi_color_schemes',
					'schemes',
					'savedMultiColorSchemes',
					'savedMulticolorSchemes',
					'schemeCrcMap',
					'entertainmentData',
					'entertainment',
					'segmentLayouts',
					'segments',
				];

				for (const field of possibleMultiColorFields) {
					const meshValue = meshRecord[field];
					const deviceValue = record[field];
					const rawDeviceValue = rawDevice?.[field];

					if (meshValue !== undefined) {
						this.log.debug(
							'Cync possible Segment mesh field %s for %s: %s',
							field,
							meshName,
							JSON.stringify(meshValue),
						);
					}

					if (deviceValue !== undefined) {
						this.log.debug(
							'Cync possible Segment device field %s for %s: %s',
							field,
							deviceName,
							JSON.stringify(deviceValue),
						);
					}

					if (rawDeviceValue !== undefined) {
						this.log.debug(
							'Cync possible Segment raw device field %s for %s: %s',
							field,
							deviceName,
							JSON.stringify(rawDeviceValue),
						);
					}
				}

				const savedLightShowsCrcMap =
					rawDevice?.savedLightShowsCrcMap ??
					rawDevice?.savedShowCrcMap ??
					rawDevice?.savedShowsCrcMap;

				const savedMultiColorSchemes =
					rawDevice?.savedMultiColorSchemesCrcMap ??
					rawDevice?.savedMultiColorSchemes ??
					rawDevice?.savedMulticolorSchemes ??
					rawDevice?.multiColorSchemeCrcMap ??
					rawDevice?.schemeCrcMap;

				if (savedMultiColorSchemes && typeof savedMultiColorSchemes === 'object') {
					this.log.debug(
						'Cync RGBIC saved Segment scheme data for %s: %s',
						deviceName,
						JSON.stringify(savedMultiColorSchemes),
					);
				}

				if (
					savedLightShowsCrcMap &&
					typeof savedLightShowsCrcMap === 'object'
				) {
					this.log.debug(
						'Cync RGBIC saved show CRC map for %s: %s',
						deviceName,
						JSON.stringify(savedLightShowsCrcMap),
					);
				}

				const savedShowCrcMap =
					savedLightShowsCrcMap &&
					typeof savedLightShowsCrcMap === 'object'
						? savedLightShowsCrcMap as Record<string, unknown>
						: {};

				const savedMultiColorSchemesCrcMap =
					savedMultiColorSchemes &&
					typeof savedMultiColorSchemes === 'object'
						? savedMultiColorSchemes as Record<string, unknown>
						: {};

				const customLightShows = Array.isArray(meshRecord.lightShows)
					? meshRecord.lightShows
						.map((show) => show as Record<string, unknown>)
						.filter((show) =>
							typeof show.index === 'number' &&
							typeof show.name === 'string' &&
							typeof savedShowCrcMap[String(show.index)] === 'number',
						)
						.map((show) => ({
							index: show.index as number,
							name: show.name as string,
							crc: savedShowCrcMap[String(show.index)] as number,
						}))
					: [];

				this.log.debug(
					'Cync mesh Segment schemes for %s: %s',
					meshName,
					JSON.stringify(meshRecord.multiColorSchemes),
				);

				const customMultiColorSchemes = Array.isArray(meshRecord.multiColorSchemes)
					? meshRecord.multiColorSchemes
						.map((scheme) => scheme as Record<string, unknown>)
						.filter((scheme) =>
							typeof scheme.index === 'number' &&
							typeof scheme.name === 'string' &&
							typeof savedMultiColorSchemesCrcMap[String(scheme.index)] === 'number',
						)
						.map((scheme) => ({
							index: scheme.index as number,
							name: scheme.name as string,
							crc: savedMultiColorSchemesCrcMap[String(scheme.index)] as number,
						}))
					: [];

				const customMusicShows = Array.isArray(meshRecord.musicShows)
					? meshRecord.musicShows
						.map((show) => show as Record<string, unknown>)
						.filter((show) =>
							typeof show.index === 'number' &&
							typeof show.name === 'string' &&
							typeof savedShowCrcMap[String(show.index)] === 'number',
						)
						.map((show) => ({
							index: show.index as number,
							name: show.name as string,
							crc: savedShowCrcMap[String(show.index)] as number,
						}))
					: [];

				this.log.debug(
					'Cync custom show discovery for %s: expose=%s light=%d multiColor=%d music=%d showCrcKeys=%s multiColorCrcKeys=%s',
					deviceName,
					String(this.shouldExposeCustomShows()),
					customLightShows.length,
					customMultiColorSchemes.length,
					customMusicShows.length,
					JSON.stringify(Object.keys(savedShowCrcMap)),
					JSON.stringify(Object.keys(savedMultiColorSchemesCrcMap)),
				);

				const enabledLightShowIndexes = this.getEnabledLightShowIndexes();

				const lightShows = BUILT_IN_CYNC_LIGHT_SHOWS.filter(
					lightShow =>
						enabledLightShowIndexes === null ||
						enabledLightShowIndexes.has(lightShow.index),
				);

				if (
					this.shouldExposeLightShows() &&
					typeof deviceType === 'number' &&
					CYNC_LIGHT_SHOW_DEVICE_TYPES.has(deviceType)
				) {
					for (const lightShow of lightShows) {
						const showIndex = lightShow.index;
						const showName = lightShow.name;

						const lightShowName = `${showName} - ${deviceName} - Light`;
						const lightShowUuidSeed = `cync-lightshow-${mesh.id}-${deviceId}-${showIndex}`;
						const lightShowUuid = this.api.hap.uuid.generate(lightShowUuidSeed);

						let lightShowAccessory = this.accessories.find(
							acc => acc.UUID === lightShowUuid,
						);

						if (lightShowAccessory) {
							this.log.info(
								'Cync: using cached light show accessory for %s (%s)',
								lightShowName,
								lightShowUuidSeed,
							);
						} else {
							this.log.info(
								'Cync: registering new light show accessory for %s (%s)',
								lightShowName,
								lightShowUuidSeed,
							);

							lightShowAccessory = new this.api.platformAccessory(
								lightShowName,
								lightShowUuid,
							);

							this.api.registerPlatformAccessories(
								'homebridge-cync-app',
								'CyncAppPlatform',
								[lightShowAccessory],
							);

							this.accessories.push(lightShowAccessory);
						}

						lightShowAccessory.context.device = device;
						lightShowAccessory.context.lightShow = lightShow;
						lightShowAccessory.context.parentDeviceId = deviceId;
						lightShowAccessory.context.showKind = 'built-in-light';

						configureCyncLightShowAccessory(
							this.accessoryEnv,
							mesh,
							device,
							lightShowAccessory,
							lightShowName,
							deviceId,
							lightShow,
							'built-in-light',
							(showDeviceId, showIndex) =>
								this.client.activateLightShow(
									showDeviceId,
									showIndex,
								),
						);
					}
				}

				const enabledMusicShowIndexes = this.getEnabledMusicShowIndexes();

				const musicShows = BUILT_IN_CYNC_MUSIC_SHOWS.filter(
					musicShow =>
						enabledMusicShowIndexes === null ||
						enabledMusicShowIndexes.has(musicShow.index),
				);

				if (
					this.shouldExposeMusicShows() &&
					typeof deviceType === 'number' &&
					CYNC_LIGHT_SHOW_DEVICE_TYPES.has(deviceType)
				) {
					for (const musicShow of musicShows) {
						const showIndex = musicShow.index;
						const showName = musicShow.name;

						const musicShowName = `${showName} - ${deviceName} - Music`;
						const musicShowUuidSeed = `cync-musicshow-${mesh.id}-${deviceId}-${showIndex}`;
						const musicShowUuid = this.api.hap.uuid.generate(musicShowUuidSeed);

						let musicShowAccessory = this.accessories.find(
							acc => acc.UUID === musicShowUuid,
						);

						if (musicShowAccessory) {
							this.log.info(
								'Cync: using cached music show accessory for %s (%s)',
								musicShowName,
								musicShowUuidSeed,
							);
						} else {
							this.log.info(
								'Cync: registering new music show accessory for %s (%s)',
								musicShowName,
								musicShowUuidSeed,
							);

							musicShowAccessory = new this.api.platformAccessory(
								musicShowName,
								musicShowUuid,
							);

							this.api.registerPlatformAccessories(
								'homebridge-cync-app',
								'CyncAppPlatform',
								[musicShowAccessory],
							);

							this.accessories.push(musicShowAccessory);
						}

						musicShowAccessory.context.device = device;
						musicShowAccessory.context.musicShow = musicShow;
						musicShowAccessory.context.parentDeviceId = deviceId;
						musicShowAccessory.context.showKind = 'built-in-music';

						configureCyncMusicShowAccessory(
							this.accessoryEnv,
							mesh,
							device,
							musicShowAccessory,
							musicShowName,
							deviceId,
							musicShow,
							(showDeviceId, showIndex) =>
								this.client.activateMusicShow(
									showDeviceId,
									showIndex,
								),
						);
					}
				}

				if (
					this.shouldExposeCustomShows() &&
					typeof deviceType === 'number' &&
					CYNC_LIGHT_SHOW_DEVICE_TYPES.has(deviceType)
				) {
					for (const customLightShow of customLightShows) {
						const showIndex = customLightShow.index;
						const showName = customLightShow.name;

						const customLightShowName = `${showName} - ${deviceName} - Custom Light`;
						const customLightShowUuidSeed = `cync-custom-lightshow-${mesh.id}-${deviceId}-${showIndex}`;
						const customLightShowUuid = this.api.hap.uuid.generate(customLightShowUuidSeed);

						let customLightShowAccessory = this.accessories.find(
							acc => acc.UUID === customLightShowUuid,
						);

						if (!customLightShowAccessory) {
							customLightShowAccessory = new this.api.platformAccessory(
								customLightShowName,
								customLightShowUuid,
							);

							this.api.registerPlatformAccessories(
								'homebridge-cync-app',
								'CyncAppPlatform',
								[customLightShowAccessory],
							);

							this.accessories.push(customLightShowAccessory);
						}

						customLightShowAccessory.context.device = device;
						customLightShowAccessory.context.lightShow = customLightShow;
						customLightShowAccessory.context.parentDeviceId = deviceId;
						customLightShowAccessory.context.showKind = 'custom-light';


						configureCyncLightShowAccessory(
							this.accessoryEnv,
							mesh,
							device,
							customLightShowAccessory,
							customLightShowName,
							deviceId,
							customLightShow,
							'custom-light',
							(showDeviceId, showIndex) =>
								this.client.activateLightShow(showDeviceId, showIndex),
						);
					}

					for (const customMultiColorScheme of customMultiColorSchemes) {
						const schemeIndex = customMultiColorScheme.index;
						const schemeName = customMultiColorScheme.name;

						const customMultiColorSchemeName = `${schemeName} - ${deviceName} - Segment`;
						const customMultiColorSchemeUuidSeed = `cync-custom-multicolor-${mesh.id}-${deviceId}-${schemeIndex}`;
						const customMultiColorSchemeUuid = this.api.hap.uuid.generate(customMultiColorSchemeUuidSeed);

						let customMultiColorSchemeAccessory = this.accessories.find(
							acc => acc.UUID === customMultiColorSchemeUuid,
						);

						if (!customMultiColorSchemeAccessory) {
							customMultiColorSchemeAccessory = new this.api.platformAccessory(
								customMultiColorSchemeName,
								customMultiColorSchemeUuid,
							);

							this.api.registerPlatformAccessories(
								'homebridge-cync-app',
								'CyncAppPlatform',
								[customMultiColorSchemeAccessory],
							);

							this.accessories.push(customMultiColorSchemeAccessory);
						}

						customMultiColorSchemeAccessory.context.device = device;
						customMultiColorSchemeAccessory.context.lightShow = customMultiColorScheme;
						customMultiColorSchemeAccessory.context.parentDeviceId = deviceId;
						customMultiColorSchemeAccessory.context.showKind = 'custom-multicolor';

						configureCyncLightShowAccessory(
							this.accessoryEnv,
							mesh,
							device,
							customMultiColorSchemeAccessory,
							customMultiColorSchemeName,
							deviceId,
							customMultiColorScheme,
							'custom-multicolor',
							(showDeviceId, showIndex) =>
								this.client.activateMultiColorScheme(showDeviceId, showIndex),
						);
					}

					for (const customMusicShow of customMusicShows) {
						const showIndex = customMusicShow.index;
						const showName = customMusicShow.name;

						const customMusicShowName = `${showName} - ${deviceName} - Custom Music`;
						const customMusicShowUuidSeed = `cync-custom-musicshow-${mesh.id}-${deviceId}-${showIndex}`;
						const customMusicShowUuid = this.api.hap.uuid.generate(customMusicShowUuidSeed);

						let customMusicShowAccessory = this.accessories.find(
							acc => acc.UUID === customMusicShowUuid,
						);

						if (!customMusicShowAccessory) {
							customMusicShowAccessory = new this.api.platformAccessory(
								customMusicShowName,
								customMusicShowUuid,
							);

							this.api.registerPlatformAccessories(
								'homebridge-cync-app',
								'CyncAppPlatform',
								[customMusicShowAccessory],
							);

							this.accessories.push(customMusicShowAccessory);
						}

						customMusicShowAccessory.context.device = device;
						customMusicShowAccessory.context.musicShow = customMusicShow;
						customMusicShowAccessory.context.parentDeviceId = deviceId;
						customMusicShowAccessory.context.showKind = 'custom-music';

						configureCyncMusicShowAccessory(
							this.accessoryEnv,
							mesh,
							device,
							customMusicShowAccessory,
							customMusicShowName,
							deviceId,
							customMusicShow,
							(showDeviceId, showIndex) =>
								this.client.activateMusicShow(showDeviceId, showIndex),
						);
					}
				}

				const enabledLightShowIndexesForCleanup =
					this.shouldExposeLightShows() &&
					typeof deviceType === 'number' &&
					CYNC_LIGHT_SHOW_DEVICE_TYPES.has(deviceType)
						? new Set(lightShows.map((lightShow) => lightShow.index))
						: new Set<number>();

				this.cleanupDisabledShowAccessoriesForDevice(
					String(mesh.id),
					deviceId,
					enabledLightShowIndexesForCleanup,
					'built-in-light',
					'cync-lightshow',
					'light show',
				);

				const enabledMusicShowIndexesForCleanup =
					this.shouldExposeMusicShows() &&
					typeof deviceType === 'number' &&
					CYNC_LIGHT_SHOW_DEVICE_TYPES.has(deviceType)
						? new Set(musicShows.map((musicShow) => musicShow.index))
						: new Set<number>();

				this.cleanupDisabledShowAccessoriesForDevice(
					String(mesh.id),
					deviceId,
					enabledMusicShowIndexesForCleanup,
					'built-in-music',
					'cync-musicshow',
					'music show',
				);

				const enabledCustomLightShowIndexesForCleanup =
					this.shouldExposeCustomShows() &&
					typeof deviceType === 'number' &&
					CYNC_LIGHT_SHOW_DEVICE_TYPES.has(deviceType)
						? new Set(customLightShows.map((customLightShow) => customLightShow.index))
						: new Set<number>();

				this.cleanupDisabledShowAccessoriesForDevice(
					String(mesh.id),
					deviceId,
					enabledCustomLightShowIndexesForCleanup,
					'custom-light',
					'cync-custom-lightshow',
					'custom light show',
				);

				const enabledCustomMultiColorIndexesForCleanup =
					this.shouldExposeCustomShows() &&
					typeof deviceType === 'number' &&
					CYNC_LIGHT_SHOW_DEVICE_TYPES.has(deviceType)
						? new Set(customMultiColorSchemes.map((scheme) => scheme.index))
						: new Set<number>();

				this.cleanupDisabledShowAccessoriesForDevice(
					String(mesh.id),
					deviceId,
					enabledCustomMultiColorIndexesForCleanup,
					'custom-multicolor',
					'cync-custom-multicolor',
					'custom MultiColor scheme',
				);

				const enabledCustomMusicShowIndexesForCleanup =
					this.shouldExposeCustomShows() &&
					typeof deviceType === 'number' &&
					CYNC_LIGHT_SHOW_DEVICE_TYPES.has(deviceType)
						? new Set(customMusicShows.map((customMusicShow) => customMusicShow.index))
						: new Set<number>();

				this.cleanupDisabledShowAccessoriesForDevice(
					String(mesh.id),
					deviceId,
					enabledCustomMusicShowIndexesForCleanup,
					'custom-music',
					'cync-custom-musicshow',
					'custom music show',
				);

				const deviceTypeStr =
					typeof deviceType === 'number' ? String(deviceType) : 'unknown';

				if (classification.accessoryType === 'ignored') {
					this.log.info(
						'Cync: ignoring controller device %s (deviceType=%s, deviceId=%s)',
						deviceName,
						deviceTypeStr,
						deviceId,
					);
					continue;
				}

				let accessory = this.accessories.find(acc => acc.UUID === uuid);

				if (accessory) {
					this.log.info('Cync: using cached accessory for %s (%s)', deviceName, uuidSeed);
				} else {
					this.log.info('Cync: registering new accessory for %s (%s)', deviceName, uuidSeed);

					accessory = new this.api.platformAccessory(deviceName, uuid);

					this.api.registerPlatformAccessories(
						'homebridge-cync-app',
						'CyncAppPlatform',
						[accessory],
					);

					this.accessories.push(accessory);
				}

				// Optional safety net (accessory modules also register this)
				this.deviceIdToAccessory.set(deviceId, accessory);

				if (classification.accessoryType === 'fan') {
					this.log.info(
						'Cync: configuring %s as Fan (deviceType=%s, deviceId=%s)',
						deviceName,
						deviceTypeStr,
						deviceId,
					);
					configureCyncFanAccessory(
						this.accessoryEnv,
						mesh,
						device,
						accessory,
						deviceName,
						deviceId,
					);
				} else if (classification.accessoryType === 'light') {
					this.log.info(
						'Cync: configuring %s as Lightbulb (deviceType=%s, deviceId=%s)',
						deviceName,
						deviceTypeStr,
						deviceId,
					);
					configureCyncLightAccessory(
						this.accessoryEnv,
						mesh,
						device,
						accessory,
						deviceName,
						deviceId,
					);
				} else if (classification.accessoryType === 'outlet') {
					this.log.info(
						'Cync: configuring %s as Outlet (deviceType=%s, deviceId=%s)',
						deviceName,
						deviceTypeStr,
						deviceId,
					);
					configureCyncOutletAccessory(
						this.accessoryEnv,
						mesh,
						device,
						accessory,
						deviceName,
						deviceId,
					);
				} else if (classification.accessoryType === 'unsupported') {
					this.log.warn(
						'Cync: unsupported device %s (deviceType=%s, deviceId=%s); skipping',
						deviceName,
						deviceTypeStr,
						deviceId,
					);
					continue;
				} else {
					this.log.info(
						'Cync: configuring %s as Switch (deviceType=%s, deviceId=%s)',
						deviceName,
						deviceTypeStr,
						deviceId,
					);
					configureCyncSwitchAccessory(
						this.accessoryEnv,
						mesh,
						device,
						accessory,
						deviceName,
						deviceId,
					);
				}
			}
		}
	}
}
