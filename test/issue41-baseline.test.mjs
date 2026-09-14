import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { TcpClient } from '../dist/cync/tcp-client.js';
import { configureCyncLightAccessory } from '../dist/cync/cync-light-accessory.js';
class ServiceDouble {
	characteristics = new Map();
	getCharacteristic(key) {
		if (!this.characteristics.has(key)) {
			this.characteristics.set(key, {
				onGet(fn) {
					this.get = fn; return this;
				},
				onSet(fn) {
					this.set = fn; return this;
				},
				setProps() {
					return this;
				},
			});
		}
		return this.characteristics.get(key);
	}
	updateCharacteristic() {
		return this;
	}
	testCharacteristic(key) {
		return this.characteristics.has(key);
	}
	removeCharacteristic() {}
}

const log = { debug() {}, info() {}, warn() {}, error() {} };
function light(options = {}) {
	const service = new ServiceDouble();
	const id = options.id ?? '53';
	const context = { cync: { meshId: 'home', deviceId: id, on: false, brightness: 0,
		lastNonZeroBrightness: 100, ...options.state } };
	const sent = [];
	const tcpClient = options.client ?? { setSwitchState: async () => {},
		setColorTemperature: async (_, args) => sent.push(args), setBrightness: async () => {} };
	const Characteristic = Object.fromEntries(['On','Brightness','Hue','Saturation','ColorTemperature'].map(k => [k,k]));
	const api = { hap: { Characteristic, Service: { Lightbulb: 'light' }, Categories: { LIGHTBULB: 5 },
		HapStatusError: Error, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 } } };
	configureCyncLightAccessory({ api, log, tcpClient, markDeviceSeen() {}, startPollingDevice() {}, registerAccessoryForDevice() {},
		isDeviceProbablyOffline: () => false },
	{ id: 'home' }, { device_id: id, mesh_id: Number(id), raw: { deviceType: 42 } },
	{ context, getService: key => key === 'light' ? service : undefined }, 'test light', id);
	return { sent, set: (key,value) => service.getCharacteristic(key).set(value) };
}
test('ON followed immediately by CT restores nonzero brightness from the OFF cache', async () => {
	const h = light();
	await Promise.all([h.set('On',true),h.set('ColorTemperature',300)]);
	assert.equal(h.sent[0].brightnessPct,100);
});
test('explicit zero brightness after ON remains zero for companion CT', async () => {
	const h = light();
	await h.set('On',true); await h.set('Brightness',0); await h.set('ColorTemperature',300);
	assert.equal(h.sent[0].brightnessPct,0);
});
test('five-record escaped mesh length decodes sparse IDs and literal 0x7d', () => {
	const client = new TcpClient(log); const updates = [];
	client.socket = { destroyed: false, write() {} };
	client.switchIdToHomeId = new Map([[123,'home']]);client.homeDevices = { home: [] };
	const ids = [137,53,224,157,54];
	for (const id of ids) {
		client.homeDevices.home[id] = String(id);
	}
	client.onLanDeviceUpdate(update => updates.push(update));
	const body = Buffer.alloc(144);
	Buffer.from('0000007b7d5e007e00000000f9527e00050000000500','hex').copy(body);
	ids.forEach((id,i) => {
		const n=22+i*24;body[n]=id;body[n+8]=1;body[n+12]=42;body[n+16]=254;body[n+20]=126;body[n+21]=125;
	});
	body[143]=126;
	const bytes=[...body.subarray(0,8)];
	for (const byte of body.subarray(8,-1)) {
		bytes.push(...(byte===126?[125,94]:[byte]));
	}
	client.handleIncomingFrame(Buffer.from([...bytes,126]),0x73);
	assert.deepEqual(updates.map(u=>u.deviceId),ids.map(String));
	assert.deepEqual(updates[0].rgb,{ r:126,g:125,b:0 });
});

test('baseline releases sends after 300ms while confirmation remains pending', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const client = new TcpClient(log);
	const sent = [];
	client.socket = { destroyed: false, write: packet => sent.push(packet) };
	client.scheduleMeshStateRefresh = () => {};
	client.switchIdToHomeId = new Map([[123, 'home']]);
	const send = id => client.sendWithControllerRetry(id, { switch_controller: 123, mesh_id: Number(id) }, true,
		() => Buffer.from([Number(id)]), 'power');
	let done = false;
	const first = send('1').then(() => {
		done = true;
	});
	t.mock.timers.tick(299); await Promise.resolve();
	assert.equal(done, false);
	t.mock.timers.tick(1); await first;
	assert.equal(client.pendingPowerCommands.size, 1);
	const second = send('2');
	assert.equal(sent.length, 2);
	t.mock.timers.tick(300); await second;
	assert.equal(client.pendingPowerCommands.size, 2);
	client.resetCommandSessionState('test cleanup');
});

test('missing feedback is diagnostic only and does not retry or reject a completed send', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const warnings = [], diagnostics = [], sent = [];
	const client = new TcpClient({ ...log, warn: (...args) => warnings.push(args), debug: (...args) => diagnostics.push(args) });
	client.socket = { destroyed: false, write: packet => sent.push(packet) };
	client.scheduleMeshStateRefresh = () => {};
	client.switchIdToHomeId = new Map([[123, 'home']]);
	const result = client.sendWithControllerRetry('1', { switch_controller: 123, mesh_id: 1 }, true,
		() => Buffer.from([1]), 'combo CT');
	t.mock.timers.tick(300); await result;
	t.mock.timers.tick(9700);
	assert.equal(client.pendingPowerCommands.size, 0);
	assert.equal(sent.length, 1);
	assert.equal(warnings.length, 0);
	assert.ok(diagnostics.some(([message]) => message.includes('physical result unknown (not a command failure)')));
});

// September 14, 13:08:55: observed setter order; subsecond arrival times were not logged.
// Same input as the beta.7 baseline: previously 15 packets over 4200 ms.
test('Issue 41 scene replay: 15 setters consolidate into five ON commands', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const client = new TcpClient(log);
	const ids = { 1: 54, 2: 157, 3: 224, 4: 53, 5: 137 };
	const packets = [];
	let elapsed = 0;
	client.config = { meshes: [{ devices: Object.values(ids).map(id =>
		({ device_id: String(id), mesh_id: id, switch_controller: 123 })) }] };
	client.ensureConnected = async () => true;
	client.scheduleMeshStateRefresh = () => {};
	client.switchIdToHomeId = new Map([[123, 'home']]);
	client.socket = { destroyed: false, write(packet) {
		packets.push({ ms: elapsed, mesh: packet.readUInt16LE(26), on: packet[31] === 1,
			brightness: packet[4] === 34 ? packet[32] : undefined });
	} };
	t.after(() => client.resetCommandSessionState('replay cleanup'));
	const lights = Object.fromEntries(Object.entries(ids).map(([number, id]) =>
		[number, light({ id: String(id), client, state: { colorTemperature: 178 } })]));
	const sequence = [
		[2, 'On', true], [2, 'Brightness', 100], [5, 'ColorTemperature', 178],
		[2, 'ColorTemperature', 178], [4, 'Brightness', 100], [5, 'On', true],
		[4, 'ColorTemperature', 178], [3, 'ColorTemperature', 178], [5, 'Brightness', 100],
		[3, 'Brightness', 100], [3, 'On', true], [4, 'On', true],
		[1, 'ColorTemperature', 178], [1, 'Brightness', 100], [1, 'On', true],
	];
	const pending = sequence.map(([number, key, value]) => lights[number].set(key, value));
	// Drain asynchronous setter/queue continuations between simulated timer ticks.
	const flush = async () => {
		for (let i = 0; i < 50; i++) {
			await Promise.resolve();
		}
	};
	await flush();
	elapsed = 50;
	t.mock.timers.tick(50);
	await flush();
	for (let i = 0; i < 5; i++) {
		elapsed += 300;
		t.mock.timers.tick(300);
		await flush();
	}
	await Promise.all(pending);
	assert.equal(packets.length, 5);
	assert.deepEqual(packets.map(p => p.mesh), [157,137,53,224,54]);
	assert.deepEqual(packets.map(p => p.ms), [50,350,650,950,1250]);
	assert.ok(packets.every(p => p.on && p.brightness === 100));
	t.diagnostic('5 packets over 1200 simulated ms; Light 1 ON at 1250 ms including batching; no intermediate OFF packets.');
});

async function flushMicrotasks() {
	for (let i = 0; i < 50; i++) {
		await Promise.resolve();
	}
}
for (const sequence of [
	[['On', true], ['Brightness', 0], ['ColorTemperature', 178]],
	[['Brightness', 100], ['On', false], ['ColorTemperature', 178]],
]) {
	test(`consolidation preserves explicit OFF/zero: ${JSON.stringify(sequence)}`, async t => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const h = light();
		const pending = sequence.map(([key, value]) => h.set(key, value));
		t.mock.timers.tick(50);
		await Promise.all(pending);
		assert.equal(h.sent.length, 1);
		assert.equal(h.sent[0].brightnessPct, 0);
	});
}
test('a new batch remains independent while the first send is pending and rejects', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const calls = [];
	let rejectFirst;
	const client = { setColorTemperature: (_, args) => {
		calls.push(args);
		return calls.length === 1 ? new Promise((_, reject) => {
			rejectFirst = reject;
		}) : Promise.resolve();
	} };
	const h = light({ client });
	const first = Promise.allSettled([h.set('ColorTemperature', 178), h.set('Brightness', 100)]);
	t.mock.timers.tick(50);
	await flushMicrotasks();
	const second = h.set('ColorTemperature', 300);
	t.mock.timers.tick(50);
	await second;
	rejectFirst(new Error('test transport failure'));
	assert.ok((await first).every(result => result.status === 'rejected'));
	assert.deepEqual(calls.map(call => call.mired), [178,300]);
	const third = h.set('ColorTemperature', 400);
	t.mock.timers.tick(50);
	await third;
	assert.deepEqual(calls.map(call => call.mired), [178,300,400]);
});

test('staggered RGB updates combine within a fixed window, with latest color mode winning', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const calls = [];
	const client = { setColor: async (_, rgb, brightness) => calls.push({ rgb, brightness }),
		setColorTemperature: async () => assert.fail('superseded CT must not be sent') };
	const h = light({ client });
	const pending = [h.set('ColorTemperature', 178), h.set('Brightness', 100)];
	t.mock.timers.tick(20);
	pending.push(h.set('Hue', 120));
	t.mock.timers.tick(20);
	pending.push(h.set('Saturation', 100));
	t.mock.timers.tick(9);
	assert.equal(calls.length, 0);
	t.mock.timers.tick(1);
	await Promise.all(pending);
	assert.deepEqual(calls, [{ rgb: { r: 0, g: 255, b: 0 }, brightness: 100 }]);
});
test('standalone power retains the power packet path', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const calls = [];
	const h = light({ client: { setSwitchState: async (_, args) => calls.push(args) } });
	const on = h.set('On', true);
	t.mock.timers.tick(50);
	await on;
	const off = h.set('On', false);
	t.mock.timers.tick(50);
	await off;
	assert.deepEqual(calls, [{ on: true }, { on: false }]);
});
