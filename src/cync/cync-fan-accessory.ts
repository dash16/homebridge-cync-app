// src/cync/cync-fan-accessory.ts
import type { PlatformAccessory } from 'homebridge';
import type { CyncDevice, CyncDeviceMesh } from './config-client.js';
import type { CyncAccessoryContext, CyncAccessoryEnv } from './cync-accessory-helpers.js';
import {
	applyAccessoryInformationFromCyncDevice,
	resolveDeviceType,
} from './cync-accessory-helpers.js';

function clampFanSpeed(value: unknown): number {
	const speed = Math.round(Number(value));

	if (!Number.isFinite(speed)) {
		return 0;
	}

	return Math.max(0, Math.min(100, speed));
}

// Fan Accessory Configurator: Exposes Cync fan switches as HomeKit Fanv2 accessories
export function configureCyncFanAccessory(
	env: CyncAccessoryEnv,
	mesh: CyncDeviceMesh,
	device: CyncDevice,
	accessory: PlatformAccessory,
	deviceName: string,
	deviceId: string,
): void {
	const Service = env.api.hap.Service;
	const Characteristic = env.api.hap.Characteristic;

	const existingLight = accessory.getService(Service.Lightbulb);
	if (existingLight) {
		env.log.info(
			'Cync: removing stale Lightbulb service from %s (deviceId=%s) before configuring as Fan',
			deviceName,
			deviceId,
		);
		accessory.removeService(existingLight);
	}

	const existingSwitch = accessory.getService(Service.Switch);
	if (existingSwitch) {
		env.log.info(
			'Cync: removing stale Switch service from %s (deviceId=%s) before configuring as Fan',
			deviceName,
			deviceId,
		);
		accessory.removeService(existingSwitch);
	}

	const existingOutlet = accessory.getService(Service.Outlet);
	if (existingOutlet) {
		env.log.info(
			'Cync: removing stale Outlet service from %s (deviceId=%s) before configuring as Fan',
			deviceName,
			deviceId,
		);
		accessory.removeService(existingOutlet);
	}

	const service =
		accessory.getService(Service.Fanv2) ||
		accessory.addService(Service.Fanv2, deviceName);

	if (accessory.category !== env.api.hap.Categories.FAN) {
		accessory.category = env.api.hap.Categories.FAN;
	}

	applyAccessoryInformationFromCyncDevice(env.api, accessory, device, deviceName, deviceId);

	const ctx = accessory.context as CyncAccessoryContext;
	ctx.cync = ctx.cync ?? {
		meshId: mesh.id,
		deviceId,
		productId: device.product_id,
		on: false,
	};

	const resolvedDeviceType = resolveDeviceType(device);
	if (typeof resolvedDeviceType === 'number' && Number.isFinite(resolvedDeviceType)) {
		ctx.cync.deviceType = resolvedDeviceType;
	}

	env.registerAccessoryForDevice(deviceId, accessory);
	env.markDeviceSeen(deviceId);
	env.startPollingDevice(deviceId);

	service
		.getCharacteristic(Characteristic.Active)
		.onGet(() => {
			return ctx.cync?.on ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE;
		})
		.onSet(async (value) => {
			const cyncMeta = ctx.cync;

			if (!cyncMeta?.deviceId) {
				env.log.warn(
					'Cync: Fan Active.set called for %s but no cync.deviceId in context',
					deviceName,
				);
				return;
			}

			const on = value === Characteristic.Active.ACTIVE;

			cyncMeta.on = on;

			try {
				await env.tcpClient.setSwitchState(cyncMeta.deviceId, { on });
				env.markDeviceSeen(cyncMeta.deviceId);
			} catch (err) {
				env.log.warn(
					'Cync: Fan Active.set failed for %s (deviceId=%s): %s',
					deviceName,
					cyncMeta.deviceId,
					(err as Error).message ?? String(err),
				);

				throw new env.api.hap.HapStatusError(
					env.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
				);
			}
		});

	service
		.getCharacteristic(Characteristic.RotationSpeed)
		.onGet(() => {
			return typeof ctx.cync?.brightness === 'number'
				? ctx.cync.brightness
				: ctx.cync?.on ? 100 : 0;
		})
		.onSet(async (value) => {
			const cyncMeta = ctx.cync;

			if (!cyncMeta?.deviceId) {
				env.log.warn(
					'Cync: Fan RotationSpeed.set called for %s but no cync.deviceId in context',
					deviceName,
				);
				return;
			}

			const speed = clampFanSpeed(value);

			cyncMeta.brightness = speed;
			cyncMeta.on = speed > 0;

			try {
				await env.tcpClient.setBrightness(cyncMeta.deviceId, speed, cyncMeta.deviceType);
				env.markDeviceSeen(cyncMeta.deviceId);
			} catch (err) {
				env.log.warn(
					'Cync: Fan RotationSpeed.set failed for %s (deviceId=%s): %s',
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
