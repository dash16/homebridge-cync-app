// src/cync/cync-light-show-accessory.ts

import type { PlatformAccessory, CharacteristicValue } from 'homebridge';

import type { CyncAccessoryEnv } from './cync-accessory-helpers.js';

export const BUILT_IN_CYNC_LIGHT_SHOWS = [
	{ index: 1, name: 'Candle' },
	{ index: 2, name: 'Rainbow' },
	{ index: 3, name: 'Fireworks' },
	{ index: 4, name: 'Volcanic' },
	{ index: 5, name: 'Aurora' },
	{ index: 6, name: 'Happy Holidays' },
	{ index: 7, name: 'Red White Blue' },
	{ index: 8, name: 'Vegas' },
	{ index: 9, name: 'Party Time' },
	{ index: 65, name: 'Power Up' },
	{ index: 67, name: 'Cyber' },
] as const;

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
	) => Promise<boolean>,
): void {
	const Service = env.api.hap.Service;
	const Characteristic = env.api.hap.Characteristic;

	const showIndex =
		typeof lightShow.index === 'number'
			? lightShow.index
			: undefined;

	if (showIndex !== undefined) {
		env.registerLightShowAccessoryForDevice?.(
			deviceId,
			accessory,
			showIndex,
		);
	}

	accessory.context.lightShowActive =
		accessory.context.lightShowActive === true;

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
		.onGet((): CharacteristicValue => {
			return accessory.context.lightShowActive === true;
		})
		.onSet(async (value: CharacteristicValue): Promise<void> => {
			const on = value === true;

			if (showIndex === undefined) {
				env.log.warn(
					'Cync Light Show missing numeric index: device=%s show=%s',
					deviceId,
					String(lightShow.name ?? 'Unknown'),
				);
				return;
			}

			if (on) {
				env.log.info(
					'Cync Light Show requested: device=%s show=%s index=%d',
					deviceId,
					String(lightShow.name ?? 'Unknown'),
					showIndex,
				);

				const activated = await activateLightShow(deviceId, showIndex);

				if (activated) {
					env.markActiveLightShowForDevice?.(deviceId, showIndex);
					env.setMainAccessoryOnForDevice?.(deviceId, true);
				}

				return;
			}

			env.log.info(
				'Cync Light Show off requested: device=%s show=%s index=%d',
				deviceId,
				String(lightShow.name ?? 'Unknown'),
				showIndex,
			);

			await env.tcpClient.exitLightShowMode(deviceId);
			await env.tcpClient.setSwitchState(deviceId, { on: false });

			env.markActiveLightShowForDevice?.(deviceId, null);
		});
}
