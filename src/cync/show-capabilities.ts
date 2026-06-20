/**
 * Device show capabilities extracted from the Cync Android SDK DeviceType table.
 *
 * Capability.C identifies Light Show support. Capability.E identifies Music Show
 * support. Music-capable devices are also Light Show capable in the SDK table.
 */
export const CYNC_LIGHT_SHOW_DEVICE_TYPES = new Set<number>([
	6, 7, 8, 21, 22, 23, 30, 31, 32, 33, 34, 35, 41, 42, 43, 44,
	46, 47, 71, 72, 73, 74, 75, 76, 97, 98, 101, 102, 104, 105, 107,
	108, 109, 110, 123, 131, 132, 133, 137, 138, 139, 140, 141, 142,
	143, 146, 147, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162,
	163, 164, 165, 166, 167, 168, 169, 170, 171, 173, 174, 175, 177,
	180, 181, 182,
]);

export const CYNC_MUSIC_SHOW_DEVICE_TYPES = new Set<number>([
	71, 72, 73, 74, 75, 76, 110, 123, 141, 155, 157, 158, 159, 166,
	167, 168,
]);

export function supportsCyncLightShows(deviceType: number | undefined): boolean {
	return deviceType !== undefined && CYNC_LIGHT_SHOW_DEVICE_TYPES.has(deviceType);
}

export function supportsCyncMusicShows(deviceType: number | undefined): boolean {
	return deviceType !== undefined && CYNC_MUSIC_SHOW_DEVICE_TYPES.has(deviceType);
}
