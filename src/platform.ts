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
	resolveDeviceType,
	rgbToHsv,
} from './cync/cync-accessory-helpers.js';
import { configureCyncLightAccessory } from './cync/cync-light-accessory.js';
import { configureCyncSwitchAccessory } from './cync/cync-switch-accessory.js';
import { configureCyncOutletAccessory } from './cync/cync-outlet-accessory.js';
import { configureCyncFanAccessory } from './cync/cync-fan-accessory.js';
import { configureCyncLightShowAccessory } from './cync/cync-light-show-accessory.js';
import { classifyCyncDevice } from './cync/device-classifier.js';

const toCyncLogger = (log: Logger): CyncLogger => ({
	debug: log.debug.bind(log),
	info: log.info.bind(log),
	warn: log.warn.bind(log),
	error: log.error.bind(log),
});

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

	private shouldExposeLightShows(): boolean {
		const raw = this.config as Record<string, unknown>;
		return raw.exposeLightShows === true;
	}

	private markDeviceSeen(deviceId: string): void {
		this.deviceLastSeen.set(deviceId, Date.now());
	}

	private isDeviceProbablyOffline(deviceId: string): boolean {
		const last = this.deviceLastSeen.get(deviceId);
		if (!last) {
			// No data yet; treat as online until we know better
			return false;
		}
		return Date.now() - last > this.offlineTimeoutMs;
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

			if (typeof update.brightnessPct === 'number' && Number.isFinite(update.brightnessPct)) {
				brightnessPct = Math.max(0, Math.min(100, Math.round(update.brightnessPct)));
			}

			if (brightnessPct !== undefined) {
				ctx.cync.brightness = brightnessPct;

				this.log.debug(
					'Cync: LAN update -> %s brightness=%d (deviceId=%s)',
					accessory.displayName,
					brightnessPct,
					update.deviceId,
				);

				if (lightService.testCharacteristic(Characteristic.Brightness)) {
					lightService.updateCharacteristic(Characteristic.Brightness, brightnessPct);
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

				this.log.debug(
					'Cync device discovery details: %s',
					JSON.stringify({
						name: device.name,
						id: device.id,
						type: device.type,
						model: device.model,
						productName: device.productName,
						product_name: device.product_name,
						firmware: device.firmware,
						firmwareVersion: device.firmwareVersion,
						mac: device.mac,
						roomId: device.roomId,
						locationId: device.locationId,
						capabilities: device.capabilities,
					}, null, 2),
				);

				const rawDevice =
					record.raw && typeof record.raw === 'object'
						? record.raw as Record<string, unknown>
						: undefined;

				const savedLightShowsCrcMap = rawDevice?.savedLightShowsCrcMap;

				if (
					savedLightShowsCrcMap &&
					typeof savedLightShowsCrcMap === 'object'
				) {
					this.log.debug(
						'Cync RGBIC candidate: %s has savedLightShowsCrcMap=%s',
						deviceName,
						JSON.stringify(savedLightShowsCrcMap),
					);
				}

				const lightShows = record.light_shows;

				if (
					this.shouldExposeLightShows() &&
					Array.isArray(lightShows) &&
					lightShows.length > 0
				) {
					for (const show of lightShows) {
						const lightShow = show as Record<string, unknown>;
						const showIndex = lightShow.index;
						const showName =
							typeof lightShow.name === 'string'
								? lightShow.name
								: `Light Show ${String(showIndex)}`;

						if (typeof showIndex !== 'number') {
							continue;
						}

						const lightShowName = `${deviceName} ${showName}`;
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

						configureCyncLightShowAccessory(
							this.accessoryEnv,
							mesh,
							device,
							lightShowAccessory,
							lightShowName,
							deviceId,
							lightShow,
							(showDeviceId, showIndex, crc) =>
								this.client.activateLightShow(
									showDeviceId,
									showIndex,
									crc,
								),
						);
					}
				}

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
