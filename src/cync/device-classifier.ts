// src/cync/device-classifier.ts
// Cync Device Classifier: Centralizes accessory type selection and classification logging context
import { getCyncApkDeviceProfile } from './device-capabilities.js';

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
	const apkProfile = getCyncApkDeviceProfile(deviceType);

	if (apkProfile) {
		return {
			accessoryType: apkProfile.accessoryType,
			deviceType,
			capabilities,
			reason: `Cync APK deviceType: ${deviceType}`,
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
