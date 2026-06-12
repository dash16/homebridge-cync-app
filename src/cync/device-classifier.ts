// src/cync/device-classifier.ts
// Cync Device Classifier: Centralizes accessory type selection and classification logging context

type CyncAccessoryType = 'light' | 'fan' | 'outlet' | 'switch' | 'ignored' | 'unsupported';

export interface CyncDeviceLike {
	id?: string;
	name?: string;
	deviceType?: number;
	type?: number;
	capabilities?: string[] | Record<string, unknown>;
}

export interface CyncDeviceClassification {
	accessoryType: CyncAccessoryType;
	deviceType?: number;
	capabilities: string[];
	reason: string;
}

const CYNC_LIGHT_DEVICE_TYPES = new Set([
	1, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 17, 18, 19, 20, 21,
	22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
	37, 46, 47, 48, 49, 55, 56, 72, 76, 80, 82, 83, 85, 110, 123, 128, 129, 130,
	131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142,
	143, 144, 145, 146, 147, 148, 149, 150, 151, 152, 153, 154,
	155, 156, 158, 159, 160, 161, 162, 163, 164, 165, 166, 169,
	170, 171, 174,
]);

const CYNC_OUTLET_DEVICE_TYPES = new Set([
	64, 65, 66, 67, 68, 172,
]);

const CYNC_FAN_DEVICE_TYPES = new Set([
	81,
]);

const CYNC_SWITCH_DEVICE_TYPES = new Set([
	125,
]);

const CYNC_IGNORED_DEVICE_TYPES = new Set([
	115,
]);

function normalizeCapabilities(capabilities: CyncDeviceLike['capabilities']): string[] {
	if (!capabilities) {
		return [];
	}

	if (Array.isArray(capabilities)) {
		return capabilities
			.map(capability => capability.toLowerCase())
			.sort();
	}

	return Object.keys(capabilities)
		.map(capability => capability.toLowerCase())
		.sort();
}

function getDeviceType(device: CyncDeviceLike): number | undefined {
	return device.deviceType ?? device.type;
}

export function classifyCyncDevice(
	device: CyncDeviceLike,
	resolvedDeviceType?: number,
): CyncDeviceClassification {
	const deviceType = resolvedDeviceType ?? getDeviceType(device);
	const capabilities = normalizeCapabilities(device.capabilities);

	if (deviceType !== undefined && CYNC_IGNORED_DEVICE_TYPES.has(deviceType)) {
		return {
			accessoryType: 'ignored',
			deviceType,
			capabilities,
			reason: `ignored deviceType: ${deviceType}`,
		};
	}

	if (capabilities.includes('fan')) {
		return {
			accessoryType: 'fan',
			deviceType,
			capabilities,
			reason: 'capability: fan',
		};
	}

	if (
		capabilities.includes('color') ||
		capabilities.includes('colortemp') ||
		capabilities.includes('brightness')
	) {
		return {
			accessoryType: 'light',
			deviceType,
			capabilities,
			reason: 'capability: light control',
		};
	}

	if (deviceType !== undefined && CYNC_FAN_DEVICE_TYPES.has(deviceType)) {
		return {
			accessoryType: 'fan',
			deviceType,
			capabilities,
			reason: `deviceType: ${deviceType}`,
		};
	}

	if (deviceType !== undefined && CYNC_LIGHT_DEVICE_TYPES.has(deviceType)) {
		return {
			accessoryType: 'light',
			deviceType,
			capabilities,
			reason: `deviceType: ${deviceType}`,
		};
	}

	if (deviceType !== undefined && CYNC_OUTLET_DEVICE_TYPES.has(deviceType)) {
		return {
			accessoryType: 'outlet',
			deviceType,
			capabilities,
			reason: `deviceType: ${deviceType}`,
		};
	}

	if (deviceType !== undefined && CYNC_SWITCH_DEVICE_TYPES.has(deviceType)) {
		return {
			accessoryType: 'switch',
			deviceType,
			capabilities,
			reason: `deviceType: ${deviceType}`,
		};
	}

	if (capabilities.includes('onoff')) {
		return {
			accessoryType: 'switch',
			deviceType,
			capabilities,
			reason: 'capability: onoff fallback',
		};
	}

	return {
		accessoryType: 'unsupported',
		deviceType,
		capabilities,
		reason: 'no supported capabilities or known deviceType',
	};
}
