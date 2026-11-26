import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { ConfigClient } from '../../dist/cync/config-client.js';
import { CyncTokenStore, withTokenSchedule } from '../../dist/cync/token-store.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const compare = (next, before) => next === undefined ? 'absent' : next === before ? 'same' : 'different';

/** One explicit experiment, no retries, no verification-code request, no speculative refresh. */
export async function checkPasswordReauth(storagePath, emit = event => process.stdout.write(`${JSON.stringify(event)}\n`)) {
	let phase = 'configuration';
	let saved = false;
	const report = fields => {
		try {
			emit({ time: new Date().toISOString(), ...fields });
		} catch {
			// A diagnostic output callback must not interrupt a credential transaction.
		}
	};
	try {
		const config = JSON.parse(await readFile(join(storagePath, 'config.json'), 'utf8'));
		const platforms = Array.isArray(config?.platforms)
			? config.platforms.filter(item => item?.platform === 'CyncAppPlatform') : [];
		if (platforms.length !== 1 || typeof platforms[0].username !== 'string' || !platforms[0].username.trim()
			|| typeof platforms[0].password !== 'string' || !platforms[0].password) {
			report({ event: 'unavailable', reason: 'requires_one_configured_cync_platform' });
			return false;
		}
		const { username, password } = platforms[0];
		phase = 'load';
		const store = new CyncTokenStore(storagePath, 'diagnostic');
		const before = await store.load();
		if (!before?.refreshToken) {
			report({ event: 'unavailable', reason: 'existing_session_required_for_comparison' });
			return false;
		}
		phase = 'lock';
		const next = await store.replaceVerifiedSession(before, async () => {
			phase = 'password_login';
			report({ event: 'password_login_starting', attempts: 1 });
			const client = new ConfigClient(quiet);
			await store.history.record('login_attempt');
			const session = await client.loginWithPassword(username, password, {
				previousAccessToken: before.accessToken, previousRefreshToken: before.refreshToken,
				emit: event => report({ ...event, operation: 'password_login' }),
			});
			report({ event: 'password_login_received', accessCredential: compare(session.accessToken, before.accessToken),
				refreshCredential: compare(session.refreshToken, before.refreshToken),
				authorizeCredential: compare(session.authorize, before.authorize), accountMatches: session.userId === before.userId,
				expirationChanged: session.expiresAt !== before.expiresAt,
				expiresAt: Number.isFinite(session.expiresAt) ? session.expiresAt : null });
			phase = 'validate';
			if (!session.accessToken || !session.refreshToken || !session.authorize || session.userId !== before.userId
				|| !/^\d+$/.test(session.userId) || Number(session.userId) > 0xffffffff
				|| !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()
				|| !/^[\x21-\x7e]+$/.test(session.authorize)) {
				throw new Error('Incomplete replacement session');
			}
			// Never carry forward the previous session's authorize or LAN login blob.
			const lanLoginCode = Buffer.from(ConfigClient.buildLanLoginCode(session.userId, session.authorize)).toString('base64');
			const replacement = withTokenSchedule({ userId: session.userId, accessToken: session.accessToken,
				refreshToken: session.refreshToken, expiresAt: session.expiresAt, authorize: session.authorize, lanLoginCode,
				authenticatedAt: Date.now() });
			phase = 'cloud';
			const cloud = await client.getCloudConfig(true);
			report({ event: 'cloud_verified', meshCount: cloud.meshes.length });
			phase = 'persist';
			return replacement;
		});
		if (!next) {
			report({ event: 'inconclusive', reason: 'saved_session_changed_before_login' });
			return false;
		}
		saved = true;
		await store.history.record('login_ok');
		phase = 'reload';
		const reloaded = await new CyncTokenStore(storagePath).load();
		if (JSON.stringify(reloaded) !== JSON.stringify(next)) {
			throw new Error('Saved session changed');
		}
		report({ event: 'session_saved', refreshCredential: compare(next.refreshToken, before.refreshToken),
			lanCredentialsRebuilt: true, authenticatedAt: next.authenticatedAt, expiresAt: next.expiresAt, refreshAt: next.refreshAt });
		report({ event: 'passed', passwordAttempts: 1, cloudChecks: 1, refreshExchangeTested: false, lifetimeResetProven: false });
		return true;
	} catch (error) {
		const status = Number.isInteger(error?.status) ? error.status : null;
		const code = Number.isInteger(error?.code) ? error.code : null;
		report({ event: 'failed', phase, status, code, sessionSaved: saved ? true : phase === 'persist' ? 'unconfirmed' : false,
			interpretation: code === 4001379 ? 'verification_code_error' : 'undetermined',
			timedOut: error?.name === 'TimeoutError' });
		return false;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const { values } = parseArgs({ options: { storage: { type: 'string' }, help: { type: 'boolean' } } });
		if (values.help || !values.storage) {
			process.stdout.write('Usage: node tools/password-reauth/check.mjs --storage /absolute/homebridge/storage\n'
				+ 'Makes one password login, verifies cloud access, and saves a complete replacement session. No retries.\n');
			process.exitCode = values.help ? 0 : 2;
		} else {
			process.exitCode = await checkPasswordReauth(values.storage) ? 0 : 1;
		}
	} catch {
		process.stderr.write('Invalid arguments. Use --help.\n');
		process.exitCode = 2;
	}
}
