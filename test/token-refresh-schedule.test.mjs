import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CyncClient } from '../dist/cync/cync-client.js';
import { CyncTokenStore, withTokenSchedule } from '../dist/cync/token-store.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const base = { userId: '123', accessToken: 'access', refreshToken: 'refresh' };
const now = 1_800_000_000_000;
const day = 86_400_000;

function harness(t, lifetime = 7 * day) {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
	let saved = withTokenSchedule({ ...base, expiresAt: now + lifetime });
	let calls = 0;
	const config = { restoreSession() {}, refreshAccessToken: async () => {
		calls++;
		return { accessToken: `access-${calls}`, expiresAt: Date.now() + lifetime };
	} };
	const client = new CyncClient(config, {}, {}, '/unused', log);
	client.tokenStore = {
		load: async () => saved && { ...saved },
		refresh: async (stored, exchange) => {
			saved = withTokenSchedule({ ...stored, ...await exchange(stored.refreshToken) });
			return saved;
		},
	};
	t.after(() => client.stopTokenRefresh());
	return { client, config, calls: () => calls, saved: () => saved, replace: value => {
		saved = value; 
	} };
}

test('refresh runs at 85% of lifetime and resets from each returned expiry', async t => {
	const h = harness(t);
	await h.client.ensureLoggedIn();
	t.mock.timers.tick(7 * day * 0.85 - 1);
	await setImmediate();
	assert.equal(h.calls(), 0);
	t.mock.timers.tick(1);
	await setImmediate();
	assert.equal(h.calls(), 1);
	assert.equal(h.saved().refreshAt, Date.now() + 7 * day * 0.85);
	// A subsequent response can specify a different lifetime.
	h.config.refreshAccessToken = async () => ({ accessToken: 'shorter', expiresAt: Date.now() + day });
	t.mock.timers.tick(7 * day * 0.85);
	await setImmediate();
	assert.equal(h.saved().refreshAt, Date.now() + day * 0.85);
});

test('restart immediately refreshes an overdue schedule even before access token expiry', async t => {
	const h = harness(t);
	t.mock.timers.tick(6 * day);
	assert.equal(await h.client.ensureLoggedIn(), true);
	assert.equal(h.calls(), 1);
});

test('temporary scheduled failures back off, preserve credentials, and recover', async t => {
	const h = harness(t);
	const original = h.config.refreshAccessToken;
	let attempts = 0;
	h.config.refreshAccessToken = async () => {
		attempts++;
		if (attempts < 3) {
			throw new TypeError('fetch failed');
		}
		return original();
	};
	await h.client.ensureLoggedIn();
	t.mock.timers.tick(7 * day * 0.85);
	await setImmediate();
	assert.equal(attempts, 1);
	assert.equal(h.saved().accessToken, base.accessToken);
	t.mock.timers.tick(29_999);
	await setImmediate();
	assert.equal(attempts, 1);
	t.mock.timers.tick(1);
	await setImmediate();
	assert.equal(attempts, 2);
	t.mock.timers.tick(60_000);
	await setImmediate();
	assert.equal(attempts, 3);
	assert.equal(h.client.refreshRetryMs, 30_000);
	assert.ok(h.saved().refreshAt > Date.now());
});

test('timer adopts a newer UI session without refreshing early', async t => {
	const h = harness(t);
	await h.client.ensureLoggedIn();
	t.mock.timers.tick(day);
	h.replace(withTokenSchedule({ ...base, accessToken: 'ui-token', expiresAt: Date.now() + 7 * day }));
	t.mock.timers.tick(7 * day * 0.85 - day);
	await setImmediate();
	assert.equal(h.calls(), 0);
	assert.equal(h.client.tokenData.accessToken, 'ui-token');
	t.mock.timers.tick(day);
	await setImmediate();
	assert.equal(h.calls(), 1);
});

test('rejection stops scheduled retries and shutdown prevents in-flight completion from rearming', async t => {
	const h = harness(t);
	h.config.refreshAccessToken = async () => {
		throw { code: 4001010 }; 
	};
	await h.client.ensureLoggedIn();
	t.mock.timers.tick(7 * day * 0.85);
	await setImmediate();
	assert.equal(h.client.refreshTimer, null);
	assert.equal(h.client.tokenData, null);
	let finish;
	h.config.refreshAccessToken = () => new Promise(resolve => {
		finish = resolve; 
	});
	h.client.scheduleTokenRefresh(h.saved());
	t.mock.timers.tick(1);
	await setImmediate();
	h.client.stopTokenRefresh();
	finish({ accessToken: 'late', expiresAt: Date.now() + day });
	await setImmediate();
	assert.equal(h.client.refreshTimer, null);
});

test('long lifetimes do not overflow Node timers or cause premature refresh', async t => {
	const h = harness(t, 60 * day);
	await h.client.ensureLoggedIn();
	t.mock.timers.tick(2_147_483_647);
	await setImmediate();
	assert.equal(h.calls(), 0);
	assert.ok(h.client.refreshTimer);
});

test('missing lifetime disables proactive schedule rather than inventing an expiration', async t => {
	const h = harness(t);
	h.replace(withTokenSchedule(base));
	await h.client.ensureLoggedIn();
	assert.equal(h.client.refreshTimer, null);
});

test('saved schedules survive reload, while legacy files use stable file time', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'cync-schedule-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = new CyncTokenStore(directory);
	const token = withTokenSchedule({ ...base, expiresAt: now + 7 * day }, now);
	await store.save(token);
	assert.deepEqual(await new CyncTokenStore(directory).load(), token);
	await store.save({ ...base, expiresAt: now + 7 * day });
	const filename = join(directory, 'homebridge-cync-app', 'cync-tokens.json');
	await utimes(filename, new Date(now), new Date(now));
	assert.equal((await store.load()).refreshAt, now + 7 * day * 0.85);
	assert.equal((await new CyncTokenStore(directory).load()).refreshAt, now + 7 * day * 0.85);
});

test('scheduled storage read failures retry with backoff and recover without losing the session', async t => {
	const h = harness(t);
	await h.client.ensureLoggedIn();
	const load = h.client.tokenStore.load;
	let reads = 0;
	h.client.tokenStore.load = async () => {
		reads++;
		if (reads <= 2) {
			throw new Error('token file temporarily unreadable');
		}
		return load();
	};
	t.mock.timers.tick(7 * day * 0.85);
	await setImmediate();
	assert.equal(h.calls(), 0);
	assert.ok(h.client.refreshTimer);
	assert.equal(h.saved().accessToken, base.accessToken);
	t.mock.timers.tick(30_000);
	await setImmediate();
	assert.equal(reads, 2);
	t.mock.timers.tick(60_000);
	await setImmediate();
	assert.equal(h.calls(), 1);
	assert.equal(h.client.refreshRetryMs, 30_000);
	assert.ok(h.saved().refreshAt > Date.now());
});

test('a genuinely missing token file stops the scheduler without refreshing', async t => {
	const h = harness(t);
	await h.client.ensureLoggedIn();
	h.replace(null);
	t.mock.timers.tick(7 * day * 0.85);
	await setImmediate();
	assert.equal(h.calls(), 0);
	assert.equal(h.client.refreshTimer, null);
});
