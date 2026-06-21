/**
 * Device categories and capabilities extracted from the DeviceType table in a
 * decompiled Cync Android APK. Keep unknown-device fallbacks outside this
 * module so a new device can still be promoted from cloud or LAN observations.
 */

export type CyncApkAccessoryType =
	| 'light'
	| 'fan'
	| 'outlet'
	| 'switch'
	| 'ignored'
	| 'unsupported';

export interface CyncApkDeviceProfile {
	accessoryType: CyncApkAccessoryType;
	supportsBrightness: boolean;
	supportsColor: boolean;
	supportsCt: boolean;
	supportsLightShows: boolean;
	supportsMusicShows: boolean;
	supportsSegmentedControl: boolean;
}

const LIGHT_DEVICE_TYPES = new Set<number>([
	1, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
	27, 28, 29, 30, 31, 32, 33, 34, 35, 41, 42, 43, 44, 46, 47, 71, 72, 73, 74, 75,
	76, 80, 82, 83, 85, 97, 98, 99, 100, 101, 102, 103, 104, 105, 107, 108, 109, 110,
	123, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142,
	143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158,
	159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 173, 174, 175,
	177, 180, 181, 182,
]);

const OUTLET_DEVICE_TYPES = new Set<number>([
	64, 65, 66, 67, 68, 69, 111, 172,
]);

const SWITCH_DEVICE_TYPES = new Set<number>([
	36, 37, 38, 39, 40, 48, 49, 51, 52, 53, 55, 56, 57, 58, 59, 61, 62, 63, 116,
	117, 118, 119, 120, 124, 125,
]);

const FAN_DEVICE_TYPES = new Set<number>([81, 121]);
const IGNORED_DEVICE_TYPES = new Set<number>([96, 112, 113, 114, 115, 65536]);
const UNSUPPORTED_DEVICE_TYPES = new Set<number>([122, 224, 240, 241, 242]);

const DIMMABLE_DEVICE_TYPES = new Set<number>([
	1, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
	27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 41, 42, 43, 44, 46, 47, 48, 49, 55,
	56, 71, 72, 73, 74, 75, 76, 80, 82, 83, 85, 97, 98, 99, 100, 101, 102, 103, 104,
	105, 107, 108, 109, 110, 116, 117, 123, 124, 125, 128, 129, 130, 131, 132, 133,
	134, 135, 136, 137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 148, 149,
	150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160, 161, 162, 163, 164, 165,
	166, 167, 168, 169, 170, 171, 173, 174, 175, 177, 180, 181, 182,
]);

const CT_DEVICE_TYPES = new Set<number>([
	5, 6, 7, 8, 10, 11, 14, 15, 19, 20, 21, 22, 23, 25, 26, 28, 29, 30, 31, 32, 33,
	34, 35, 41, 42, 43, 44, 46, 47, 71, 72, 73, 74, 75, 76, 80, 82, 83, 85, 97, 98,
	101, 102, 104, 105, 107, 108, 109, 110, 123, 129, 130, 131, 132, 133, 135, 136,
	137, 138, 139, 140, 141, 142, 143, 144, 145, 146, 147, 153, 154, 155, 156, 157,
	158, 159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 173, 174,
	175, 177, 180, 181, 182,
]);

const COLOR_DEVICE_TYPES = new Set<number>([
	6, 7, 8, 21, 22, 23, 30, 31, 32, 33, 34, 35, 41, 42, 43, 44, 46, 47, 71, 72,
	73, 74, 75, 76, 97, 98, 101, 102, 104, 105, 107, 108, 109, 110, 123, 131, 132,
	133, 137, 138, 139, 140, 141, 142, 143, 146, 147, 153, 154, 155, 156, 157, 158,
	159, 160, 161, 162, 163, 164, 165, 166, 167, 168, 169, 170, 171, 173, 174, 175,
	177, 180, 181, 182,
]);

const MUSIC_SHOW_DEVICE_TYPES = new Set<number>([
	71, 72, 73, 74, 75, 76, 110, 123, 141, 155, 157, 158, 159, 166, 167, 168,
]);

const SEGMENTED_DEVICE_TYPES = new Set<number>([
	71, 72, 73, 74, 75, 76, 141, 155, 157, 158, 159, 166, 167, 168,
]);

function resolveAccessoryType(deviceType: number): CyncApkAccessoryType | undefined {
	if (IGNORED_DEVICE_TYPES.has(deviceType)) {
		return 'ignored';
	}
	if (UNSUPPORTED_DEVICE_TYPES.has(deviceType)) {
		return 'unsupported';
	}
	if (FAN_DEVICE_TYPES.has(deviceType)) {
		return 'fan';
	}
	if (OUTLET_DEVICE_TYPES.has(deviceType)) {
		return 'outlet';
	}
	if (LIGHT_DEVICE_TYPES.has(deviceType)) {
		return 'light';
	}
	if (SWITCH_DEVICE_TYPES.has(deviceType)) {
		// HomeKit exposes dimmers through Lightbulb so brightness is available.
		return DIMMABLE_DEVICE_TYPES.has(deviceType) ? 'light' : 'switch';
	}
	return undefined;
}

export function getCyncApkDeviceProfile(
	deviceType: number | undefined,
): CyncApkDeviceProfile | undefined {
	if (deviceType === undefined) {
		return undefined;
	}

	const accessoryType = resolveAccessoryType(deviceType);
	if (!accessoryType) {
		return undefined;
	}

	return {
		accessoryType,
		supportsBrightness: DIMMABLE_DEVICE_TYPES.has(deviceType),
		supportsColor: COLOR_DEVICE_TYPES.has(deviceType),
		supportsCt: CT_DEVICE_TYPES.has(deviceType),
		supportsLightShows: COLOR_DEVICE_TYPES.has(deviceType),
		supportsMusicShows: MUSIC_SHOW_DEVICE_TYPES.has(deviceType),
		supportsSegmentedControl: SEGMENTED_DEVICE_TYPES.has(deviceType),
	};
}

export function supportsCyncLightShows(deviceType: number | undefined): boolean {
	return getCyncApkDeviceProfile(deviceType)?.supportsLightShows === true;
}

export function supportsCyncMusicShows(deviceType: number | undefined): boolean {
	return getCyncApkDeviceProfile(deviceType)?.supportsMusicShows === true;
}

export function supportsCyncSegmentedControl(deviceType: number | undefined): boolean {
	return getCyncApkDeviceProfile(deviceType)?.supportsSegmentedControl === true;
}
