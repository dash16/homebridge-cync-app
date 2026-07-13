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
	const service =
		accessory.getService(env.api.hap.Service.Switch) ||
		accessory.addService(env.api.hap.Service.Switch, deviceName);

	const existingLight = accessory.getService(env.api.hap.Service.Lightbulb);
	if (existingLight) {
		env.log.info(
			'Cync: removing stale Lightbulb service from %s (deviceId=%s) before configuring as Switch',
			deviceName,
			deviceId,
		);
		accessory.removeService(existingLight);
	}

	const existingOutlet = accessory.getService(env.api.hap.Service.Outlet);
	if (existingOutlet) {
		accessory.removeService(existingOutlet);
	}

	const existingFan = accessory.getService(env.api.hap.Service.Fanv2);
	if (existingFan) {
		accessory.removeService(existingFan);
	}

	accessory.category = env.api.hap.Categories.SWITCH;

	applyAccessoryInformationFromCyncDevice(env.api, accessory, device, deviceName, deviceId);

	// Ensure context is initialized
	const ctx = accessory.context as CyncAccessoryContext;
	ctx.cync = ctx.cync ?? {
		meshId: mesh.id,
		deviceId,
		productId: device.product_id,
		on: false,
	};

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
					'Cync: Switch On.get offline-heuristic hit; returning cached=%s for %s (deviceId=%s)',
					String(currentOn),
					deviceName,
					deviceId,
				);
				return currentOn;
			}

			env.log.debug(
				'Cync: On.get -> %s for %s (deviceId=%s)',
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

			// Optimistic cache
			cyncMeta.on = on;

			try {
				if (!on) {
					await env.tcpClient.setSwitchState(cyncMeta.deviceId, { on: false });
					env.markDeviceSeen(cyncMeta.deviceId);
					return;
				}

				await env.tcpClient.setSwitchState(cyncMeta.deviceId, { on: true });

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
}
