import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CyncTokenStore } from '../dist/cync/token-store.js';
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
