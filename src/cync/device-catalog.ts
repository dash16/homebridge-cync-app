// src/cync/device-catalog.ts

export interface CyncDeviceModel {
	deviceType: number;
	modelName: string;
	marketingName?: string;
	notes?: string;
}
/**
 * Device catalog keyed by deviceType.
 * Extend this as you discover more types.
 */
export const DEVICE_CATALOG: Record<number, CyncDeviceModel> = {
	10: {
		deviceType: 10,
		modelName: 'Tunable White Smart Bulb (A19)',
		marketingName: 'Direct Connect Smart Bulb',
	},
	30: {
		deviceType: 30,
		modelName: 'Full Color Smart Bulb (A19)',
		marketingName: 'Direct Connect Smart Bulb',
	},
	46: {
		deviceType: 46,
		modelName: '6" Recessed Can Retrofit Fixture (Matter)',
		marketingName: 'Cync reveal HD+',
	},
	48: {
		deviceType: 48,
		modelName: 'Cync Smart Dimmer Switch',
		marketingName: 'Cync Smart Dimmer',
	},
	64: {
		deviceType: 64,
		modelName: 'Indoor Smart Plug (CPLGSTDBLW1)',
		marketingName: 'On/Off Smart Plug (CPLGSTDBLW1)',
		notes: 'Legacy C by GE plug. FCC ID PUU-CPLGSTDBLW1. Original hardware revision. Final firmware 1.x.',
	},
	65: {
		deviceType: 65,
		modelName: 'Indoor Smart Plug (CPLGSTDBLW1-T)',
		marketingName: 'On/Off Smart Plug (CPLGSTDBLW1-T)',
		notes: 'Legacy C by GE plug. FCC ID PUU-CPLGSTDBLW1T / HVIN CPLGSTDBLW1T. Revised hardware ("T" revision). Final firmware 2.x.',
	},
	72: {
		deviceType: 72,
		modelName: 'Indoor 32ft Premium Light Strip',
		marketingName: 'Dynamic Effects Smart Light Strip (32ft)',
		notes: 'Full color light strip.',
	},
	110: {
		deviceType: 110,
		modelName: 'Direct Connect Strip - Thin Style (16ft)',
		marketingName: 'Direct Connect Smart Light Strip',
		notes: 'Full color light strip; cloud payload lacks color/level fields, so prefer LAN capability/state detection.',
	},
	123: {
		deviceType: 123,
		modelName: 'Direct Connect Strip - Thin Style (32ft)',
		marketingName: 'Direct Connect Smart Light Strip',
		notes: 'Full color light strip; cloud payload lacks color/level fields, so prefer LAN capability/state detection.',
	},
	128: {
		deviceType: 128,
		modelName: 'Soft White Direct Connect Smart Bulb',
		marketingName: 'GE Cync Soft White General Purpose A19 60W Replacement Smart LED Bulbs',
		notes: 'Reported by users as white + dimming bulbs',
	},
	131: {
		deviceType: 131,
		modelName: 'Full Color Direct Connect Smart Bulb (A19) (3in1)',
		marketingName: 'GE Cync A19 Direct Connect LED Light Bulb, Color Changing Clear Smart Light, Matter Compatible, Works with Alexa and Google Home',
		notes: 'Reported by users as full color + dimming bulbs',
	},
	137: {
		deviceType: 137,
		modelName: 'A19 Full Color Direct Connect Smart Bulb (3-in-1)',
		marketingName: 'GE Cync A19 Smart LED Light Bulb, Color Changing Smart WiFi Light',
		notes: 'Reported by users as full color + dimming bulbs',
	},
	142: {
		deviceType: 142,
		modelName: '4" Full Color Wafer Downlight',
		marketingName: 'CYNC Wafer Smart LED Downlight',
		notes: 'Reported by users as full color + dimming bulbs',
	},
	171: {
		deviceType: 171,
		modelName: 'A19 Full Color Direct Connect Smart Bulb (3-in-1)',
		marketingName: 'GE Cync A19 Smart LED Light Bulb, Color Changing Smart WiFi Light',
		notes: 'Reported alongside deviceType=137 in the same home; appears to be same class of bulb.',
	},
	172: {
		deviceType: 172,
		modelName: 'Indoor Smart Plug (3in1)',
		marketingName: 'Cync Indoor Smart Plug',
		notes: 'Matter-capable hardware. Replaces legacy C by GE On/Off Smart Plug.',
	},
};

export function lookupDeviceModel(deviceType: number): CyncDeviceModel | undefined {
	return DEVICE_CATALOG[deviceType];
}
