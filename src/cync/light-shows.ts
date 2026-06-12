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
	if (!Array.isArray(value)) {
		return [];
	}

	const crcRecord =
		crcMap && typeof crcMap === 'object'
			? crcMap as Record<string, unknown>
			: {};

	return value
		.filter((entry): entry is Record<string, unknown> => {
			return !!entry && typeof entry === 'object';
		})
		.map((entry) => {
			const index = Number(entry.index);
			const crc = Number(crcRecord[String(index)]);

			return {
				index,
				name: typeof entry.name === 'string' ? entry.name : `Light Show ${index}`,
				effect: typeof entry.effect === 'number' ? entry.effect : undefined,
				icon: typeof entry.icon === 'number' ? entry.icon : undefined,
				colors: Array.isArray(entry.colors) ? entry.colors.filter((c): c is string => typeof c === 'string') : undefined,
				speed: Array.isArray(entry.speed) ? entry.speed.filter((n): n is number => typeof n === 'number') : undefined,
				fadeSpeed: Array.isArray(entry.fadeSpeed) ? entry.fadeSpeed.filter((n): n is number => typeof n === 'number') : undefined,
				brightness: Array.isArray(entry.brightness) ? entry.brightness.filter((n): n is number => typeof n === 'number') : undefined,
				colorOrder: typeof entry.colorOrder === 'string' ? entry.colorOrder : undefined,
				crc: Number.isFinite(crc) ? crc : undefined,
			};
		})
		.filter((show) => Number.isFinite(show.index));
}
