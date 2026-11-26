import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CyncTokenStore } from '../dist/cync/token-store.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import process from 'node:process';
import { ConfigClient } from '../dist/cync/config-client.js';
import { checkRefresh } from '../tools/token-refresh/check.mjs';

const { Response } = globalThis;

async function setup(t) {
	const directory = await mkdtemp(join(tmpdir(), 'cync-diagnostic-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = new CyncTokenStore(directory);
	await store.save({ userId: 'private-user', accessToken: 'secret-access-0', refreshToken: 'secret-refresh-0' });
	const events = [];
	return { directory, store, events, emit: event => events.push(event) };
}

test('diagnostic verifies two real exchanges using the persisted rotating token and new access token', async t => {
	const h = await setup(t);
	let exchanges = 0;
	let reads = 0;
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		if (url.endsWith('/token/refresh')) {
			assert.equal(JSON.parse(options.body).refresh_token, `secret-refresh-${exchanges}`);
			exchanges++;
			return new Response(JSON.stringify({ access_token: `secret-access-${exchanges}`,
				refresh_token: `secret-refresh-${exchanges}`, expire_in: 604800 }));
		}
		reads++;
		assert.equal(options.headers['Access-Token'], `secret-access-${exchanges}`);
		return new Response(JSON.stringify([{ id: 'private-mesh' }]));
	});
	assert.equal(await checkRefresh(h.directory, h.emit), true);
	assert.equal(exchanges, 2);
	assert.equal(reads, 2);
	assert.equal((await h.store.load()).refreshToken, 'secret-refresh-2');
	assert.equal(h.events.at(-1).event, 'passed');
	assert.ok(!h.events.some(row => row.event === 'response_inspected'));
	assert.doesNotMatch(JSON.stringify(h.events), /secret-|private-/);
});

test('diagnostic stops on rejection and only logs allowlisted error metadata', async t => {
	const h = await setup(t);
	let calls = 0;
	t.mock.method(globalThis, 'fetch', async () => {
		calls++;
		return new Response(JSON.stringify({ error: { code: 4001010, msg: 'secret-error' } }), { status: 400 });
	});
	assert.equal(await checkRefresh(h.directory, h.emit), false);
	assert.equal(calls, 1);
	assert.equal((await h.store.load()).refreshRejected, true);
	assert.equal(h.events.at(-1).code, 4001010);
	assert.doesNotMatch(JSON.stringify(h.events), /secret-/);
});

test('cloud verification failure does not undo saved rotated credentials', async t => {
	const h = await setup(t);
	t.mock.method(globalThis, 'fetch', async url => {
		if (url.endsWith('/token/refresh')) {
			return new Response(JSON.stringify({ access_token: 'secret-access-new', refresh_token: 'secret-refresh-new', expire_in: 604800 }));
		}
		throw new Error('secret-upstream-error');
	});
	assert.equal(await checkRefresh(h.directory, h.emit), false);
	assert.equal((await h.store.load()).refreshToken, 'secret-refresh-new');
	assert.equal(h.events.at(-1).phase, 'cloud');
	assert.doesNotMatch(JSON.stringify(h.events), /secret-/);
});

for (const [label, replacement, expected] of [
	['omitted', undefined, 'absent'], ['same', 'secret-refresh-0', 'same'], ['rotated', 'secret-refresh-1', 'different'],
]) {
	test(`inspection distinguishes ${label} refresh credentials and persists one exchange`, async t => {
		const h = await setup(t);
		let exchanges = 0;
		t.mock.method(globalThis, 'fetch', async url => {
			if (url.endsWith('/token/refresh')) {
				exchanges++;
				return new Response(JSON.stringify({ access_token: 'secret-new-access', refresh_token: replacement, expires_in: 604800 }),
					{ headers: { 'content-type': 'application/json; charset=utf-8' } });
			}
			return new Response('[]');
		});
		assert.equal(await checkRefresh(h.directory, h.emit, { count: 1, inspectResponse: true }), true);
		assert.equal(exchanges, 1);
		assert.equal((await h.store.load()).refreshToken, replacement ?? 'secret-refresh-0');
		const inspection = h.events.find(row => row.event === 'response_inspected');
		assert.equal(inspection.refreshCredential, expected);
		assert.equal(inspection.contentType, 'application/json');
		assert.equal(inspection.fields.find(field => field.path === '$.expires_in').numericValue, 604800);
		const parsed = h.events.find(row => row.event === 'response_parsed');
		assert.ok(parsed.consumed.includes('$.access_token'));
		assert.equal(parsed.consumed.includes('$.refresh_token'), replacement !== undefined);
		assert.equal(h.events.at(-1).refreshes, 1);
		assert.doesNotMatch(JSON.stringify(h.events), /secret-|private-/);
	});
}

test('inspection exposes ignored nested/alternate credentials and expiry structure without changing parsing', async t => {
	const h = await setup(t);
	t.mock.method(globalThis, 'fetch', async url => url.endsWith('/token/refresh')
		? new Response(JSON.stringify({ accessToken: 'secret-new-access', expiresIn: 604800,
			data: [{ refresh_token: 'secret-nested', refreshExpiresAt: 1800000000, renewalToken: 'secret-renewal',
				'unfamiliar-secret-token-key': 'secret-unknown', email: 'private-email', id: 987654321,
				'private-account-as-key': { ttl: 1234 } }],
		})) : new Response('[]'));
	assert.equal(await checkRefresh(h.directory, h.emit, { count: 1, inspectResponse: true }), true);
	assert.equal((await h.store.load()).refreshToken, 'secret-refresh-0');
	const inspection = h.events.find(row => row.event === 'response_inspected');
	const nested = inspection.fields.find(field => field.path === '$.data[0].refresh_token');
	assert.equal(nested.matchesRefresh, 'different');
	assert.equal(nested.parserRecognized, false);
	assert.equal(inspection.fields.find(field => field.path === '$.data[0].refreshExpiresAt').numericValue, 1800000000);
	const parsed = h.events.find(row => row.event === 'response_parsed');
	assert.ok(parsed.ignoredCredentialFields.includes('$.data[0].refresh_token'));
	assert.ok(parsed.ignoredCredentialFields.includes('$.data[0].renewalToken'));
	assert.doesNotMatch(JSON.stringify(h.events), /secret-|private-|987654321/);
});

test('nested-only credentials are reported as ignored and original credentials remain intact', async t => {
	const h = await setup(t);
	t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: {
		access_token: 'secret-nested-access', refresh_token: 'secret-nested-refresh',
	} })));
	assert.equal(await checkRefresh(h.directory, h.emit, { count: 1, inspectResponse: true }), false);
	assert.equal((await h.store.load()).refreshToken, 'secret-refresh-0');
	assert.equal(h.events.find(row => row.event === 'response_parsed').outcome, 'missing_access_token');
	assert.doesNotMatch(JSON.stringify(h.events), /secret-|private-/);
});

for (const body of [JSON.stringify({ error: { code: 4001010, msg: 'secret-body', password: 'secret-password' } }),
	'<html>secret-body</html>', '']) {
	test('inspection sanitizes failed responses including content-type and exception details', async t => {
		const h = await setup(t);
		t.mock.method(globalThis, 'fetch', async () => new Response(body,
			{ status: 400, statusText: 'secret-status', headers: { 'content-type': 'secret-mime', 'set-cookie': 'secret-cookie' } }));
		assert.equal(await checkRefresh(h.directory, h.emit, { inspectResponse: true }), false);
		assert.equal(h.events.find(row => row.event === 'response_inspected').status, 400);
		assert.equal(h.events.find(row => row.event === 'response_inspected').contentType, 'unrecognized');
		assert.doesNotMatch(JSON.stringify(h.events), /secret-|private-|4001010.*numericValue/);
	});
}

test('invalid counts are rejected before fetching or touching storage', async t => {
	const fetch = t.mock.method(globalThis, 'fetch', () => {
		throw new Error('must not fetch');
	});
	for (const count of [0, -1, 1.5, NaN, Infinity, '1']) {
		await assert.rejects(checkRefresh('/unused', () => {}, { count }));
	}
	assert.equal(fetch.mock.callCount(), 0);
});

test('actual CLI accepts inspect-response/count and defaults to two persisted exchanges', async t => {
	const h = await setup(t);
	const mock = join(h.directory, 'mock-fetch.mjs');
	await writeFile(mock, `globalThis.fetch = async url => new Response(JSON.stringify(
		url.endsWith('/token/refresh') ? { access_token: 'secret-cli', refresh_token: 'secret-cli-refresh', expire_in: 604800 } : []));`);
	for (const [args, count] of [[['--inspect-response', '--count', '1'], 1], [[], 2]]) {
		const { stdout, stderr } = await promisify(execFile)(process.execPath,
			['--import', mock, 'tools/token-refresh/check.mjs', '--storage', h.directory, ...args]);
		const events = stdout.trim().split('\n').map(JSON.parse);
		assert.equal(events.at(-1).refreshes, count);
		assert.equal(events.filter(row => row.event === 'response_inspected').length, count === 1 ? 1 : 0);
		assert.doesNotMatch(stdout + stderr, /secret-|private-/);
		assert.equal((await h.store.load()).refreshToken, 'secret-cli-refresh');
	}
});

test('observer exceptions cannot prevent persistence after successful exchange', async t => {
	const h = await setup(t);
	t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
		access_token: 'secret-observer-access', refresh_token: 'secret-observer-refresh',
	})));
	const client = new ConfigClient({ debug() {}, info() {}, warn() {}, error() {} });
	const before = await h.store.load();
	await h.store.refresh(before, value => client.refreshAccessToken(value, {
		previousAccessToken: before.accessToken, emit() {
			throw new Error('secret-observer');
		},
	}));
	assert.equal((await h.store.load()).refreshToken, 'secret-observer-refresh');
});

test('network exceptions do not disclose messages or arbitrary causes', async t => {
	const h = await setup(t);
	t.mock.method(globalThis, 'fetch', async () => {
		throw Object.assign(new Error('secret-network'), { cause: { code: 'secret-cause' } });
	});
	assert.equal(await checkRefresh(h.directory, h.emit, { inspectResponse: true }), false);
	assert.doesNotMatch(JSON.stringify(h.events), /secret-|private-/);
	assert.equal((await h.store.load()).refreshToken, 'secret-refresh-0');
});

test('inspection reports actual alias precedence, including invalid primary refresh alias', async t => {
	const h = await setup(t);
	t.mock.method(globalThis, 'fetch', async url => url.endsWith('/token/refresh')
		? new Response(JSON.stringify({ access_token: 'secret-access-new', refresh_token: '', refreshToken: 'secret-secondary',
			expires_at: false, expiresIn: 604800 })) : new Response('[]'));
	assert.equal(await checkRefresh(h.directory, h.emit, { count: 1, inspectResponse: true }), true);
	const parsed = h.events.find(row => row.event === 'response_parsed');
	assert.ok(parsed.consumed.includes('$.expiresIn'));
	assert.ok(!parsed.consumed.includes('$.expires_at'));
	assert.ok(parsed.ignoredCredentialFields.includes('$.refreshToken'));
	assert.equal((await h.store.load()).refreshToken, 'secret-refresh-0');
	assert.doesNotMatch(JSON.stringify(h.events), /secret-|private-/);
});
