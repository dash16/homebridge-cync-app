//src/cync/light-shows.ts

export type CyncLightShow = {
	index: number;
	name: string;
	effect?: number;
	icon?: number;
	colors?: string[];
	speed?: number[];
	fadeSpeed?: number[];
	brightness?: number[];
	colorOrder?: string;
	crc?: number;
};

export function parseLightShows(
	value: unknown,
	crcMap: unknown,
): CyncLightShow[] {
	const crcRecord =
		crcMap && typeof crcMap === 'object'
			? crcMap as Record<string, unknown>
			: {};

	const showsByIndex = new Map<number, CyncLightShow>();

	if (Array.isArray(value)) {
		for (const entry of value) {
			if (!entry || typeof entry !== 'object') {
				continue;
			}

			const record = entry as Record<string, unknown>;
			const index = Number(record.index);

			if (!Number.isFinite(index)) {
				continue;
			}

			const crc = Number(crcRecord[String(index)]);

			showsByIndex.set(index, {
				index,
				name: typeof record.name === 'string' ? record.name : `Light Show ${index}`,
				effect: typeof record.effect === 'number' ? record.effect : undefined,
				icon: typeof record.icon === 'number' ? record.icon : undefined,
				colors: Array.isArray(record.colors) ? record.colors.filter((c): c is string => typeof c === 'string') : undefined,
				speed: Array.isArray(record.speed) ? record.speed.filter((n): n is number => typeof n === 'number') : undefined,
				fadeSpeed: Array.isArray(record.fadeSpeed) ? record.fadeSpeed.filter((n): n is number => typeof n === 'number') : undefined,
				brightness: Array.isArray(record.brightness) ? record.brightness.filter((n): n is number => typeof n === 'number') : undefined,
				colorOrder: typeof record.colorOrder === 'string' ? record.colorOrder : undefined,
				crc: Number.isFinite(crc) ? crc : undefined,
			});
		}
	}

	for (const [key, value] of Object.entries(crcRecord)) {
		const index = Number(key);
		const crc = Number(value);

		if (!Number.isFinite(index) || showsByIndex.has(index)) {
			continue;
		}

		showsByIndex.set(index, {
			index,
			name: `Light Show ${index}`,
			crc: Number.isFinite(crc) ? crc : undefined,
		});
	}

	return [...showsByIndex.values()]
		.sort((a, b) => a.index - b.index);
}
