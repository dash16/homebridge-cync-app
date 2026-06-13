// src/cync/cync-switch-accessory.ts
import type { PlatformAccessory } from 'homebridge';
import type { CyncDevice, CyncDeviceMesh } from './config-client.js';
import type { CyncAccessoryContext, CyncAccessoryEnv } from './cync-accessory-helpers.js';
import { applyAccessoryInformationFromCyncDevice } from './cync-accessory-helpers.js';

export function configureCyncSwitchAccessory(
	env: CyncAccessoryEnv,
	mesh: CyncDeviceMesh,
	device: CyncDevice,
	accessory: PlatformAccessory,
	deviceName: string,
	deviceId: string,
): void {
	const { Characteristic, Service } = env.api.hap;

	const service =
		accessory.getService(Service.Switch) ||
		accessory.addService(Service.Switch, deviceName);

	const existingLight = accessory.getService(Service.Lightbulb);
	if (existingLight) {
		env.log.info(
			'Cync: removing stale Lightbulb service from %s (deviceId=%s) before configuring as Switch',
			deviceName,
			deviceId,
		);
		accessory.removeService(existingLight);
	}

	const deviceRecord = device as unknown as Record<string, unknown>;

	const deviceType =
		typeof deviceRecord.deviceType === 'number'
			? deviceRecord.deviceType
			: typeof deviceRecord.type === 'number'
				? deviceRecord.type
				: undefined;

	const supportsBrightness = deviceType === 125;

	applyAccessoryInformationFromCyncDevice(env.api, accessory, device, deviceName, deviceId);

	const ctx = accessory.context as CyncAccessoryContext;
	ctx.cync = ctx.cync ?? {
		meshId: mesh.id,
		deviceId,
		productId: device.product_id,
		on: false,
	};

	ctx.cync.deviceType = deviceType;

	env.registerAccessoryForDevice(deviceId, accessory);
	env.markDeviceSeen(deviceId);
	env.startPollingDevice(deviceId);

	service
		.getCharacteristic(Characteristic.On)
		.onGet(() => {
			const currentOn = !!ctx.cync?.on;

			if (env.isDeviceProbablyOffline(deviceId)) {
				env.log.debug(
					'Cync: Switch On.get offline-heuristic hit; returning cached=%s for %s (deviceId=%s)',
					String(currentOn),
					deviceName,
					deviceId,
				);
				return currentOn;
			}

			env.log.info(
				'Cync: Switch On.get -> %s for %s (deviceId=%s)',
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
					'Cync: Switch On.set called for %s but no cync.deviceId in context',
					deviceName,
				);
				return;
			}

			const on = value === true || value === 1;

			env.log.info(
				'Cync: Switch On.set -> %s for %s (deviceId=%s)',
				String(on),
				deviceName,
				cyncMeta.deviceId,
			);

			cyncMeta.on = on;

			try {
				if (!on) {
					await env.tcpClient.setSwitchState(cyncMeta.deviceId, { on: false });
					env.markDeviceSeen(cyncMeta.deviceId);
					return;
				}

				await env.tcpClient.setSwitchState(cyncMeta.deviceId, { on: true });

				if (
					supportsBrightness &&
					typeof cyncMeta.brightness === 'number' &&
					cyncMeta.brightness > 0 &&
					cyncMeta.brightness < 100
				) {
					env.log.debug(
						'Cync: Switch On.set restoring brightness=%d for %s (deviceId=%s)',
						cyncMeta.brightness,
						deviceName,
						cyncMeta.deviceId,
					);

					await env.tcpClient.setBrightness(
						cyncMeta.deviceId,
						cyncMeta.brightness,
						cyncMeta.deviceType,
					);
				}

				env.markDeviceSeen(cyncMeta.deviceId);
			} catch (err) {
				env.log.warn(
					'Cync: Switch On.set failed for %s (deviceId=%s): %s',
					deviceName,
					cyncMeta.deviceId,
					(err as Error).message ?? String(err),
				);

				throw new env.api.hap.HapStatusError(
					env.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
				);
			}
		});

	if (supportsBrightness) {
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
						'Cync: Switch Brightness.get offline-heuristic hit; returning cached=%d for %s (deviceId=%s)',
						cachedBrightness,
						deviceName,
						deviceId,
					);
				}

				return cachedBrightness;
			})
			.onSet(async (value) => {
				const cyncMeta = ctx.cync;

				if (!cyncMeta?.deviceId) {
					env.log.warn(
						'Cync: Switch Brightness.set called for %s but no cync.deviceId in context',
						deviceName,
					);
					return;
				}

				const brightness = Math.max(0, Math.min(100, Number(value)));

				if (!Number.isFinite(brightness)) {
					env.log.warn(
						'Cync: Switch Brightness.set received invalid value=%o for %s (deviceId=%s)',
						value,
						deviceName,
						cyncMeta.deviceId,
					);
					return;
				}

				cyncMeta.brightness = brightness;
				cyncMeta.on = brightness > 0;

				env.log.info(
					'Cync: Switch Brightness.set -> %d for %s (deviceId=%s)',
					brightness,
					deviceName,
					cyncMeta.deviceId,
				);

				try {
					await env.tcpClient.setBrightness(
						cyncMeta.deviceId,
						brightness,
						cyncMeta.deviceType,
					);

					env.markDeviceSeen(cyncMeta.deviceId);
				} catch (err) {
					env.log.warn(
						'Cync: Switch Brightness.set failed for %s (deviceId=%s): %s',
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
}
