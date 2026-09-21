import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CyncTokenStore } from '../dist/cync/token-store.js';
import { CyncClient } from '../dist/cync/cync-client.js';
import { CyncAppPlatform } from '../dist/platform.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const token = { userId: '123', accessToken: 'old', refreshToken: 'refresh-old', expiresAt: 1 };
async function storage(t) {
	const directory = await mkdtemp(join(tmpdir(), 'cync-auth-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = new CyncTokenStore(directory);
	await store.save(token);
	return { directory, store };
}

test('UI and runtime share rotated credentials even with stale in-memory tokens', async t => {
	const { directory, store } = await storage(t);
	const other = new CyncTokenStore(directory);
	let calls = 0;
	const exchange = async value => {
		assert.equal(value, token.refreshToken);
		calls++;
		return { accessToken: 'new', refreshToken: 'refresh-new', expiresAt: Date.now() + 100_000 };
	};
	const results = await Promise.all([store.refresh(token, exchange), other.refresh(token, exchange)]);
	assert.equal(calls, 1);
	assert.deepEqual(results[0], results[1]);
	await other.refresh(token, exchange);
	assert.equal(calls, 1);
	assert.deepEqual(await store.load(), results[0]);
});

test('temporary startup refresh failure preserves credentials and permits recovery', async t => {
	const { directory, store } = await storage(t);
	let fail = true;
	const config = {
		refreshAccessToken: async () => {
			if (fail) {
				throw new TypeError('fetch failed');
			}
			return { accessToken: 'new', expiresAt: Date.now() + 100_000 };
		},
		restoreSession() {},
	};
	const client = new CyncClient(config, {}, { username: 'test', password: 'test' }, directory, log);
	assert.equal(await client.ensureLoggedIn(), false);
	assert.equal(client.loginRetryNeeded, true);
	assert.equal((await store.load()).accessToken, token.accessToken);
	assert.equal((await store.load()).refreshToken, token.refreshToken);
	fail = false;
	assert.equal(await client.ensureLoggedIn(), true);
	assert.equal(client.loginRetryNeeded, false);
	assert.equal((await store.load()).accessToken, 'new');
});

test('rejected refresh requests fresh 2FA without reusing configured OTP or scheduling retry', async t => {
	const { directory, store } = await storage(t);
	let otpRequests = 0;
	const client = new CyncClient({
		refreshAccessToken: async () => {
			throw { code: 4001010, status: 400, msg: 'refresh token error' }; 
		},
		sendTwoFactorCode: async () => {
			otpRequests++; 
		},
	}, {}, { username: 'test', password: 'test', twoFactor: 'stale' }, directory, log);
	assert.equal(await client.ensureLoggedIn(), false);
	assert.equal(otpRequests, 1);
	assert.equal(client.loginRetryNeeded, false);
	assert.equal(await store.load(), null);
});

function platform() {
	const events = new Map();
	const api = { hap: { Service: { AccessoryInformation: { UUID: 'info' } },
		Perms: { PAIRED_WRITE: 'pw' }, HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
		HapStatusError: class extends Error {} },
	user: { storagePath: () => '/unused' }, on: (event, fn) => events.set(event, fn) };
	return { instance: new CyncAppPlatform(log, { username: 'test', password: 'test' }, api), events };
}

test('cached accessories reject reads and writes before cloud initialization', () => {
	const { instance } = platform();
	const characteristic = { props: { perms: ['pr', 'pw'] }, value: true,
		onGet(fn) {
			this.get = fn; return this; 
		}, onSet(fn) {
			this.set = fn; return this; 
		},
		updateValue(error) {
			this.error = error; 
		} };
	instance.configureAccessory({ displayName: 'cached light', services: [{ UUID: 'light', characteristics: [characteristic] }] });
	assert.throws(() => characteristic.get(), /-70402/);
	assert.throws(() => characteristic.set(false), /-70402/);
	assert.match(characteristic.error.message, /-70402/);
});

test('temporary initialization failure retries and shutdown cancels pending retry', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const { instance, events } = platform();
	let attempts = 0;
	instance.client.ensureLoggedIn = async () => {
		attempts++;
		instance.client.loginRetryNeeded = true;
		return false;
	};
	await instance.loadCync();
	assert.equal(attempts, 1);
	t.mock.timers.tick(30_000);
	await Promise.resolve();
	assert.equal(attempts, 2);
	events.get('shutdown')();
	t.mock.timers.tick(60_000);
	assert.equal(attempts, 2);
});

test('UI remembers rejection without retrying the rejected token or losing the reauth signal', async t => {
	const { store } = await storage(t);
	let calls = 0;
	const exchange = async () => {
		calls++;
		throw { code: 4001010 };
	};
	await assert.rejects(store.refresh(token, exchange, false), error => error.code === 4001010);
	assert.equal((await store.load()).refreshRejected, true);
	await assert.rejects(store.refresh(await store.load(), exchange, false), error => error.code === 4001010);
	assert.equal(calls, 1);
	await assert.rejects(store.refresh(await store.load(), exchange), error => error.code === 4001010);
	assert.equal(await store.load(), null);
});

test('cloud startup failure retries, while a rejected login does not loop OTP attempts', async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const { instance, events } = platform();
	instance.client.ensureLoggedIn = async () => true;
	instance.client.loadConfiguration = async () => {
		throw new TypeError('fetch failed'); 
	};
	await instance.loadCync();
	assert.ok(instance.startupRetryTimer);
	events.get('shutdown')();
	const second = platform().instance;
	second.client.ensureLoggedIn = async () => {
		throw { status: 400, msg: 'Invalid code' }; 
	};
	await second.loadCync();
	assert.equal(second.startupRetryTimer, null);
});
