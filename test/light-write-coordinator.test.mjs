import assert from 'node:assert/strict';
import test from 'node:test';
import { LightWriteCoordinator } from '../dist/cync/light-write-coordinator.js';

function harness() {
	const batches = [];
	const coordinator = new LightWriteCoordinator(1, async (writes) => {
		batches.push(writes);
	});
	return { batches, coordinator };
}

test('coalesces a HomeKit color burst into one color intent', async () => {
	const { batches, coordinator } = harness();
	await Promise.all([
		coordinator.queueHue(275),
		coordinator.queueBrightness(42),
		coordinator.queueSaturation(80),
		coordinator.queueOn(true),
	]);

	assert.deepEqual(batches, [{
		on: true,
		brightness: 42,
		hue: 275,
		saturation: 80,
		mode: 'color',
		brightnessTouched: true,
	}]);
});

test('keeps CT mode when HomeKit follows CT with companion hue and saturation zero', async () => {
	const { batches, coordinator } = harness();
	await Promise.all([
		coordinator.queueColorTemperature(370),
		coordinator.queueHue(0),
		coordinator.queueSaturation(0),
	]);

	assert.equal(batches.length, 1);
	assert.equal(batches[0].mode, 'ct');
	assert.equal(batches[0].colorTemperature, 370);
});

test('keeps color mode when HomeKit follows color with a companion CT update', async () => {
	const { batches, coordinator } = harness();
	await Promise.all([
		coordinator.queueHue(120),
		coordinator.queueSaturation(75),
		coordinator.queueColorTemperature(250),
	]);

	assert.equal(batches.length, 1);
	assert.equal(batches[0].mode, 'color');
});

test('a nonzero saturation after CT explicitly selects color mode', async () => {
	const { batches, coordinator } = harness();
	await Promise.all([
		coordinator.queueColorTemperature(300),
		coordinator.queueHue(210),
		coordinator.queueSaturation(60),
	]);

	assert.equal(batches.length, 1);
	assert.equal(batches[0].mode, 'color');
});
