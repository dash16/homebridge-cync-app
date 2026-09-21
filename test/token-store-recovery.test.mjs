import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CyncTokenStore } from '../dist/cync/token-store.js';

const token = { userId: 'user', accessToken: 'access', refreshToken: 'refresh' };
async function storage(t) {
	const directory = await fs.mkdtemp(join(tmpdir(), 'cync-store-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const store = new CyncTokenStore(directory);
	await store.save(token);
	return { directory, store, filename: join(directory, 'homebridge-cync-app', 'cync-tokens.json') };
}
function deferred() {
	let resolve;
	const promise = new Promise(done => {
		resolve = done; 
	});
	return { promise, resolve };
}

test('only a missing token file means signed out; read failures propagate', async t => {
	const h = await storage(t);
	const failure = Object.assign(new Error('storage access denied'), { code: 'EACCES' });
	const mock = t.mock.method(fs, 'open', async () => {
		throw failure; 
	});
	await assert.rejects(h.store.load(), error => error === failure);
	mock.mock.restore();
	assert.deepEqual(await h.store.load(), token);
	await h.store.clear();
	assert.equal(await h.store.load(), null);
	await h.store.clear(); // Missing files remain an idempotent sign-out.
});

test('malformed JSON and invalid session metadata are preserved and never logged in errors', async t => {
	const h = await storage(t);
	for (const contents of ['{"accessToken":"private-secret", broken', 'null', '{}',
		JSON.stringify({ ...token, refreshAt: 'private-secret' })]) {
		await fs.writeFile(h.filename, contents);
		await assert.rejects(h.store.load(), error => {
			assert.doesNotMatch(error.message, /private-secret/);
			return /invalid/.test(error.message);
		});
		assert.equal(await fs.readFile(h.filename, 'utf8'), contents);
	}
	await h.store.save(token);
	assert.deepEqual(await h.store.load(), token);
});

test('sign-out waits for an in-flight refresh then removes its replacement credentials', async t => {
	const h = await storage(t);
	const other = new CyncTokenStore(h.directory);
	const entered = deferred();
	const finish = deferred();
	const contended = deferred();
	const originalMkdir = fs.mkdir;
	t.mock.method(fs, 'mkdir', async (...args) => {
		try {
			return await originalMkdir(...args);
		} catch (error) {
			if (error.code === 'EEXIST' && args[0].endsWith('.refresh-lock')) {
				contended.resolve('waiting');
			}
			throw error;
		}
	});
	const refreshing = h.store.refresh(token, async () => {
		entered.resolve();
		await finish.promise;
		return { accessToken: 'rotated-access', refreshToken: 'rotated-refresh' };
	});
	await entered.promise;
	const signingOut = other.clear();
	try {
		assert.equal(await Promise.race([contended.promise, signingOut.then(() => 'completed')]), 'waiting');
	} finally {
		finish.resolve();
		await Promise.all([refreshing, signingOut]);
	}
	assert.equal(await h.store.load(), null);
	let exchanges = 0;
	await assert.rejects(h.store.refresh(token, async () => {
		exchanges++;
		return { accessToken: 'unwanted' };
	}), /Sign in/);
	assert.equal(exchanges, 0);
	assert.equal(await other.load(), null);
});

test('sign-out deletion errors are reported instead of claiming success and release the lock', async t => {
	const h = await storage(t);
	const failure = Object.assign(new Error('storage access denied'), { code: 'EACCES' });
	const mock = t.mock.method(fs, 'unlink', async () => {
		throw failure; 
	});
	await assert.rejects(h.store.clear(), error => error === failure);
	mock.mock.restore();
	assert.deepEqual(await h.store.load(), token);
	await h.store.clear();
	assert.equal(await h.store.load(), null);
});
