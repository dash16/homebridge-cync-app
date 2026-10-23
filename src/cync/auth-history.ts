import { promises as fs, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version as string;
const numericFields = ['expiresAt', 'issuedAt', 'refreshAt', 'delayMs', 'status', 'code'];
const booleanFields = ['hasRefreshToken', 'refreshRejected', 'accessChanged', 'refreshChanged', 'timerArmed'];
export type AuthEvent = 'startup' | 'load_missing' | 'load_ok' | 'load_failed' | 'save_ok' | 'save_failed'
	| 'refresh_attempt' | 'refresh_response' | 'refresh_ok' | 'refresh_failed' | 'refresh_rejected' | 'session_adopted'
	| 'delete_signout' | 'delete_rejected' | 'delete_failed' | 'scheduled' | 'schedule_skipped'
	| 'timer_fired' | 'retry_scheduled' | 'stopped' | 'login_attempt' | 'login_ok' | 'login_failed';

/** Independent, best-effort journal: never serialize credentials or arbitrary error text. */
export class AuthHistory {
	private pending: Promise<void> = Promise.resolve();
	private warned = false;
	private readonly run = randomUUID();
	constructor(private readonly directory: string, private readonly source: 'plugin' | 'ui' | 'diagnostic') {}

	public record(event: AuthEvent, data: object = {}): Promise<void> {
		const input = data as Record<string, unknown>;
		const safe: Record<string, number | boolean | string> = {};
		const cause = input.cause as { code?: unknown } | undefined;
		const errorCode = typeof input.code === 'string' ? input.code : cause?.code;
		if (typeof errorCode === 'string' && ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO',
			'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(errorCode)) {
			safe.errorCode = errorCode;
		}
		for (const key of numericFields) {
			if (typeof input[key] === 'number' && Number.isFinite(input[key])) {
				safe[key] = input[key] as number;
			}
		}
		for (const key of booleanFields) {
			if (typeof input[key] === 'boolean') {
				safe[key] = input[key] as boolean;
			}
		}
		const line = JSON.stringify({ time: new Date().toISOString(), version, source: this.source,
			pid: process.pid, run: this.run, event, ...safe }) + '\n';
		this.pending = this.pending.then(() => this.append(line)).catch(() => {
			if (!this.warned) {
				this.warned = true;
				console.warn('[Cync] Authentication history could not be written; check Homebridge storage permissions and free space.');
			}
		});
		return this.pending;
	}

	private async append(line: string): Promise<void> {
		await fs.mkdir(this.directory, { recursive: true });
		const lock = join(this.directory, 'auth-history.lock');
		const deadline = Date.now() + 2_000;
		for (;;) {
			try {
				await fs.mkdir(lock);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw error;
				}
				const stat = await fs.stat(lock).catch(() => null);
				if (stat && Date.now() - stat.mtimeMs > 60_000) {
					await fs.rmdir(lock).catch(() => {});
				}
				if (Date.now() >= deadline) {
					throw new Error('History busy');
				}
				await delay(25);
			}
		}
		try {
			const file = join(this.directory, 'auth-history.jsonl');
			const stat = await fs.stat(file).catch(error => {
				if (error.code !== 'ENOENT') {
					throw error; 
				}
				return null;
			});
			if (stat && stat.size + Buffer.byteLength(line) > 4 * 1024 * 1024) {
				await fs.rm(`${file}.7`, { force: true });
				for (let index = 6; index >= 0; index--) {
					await fs.rename(index ? `${file}.${index}` : file, `${file}.${index + 1}`).catch(error => {
						if (error.code !== 'ENOENT') {
							throw error; 
						}
					});
				}
			}
			await fs.appendFile(file, line, { encoding: 'utf8', mode: 0o600 });
		} finally {
			await fs.rmdir(lock);
		}
	}
}
