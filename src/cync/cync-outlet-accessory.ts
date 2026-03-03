// src/cync/cync-outlet-accessory.ts

import type { PlatformAccessory } from 'homebridge';
import type { CyncDevice, CyncDeviceMesh } from './config-client.js';
import type { CyncAccessoryContext, CyncAccessoryEnv } from './cync-accessory-helpers.js';
import { applyAccessoryInformationFromCyncDevice, resolveDeviceType } from './cync-accessory-helpers.js';

export function configureCyncOutletAccessory(
	env: CyncAccessoryEnv,
	mesh: CyncDeviceMesh,
	device: CyncDevice,
	accessory: PlatformAccessory,
	deviceName: string,
	deviceId: string,
): void {
	// Remove stale services if present (service-type changes must be cleaned up)
	const existingSwitch = accessory.getService(env.api.hap.Service.Switch);
	if (existingSwitch) {
		env.log.info(
			'Cync: removing stale Switch service from %s (deviceId=%s) before configuring as Outlet',
			deviceName,
			deviceId,
		);
		accessory.removeService(existingSwitch);
	}

	const existingLight = accessory.getService(env.api.hap.Service.Lightbulb);
	if (existingLight) {
		env.log.info(
			'Cync: removing stale Lightbulb service from %s (deviceId=%s) before configuring as Outlet',
			deviceName,
			deviceId,
		);
		accessory.removeService(existingLight);
	}

	const service =
		accessory.getService(env.api.hap.Service.Outlet) ||
		accessory.addService(env.api.hap.Service.Outlet, deviceName);

	applyAccessoryInformationFromCyncDevice(env.api, accessory, device, deviceName, deviceId);

	// Ensure context is initialized
	const ctx = accessory.context as CyncAccessoryContext;
	ctx.cync = ctx.cync ?? {
		meshId: mesh.id,
		deviceId,
		productId: device.product_id,
		on: false,
	};

	// Populate deviceType so platform-side default capabilities work as intended
	ctx.cync.deviceType = resolveDeviceType(device);

	// Remember mapping for LAN updates
	env.registerAccessoryForDevice(deviceId, accessory);
	env.markDeviceSeen(deviceId);
	env.startPollingDevice(deviceId);

	service
		.getCharacteristic(env.api.hap.Characteristic.On)
		.onGet(() => {
			const currentOn = !!ctx.cync?.on;

			if (env.isDeviceProbablyOffline(deviceId)) {
				env.log.debug(
					'Cync: Outlet On.get offline-heuristic hit; returning cached=%s for %s (deviceId=%s)',
					String(currentOn),
					deviceName,
					deviceId,
				);
				return currentOn;
			}

			env.log.info(
				'Cync: Outlet On.get -> %s for %s (deviceId=%s)',
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
					'Cync: Outlet On.set called for %s but no cync.deviceId in context',
					deviceName,
				);
				return;
			}

			const on = value === true || value === 1;

			env.log.info(
				'Cync: Outlet On.set -> %s for %s (deviceId=%s)',
				String(on),
				deviceName,
				cyncMeta.deviceId,
			);

			// Optimistic cache
			cyncMeta.on = on;

			try {
				await env.tcpClient.setSwitchState(cyncMeta.deviceId, { on });
				env.markDeviceSeen(cyncMeta.deviceId);

				if (service.testCharacteristic(env.api.hap.Characteristic.OutletInUse)) {
					service.updateCharacteristic(env.api.hap.Characteristic.OutletInUse, on);
				}
			} catch (err) {
				env.log.warn(
					'Cync: Outlet On.set failed for %s (deviceId=%s): %s',
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
