// src/cync/cync-accessory-helpers.ts
import type {
	API,
	Logger,
	PlatformAccessory,
} from 'homebridge';

import type { CyncDevice } from './config-client.js';
import type { TcpClient } from './tcp-client.js';
import { lookupDeviceModel } from './device-catalog.js';


// Narrowed view of the Cync device properties returned by getDeviceProperties()
type CyncDeviceRaw = {
  displayName?: string;
  firmwareVersion?: string;
  mac?: string;
  wifiMac?: string;
  deviceType?: number;
  deviceID?: number;
  [key: string]: unknown;
};

// CyncDevice as seen by the platform, possibly enriched with a `raw` block
type CyncDeviceWithRaw = CyncDevice & {
  raw?: CyncDeviceRaw;
};

export interface CyncCapabilityProfile {
	isLight: boolean;
	supportsBrightness: boolean;
	supportsColor: boolean;
	supportsCt: boolean;
	source: 'deviceType' | 'cloud' | 'lan';
}

// Context stored on the accessory
export interface CyncAccessoryContext {
  cync?: {
    meshId: string;
    deviceId: string;
    productId?: string;

    deviceType?: number;

    on?: boolean;
    brightness?: number; // 0–100 (LAN "level")

    hue?: number;          // 0–360
    saturation?: number;   // 0–100
    rgb?: { r: number; g: number; b: number };
    colorActive?: boolean; // true if we last set RGB color

    // Tunable-white state
	colorTemperature?: number; // mireds (e.g. ~153–500)
	// Capability-based detection & characteristic gating
	capabilities?: CyncCapabilityProfile;
  };
  [key: string]: unknown;
}

// Minimal runtime “env” that accessory modules need from the platform
export interface CyncAccessoryEnv {
  log: Logger;
  api: API;
  tcpClient: TcpClient;

  isDeviceProbablyOffline(deviceId: string): boolean;
  markDeviceSeen(deviceId: string): void;
  startPollingDevice(deviceId: string): void;
  registerAccessoryForDevice(deviceId: string, accessory: PlatformAccessory): void;

  registerLightShowAccessoryForDevice?: (
  	deviceId: string,
  	accessory: PlatformAccessory,
  	showIndex: number,
  ) => void;

  markActiveLightShowForDevice?: (
  	deviceId: string,
  	activeShowIndex: number | null,
  ) => void;

  registerMusicShowAccessoryForDevice?: (
  	deviceId: string,
  	accessory: PlatformAccessory,
  	showIndex: number,
  ) => void;

  markActiveMusicShowForDevice?: (
  	deviceId: string,
  	activeShowIndex: number | null,
  ) => void;

  clearActiveShowsForDevice?: (
  	deviceId: string,
  ) => void;

  setMainAccessoryOnForDevice?: (
  	deviceId: string,
  	on: boolean,
  ) => void;

}

/**
 * HSV (HomeKit style) → RGB helper used by color lights.
 */
export function hsvToRgb(hue: number, saturation: number, value: number): { r: number; g: number; b: number } {
	const h = ((hue % 360) + 360) % 360;
	const s = Math.max(0, Math.min(100, saturation)) / 100;
	const v = Math.max(0, Math.min(100, value)) / 100;

	if (s === 0) {
		const grey = Math.round(v * 255);
		return { r: grey, g: grey, b: grey };
	}

	const sector = h / 60;
	const i = Math.floor(sector);
	const f = sector - i;

	const p = v * (1 - s);
	const q = v * (1 - s * f);
	const t = v * (1 - s * (1 - f));

	let r = 0;
	let g = 0;
	let b = 0;

	switch (i) {
	case 0:
		r = v;
		g = t;
		b = p;
		break;
	case 1:
		r = q;
		g = v;
		b = p;
		break;
	case 2:
		r = p;
		g = v;
		b = t;
		break;
	case 3:
		r = p;
		g = q;
		b = v;
		break;
	case 4:
		r = t;
		g = p;
		b = v;
		break;
	default:
		r = v;
		g = p;
		b = q;
		break;
	}

	return {
		r: Math.round(r * 255),
		g: Math.round(g * 255),
		b: Math.round(b * 255),
	};
}

function clampNumber(n: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, n));
}

/**
 * Color Temperature Converters: Convert HomeKit mired values to Kelvin
 */
export function miredToKelvin(mired: number): number {
	const m = clampNumber(Number(mired), 1, 1_000_000);
	return Math.round(1_000_000 / m);
}

/**
 * Color Temperature Converters: Convert Kelvin to HomeKit mired values
 */
export function kelvinToMired(kelvin: number): number {
	const k = clampNumber(Number(kelvin), 1, 1_000_000);
	return Math.round(1_000_000 / k);
}

/**
* RGB→HSV Converter: Enables HomeKit Hue/Saturation updates from LAN RGB frames
*/
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
	const rn = clampNumber(r, 0, 255) / 255;
	const gn = clampNumber(g, 0, 255) / 255;
	const bn = clampNumber(b, 0, 255) / 255;

	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const delta = max - min;

	let h = 0;
	if (delta !== 0) {
		if (max === rn) {
			h = ((gn - bn) / delta) % 6;
		} else if (max === gn) {
			h = (bn - rn) / delta + 2;
		} else {
			h = (rn - gn) / delta + 4;
		}
		h *= 60;
		if (h < 0) {
			h += 360;
		}
	}

	const s = max === 0 ? 0 : (delta / max) * 100;
	const v = max * 100;

	return {
		h: clampNumber(h, 0, 360),
		s: clampNumber(s, 0, 100),
		v: clampNumber(v, 0, 100),
	};
}

/**
 * Resolve the numeric device type from cloud + raw device shape.
 */
export function resolveDeviceType(device: CyncDevice): number | undefined {
	const typedDevice = device as unknown as {
    device_type?: number;
    raw?: { deviceType?: number | string };
  };

	if (typeof typedDevice.device_type === 'number') {
		return typedDevice.device_type;
	}

	const rawType = typedDevice.raw?.deviceType;
	if (typeof rawType === 'number') {
		return rawType;
	}

	if (typeof rawType === 'string' && rawType.trim() !== '') {
		const parsed = Number(rawType.trim());
		if (!Number.isNaN(parsed)) {
			return parsed;
		}
	}

	return undefined;
}

/**
 * Populate the standard Accessory Information service with Cync metadata.
 */
export function applyAccessoryInformationFromCyncDevice(
	api: API,
	accessory: PlatformAccessory,
	device: CyncDevice,
	deviceName: string,
	deviceId: string,
): void {
	const infoService = accessory.getService(api.hap.Service.AccessoryInformation);
	if (!infoService) {
		return;
	}

	const Characteristic = api.hap.Characteristic;
	const deviceWithRaw = device as CyncDeviceWithRaw;
	const rawDevice = deviceWithRaw.raw ?? {};

	// Name: keep in sync with how we present the accessory
	const name = deviceName || accessory.displayName;
	infoService.updateCharacteristic(Characteristic.Name, name);

	// Manufacturer: fixed for all Cync devices
	infoService.updateCharacteristic(Characteristic.Manufacturer, 'GE Lighting');

	// Model: prefer catalog entry (Cync app-style model name), fall back to raw info
	const resolvedType = resolveDeviceType(device);
	const catalogEntry = typeof resolvedType === 'number'
		? lookupDeviceModel(resolvedType)
		: undefined;

	let model: string;

	if (catalogEntry) {
		// Use the Cync app-style model name
		model = catalogEntry.modelName;

		// Persist for debugging / future use
		const ctx = accessory.context as Record<string, unknown>;
		ctx.deviceType = resolvedType;
		ctx.modelName = catalogEntry.modelName;
		if (catalogEntry.marketingName) {
			ctx.marketingName = catalogEntry.marketingName;
		}
	} else {
		// Fallback: use device displayName + type
		const modelBase =
      typeof rawDevice.displayName === 'string' && rawDevice.displayName.trim().length > 0
      	? rawDevice.displayName.trim()
      	: 'Cync Device';

		const modelSuffix =
      typeof resolvedType === 'number'
      	? ` (Type ${resolvedType})`
      	: '';

		model = modelBase + modelSuffix;
	}

	infoService.updateCharacteristic(Characteristic.Model, model);

	// Serial: prefer wifiMac, then mac, then deviceID, then the string deviceId
	const serial =
    (typeof rawDevice.wifiMac === 'string' && rawDevice.wifiMac.trim().length > 0)
    	? rawDevice.wifiMac.trim()
    	: (typeof rawDevice.mac === 'string' && rawDevice.mac.trim().length > 0)
    		? rawDevice.mac.trim()
    		: (rawDevice.deviceID !== undefined
    			? String(rawDevice.deviceID)
    			: deviceId);

	infoService.updateCharacteristic(Characteristic.SerialNumber, serial);

	// Firmware / Software revision
	if (typeof rawDevice.firmwareVersion === 'string' && rawDevice.firmwareVersion.trim().length > 0) {
		const rev = rawDevice.firmwareVersion.trim();

		infoService.updateCharacteristic(Characteristic.FirmwareRevision, rev);
		infoService.updateCharacteristic(Characteristic.SoftwareRevision, rev);
	}
}
