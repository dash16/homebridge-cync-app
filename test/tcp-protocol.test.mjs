import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import test from 'node:test';
import { TcpClient } from '../dist/cync/tcp-client.js';

function harness() {
	const client = new TcpClient({ debug() {}, info() {}, warn() {}, error() {} });
	const sent = [], updates = [];
	client.socket = { destroyed: false, write: packet => sent.push(packet) };
	client.homeDevices = { home: ['', 'one', 'two'] };
	client.switchIdToHomeId = new Map([[123, 'home'], [456, 'home']]);
	client.lanDeviceUpdateListeners.push(update => updates.push(update));
	const receive = (type, body) => {
		const header = Buffer.alloc(5); header[0] = type; header.writeUInt32BE(body.length, 1);
		client.readBuffer = Buffer.concat([header, body]); client.processIncoming();
	};
	return { client, sent, updates, receive };
}

test('acknowledges unknown status payloads with original controller and sequence, without ACK loops', () => {
	const { client, sent, receive } = harness();
	const body = Buffer.from('0000007b012300', 'hex');
	receive(0x73, body);
	assert.equal(sent[0].toString('hex'), '73000000070000007b012300');
	assert.equal(client.seq, 0);
	receive(0x7b, body); receive(0x78, body); receive(0x83, body); receive(0x73, body.subarray(0, 4));
	assert.equal(sent.length, 1);
});

test('compact state processes every complete record and skips unknown devices', () => {
	const { receive, updates } = harness();
	const header = Buffer.from('0000007b010106', 'hex');
	const record = (id, on, level) => {
		const r = Buffer.alloc(19); r[3] = id; r[4] = on; r[5] = level; r[6] = 50; return r;
	};
	receive(0x43, Buffer.concat([header, record(1, 1, 42), record(99, 1, 80), record(2, 0, 65), Buffer.alloc(4)]));
	assert.deepEqual(updates.map(({ deviceId, on, brightnessPct }) => ({ deviceId, on, brightnessPct })), [
		{ deviceId: 'one', on: true, brightnessPct: 42 }, { deviceId: 'two', on: false, brightnessPct: 0 },
	]);
});

test('controller response prioritizes a reachable controller without marking its lights seen', () => {
	const { client, receive, updates } = harness();
	receive(0xab, Buffer.from('000001c8000100', 'hex'));
	assert.deepEqual(client.getControllerCandidates('one', 123), [456, 123]);
	assert.equal(updates.length, 0);
	client.resetCommandSessionState('test');
	assert.equal(client.controllerLastResponse.size, 0);
});

test('unmapped mesh replies cannot satisfy reconciliation; mapped replies update state', () => {
	const { client, receive, updates } = harness();
	let resolved = 0;
	client.resolveMeshStateResponse = () => {
		resolved++; 
	};
	const body = Buffer.alloc(72); body.writeUInt32BE(123); body[13] = 0x52;
	body[22] = 99; body[46] = 98;
	receive(0x73, body); assert.equal(resolved, 0);
	body[22] = 1; body[30] = 1; body[34] = 55;
	receive(0x73, body); assert.equal(resolved, 1); assert.equal(updates[0].brightnessPct, 55);
});
