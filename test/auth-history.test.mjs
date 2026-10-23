import assert from 'node:assert/strict';
import console from 'node:console';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthHistory } from '../dist/cync/auth-history.js';
import { CyncTokenStore } from '../dist/cync/token-store.js';

async function setup(t) {
	const root = await fs.mkdtemp(join(tmpdir(), 'cync-history-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const directory = join(root, 'homebridge-cync-app');
	const file = join(directory, 'auth-history.jsonl');
	return { root, directory, file, read: async () => (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse) };
}

test('journal excludes secrets and arbitrary errors and distinguishes writers', async t => {
	const h = await setup(t);
	const plugin = new AuthHistory(h.directory, 'plugin');
	const ui = new AuthHistory(h.directory, 'ui');
	await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? plugin : ui).record('refresh_failed', {
		status: 400, code: 4001010, msg: 'SECRET', accessToken: 'SECRET', password: 'SECRET',
		twoFactor: 'SECRET', body: { token: 'SECRET' }, refreshAt: 'SECRET', expiresAt: Infinity,
	})));
	const rows = await h.read();
	assert.equal(rows.length, 20);
	assert.equal(new Set(rows.map(row => row.run)).size, 2);
	assert.deepEqual(new Set(rows.map(row => row.source)), new Set(['plugin', 'ui']));
	assert.ok(rows.every(row => row.status === 400 && row.code === 4001010 && row.version));
	assert.ok(!(await fs.readFile(h.file, 'utf8')).includes('SECRET'));
	assert.equal((await fs.stat(h.file)).mode & 0o777, 0o600);
});

test('history survives signout and records rejection before credential deletion', async t => {
	const h = await setup(t);
	const store = new CyncTokenStore(h.root, 'plugin');
	const token = { userId: 'SECRET', accessToken: 'SECRET', refreshToken: 'SECRET' };
	await store.save(token);
	await assert.rejects(store.refresh(token, async () => {
		throw { status: 400, code: 4001010 }; 
	}));
	assert.equal(await store.load(), null);
	await store.clear();
	const events = (await h.read()).map(row => row.event);
	assert.ok(events.indexOf('refresh_rejected') < events.indexOf('delete_rejected'));
	assert.ok(events.includes('delete_signout'));
	assert.ok(!(await fs.readFile(h.file, 'utf8')).includes('SECRET'));
});

test('rotation retains seven archives and a writable current file', async t => {
	const h = await setup(t);
	await fs.mkdir(h.directory);
	await fs.writeFile(h.file, 'x'.repeat(4 * 1024 * 1024));
	for (let index = 1; index <= 7; index++) {
		await fs.writeFile(`${h.file}.${index}`, String(index));
	}
	await new AuthHistory(h.directory, 'plugin').record('startup');
	assert.equal((await h.read())[0].event, 'startup');
	assert.equal(await fs.readFile(`${h.file}.7`, 'utf8'), '6');
	assert.equal((await fs.stat(`${h.file}.1`)).size, 4 * 1024 * 1024);
	assert.equal((await fs.readdir(h.directory)).length, 8);
});

test('history write failure cannot prevent token persistence or loading', async t => {
	const h = await setup(t);
	await fs.mkdir(h.directory);
	await fs.mkdir(h.file); // A directory at the journal path makes append fail.
	t.mock.method(console, 'warn', () => {});
	const store = new CyncTokenStore(h.root, 'plugin');
	const token = { userId: 'test', accessToken: 'test' };
	await store.save(token);
	assert.deepEqual(await store.load(), token);
	await store.clear();
	assert.equal(await store.load(), null);
	assert.equal(console.warn.mock.callCount(), 1);
});
