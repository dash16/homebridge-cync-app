import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { ConfigClient } from '../../dist/cync/config-client.js';
import { CyncTokenStore } from '../../dist/cync/token-store.js';

// ConfigClient can log response bodies. Diagnostics deliberately expose only
// allowlisted metadata, never upstream messages, account IDs, or credentials.
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const expiry = token => Number.isFinite(token?.expiresAt) ? new Date(token.expiresAt).toISOString() : null;

export async function checkRefresh(storagePath, emit = event => process.stdout.write(`${JSON.stringify(event)}\n`)) {
	let phase = 'load';
	let attempt = 0;
	const report = fields => emit({ time: new Date().toISOString(), ...fields });
	try {
		for (attempt = 1; attempt <= 2; attempt++) {
			// Recreate both objects so the second attempt cannot rely on memory.
			const store = new CyncTokenStore(storagePath);
			const client = new ConfigClient(quiet);
			phase = 'load';
			const before = await store.load();
			if (!before?.accessToken || !before?.userId || !before?.refreshToken || before.refreshRejected) {
				report({ event: 'unavailable', attempt, reason: 'missing_or_rejected_credentials' });
				return false;
			}
			report({ event: 'starting', attempt, expiresAt: expiry(before) });
			phase = 'refresh';
			let exchanged = false;
			const next = await store.refresh(before, async value => {
				exchanged = true;
				return client.refreshAccessToken(value);
			}, false);
			report({ event: 'refresh_saved', attempt, exchanged,
				accessTokenChanged: next.accessToken !== before.accessToken,
				refreshTokenChanged: next.refreshToken !== before.refreshToken,
				expiresAt: expiry(next) });
			phase = 'reload';
			const saved = await new CyncTokenStore(storagePath).load();
			if (!saved || saved.accessToken !== next.accessToken || saved.refreshToken !== next.refreshToken ||
				saved.expiresAt !== next.expiresAt || saved.userId !== next.userId) {
				report({ event: 'failed', attempt, phase, reason: 'saved_session_changed_or_missing' });
				return false;
			}
			phase = 'cloud';
			client.restoreSession(saved.accessToken, saved.userId);
			const config = await client.getCloudConfig();
			report({ event: 'cloud_verified', attempt, meshCount: config.meshes.length });
			if (!exchanged) {
				report({ event: 'inconclusive', attempt, reason: 'another_client_refreshed_first' });
				return false;
			}
		}
		report({ event: 'passed', refreshes: 2, cloudChecks: 2 });
		return true;
	} catch (error) {
		// Do not print error.message, stack, body, or arbitrary exception fields.
		const status = Number.isInteger(error?.status) ? error.status : null;
		const code = Number.isInteger(error?.code) ? error.code : null;
		const cause = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED']
			.includes(error?.cause?.code) ? error.cause.code : null;
		report({ event: 'failed', attempt, phase, status, code, networkCode: cause,
			timedOut: error?.name === 'TimeoutError' });
		return false;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const { values } = parseArgs({ options: { storage: { type: 'string' }, help: { type: 'boolean' } } });
		if (values.help || !values.storage) {
			process.stdout.write('Usage: npm run check:token-refresh -- --storage /absolute/homebridge/storage\n' +
				'Runs two live refreshes, saves replacement credentials, and verifies cloud access.\n');
			process.exitCode = values.help ? 0 : 2;
		} else {
			process.exitCode = await checkRefresh(values.storage) ? 0 : 1;
		}
	} catch {
		process.stderr.write('Invalid arguments. Use --help.\n');
		process.exitCode = 2;
	}
}
