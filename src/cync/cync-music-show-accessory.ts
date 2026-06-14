// src/cync/cync-music-show-accessory.ts

import type { PlatformAccessory, CharacteristicValue } from 'homebridge';

import type { CyncAccessoryEnv } from './cync-accessory-helpers.js';

export const BUILT_IN_CYNC_MUSIC_SHOWS = [
	{ index: 1, name: 'Midnight' },
	{ index: 2, name: 'Earth Tones' },
	{ index: 3, name: 'Heat Wave' },
	{ index: 4, name: 'Solar Flare' },
	{ index: 5, name: 'Breeze' },
	{ index: 6, name: 'Tropical' },
	{ index: 7, name: 'Spectrum' },
	{ index: 8, name: 'Supernova' },
] as const;

export function configureCyncMusicShowAccessory(
	env: CyncAccessoryEnv,
	_mesh: unknown,
	_device: unknown,
	accessory: PlatformAccessory,
	accessoryName: string,
	deviceId: string,
	musicShow: Record<string, unknown>,
	activateMusicShow: (
		deviceId: string,
		showIndex: number,
		crc?: number,
	) => Promise<boolean>,
): void {
	const Service = env.api.hap.Service;
	const Characteristic = env.api.hap.Characteristic;

	const showIndex =
		typeof musicShow.index === 'number'
			? musicShow.index
			: undefined;

	if (showIndex !== undefined) {
		env.registerMusicShowAccessoryForDevice?.(
			deviceId,
			accessory,
			showIndex,
		);
	}

	accessory.context.musicShowActive =
		accessory.context.musicShowActive === true;

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
		'Cync Music Show',
	);

	informationService?.setCharacteristic(
		Characteristic.SerialNumber,
		`${deviceId}-${String(musicShow.index ?? 'unknown')}`,
	);

	service.setCharacteristic(
		Characteristic.Name,
		accessoryName,
	);

	service
		.getCharacteristic(Characteristic.On)
		.onGet((): CharacteristicValue => {
			return accessory.context.musicShowActive === true;
		})
		.onSet(async (value: CharacteristicValue): Promise<void> => {
			const on = value === true;

			const crc =
				typeof musicShow.crc === 'number'
					? musicShow.crc
					: undefined;

			if (showIndex === undefined) {
				env.log.warn(
					'Cync Music Show missing numeric index: device=%s show=%s',
					deviceId,
					String(musicShow.name ?? 'Unknown'),
				);
				return;
			}

			if (on) {
				env.log.info(
					'Cync Music Show requested: device=%s show=%s index=%d',
					deviceId,
					String(musicShow.name ?? 'Unknown'),
					showIndex,
				);

				const activated = await activateMusicShow(deviceId, showIndex, crc);

				if (activated) {
					env.markActiveMusicShowForDevice?.(deviceId, showIndex);
					env.setMainAccessoryOnForDevice?.(deviceId, true);
				}

				return;
			}

			env.log.info(
				'Cync Music Show off requested: device=%s show=%s index=%d',
				deviceId,
				String(musicShow.name ?? 'Unknown'),
				showIndex,
			);

			await env.tcpClient.exitMusicShowMode(deviceId);
			await env.tcpClient.setSwitchState(deviceId, { on: false });

			env.markActiveMusicShowForDevice?.(deviceId, null);
		});
}
