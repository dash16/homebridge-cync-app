export type LightAppearanceMode = 'color' | 'ct';

export interface PendingLightWrites {
	on?: boolean;
	brightness?: number;
	hue?: number;
	saturation?: number;
	colorTemperature?: number;
	mode?: LightAppearanceMode;
	brightnessTouched: boolean;
}

type Waiter = {
	resolve: () => void;
	reject: (reason?: unknown) => void;
};

function emptyWrites(): PendingLightWrites {
	return { brightnessTouched: false };
}

/**
 * Collect the cluster of characteristic writes HomeKit emits for one user action.
 * The coordinator owns timing only; the accessory owns device state and packet choice.
 */
export class LightWriteCoordinator {
	private pending = emptyWrites();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private waiters: Waiter[] = [];

	constructor(
		private readonly flushDelayMs: number,
		private readonly flush: (writes: PendingLightWrites) => Promise<void>,
	) {}

	public queueOn(on: boolean): Promise<void> {
		this.pending.on = on;
		return this.schedule();
	}

	public queueBrightness(brightness: number): Promise<void> {
		this.pending.brightness = brightness;
		this.pending.brightnessTouched = true;
		return this.schedule();
	}

	public queueHue(hue: number): Promise<void> {
		this.pending.hue = hue;
		// CT changes are accompanied by Hue=0/Saturation=0 writes. Once CT owns
		// this burst, a Hue write alone must not turn it back into an RGB command.
		if (this.pending.mode !== 'ct') {
			this.pending.mode = 'color';
		}
		return this.schedule();
	}

	public queueSaturation(saturation: number): Promise<void> {
		this.pending.saturation = saturation;
		if (this.pending.mode !== 'ct' || saturation > 0) {
			this.pending.mode = 'color';
		}
		return this.schedule();
	}

	public queueColorTemperature(colorTemperature: number): Promise<void> {
		this.pending.colorTemperature = colorTemperature;
		// Conversely, HomeKit may update CT as a companion to an RGB selection.
		if (this.pending.mode !== 'color') {
			this.pending.mode = 'ct';
		}
		return this.schedule();
	}

	private schedule(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
		}

		return new Promise<void>((resolve, reject) => {
			this.waiters.push({ resolve, reject });
			this.timer = setTimeout(() => {
				this.timer = undefined;
				const writes = this.pending;
				const waiters = this.waiters;
				this.pending = emptyWrites();
				this.waiters = [];

				void this.flush(writes).then(
					() => waiters.forEach((waiter) => waiter.resolve()),
					(err: unknown) => waiters.forEach((waiter) => waiter.reject(err)),
				);
			}, this.flushDelayMs);
		});
	}
}
