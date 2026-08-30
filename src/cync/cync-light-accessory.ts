// src/cync/cync-light-accessory.ts
import type { PlatformAccessory } from 'homebridge';
import type { CyncDevice, CyncDeviceMesh } from './config-client.js';
import type { CyncAccessoryContext, CyncAccessoryEnv } from './cync-accessory-helpers.js';
import {
	applyAccessoryInformationFromCyncDevice,
	hsvToRgb,
	miredToKelvin,
	resolveDeviceType,
} from './cync-accessory-helpers.js';
import { getCyncApkDeviceProfile } from './device-capabilities.js';

function clampNumber(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, n));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const POWER_ON_BRIGHTNESS_RESTORE_DELAY_MS = 500;
const LIGHT_COMMAND_COALESCE_MS = 120;
const LAN_APPEARANCE_HOLD_MS = 2000;
const ctMinMired = 153;
const ctMaxMired = 500;

interface PendingLightWrites {
	on?: boolean;
	brightness?: number;
	hue?: number;
	saturation?: number;
	mired?: number;
	colorTouched: boolean;
	satTouched: boolean;
	ctTouched: boolean;
	brightnessTouched: boolean;
	restoreBrightness?: number;
}

function emptyPendingWrites(): PendingLightWrites {
	return {
		colorTouched: false,
		satTouched: false,
		ctTouched: false,
		brightnessTouched: false,
	};
}

function markLocalAppearanceWrite(cyncMeta: NonNullable<CyncAccessoryContext['cync']>): void {
	cyncMeta.ignoreLanAppearanceUntil = Date.now() + LAN_APPEARANCE_HOLD_MS;
}

async function restoreBrightnessAfterPowerOn(
	env: CyncAccessoryEnv,
	cyncMeta: NonNullable<CyncAccessoryContext['cync']>,
	deviceName: string,
	brightness: number,
): Promise<void> {
	if (!cyncMeta.deviceId) {
		return;
	}

	const isCtMode =
		!cyncMeta.colorActive && typeof cyncMeta.colorTemperature === 'number';

	if (isCtMode) {
		const colorTemperature = cyncMeta.colorTemperature as number;

		env.log.debug(
			'Cync: Light On.set restoring CT brightness=%d mired=%d for %s (deviceId=%s)',
			brightness,
			colorTemperature,
			deviceName,
			cyncMeta.deviceId,
		);

		markLocalAppearanceWrite(cyncMeta);
		await env.tcpClient.setColorTemperature(
			cyncMeta.deviceId,
			{
				mired: colorTemperature,
				brightnessPct: brightness,
				ctMinMired,
				ctMaxMired,
				invertTone: true,
			},
			cyncMeta.deviceType,
		);
	} else {
		env.log.debug(
			'Cync: Light On.set restoring brightness=%d for %s (deviceId=%s)',
			brightness,
			deviceName,
			cyncMeta.deviceId,
		);

		markLocalAppearanceWrite(cyncMeta);
		await env.tcpClient.setBrightness(
			cyncMeta.deviceId,
			brightness,
			cyncMeta.deviceType,
			{
				colorActive: cyncMeta.colorActive,
				rgb: cyncMeta.rgb,
			},
		);
	}

	cyncMeta.brightness = brightness;
	cyncMeta.lastNonZeroBrightness = brightness;
}

export function configureCyncLightAccessory(
	env: CyncAccessoryEnv,
	mesh: CyncDeviceMesh,
	device: CyncDevice,
	accessory: PlatformAccessory,
	deviceName: string,
	deviceId: string,
): void {
	// If this accessory used to be a switch, remove that service
	const existingSwitch = accessory.getService(env.api.hap.Service.Switch);
	if (existingSwitch) {
		env.log.info(
			'Cync: removing stale Switch service from %s (deviceId=%s) before configuring as Lightbulb',
			deviceName,
			deviceId,
		);
		accessory.removeService(existingSwitch);
	}

	const existingOutlet = accessory.getService(env.api.hap.Service.Outlet);
	if (existingOutlet) {
		accessory.removeService(existingOutlet);
	}

	const existingFan = accessory.getService(env.api.hap.Service.Fanv2);
	if (existingFan) {
		accessory.removeService(existingFan);
	}

	const service =
    accessory.getService(env.api.hap.Service.Lightbulb) ||
    accessory.addService(env.api.hap.Service.Lightbulb, deviceName);

	// Optionally update accessory category so UIs treat it as a light
	if (accessory.category !== env.api.hap.Categories.LIGHTBULB) {
		accessory.category = env.api.hap.Categories.LIGHTBULB;
	}

	// Populate Accessory Information from Cync metadata
	applyAccessoryInformationFromCyncDevice(env.api, accessory, device, deviceName, deviceId);

	// Ensure context is initialized
	const ctx = accessory.context as CyncAccessoryContext;
	ctx.cync = ctx.cync ?? {
		meshId: mesh.id,
		deviceId,
		productId: device.product_id,
		on: false,
	};
	// Persist deviceType in context so TcpClient can encode correctly for LAN packets.
	const resolvedDeviceType = resolveDeviceType(device);
	const apkProfile = getCyncApkDeviceProfile(resolvedDeviceType);

	if (typeof resolvedDeviceType === 'number' && Number.isFinite(resolvedDeviceType)) {
		ctx.cync.deviceType = resolvedDeviceType;
	} else {
		env.log.debug(
			'Cync: resolveDeviceType() returned %o for %s (deviceId=%s)',
			resolvedDeviceType,
			deviceName,
			deviceId,
		);
	}

	if (apkProfile) {
		ctx.cync.capabilities = {
			isLight: apkProfile.accessoryType === 'light',
			supportsBrightness: apkProfile.supportsBrightness,
			supportsColor: apkProfile.supportsColor,
			supportsCt: apkProfile.supportsCt,
			source: 'deviceType',
		};
	}

	// Remember mapping for LAN updates
	env.registerAccessoryForDevice(deviceId, accessory);
	env.markDeviceSeen(deviceId);
	env.startPollingDevice(deviceId);

	const Characteristic = env.api.hap.Characteristic;
	let pendingWrites = emptyPendingWrites();
	let pendingPowerOnRestore: { brightness: number; commandId: number } | undefined;
	let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
	let coalesceWaiters: {
		resolve: () => void;
		reject: (reason?: unknown) => void;
	}[] = [];

	const failWrite = (action: string, err: unknown): never => {
		env.log.warn(
			'Cync: Light %s failed for %s (deviceId=%s): %s',
			action,
			deviceName,
			ctx.cync?.deviceId ?? deviceId,
			(err as Error).message ?? String(err),
		);

		throw new env.api.hap.HapStatusError(
			env.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
		);
	};

	const resolveBrightness = (
		cyncMeta: NonNullable<CyncAccessoryContext['cync']>,
		pending: PendingLightWrites,
	): number => {
		if (typeof pending.brightness === 'number') {
			return pending.brightness;
		}
		if (typeof cyncMeta.brightness === 'number') {
			return cyncMeta.brightness;
		}
		return 100;
	};

	const applyOptimisticColor = (
		cyncMeta: NonNullable<CyncAccessoryContext['cync']>,
		hue: number,
		saturation: number,
		brightness: number,
	): { r: number; g: number; b: number } => {
		const rgb = hsvToRgb(hue, saturation, brightness);
		cyncMeta.hue = hue;
		cyncMeta.saturation = saturation;
		cyncMeta.rgb = rgb;
		cyncMeta.colorActive = true;
		cyncMeta.on = brightness > 0;
		cyncMeta.brightness = brightness;
		if (brightness > 0) {
			cyncMeta.lastNonZeroBrightness = brightness;
		}
		return rgb;
	};

	const flushPendingWrites = async (): Promise<void> => {
		const cyncMeta = ctx.cync;
		const pending = pendingWrites;
		pendingWrites = emptyPendingWrites();

		if (!cyncMeta?.deviceId) {
			return;
		}

		if (pending.on === false) {
			await env.tcpClient.setSwitchState(cyncMeta.deviceId, { on: false });
			env.clearActiveShowsForDevice?.(cyncMeta.deviceId);
			env.markDeviceSeen(cyncMeta.deviceId);
			return;
		}

		if (pending.colorTouched) {
			const hue = typeof pending.hue === 'number' ? pending.hue : (cyncMeta.hue ?? 0);
			let saturation = pending.satTouched
				? (pending.saturation ?? 0)
				: (typeof cyncMeta.saturation === 'number' ? cyncMeta.saturation : 100);
			if (!pending.satTouched && saturation === 0) {
				// HomeKit often writes Hue first while leftover CT mode still has sat=0.
				// Treat that as "enter color mode" rather than sending white RGB.
				saturation = 100;
			}
			const brightness = resolveBrightness(cyncMeta, pending);
			const rgb = applyOptimisticColor(cyncMeta, hue, saturation, brightness);

			env.log.info(
				'Cync: Light flush color -> hue=%d sat=%d rgb=(%d,%d,%d) brightness=%d for %s (deviceId=%s)',
				hue,
				saturation,
				rgb.r,
				rgb.g,
				rgb.b,
				brightness,
				deviceName,
				cyncMeta.deviceId,
			);

			markLocalAppearanceWrite(cyncMeta);
			await env.tcpClient.setColor(
				cyncMeta.deviceId,
				rgb,
				brightness,
				cyncMeta.deviceType,
			);
			env.markDeviceSeen(cyncMeta.deviceId);
			return;
		}

		if (pending.ctTouched && typeof pending.mired === 'number') {
			const brightness = resolveBrightness(cyncMeta, pending);

			env.log.info(
				'Cync: Light flush CT -> %d mired (~%dK) brightness=%d for %s (deviceId=%s)',
				pending.mired,
				miredToKelvin(pending.mired),
				brightness,
				deviceName,
				cyncMeta.deviceId,
			);

			markLocalAppearanceWrite(cyncMeta);
			await env.tcpClient.setColorTemperature(
				cyncMeta.deviceId,
				{
					mired: pending.mired,
					brightnessPct: brightness,
					ctMinMired,
					ctMaxMired,
					invertTone: true,
				},
				cyncMeta.deviceType,
			);
			env.markDeviceSeen(cyncMeta.deviceId);
			return;
		}

		if (pending.brightnessTouched && typeof pending.brightness === 'number') {
			const brightness = pending.brightness;
			const isCtMode =
				!cyncMeta.colorActive && typeof cyncMeta.colorTemperature === 'number';

			if (isCtMode) {
				const colorTemperature = cyncMeta.colorTemperature;
				if (typeof colorTemperature !== 'number') {
					env.log.warn(
						'Cync: Brightness.set CT mode for %s but no cached color temperature is available',
						deviceName,
					);
					return;
				}

				env.log.debug(
					'Cync: Light flush brightness preserving CT mode (mired=%d brightness=%d)',
					colorTemperature,
					brightness,
				);

				markLocalAppearanceWrite(cyncMeta);
				await env.tcpClient.setColorTemperature(
					cyncMeta.deviceId,
					{
						mired: colorTemperature,
						brightnessPct: brightness,
						ctMinMired,
						ctMaxMired,
						invertTone: true,
					},
					cyncMeta.deviceType,
				);
			} else {
				env.log.debug(
					'Cync: Light flush brightness preserving RGB state (colorActive=%s rgb=%o)',
					String(!!cyncMeta.colorActive),
					cyncMeta.rgb,
				);

				markLocalAppearanceWrite(cyncMeta);
				await env.tcpClient.setBrightness(
					cyncMeta.deviceId,
					brightness,
					cyncMeta.deviceType,
					{
						colorActive: cyncMeta.colorActive,
						rgb: cyncMeta.rgb,
					},
				);
			}

			env.markDeviceSeen(cyncMeta.deviceId);
			return;
		}

		if (pending.on === true) {
			const powerCommandId = cyncMeta.powerCommandId ?? 0;
			const restoreBrightness = pending.restoreBrightness;

			await env.tcpClient.setSwitchState(cyncMeta.deviceId, { on: true });
			env.markDeviceSeen(cyncMeta.deviceId);

			if (
				(apkProfile?.supportsBrightness ?? true) &&
				typeof restoreBrightness === 'number' &&
				restoreBrightness > 0 &&
				restoreBrightness < 100
			) {
				await delay(POWER_ON_BRIGHTNESS_RESTORE_DELAY_MS);
				if (
					pendingPowerOnRestore?.commandId === powerCommandId &&
					cyncMeta.powerCommandId === powerCommandId &&
					cyncMeta.on === true
				) {
					await restoreBrightnessAfterPowerOn(
						env,
						cyncMeta,
						deviceName,
						restoreBrightness,
					);
				}
				if (pendingPowerOnRestore?.commandId === powerCommandId) {
					pendingPowerOnRestore = undefined;
				}
			}
		}
	};

	const queueLightWrite = (): Promise<void> => {
		if (coalesceTimer) {
			clearTimeout(coalesceTimer);
		}

		return new Promise<void>((resolve, reject) => {
			coalesceWaiters.push({ resolve, reject });
			coalesceTimer = setTimeout(() => {
				coalesceTimer = undefined;
				const waiters = coalesceWaiters;
				coalesceWaiters = [];
				void flushPendingWrites().then(
					() => {
						for (const waiter of waiters) {
							waiter.resolve();
						}
					},
					(err: unknown) => {
						for (const waiter of waiters) {
							waiter.reject(err);
						}
					},
				);
			}, LIGHT_COMMAND_COALESCE_MS);
		});
	};

	// ----- On/Off -----
	service
		.getCharacteristic(Characteristic.On)
		.onGet(() => {
			const currentOn = !!ctx.cync?.on;

			if (env.isDeviceProbablyOffline(deviceId)) {
				env.log.debug(
					'Cync: Light On.get offline-heuristic hit; applying unreachable-state policy with cached=%s for %s (deviceId=%s)',
					String(currentOn),
					deviceName,
					deviceId,
				);
				return env.resolveOfflineOnState(currentOn);
			}

			env.log.debug(
				'Cync: Light On.get -> %s for %s (deviceId=%s)',
				String(currentOn),
				deviceName,
				deviceId,
			);

			return currentOn;
		})
		.onSet(async (value) => {
			const cyncMeta = ctx.cync;

			if (!cyncMeta?.deviceId) {
				env.log.warn(
					'Cync: Light On.set called for %s but no cync.deviceId in context',
					deviceName,
				);
				return;
			}

			const on = value === true || value === 1;

			env.log.info(
				'Cync: Light On.set -> %s for %s (deviceId=%s)',
				String(on),
				deviceName,
				cyncMeta.deviceId,
			);

			const restoreBrightness =
				typeof cyncMeta.lastNonZeroBrightness === 'number'
					? cyncMeta.lastNonZeroBrightness
					: typeof cyncMeta.brightness === 'number'
						? cyncMeta.brightness
						: undefined;
			if (typeof restoreBrightness === 'number' && restoreBrightness > 0) {
				cyncMeta.lastNonZeroBrightness = restoreBrightness;
			}

			cyncMeta.on = on;
			cyncMeta.powerCommandId = (cyncMeta.powerCommandId ?? 0) + 1;
			const powerCommandId = cyncMeta.powerCommandId;
			pendingWrites.on = on;
			if (
				on &&
				!pendingWrites.brightnessTouched &&
				typeof restoreBrightness === 'number' &&
				restoreBrightness > 0 &&
				restoreBrightness < 100
			) {
				pendingWrites.restoreBrightness = restoreBrightness;
				pendingPowerOnRestore = { brightness: restoreBrightness, commandId: powerCommandId };
			} else {
				pendingWrites.restoreBrightness = undefined;
				pendingPowerOnRestore = undefined;
			}

			try {
				await queueLightWrite();
			} catch (err) {
				failWrite('On.set', err);
			}
		});

	// ----- Brightness (dimming via LAN combo_control / CT control) -----
	service
		.getCharacteristic(Characteristic.Brightness)
		.onGet(() => {
			const current = ctx.cync?.brightness;
			const lastNonZero = ctx.cync?.lastNonZeroBrightness;
			let cachedBrightness = (ctx.cync?.on ?? false) ? 100 : 0;

			if (ctx.cync?.on === false && typeof lastNonZero === 'number') {
				cachedBrightness = lastNonZero;
			} else if (typeof current === 'number') {
				cachedBrightness = current;
			}

			if (env.isDeviceProbablyOffline(deviceId)) {
				env.log.debug(
					'Cync: Light Brightness.get offline-heuristic hit; returning cached=%d for %s (deviceId=%s)',
					cachedBrightness,
					deviceName,
					deviceId,
				);
				return cachedBrightness;
			}

			return cachedBrightness;
		})
		.onSet(async (value) => {
			const cyncMeta = ctx.cync;

			if (!cyncMeta?.deviceId) {
				env.log.warn(
					'Cync: Light Brightness.set called for %s but no cync.deviceId in context',
					deviceName,
				);
				return;
			}

			const brightness = Math.max(0, Math.min(100, Number(value)));

			if (!Number.isFinite(brightness)) {
				env.log.warn(
					'Cync: Light Brightness.set received invalid value=%o for %s (deviceId=%s)',
					value,
					deviceName,
					cyncMeta.deviceId,
				);
				return;
			}

			if (
				brightness === 100 &&
				pendingPowerOnRestore &&
				pendingPowerOnRestore.brightness < 100 &&
				!pendingWrites.brightnessTouched
			) {
				env.log.debug(
					'Cync: Light Brightness.set suppressing companion 100%% while restoring %d for %s (deviceId=%s)',
					pendingPowerOnRestore.brightness,
					deviceName,
					cyncMeta.deviceId,
				);
				service.updateCharacteristic(
					Characteristic.Brightness,
					pendingPowerOnRestore.brightness,
				);
				return;
			}

			cyncMeta.brightness = brightness;
			cyncMeta.on = brightness > 0;
			if (brightness > 0) {
				cyncMeta.lastNonZeroBrightness = brightness;
			}
			cyncMeta.powerCommandId = (cyncMeta.powerCommandId ?? 0) + 1;
			pendingWrites.brightness = brightness;
			pendingWrites.brightnessTouched = true;
			pendingWrites.restoreBrightness = undefined;
			pendingPowerOnRestore = undefined;

			env.log.info(
				'Cync: Light Brightness.set -> %d for %s (deviceId=%s)',
				brightness,
				deviceName,
				cyncMeta.deviceId,
			);

			try {
				await queueLightWrite();
			} catch (err) {
				failWrite('Brightness.set', err);
			}
		});
	// ----- Hue -----
	service
		.getCharacteristic(Characteristic.Hue)
		.onGet(() => {
			const hue = typeof ctx.cync?.hue === 'number' ? ctx.cync.hue : 0;

			if (env.isDeviceProbablyOffline(deviceId)) {
				env.log.debug(
					'Cync: Light Hue.get offline-heuristic hit; returning cached=%d for %s (deviceId=%s)',
					hue,
					deviceName,
					deviceId,
				);
			}

			return hue;
		})
		.onSet(async (value) => {
			const cyncMeta = ctx.cync;

			if (!cyncMeta?.deviceId) {
				env.log.warn(
					'Cync: Light Hue.set called for %s but no cync.deviceId in context',
					deviceName,
				);
				return;
			}

			const hue = Math.max(0, Math.min(360, Number(value)));
			if (!Number.isFinite(hue)) {
				env.log.warn(
					'Cync: Light Hue.set received invalid value=%o for %s (deviceId=%s)',
					value,
					deviceName,
					cyncMeta.deviceId,
				);
				return;
			}

			cyncMeta.hue = hue;
			cyncMeta.powerCommandId = (cyncMeta.powerCommandId ?? 0) + 1;
			pendingWrites.hue = hue;
			pendingWrites.restoreBrightness = undefined;
			pendingPowerOnRestore = undefined;

			if (pendingWrites.ctTouched && !pendingWrites.satTouched) {
				env.log.debug(
					'Cync: Light Hue.set ignored companion hue=%d after CT write for %s (deviceId=%s)',
					hue,
					deviceName,
					cyncMeta.deviceId,
				);
				try {
					await queueLightWrite();
				} catch (err) {
					failWrite('Hue.set', err);
				}
				return;
			}

			cyncMeta.colorActive = true;
			pendingWrites.colorTouched = true;
			pendingWrites.ctTouched = false;

			env.log.info(
				'Cync: Light Hue.set -> %d for %s (deviceId=%s)',
				hue,
				deviceName,
				cyncMeta.deviceId,
			);

			try {
				await queueLightWrite();
			} catch (err) {
				failWrite('Hue.set', err);
			}
		});

	// ----- Color Temperature (tunable white via LAN tone byte) -----
	// HomeKit uses mireds. Typical tunable-white range is ~153–500 mired (~6500K–2000K).

	service
		.getCharacteristic(Characteristic.ColorTemperature)
		.setProps({
			minValue: ctMinMired,
			maxValue: ctMaxMired,
			minStep: 1,
		})
		.onGet(() => {
			const cached = ctx.cync?.colorTemperature;

			// Default: warm-ish white (≈2700K)
			const value = typeof cached === 'number' ? cached : 370;

			if (env.isDeviceProbablyOffline(deviceId)) {
				env.log.debug(
					'Cync: Light ColorTemperature.get offline-heuristic hit; returning cached=%d for %s (deviceId=%s)',
					value,
					deviceName,
					deviceId,
				);
			}

			return value;
		})
		.onSet(async (value) => {
			const cyncMeta = ctx.cync;

			if (!cyncMeta?.deviceId) {
				env.log.warn(
					'Cync: Light ColorTemperature.set called for %s but no cync.deviceId in context',
					deviceName,
				);
				return;
			}

			const mired = clampNumber(Number(value), ctMinMired, ctMaxMired);
			if (!Number.isFinite(mired)) {
				env.log.warn(
					'Cync: Light ColorTemperature.set received invalid value=%o for %s (deviceId=%s)',
					value,
					deviceName,
					cyncMeta.deviceId,
				);
				return;
			}

			const kelvin = miredToKelvin(mired);
			const brightness =
				typeof pendingWrites.brightness === 'number'
					? pendingWrites.brightness
					: typeof cyncMeta.brightness === 'number'
						? cyncMeta.brightness
						: 100;

			if (pendingWrites.colorTouched) {
				env.log.debug(
					'Cync: Light ColorTemperature.set ignored companion CT %d mired after color write for %s (deviceId=%s)',
					mired,
					deviceName,
					cyncMeta.deviceId,
				);
				cyncMeta.colorTemperature = mired;
				try {
					await queueLightWrite();
				} catch (err) {
					failWrite('ColorTemperature.set', err);
				}
				return;
			}

			cyncMeta.colorTemperature = mired;
			cyncMeta.colorActive = false;
			cyncMeta.hue = 0;
			cyncMeta.saturation = 0;
			cyncMeta.rgb = { r: 255, g: 255, b: 255 };
			cyncMeta.on = brightness > 0;
			cyncMeta.brightness = brightness;
			if (brightness > 0) {
				cyncMeta.lastNonZeroBrightness = brightness;
			}
			cyncMeta.powerCommandId = (cyncMeta.powerCommandId ?? 0) + 1;
			pendingWrites.mired = mired;
			pendingWrites.ctTouched = true;
			pendingWrites.restoreBrightness = undefined;
			pendingPowerOnRestore = undefined;

			env.log.info(
				'Cync: Light ColorTemperature.set -> %d mired (~%dK) for %s (deviceId=%s) brightness=%d',
				mired,
				kelvin,
				deviceName,
				cyncMeta.deviceId,
				brightness,
			);

			try {
				await queueLightWrite();
			} catch (err) {
				failWrite('ColorTemperature.set', err);
			}
		});

	// ----- Saturation -----
	service
		.getCharacteristic(Characteristic.Saturation)
		.onGet(() => {
			const sat = typeof ctx.cync?.saturation === 'number' ? ctx.cync.saturation : 100;

			if (env.isDeviceProbablyOffline(deviceId)) {
				env.log.debug(
					'Cync: Light Saturation.get offline-heuristic hit; returning cached=%d for %s (deviceId=%s)',
					sat,
					deviceName,
					deviceId,
				);
			}

			return sat;
		})
		.onSet(async (value) => {
			const cyncMeta = ctx.cync;

			if (!cyncMeta?.deviceId) {
				env.log.warn(
					'Cync: Light Saturation.set called for %s but no cync.deviceId in context',
					deviceName,
				);
				return;
			}

			const saturation = Math.max(0, Math.min(100, Number(value)));
			if (!Number.isFinite(saturation)) {
				env.log.warn(
					'Cync: Light Saturation.set received invalid value=%o for %s (deviceId=%s)',
					value,
					deviceName,
					cyncMeta.deviceId,
				);
				return;
			}

			cyncMeta.saturation = saturation;
			cyncMeta.powerCommandId = (cyncMeta.powerCommandId ?? 0) + 1;
			pendingWrites.saturation = saturation;
			pendingWrites.satTouched = true;
			pendingWrites.restoreBrightness = undefined;
			pendingPowerOnRestore = undefined;

			if (pendingWrites.ctTouched && saturation === 0) {
				env.log.debug(
					'Cync: Light Saturation.set ignored companion sat=0 after CT write for %s (deviceId=%s)',
					deviceName,
					cyncMeta.deviceId,
				);
				try {
					await queueLightWrite();
				} catch (err) {
					failWrite('Saturation.set', err);
				}
				return;
			}

			cyncMeta.colorActive = true;
			pendingWrites.colorTouched = true;
			pendingWrites.ctTouched = false;

			env.log.info(
				'Cync: Light Saturation.set -> %d for %s (deviceId=%s)',
				saturation,
				deviceName,
				cyncMeta.deviceId,
			);

			try {
				await queueLightWrite();
			} catch (err) {
				failWrite('Saturation.set', err);
			}
		});

	// Remove optional HomeKit controls that the APK table says this device cannot handle.
	// Unknown future device types retain the legacy behavior until cloud/LAN data
	// can promote their capabilities.
	if (apkProfile && !apkProfile.supportsBrightness && service.testCharacteristic(Characteristic.Brightness)) {
		service.removeCharacteristic(service.getCharacteristic(Characteristic.Brightness));
	}
	if (apkProfile && !apkProfile.supportsColor) {
		if (service.testCharacteristic(Characteristic.Hue)) {
			service.removeCharacteristic(service.getCharacteristic(Characteristic.Hue));
		}
		if (service.testCharacteristic(Characteristic.Saturation)) {
			service.removeCharacteristic(service.getCharacteristic(Characteristic.Saturation));
		}
	}
	if (apkProfile && !apkProfile.supportsCt && service.testCharacteristic(Characteristic.ColorTemperature)) {
		service.removeCharacteristic(service.getCharacteristic(Characteristic.ColorTemperature));
	}
}
