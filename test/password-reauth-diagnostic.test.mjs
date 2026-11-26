import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import { ConfigClient } from '../dist/cync/config-client.js';
import { CyncTokenStore } from '../dist/cync/token-store.js';
import { checkPasswordReauth } from '../tools/password-reauth/check.mjs';

const { Response } = globalThis;
const original = { userId: '123', accessToken: 'secret-old-access', refreshToken: 'secret-old-refresh',
	authorize: 'secret-old-authorize', lanLoginCode: 'secret-old-lan' };
const response = { user_id: 123, access_token: 'secret-new-access', refresh_token: 'secret-new-refresh',
	authorize: 'secret-new-authorize', expire_in: 604800 };
async function setup(t) {
	const root = await mkdtemp(join(tmpdir(), 'cync-password-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, 'config.json'), JSON.stringify({ platforms: [{ platform: 'CyncAppPlatform',
		username: 'private-email', password: 'secret-password', twoFactor: 'secret-stale-otp' }] }));
	const store = new CyncTokenStore(root);
	await store.save(original);
	const file = join(root, 'homebridge-cync-app', 'cync-tokens.json');
	const bytes = await readFile(file, 'utf8');
	const events = [];
	return { root, store, file, bytes, events, emit: event => events.push(event) };
}
function mockServer(t, body = response, status = 200, cloud = []) {
	const calls = [];
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		calls.push(url);
		assert.ok(options.signal);
		if (url.endsWith('/user_auth')) {
			const request = JSON.parse(options.body);
			assert.equal(request.password, 'secret-password');
			assert.equal(request.email, 'private-email');
			assert.deepEqual(Object.keys(request).sort(), ['corp_id', 'email', 'password', 'resource']);
			return new Response(typeof body === 'string' ? body : JSON.stringify(body),
				{ status, headers: { 'content-type': 'application/json' } });
		}
		assert.ok(url.endsWith('/user/123/subscribe/devices'));
		assert.equal(options.headers['Access-Token'], 'secret-new-access');
		if (cloud instanceof Error) {
			throw cloud;
		}
		return new Response(JSON.stringify(cloud));
	});
	return calls;
}

for (const [label, refreshToken] of [['new', 'secret-new-refresh'], ['same', original.refreshToken]]) {
	test(`password diagnostic verifies and saves complete ${label} session with rebuilt LAN auth`, async t => {
		const h = await setup(t);
		const calls = mockServer(t, { ...response, refresh_token: refreshToken });
		assert.equal(await checkPasswordReauth(h.root, h.emit), true);
		assert.equal(calls.length, 2);
		assert.equal(calls.filter(url => url.endsWith('/user_auth')).length, 1);
		const saved = await h.store.load();
		assert.equal(saved.refreshToken, refreshToken);
		assert.equal(saved.authorize, response.authorize);
		assert.equal(saved.lanLoginCode, Buffer.from(ConfigClient.buildLanLoginCode('123', response.authorize)).toString('base64'));
		assert.ok(saved.refreshAt > Date.now());
		assert.equal(saved.refreshRejected, undefined);
		assert.equal(h.events.at(-1).lifetimeResetProven, false);
		assert.doesNotMatch(JSON.stringify(h.events), /secret-|private-|"123"/);
	});
}

for (const [label, body, status, cloud] of [
	['2FA rejection', { error: { code: 4001379, msg: 'secret-2fa' } }, 400, []],
	['unknown rejection', { error: { code: 12345, msg: 'secret-rejection' } }, 401, []],
	['non JSON', 'secret-invalid-json', 200, []],
	['missing refresh', { ...response, refresh_token: undefined }, 200, []],
	['missing authorize', { ...response, authorize: undefined }, 200, []],
	['wrong account', { ...response, user_id: 456 }, 200, []],
	['missing expiry', { ...response, expire_in: undefined }, 200, []],
	['expired', { ...response, expires_at: 1 }, 200, []],
	['oversize LAN material', { ...response, authorize: 'x'.repeat(300) }, 200, []],
	['cloud failure', response, 200, new Error('secret-cloud-failure')],
	['malformed cloud', response, 200, { error: { msg: 'secret-body' } }],
]) {
	test(`${label} preserves original credential file without retry`, async t => {
		const h = await setup(t);
		const calls = mockServer(t, body, status, cloud);
		assert.equal(await checkPasswordReauth(h.root, h.emit), false);
		assert.equal(calls.filter(url => url.endsWith('/user_auth')).length, 1);
		assert.ok(calls.length <= 2);
		assert.equal(await readFile(h.file, 'utf8'), h.bytes);
		assert.equal(h.events.at(-1).sessionSaved, false);
		if (status === 400) {
			assert.equal(h.events.at(-1).code, 4001379);
		}
		assert.doesNotMatch(JSON.stringify(h.events), /secret-|private-|"123"/);
	});
}

test('concurrent session change prevents login and overwrite', async t => {
	const h = await setup(t);
	const other = { ...original, accessToken: 'secret-other' };
	await h.store.save(other);
	let called = false;
	assert.equal(await h.store.replaceVerifiedSession(original, async () => {
		called = true;
		return original;
	}), null);
	assert.equal(called, false);
	assert.deepEqual(await h.store.load(), other);
});

test('sign-out coordinates with verification and cannot be undone by late save', async t => {
	const h = await setup(t);
	let release;
	let entered;
	const started = new Promise(resolve => {
		entered = resolve; 
	});
	const pending = h.store.replaceVerifiedSession(original, async () => {
		entered();
		await new Promise(resolve => {
			release = resolve; 
		});
		return { ...original, accessToken: 'secret-new' };
	});
	await started;
	const signout = new CyncTokenStore(h.root).clear();
	release();
	await Promise.all([pending, signout]);
	assert.equal(await h.store.load(), null);
});

test('password client error logging and thrown errors do not include raw sensitive data', async t => {
	mockServer(t, { error: { code: 4001379, msg: 'secret-raw' }, 'private-key': 'secret-value' }, 400);
	const log = [];
	const capture = (...args) => log.push(args);
	const client = new ConfigClient({ debug: capture, info: capture, warn: capture, error: capture });
	await assert.rejects(client.loginWithPassword('private-email', 'secret-password'), error => {
		assert.equal(error.code, 4001379);
		assert.doesNotMatch(error.message + JSON.stringify(error), /secret-|private-/);
		return true;
	});
	assert.doesNotMatch(JSON.stringify(log), /secret-|private-/);
});

test('atomic replacement failure leaves existing credentials intact', async t => {
	const h = await setup(t);
	mockServer(t);
	t.mock.method(fs, 'rename', async () => {
		throw new Error('secret-disk-failure');
	});
	assert.equal(await checkPasswordReauth(h.root, h.emit), false);
	assert.equal(await readFile(h.file, 'utf8'), h.bytes);
	assert.equal(h.events.at(-1).phase, 'persist');
	assert.equal(h.events.at(-1).sessionSaved, 'unconfirmed');
	assert.doesNotMatch(JSON.stringify(h.events), /secret-|private-/);
});

test('full authentication timestamp survives later access-token refresh', async t => {
	const h = await setup(t);
	mockServer(t);
	assert.equal(await checkPasswordReauth(h.root, h.emit), true);
	const saved = await h.store.load();
	assert.ok(Number.isFinite(saved.authenticatedAt));
	await h.store.refresh(saved, async () => ({ accessToken: 'secret-refreshed', expiresAt: Date.now() + 604800000 }));
	assert.equal((await h.store.load()).authenticatedAt, saved.authenticatedAt);
});

test('ambiguous configuration makes no authentication request', async t => {
	const h = await setup(t);
	await writeFile(join(h.root, 'config.json'), JSON.stringify({ platforms: [
		{ platform: 'CyncAppPlatform', username: 'private-a', password: 'secret-a' },
		{ platform: 'CyncAppPlatform', username: 'private-b', password: 'secret-b' },
	] }));
	const calls = mockServer(t);
	assert.equal(await checkPasswordReauth(h.root, h.emit), false);
	assert.equal(calls.length, 0);
	assert.equal(await readFile(h.file, 'utf8'), h.bytes);
});
