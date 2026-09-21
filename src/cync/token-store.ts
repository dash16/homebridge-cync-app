// src/cync/token-store.ts
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { CyncRefreshResponse } from './config-client.js';

export function isRefreshTokenRejected(error: unknown): boolean {
	const e = error as { code?: number; status?: number; msg?: string };
	return e?.code === 4001010 || (e?.status === 400 && e?.msg === 'refresh token error');
}

export interface CyncTokenData {
	userId: string;
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
	issuedAt?: number;
	refreshAt?: number;
	authorize?: string;
	lanLoginCode?: string;
	refreshRejected?: boolean;
}

/** Schedule from the lifetime returned by Cync, not a fixed number of days. */
export function withTokenSchedule(data: CyncTokenData, issuedAt = Date.now()): CyncTokenData {
	const expiresAt = data.expiresAt;
	return {
		...data,
		issuedAt,
		refreshAt: typeof expiresAt === 'number' && Number.isFinite(expiresAt)
			? issuedAt + Math.max(0, expiresAt - issuedAt) * 0.85
			: undefined,
	};
}

/**
 * Simple JSON token store under the Homebridge storage path.
 *
 * Files are stored at:
 *   <storagePath>/homebridge-cync-app/cync-tokens.json
 */
export class CyncTokenStore {
	private readonly dirPath: string;
	private readonly filePath: string;

	public constructor(storagePath: string) {
		this.dirPath = path.join(storagePath, 'homebridge-cync-app');
		this.filePath = path.join(this.dirPath, 'cync-tokens.json');
	}

	public async load(): Promise<CyncTokenData | null> {
		let file;
		try {
			file = await fs.open(this.filePath, 'r');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return null;
			}
			throw error;
		}
		try {
			const raw = await file.readFile('utf8');
			let data: CyncTokenData;
			try {
				data = JSON.parse(raw) as CyncTokenData;
			} catch {
				// JSON parser errors can contain fragments of credentials.
				throw new Error('Cync token file contains invalid JSON. Stored credentials were preserved.');
			}
			if (!data || typeof data !== 'object' ||
				typeof data.userId !== 'string' || !data.userId ||
				typeof data.accessToken !== 'string' || !data.accessToken ||
				(data.refreshToken !== undefined && typeof data.refreshToken !== 'string') ||
				(data.refreshRejected !== undefined && typeof data.refreshRejected !== 'boolean') ||
				[data.expiresAt, data.issuedAt, data.refreshAt].some(value => value !== undefined && !Number.isFinite(value))) {
				throw new Error('Cync token file has invalid session metadata. Stored credentials were preserved.');
			}
			// Read metadata from the same open file, even if another process
			// atomically replaces the path while this read is in progress.
			if (data.refreshAt === undefined && Number.isFinite(data.expiresAt)) {
				const stat = await file.stat();
				return withTokenSchedule(data, data.issuedAt ?? Math.min(stat.mtimeMs, data.expiresAt!));
			}
			return data;
		} finally {
			await file.close();
		}
	}

	public async save(data: CyncTokenData): Promise<void> {
		await this.withLock(() => this.saveUnlocked(data));
	}

	private async saveUnlocked(data: CyncTokenData): Promise<void> {
		const json = JSON.stringify(data, null, 2);

		// Ensure directory exists before writing
		await fs.mkdir(this.dirPath, { recursive: true });
		const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporaryPath, json, { encoding: 'utf8', mode: 0o600 });
			await fs.rename(temporaryPath, this.filePath);
		} finally {
			await fs.unlink(temporaryPath).catch(() => {});
		}
	}

	/** Coordinate rotating refresh tokens across the UI and Homebridge processes. */
	public async refresh(
		stored: CyncTokenData,
		exchange: (refreshToken: string) => Promise<CyncRefreshResponse>,
		clearRejected = true,
	): Promise<CyncTokenData> {
		return this.withLock(() => this.refreshUnlocked(stored, exchange, clearRejected));
	}

	private async refreshUnlocked(
		stored: CyncTokenData,
		exchange: (refreshToken: string) => Promise<CyncRefreshResponse>,
		clearRejected: boolean,
	): Promise<CyncTokenData> {
		try {
			const current = await this.load();
			if (!current) {
				throw new Error('Sign in to Cync before loading devices.');
			}
			if (current.accessToken !== stored.accessToken || current.refreshToken !== stored.refreshToken) {
				return current;
			}
			if (current.refreshRejected || !current.refreshToken) {
				throw { code: 4001010, msg: 'Refresh token unavailable or rejected' };
			}
			const response = await exchange(current.refreshToken);
			const next = withTokenSchedule({
				...current,
				accessToken: response.accessToken,
				refreshToken: response.refreshToken ?? current.refreshToken,
				expiresAt: response.expiresAt,
			});
			await this.saveUnlocked(next);
			return next;
		} catch (error) {
			if (isRefreshTokenRejected(error)) {
				if (clearRejected) {
					await this.clearUnlocked();
				} else {
					const current = await this.load();
					if (current) {
						await this.saveUnlocked({ ...current, refreshRejected: true });
					}
				}
			}
			throw error;
		}
	}

	/** Sign-out waits for any active refresh to finish, then removes its result. */
	public async clear(): Promise<void> {
		await this.withLock(() => this.clearUnlocked());
	}

	private async clearUnlocked(): Promise<void> {
		try {
			await fs.unlink(this.filePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
	}

	/** All credential mutations use the same cross-process lock. */
	private async withLock<T>(operation: () => Promise<T>): Promise<T> {
		await fs.mkdir(this.dirPath, { recursive: true });
		const lockPath = `${this.filePath}.refresh-lock`;
		const deadline = Date.now() + 20_000;
		for (;;) {
			try {
				await fs.mkdir(lockPath);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw error;
				}
				// Recover locks left behind by a terminated process. Network refreshes
				// have a 15-second timeout, well below this recovery threshold.
				const stat = await fs.stat(lockPath).catch(() => null);
				if (stat && Date.now() - stat.mtimeMs > 120_000) {
					await fs.rmdir(lockPath).catch(() => {});
					continue;
				}
				if (Date.now() >= deadline) {
					throw new Error('Timed out waiting for Cync token refresh; retry later.');
				}
				await delay(100);
			}
		}
		try {
			return await operation();
		} finally {
			await fs.rmdir(lockPath);
		}
	}
}
