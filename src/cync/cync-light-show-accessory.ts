// src/cync/cync-light-show-accessory.ts

import type { PlatformAccessory, CharacteristicValue } from 'homebridge';

import type { CyncAccessoryEnv } from './cync-accessory-helpers.js';

export function configureCyncLightShowAccessory(
	env: CyncAccessoryEnv,
	_mesh: unknown,
	_device: unknown,
	accessory: PlatformAccessory,
	accessoryName: string,
	deviceId: string,
	lightShow: Record<string, unknown>,
	activateLightShow: (
		deviceId: string,
		showIndex: number,
		crc?: number,
	) => Promise<boolean>,
): void {
	const Service = env.api.hap.Service;
	const Characteristic = env.api.hap.Characteristic;

	const service =
		accessory.getService(Service.Switch) ??
		accessory.addService(Service.Switch, accessoryName);

	const informationService =
		accessory.getService(Service.AccessoryInformation);

	informationService?.setCharacteristic(
		Characteristic.Manufacturer,
		'Savant',
	);

	informationService?.setCharacteristic(
		Characteristic.Model,
		'Cync Light Show',
	);

	informationService?.setCharacteristic(
		Characteristic.SerialNumber,
		`${deviceId}-${String(lightShow.index ?? 'unknown')}`,
	);

	service.setCharacteristic(
		Characteristic.Name,
		accessoryName,
	);

	service
		.getCharacteristic(Characteristic.On)
		.onGet((): CharacteristicValue => false)
		.onSet(async (value: CharacteristicValue): Promise<void> => {
			if (value !== true) {
				return;
			}

			const showIndex =
				typeof lightShow.index === 'number'
					? lightShow.index
					: undefined;

			const crc =
				typeof lightShow.crc === 'number'
					? lightShow.crc
					: undefined;

			if (showIndex === undefined) {
				env.log.warn(
					'Cync Light Show missing numeric index: device=%s show=%s',
					deviceId,
					String(lightShow.name ?? 'Unknown'),
				);
				return;
			}

			env.log.info(
				'Cync Light Show requested: device=%s show=%s index=%d',
				deviceId,
				String(lightShow.name ?? 'Unknown'),
				showIndex,
			);

			await activateLightShow(deviceId, showIndex, crc);

			setTimeout(() => {
				service.updateCharacteristic(
					Characteristic.On,
					false,
				);
			}, 250);
		});
}
