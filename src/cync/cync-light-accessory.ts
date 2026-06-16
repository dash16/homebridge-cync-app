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

function clampNumber(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, n));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const POWER_ON_BRIGHTNESS_RESTORE_DELAY_MS = 500;
const ctMinMired = 153;
const ctMaxMired = 500;

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

	// Remember mapping for LAN updates
	env.registerAccessoryForDevice(deviceId, accessory);
	env.markDeviceSeen(deviceId);
	env.startPollingDevice(deviceId);

	const Characteristic = env.api.hap.Characteristic;

	// ----- On/Off -----
	service
		.getCharacteristic(Characteristic.On)
		.onGet(() => {
			const currentOn = !!ctx.cync?.on;

			if (env.isDeviceProbablyOffline(deviceId)) {
				env.log.debug(
					'Cync: Light On.get offline-heuristic hit; returning cached=%s for %s (deviceId=%s)',
					String(currentOn),
					deviceName,
					deviceId,
				);
				return currentOn;
			}

			env.log.info(
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

			// Optimistic local cache; LAN update will confirm
			cyncMeta.on = on;
			cyncMeta.powerCommandId = (cyncMeta.powerCommandId ?? 0) + 1;
			const powerCommandId = cyncMeta.powerCommandId;

			try {
				await env.tcpClient.setSwitchState(cyncMeta.deviceId, { on });

				if (
					on &&
					typeof restoreBrightness === 'number' &&
					restoreBrightness > 0 &&
					restoreBrightness < 100
				) {
					await delay(POWER_ON_BRIGHTNESS_RESTORE_DELAY_MS);
					if (cyncMeta.powerCommandId === powerCommandId && cyncMeta.on === true) {
						await restoreBrightnessAfterPowerOn(
							env,
							cyncMeta,
							deviceName,
							restoreBrightness,
						);
					}
				}

				env.markDeviceSeen(cyncMeta.deviceId);
			} catch (err) {
				env.log.warn(
					'Cync: Light On.set failed for %s (deviceId=%s): %s',
					deviceName,
					cyncMeta.deviceId,
					(err as Error).message ?? String(err),
				);

				throw new env.api.hap.HapStatusError(
					env.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
				);
			}
		});

	// ----- Brightness (dimming via LAN combo_control / CT control) -----
	service
		.getCharacteristic(Characteristic.Brightness)
		.onGet(() => {
			const current = ctx.cync?.brightness;

			const cachedBrightness =
				typeof current === 'number'
					? current
					: (ctx.cync?.on ?? false) ? 100 : 0;

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

			// Optimistic cache
			cyncMeta.brightness = brightness;
			cyncMeta.on = brightness > 0;
			if (brightness > 0) {
				cyncMeta.lastNonZeroBrightness = brightness;
			}
			cyncMeta.powerCommandId = (cyncMeta.powerCommandId ?? 0) + 1;

			env.log.info(
				'Cync: Light Brightness.set -> %d for %s (deviceId=%s)',
				brightness,
				deviceName,
				cyncMeta.deviceId,
			);

			try {
				const isCtMode =
					!cyncMeta.colorActive && typeof cyncMeta.colorTemperature === 'number';

				if (isCtMode) {
					env.log.debug(
						'Cync: Brightness.set preserving CT mode (mired=%d brightness=%d)',
						cyncMeta.colorTemperature,
						brightness,
					);

					const colorTemperature = cyncMeta.colorTemperature;

					if (typeof colorTemperature !== 'number') {
						env.log.warn(
							'Cync: Brightness.set CT mode for %s but no cached color temperature is available',
							deviceName,
						);
						return;
					}

					const ctMinMired = 153;
					const ctMaxMired = 500;

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
						'Cync: Brightness.set preserving RGB state (colorActive=%s rgb=%o)',
						String(!!cyncMeta.colorActive),
						cyncMeta.rgb,
					);

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
			} catch (err) {
				env.log.warn(
					'Cync: Light Brightness.set failed for %s (deviceId=%s): %s',
					deviceName,
					cyncMeta.deviceId,
					(err as Error).message ?? String(err),
				);

				throw new env.api.hap.HapStatusError(
					env.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
				);
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

			// Use cached saturation/brightness if available, otherwise sane defaults
			const saturation =
        typeof cyncMeta.saturation === 'number' ? cyncMeta.saturation : 100;

			const brightness =
        typeof cyncMeta.brightness === 'number' ? cyncMeta.brightness : 100;

			const rgb = hsvToRgb(hue, saturation, brightness);

			// Optimistic cache
			cyncMeta.hue = hue;
			cyncMeta.saturation = saturation;
			cyncMeta.rgb = rgb;
			cyncMeta.colorActive = true;
			cyncMeta.on = brightness > 0;
			cyncMeta.brightness = brightness;
			if (brightness > 0) {
				cyncMeta.lastNonZeroBrightness = brightness;
			}
			cyncMeta.powerCommandId = (cyncMeta.powerCommandId ?? 0) + 1;

			env.log.info(
				'Cync: Light Hue.set -> %d for %s (deviceId=%s) -> rgb=(%d,%d,%d) brightness=%d',
				hue,
				deviceName,
				cyncMeta.deviceId,
				rgb.r,
				rgb.g,
				rgb.b,
				brightness,
			);

			try {
				await env.tcpClient.setColor(
					cyncMeta.deviceId,
					cyncMeta.rgb,
					brightness,
					cyncMeta.deviceType,
				);
				env.markDeviceSeen(cyncMeta.deviceId);
			} catch (err) {
				env.log.warn(
					'Cync: Light Hue.set failed for %s (deviceId=%s): %s',
					deviceName,
					cyncMeta.deviceId,
					(err as Error).message ?? String(err),
				);

				throw new env.api.hap.HapStatusError(
					env.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
				);
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

			// Treat CT as "white mode" (not RGB color mode)
			cyncMeta.colorTemperature = mired;
			cyncMeta.colorActive = false;

			const brightness =
				typeof cyncMeta.brightness === 'number' ? cyncMeta.brightness : 100;

			cyncMeta.on = brightness > 0;
			cyncMeta.brightness = brightness;
			if (brightness > 0) {
				cyncMeta.lastNonZeroBrightness = brightness;
			}
			cyncMeta.powerCommandId = (cyncMeta.powerCommandId ?? 0) + 1;

			env.log.info(
				'Cync: Light ColorTemperature.set -> %d mired (~%dK) for %s (deviceId=%s) brightness=%d',
				mired,
				kelvin,
				deviceName,
				cyncMeta.deviceId,
				brightness,
			);

			try {
				await env.tcpClient.setColorTemperature(
					cyncMeta.deviceId,
					{
						mired,
						brightnessPct: brightness,
						ctMinMired,
						ctMaxMired,

						invertTone: true,
					},
					cyncMeta.deviceType,
				);

				env.markDeviceSeen(cyncMeta.deviceId);
			} catch (err) {
				env.log.warn(
					'Cync: Light ColorTemperature.set failed for %s (deviceId=%s): %s',
					deviceName,
					cyncMeta.deviceId,
					(err as Error).message ?? String(err),
				);

				throw new env.api.hap.HapStatusError(
					env.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
				);
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

			const hue = typeof cyncMeta.hue === 'number' ? cyncMeta.hue : 0;

			const brightness =
        typeof cyncMeta.brightness === 'number' ? cyncMeta.brightness : 100;

			const rgb = hsvToRgb(hue, saturation, brightness);

			// Optimistic cache
			cyncMeta.hue = hue;
			cyncMeta.saturation = saturation;
			cyncMeta.rgb = rgb;
			cyncMeta.colorActive = true;
			cyncMeta.on = brightness > 0;
			cyncMeta.brightness = brightness;
			if (brightness > 0) {
				cyncMeta.lastNonZeroBrightness = brightness;
			}
			cyncMeta.powerCommandId = (cyncMeta.powerCommandId ?? 0) + 1;

			env.log.info(
				'Cync: Light Saturation.set -> %d for %s (deviceId=%s) -> rgb=(%d,%d,%d) brightness=%d',
				saturation,
				deviceName,
				cyncMeta.deviceId,
				rgb.r,
				rgb.g,
				rgb.b,
				brightness,
			);

			try {
				await env.tcpClient.setColor(
					cyncMeta.deviceId,
					rgb,
					brightness,
					cyncMeta.deviceType,
				);
				env.markDeviceSeen(cyncMeta.deviceId);
			} catch (err) {
				env.log.warn(
					'Cync: Light Saturation.set failed for %s (deviceId=%s): %s',
					deviceName,
					cyncMeta.deviceId,
					(err as Error).message ?? String(err),
				);

				throw new env.api.hap.HapStatusError(
					env.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
				);
			}
		});
}
