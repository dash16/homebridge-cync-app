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
	assert.equal(sent[0].toString('hex'), '78000000070000007b012300');
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

// Reconstructed fixture: the logged prefix is preserved with an anonymized
// controller/sequence; the remaining records are synthetic, not a full capture.
function escapedFiveLightReply() {
	const body = Buffer.alloc(144);
	Buffer.from('0000007b7d5e007e00000000f9527e00050000000500', 'hex').copy(body);
	for (const [i, id] of [137, 53, 224, 157, 54].entries()) {
		const offset = 22 + i * 24;
		body[offset] = id;
		body[offset + 8] = 1;
		body[offset + 12] = 42;
		body[offset + 16] = 0xfe;
		body[offset + 20] = 0x7e;
		body[offset + 21] = 0x7d;
	}
	body[143] = 0x7e;
	const encoded = [...body.subarray(0, 8)];
	for (const byte of body.subarray(8, -1)) {
		encoded.push(...(byte === 0x7d || byte === 0x7e ? [0x7d, byte ^ 0x20] : [byte]));
	}
	return Buffer.from([...encoded, 0x7e]);
}

test('escaped five-light reply updates all sparse mesh IDs and preserves outer sequence', () => {
	const { client, receive, updates, sent } = harness();
	for (const id of [137, 53, 224, 157, 54]) {
		client.homeDevices.home[id] = `light-${id}`;
	}
	let resolved = 0;
	client.resolveMeshStateResponse = () => {
		resolved++;
	};
	const decode = client.decodeInnerStatusFrame.bind(client);
	client.decodeInnerStatusFrame = frame => frame;
	receive(0x73, escapedFiveLightReply());
	assert.equal(updates.length, 0, 'beta.0 fixed offsets miss the escaped records');
	assert.equal(resolved, 0);
	client.decodeInnerStatusFrame = decode;
	receive(0x73, escapedFiveLightReply());
	assert.equal(resolved, 1);
	assert.deepEqual(updates.map(update => update.deviceId), [137, 53, 224, 157, 54].map(id => `light-${id}`));
	assert.deepEqual(updates[0].rgb, { r: 126, g: 125, b: 0 });
	assert.equal(sent[0].toString('hex'), '78000000070000007b7d5e00');
});

test('truncated inner escape produces no light updates but still acknowledges transport', () => {
	const { receive, updates, sent } = harness();
	const frame = escapedFiveLightReply();
	receive(0x73, Buffer.concat([frame.subarray(0, -1), Buffer.from([0x7d, 0x7e])]));
	assert.equal(updates.length, 0);
	assert.equal(sent.length, 1);
});
