// src/cync/config-client.ts
// Cync cloud configuration & login client.
// Handles 2FA email flow and basic device/config queries against api.gelighting.com.
//
// This is intentionally low-level and stateless-ish: CyncClient is expected to
// own an instance of this class and persist the resulting session info.

const CYNC_API_BASE = 'https://api.gelighting.com/v2/';
const CORP_ID = '1007d2ad150c4000';

type FetchLike = (input: unknown, init?: unknown) => Promise<unknown>;

declare const fetch: FetchLike;

type HttpHeaders = {
	get(name: string): string | null;
};

type HttpResponse = {
	ok: boolean;
	status: number;
	statusText: string;
	headers?: HttpHeaders;
	json(): Promise<unknown>;
	text(): Promise<string>;
};

type CyncErrorBody = {
	error?: {
		msg?: string;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

type CyncApiError = {
	status: number;
	statusText: string;
	body: unknown;
	code?: number;
	msg?: string;
};

function extractCyncError(body: unknown): { code?: number; msg?: string } {
	if (!body || typeof body !== 'object') {
		return {};
	}

	const obj = body as Record<string, unknown>;
	const err = obj.error;

	if (!err || typeof err !== 'object') {
		return {};
	}

	const e = err as Record<string, unknown>;
	const code = typeof e.code === 'number' ? e.code : undefined;
	const msg = typeof e.msg === 'string' ? e.msg : undefined;

	return { code, msg };
}

function isDevicePropertyNotExists(status: number, body: unknown): boolean {
	const { code, msg } = extractCyncError(body);
	return status === 404 && (code === 4041009 || msg === 'device property not exists');
}

export interface CyncLoginSession {
	accessToken: string;
	userId: string;
	authorize?: string;

	// Token refresh support
	refreshToken?: string;
	expiresAt?: number;

	raw: unknown;
}

export interface CyncDevice {
	id: string;
	name?: string;
	product_id?: string;
	device_id?: string;
	mac?: string;
	sn?: string;
	switch_id?: string;
	/** uint32 LAN controller ID, derived from raw_switch_id when the REST API returns a composite value */
	switch_controller?: number | string;
	/** Original switchID from the Cync REST API — may be a composite value encoding a device index */
	raw_switch_id?: number;
	/** Trailing device index encoded in raw_switch_id when it exceeds uint32 range (e.g. 1850364131001 → 1) */
	switch_index?: number;
	mesh_id?: number | string;

	[key: string]: unknown;
}

export interface CyncDeviceMesh {
	id: string;
	name?: string;
	product_id: string;
	access_key?: string;
	mac?: string;
	properties?: Record<string, unknown>;
	devices?: CyncDevice[];
	[key: string]: unknown;
}

export interface CyncCloudConfig {
	meshes: CyncDeviceMesh[];
}

export interface CyncRefreshResponse {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
}

export interface CyncLogger {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
}

const defaultLogger: CyncLogger = {
	debug: (...args: unknown[]) => console.debug('[cync-config]', ...args),
	info: (...args: unknown[]) => console.info('[cync-config]', ...args),
	warn: (...args: unknown[]) => console.warn('[cync-config]', ...args),
	error: (...args: unknown[]) => console.error('[cync-config]', ...args),
};

export class ConfigClient {
	private readonly log: CyncLogger;

	// These are populated after a successful 2FA login.
	private accessToken: string | null = null;
	private userId: string | null = null;
	private authorize: string | null = null;

	constructor(logger?: CyncLogger) {
		this.log = logger ?? defaultLogger;
	}

	/**
	 * Request that Cync send a one-time 2FA verification code to the given email.
	 *
	 * This MUST be called before loginWithTwoFactor() for accounts that require 2FA.
	 * The user reads the code from their email and provides it to loginWithTwoFactor.
	 */
	public async sendTwoFactorCode(email: string): Promise<void> {
		const url = `${CYNC_API_BASE}two_factor/email/verifycode`;
		this.log.debug(`Requesting Cync 2FA code for ${email}…`);

		const body = {
			corp_id: CORP_ID,
			email,
			local_lang: 'en-us',
		};

		const res = (await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
		})) as HttpResponse;

		if (!res.ok) {
			const parsed = await this.readBodyOnce(res);
			const ct = parsed.contentType ?? 'unknown';
			const snippet = parsed.text.trim().slice(0, 300);

			this.log.error(
				`Cync 2FA request failed: HTTP ${res.status} ${res.statusText} (content-type=${ct}) ${snippet}`,
			);
			throw new Error(`Cync 2FA request failed with status ${res.status}`);
		}

		this.log.info('Cync 2FA email request succeeded.');
	}

	/**
	 * Perform the actual 2FA login and capture the access token + userId.
	 *
	 * You are expected to first call sendTwoFactorCode(), then prompt the user
	 * for the emailed OTP code, then call loginWithTwoFactor() with that code.
	 *
	 * The access token is used for subsequent getCloudConfig() / getDeviceProperties() calls.
	 */
	public async loginWithTwoFactor(
		email: string,
		password: string,
		otpCode: string,
	): Promise<CyncLoginSession> {
		const url = `${CYNC_API_BASE}user_auth/two_factor`;
		this.log.debug('Logging into Cync with 2FA for %s…', email);

		const body = {
			corp_id: CORP_ID,
			email,
			password,
			two_factor: otpCode,
			resource: ConfigClient.randomLoginResource(),
		};

		const res = (await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json',
			},
			body: JSON.stringify(body),
		})) as HttpResponse;

		const parsed = await this.readBodyOnce(res);

		if (parsed.text.trim().length === 0) {
			const ct = parsed.contentType ?? 'unknown';
			throw new Error(
				`Cync login returned empty body: HTTP ${res.status} ${res.statusText} (content-type=${ct})`,
			);
		}

		if (parsed.json === null) {
			const ct = parsed.contentType ?? 'unknown';
			const snippet = parsed.text.trim().slice(0, 300);
			throw new Error(
				`Cync login returned non-JSON payload: HTTP ${res.status} ${res.statusText} (content-type=${ct}): ${snippet}`,
			);
		}

		const json: unknown = parsed.json;

		if (!res.ok) {
			this.log.error(
				'Cync login failed: HTTP %d %s %o',
				res.status,
				res.statusText,
				json,
			);
			const errBody = json as CyncErrorBody;
			throw new Error(
				errBody.error?.msg ??
				`Cync login failed with status ${res.status} ${res.statusText}`,
			);
		}

		const obj = json as Record<string, unknown>;
		this.log.debug('Cync login response: keys=%o', Object.keys(obj));

		// Accept both snake_case and camelCase, and both string/number user_id.
		const accessTokenRaw = obj.access_token ?? obj.accessToken;
		const userIdRaw = obj.user_id ?? obj.userId;
		const authorizeRaw = obj.authorize;

		// Token refresh fields (observed from /user_auth/two_factor):
		// - refresh_token
		// - expire_in (seconds)
		const refreshTokenRaw = obj.refresh_token ?? obj.refreshToken;
		const expireInRaw =
			obj.expire_in ??
			obj.expires_in ??
			obj.expireIn ??
			obj.expiresIn;

		const accessToken =
			typeof accessTokenRaw === 'string' && accessTokenRaw.length > 0
				? accessTokenRaw
				: undefined;

		const userId =
			userIdRaw !== undefined && userIdRaw !== null
				? String(userIdRaw)
				: undefined;

		const authorize =
			typeof authorizeRaw === 'string' && authorizeRaw.length > 0
				? authorizeRaw
				: undefined;

		if (!accessToken || !userId) {
			this.log.error('Cync login missing access_token or user_id: %o', json);
			throw new Error('Cync login response missing access_token or user_id');
		}

		let refreshToken: string | undefined;
		if (typeof refreshTokenRaw === 'string' && refreshTokenRaw.length > 0) {
			refreshToken = refreshTokenRaw;
		}

		let expiresAt: number | undefined;
		if (typeof expireInRaw === 'number' && expireInRaw > 0) {
			expiresAt = Date.now() + expireInRaw * 1000;
		} else if (typeof expireInRaw === 'string') {
			const n = Number(expireInRaw);
			if (Number.isFinite(n) && n > 0) {
				expiresAt = Date.now() + n * 1000;
			}
		}

		this.accessToken = accessToken;
		this.userId = userId;
		this.authorize = authorize ?? null;

		this.log.info('Cync login successful; userId=%s', userId);

		return {
			accessToken,
			userId,
			authorize,
			refreshToken,
			expiresAt,
			raw: json,
		};
	}

	/**
	 * Password-only login for background refresh.
	 *
	 * This uses the /user_auth endpoint (no two_factor) and is intended
	 * for automatic re-auth when the access token has expired, after an
	 * initial 2FA bootstrap has already been completed.
	 */
	public async loginWithPassword(
		email: string,
		password: string,
	): Promise<CyncLoginSession & { refreshToken?: string; expiresAt?: number }> {
		const url = `${CYNC_API_BASE}user_auth`;
		this.log.debug('Logging into Cync with password-only auth for %s…', email);

		const body = {
			corp_id: CORP_ID,
			email,
			password,
			resource: ConfigClient.randomLoginResource(),
		};

		const res = (await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json',
			},
			body: JSON.stringify(body),
		})) as HttpResponse;

		const parsed = await this.readBodyOnce(res);

		if (parsed.text.trim().length === 0) {
			const ct = parsed.contentType ?? 'unknown';
			throw new Error(
				`Cync password login returned empty body: HTTP ${res.status} ${res.statusText} (content-type=${ct})`,
			);
		}

		if (parsed.json === null) {
			const ct = parsed.contentType ?? 'unknown';
			const snippet = parsed.text.trim().slice(0, 300);
			throw new Error(
				`Cync password login returned non-JSON payload: HTTP ${res.status} ${res.statusText} (content-type=${ct}): ${snippet}`,
			);
		}

		const json: unknown = parsed.json;

		if (!res.ok) {
			this.log.error(
				'Cync password login failed: HTTP %d %s %o',
				res.status,
				res.statusText,
				json,
			);
			const errBody = json as CyncErrorBody;
			throw new Error(
				errBody.error?.msg ??
				`Cync password login failed with status ${res.status} ${res.statusText}`,
			);
		}

		const obj = json as Record<string, unknown>;
		this.log.debug('Cync password login response: keys=%o', Object.keys(obj));

		const accessTokenRaw = obj.access_token ?? obj.accessToken;
		const userIdRaw = obj.user_id ?? obj.userId;
		const authorizeRaw = obj.authorize;
		const refreshTokenRaw = obj.refresh_token ?? obj.refreshToken;

		const expiresAtRaw = obj.expires_at ?? obj.expiresAt;
		const expireInRaw =
			obj.expire_in ??
			obj.expires_in ??
			obj.expireIn ??
			obj.expiresIn;

		const accessToken =
			typeof accessTokenRaw === 'string' && accessTokenRaw.length > 0
				? accessTokenRaw
				: undefined;

		const userId =
			userIdRaw !== undefined && userIdRaw !== null
				? String(userIdRaw)
				: undefined;

		const authorize =
			typeof authorizeRaw === 'string' && authorizeRaw.length > 0
				? authorizeRaw
				: undefined;

		if (!accessToken || !userId) {
			this.log.error(
				'Cync password login missing access_token or user_id: %o',
				json,
			);
			throw new Error(
				'Cync password login response missing access_token or user_id',
			);
		}

		let refreshToken: string | undefined;
		if (typeof refreshTokenRaw === 'string' && refreshTokenRaw.length > 0) {
			refreshToken = refreshTokenRaw;
		}

		let expiresAt: number | undefined;

		// Prefer absolute expiresAt if present, otherwise derive from expire_in
		if (typeof expiresAtRaw === 'number') {
			expiresAt = expiresAtRaw < 2_000_000_000 ? expiresAtRaw * 1000 : expiresAtRaw;
		} else if (typeof expiresAtRaw === 'string') {
			const n = Number(expiresAtRaw);
			if (Number.isFinite(n)) {
				expiresAt = n < 2_000_000_000 ? n * 1000 : n;
			}
		} else if (typeof expireInRaw === 'number' && expireInRaw > 0) {
			expiresAt = Date.now() + expireInRaw * 1000;
		} else if (typeof expireInRaw === 'string') {
			const n = Number(expireInRaw);
			if (Number.isFinite(n) && n > 0) {
				expiresAt = Date.now() + n * 1000;
			}
		}

		this.accessToken = accessToken;
		this.userId = userId;
		this.authorize = authorize ?? null;

		this.log.info('Cync password login successful; userId=%s', userId);

		return {
			accessToken,
			userId,
			authorize,
			raw: {
				...obj,
				refreshToken,
				expiresAt,
			},
			refreshToken,
			expiresAt,
		};
	}

	/**
	 * Refresh the access token using a stored refresh token.
	 *
	 * This mirrors the 2FA login flow in shape, but only exchanges the
	 * refresh_token for a new access_token (and possibly a new refresh_token).
	 */
	public async refreshAccessToken(refreshToken: string): Promise<CyncRefreshResponse> {
		// Token Refresh Endpoint: Exchanges refresh_token for a new access token.
		// The correct endpoint is /v2/user/token/refresh (NOT /v2/user_auth/refresh). :contentReference[oaicite:1]{index=1}
		const url = `${CYNC_API_BASE}user/token/refresh`;
		this.log.debug('Refreshing Cync access token…');

		// Known shape used by other integrations: {"refresh_token": "..."} :contentReference[oaicite:2]{index=2}
		const body = {
			refresh_token: refreshToken,
		};

		const res = (await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json',
			},
			body: JSON.stringify(body),
		})) as HttpResponse;

		const parsed = await this.readBodyOnce(res);

		if (parsed.text.trim().length === 0) {
			const ct = parsed.contentType ?? 'unknown';
			const msg = `Cync refresh returned empty body (HTTP ${res.status} ${res.statusText}, content-type=${ct})`;
			this.log.error(msg);
			throw new Error(msg);
		}

		if (parsed.json === null) {
			const ct = parsed.contentType ?? 'unknown';
			const snippet = parsed.text.trim().slice(0, 300);
			const msg = `Cync refresh returned non-JSON body (HTTP ${res.status} ${res.statusText}, content-type=${ct}): ${snippet}`;
			this.log.error(msg);
			throw new Error(msg);
		}

		const json: unknown = parsed.json;

		if (!res.ok) {
			this.log.error(
				'Cync refresh failed: HTTP %d %s %o',
				res.status,
				res.statusText,
				json,
			);
			const errBody = json as CyncErrorBody;
			const msg =
				errBody.error?.msg ??
				`Cync refresh failed with status ${res.status} ${res.statusText}`;
			throw new Error(msg);
		}

		const obj = json as Record<string, unknown>;
		this.log.debug('Cync refresh response: keys=%o', Object.keys(obj));

		const accessTokenRaw = obj.access_token ?? obj.accessToken;
		const refreshTokenRaw = obj.refresh_token ?? obj.refreshToken;

		const expiresAtRaw = obj.expires_at ?? obj.expiresAt;
		const expireInRaw =
			obj.expire_in ??
			obj.expires_in ??
			obj.expireIn ??
			obj.expiresIn;

		const accessToken =
			typeof accessTokenRaw === 'string' && accessTokenRaw.length > 0
				? accessTokenRaw
				: undefined;

		if (!accessToken) {
			this.log.error('Cync refresh missing access_token: %o', json);
			throw new Error('Cync refresh response missing access_token');
		}

		const next: CyncRefreshResponse = {
			accessToken,
		};

		if (typeof refreshTokenRaw === 'string' && refreshTokenRaw.length > 0) {
			next.refreshToken = refreshTokenRaw;
		}

		// Prefer absolute expiresAt if present; otherwise derive from expire_in
		let expiresAt: number | undefined;

		if (typeof expiresAtRaw === 'number') {
			expiresAt = expiresAtRaw < 2_000_000_000 ? expiresAtRaw * 1000 : expiresAtRaw;
		} else if (typeof expiresAtRaw === 'string') {
			const n = Number(expiresAtRaw);
			if (Number.isFinite(n)) {
				expiresAt = n < 2_000_000_000 ? n * 1000 : n;
			}
		} else if (typeof expireInRaw === 'number' && expireInRaw > 0) {
			expiresAt = Date.now() + expireInRaw * 1000;
		} else if (typeof expireInRaw === 'string') {
			const n = Number(expireInRaw);
			if (Number.isFinite(n) && n > 0) {
				expiresAt = Date.now() + n * 1000;
			}
		}

		if (expiresAt !== undefined) {
			next.expiresAt = expiresAt;
		}

		return next;
	}

	/**
	 * Fetch the list of meshes/devices for the current user from the cloud.
	 *
	 * This roughly matches CyncCloudAPI.get_devices() from cync-lan, but in a
	 * simplified, single-call interface.
	 */
	public async getCloudConfig(): Promise<CyncCloudConfig> {
		this.ensureSession();

		const devicesUrl = `${CYNC_API_BASE}user/${this.userId}/subscribe/devices`;
		const headers = {
			'Access-Token': this.accessToken as string,
		};

		this.log.debug('Fetching Cync devices from %s', devicesUrl);

		const res = (await fetch(devicesUrl, {
			method: 'GET',
			headers: {
				...headers,
				'Accept': 'application/json',
			},
		})) as HttpResponse;

		const parsed = await this.readBodyOnce(res);

		if (parsed.text.trim().length === 0) {
			const ct = parsed.contentType ?? 'unknown';
			throw new Error(
				`Cync devices returned empty body: HTTP ${res.status} ${res.statusText} (content-type=${ct})`,
			);
		}

		if (parsed.json === null) {
			const ct = parsed.contentType ?? 'unknown';
			const snippet = parsed.text.trim().slice(0, 300);
			throw new Error(
				`Cync devices returned non-JSON payload: HTTP ${res.status} ${res.statusText} (content-type=${ct}): ${snippet}`,
			);
		}

		const json: unknown = parsed.json;

		if (!res.ok) {
			this.log.error(
				'Cync devices call failed: HTTP %d %s %o',
				res.status,
				res.statusText,
				json,
			);
			const errBody = json as CyncErrorBody;
			const msg = errBody.error?.msg ?? 'Unknown error from Cync devices API';
			throw new Error(msg);
		}

		// DEBUG: log high-level shape without dumping any secrets.
		if (Array.isArray(json)) {
			this.log.debug(
				'Cync devices payload: top-level array length=%d; first item keys=%o',
				json.length,
				json.length > 0 ? Object.keys((json as Record<string, unknown>[])[0]) : [],
			);
		} else if (json && typeof json === 'object') {
			this.log.debug(
				'Cync devices payload: top-level object keys=%o',
				Object.keys(json as Record<string, unknown>),
			);
		} else {
			this.log.debug('Cync devices payload: top-level type=%s', typeof json);
		}

		// Some Cync responses wrap arrays; others are raw arrays.
		let meshes: CyncDeviceMesh[] = [];

		if (Array.isArray(json)) {
			meshes = json as CyncDeviceMesh[];
		} else if (json && typeof json === 'object') {
			const obj = json as Record<string, unknown>;

			this.log.debug(
				'Cync devices payload (object) example values for known keys=%o',
				{
					dataType: typeof obj.data,
					devicesType: typeof (obj.devices as unknown),
					meshesType: typeof (obj.meshes as unknown),
				},
			);

			if (Array.isArray(obj.data)) {
				meshes = obj.data as CyncDeviceMesh[];
			} else if (Array.isArray(obj.meshes)) {
				meshes = obj.meshes as CyncDeviceMesh[];
			}
		}

		return { meshes };
	}

	/**
	 * Convenience to fetch the properties object for a single device.
	 */
	public async getDeviceProperties(
		productId: string,
		deviceId: string,
	): Promise<Record<string, unknown>> {
		this.ensureSession();

		const url = `${CYNC_API_BASE}product/${encodeURIComponent(
			productId,
		)}/device/${encodeURIComponent(deviceId)}/property`;

		const res = (await fetch(url, {
			method: 'GET',
			headers: {
				'Access-Token': this.accessToken as string,
				'Accept': 'application/json',
			},
		})) as HttpResponse;

		const parsed = await this.readBodyOnce(res);

		if (parsed.text.trim().length === 0) {
			const ct = parsed.contentType ?? 'unknown';
			throw new Error(
				`Cync properties returned empty body: HTTP ${res.status} ${res.statusText} (content-type=${ct})`,
			);
		}

		if (parsed.json === null) {
			const ct = parsed.contentType ?? 'unknown';
			const snippet = parsed.text.trim().slice(0, 300);
			throw new Error(
				`Cync properties returned non-JSON payload: HTTP ${res.status} ${res.statusText} (content-type=${ct}): ${snippet}`,
			);
		}

		const json: unknown = parsed.json;

		if (!res.ok) {
			const { code, msg } = extractCyncError(json);
			const outMsg = msg ?? `Cync properties failed with ${res.status}`;

			if (isDevicePropertyNotExists(res.status, json)) {
				this.log.debug(
					'Cync properties call failed (expected): HTTP %d %s code=%s msg=%s',
					res.status,
					res.statusText,
					code !== undefined ? String(code) : 'unknown',
					outMsg,
				);
			} else {
				this.log.error(
					'Cync properties call failed: HTTP %d %s %o',
					res.status,
					res.statusText,
					json,
				);
			}

			const e: CyncApiError = {
				status: res.status,
				statusText: res.statusText,
				body: json,
				code,
				msg: outMsg,
			};

			throw e;
		}

		return json as Record<string, unknown>;
	}

	public restoreSession(accessToken: string, userId: string): void {
		this.accessToken = accessToken;
		this.userId = userId;
		this.log.info('Cync: restored session from stored token; userId=%s', userId);
	}

	public getSessionSnapshot(): { accessToken: string | null; userId: string | null } {
		return {
			accessToken: this.accessToken,
			userId: this.userId,
		};
	}

	// HTTP Body Parser: Reads body once; attempts JSON parse; preserves raw text for debugging
	private async readBodyOnce(res: HttpResponse): Promise<{
		text: string;
		json: unknown | null;
		contentType: string | null;
	}> {
		const contentType = res.headers?.get('content-type') ?? null;

		const text = await res.text().catch(() => '');
		const trimmed = text.trim();

		if (trimmed.length === 0) {
			return { text, json: null, contentType };
		}

		// Only attempt JSON parse if it looks like JSON (or content-type claims JSON)
		const looksJson =
			trimmed.startsWith('{') ||
			trimmed.startsWith('[') ||
			(contentType?.toLowerCase().includes('application/json') ?? false);

		if (!looksJson) {
			return { text, json: null, contentType };
		}

		try {
			return { text, json: JSON.parse(trimmed) as unknown, contentType };
		} catch {
			return { text, json: null, contentType };
		}
	}

	private ensureSession(): void {
		if (!this.accessToken || !this.userId) {
			throw new Error('Cync session not initialised. Call loginWithTwoFactor() or loginWithPassword() first.');
		}
	}
	// LAN Login Blob Builder: Generates the auth_code payload used by Cync LAN TCP
	public static buildLanLoginCode(userId: string, authorize: string): Uint8Array {
		const authBytes = Buffer.from(authorize, 'ascii');
		const lengthByte = 10 + authBytes.length;

		if (lengthByte > 0xff) {
			throw new Error('Cync LAN authorize token too long to encode.');
		}

		const userIdNum = Number.parseInt(userId, 10);
		if (!Number.isFinite(userIdNum) || userIdNum < 0) {
			throw new Error(`Invalid Cync userId for LAN auth: ${userId}`);
		}

		const header = Buffer.from('13000000', 'hex');

		const lenBuf = Buffer.alloc(1);
		lenBuf.writeUInt8(lengthByte & 0xff, 0);

		const cmdBuf = Buffer.from('03', 'hex');

		const userIdBuf = Buffer.alloc(4);
		userIdBuf.writeUInt32BE(userIdNum >>> 0, 0);

		const authLenBuf = Buffer.alloc(2);
		authLenBuf.writeUInt16BE(authBytes.length, 0);

		const tail = Buffer.from('0000b4', 'hex');

		const loginBuf = Buffer.concat([
			header,
			lenBuf,
			cmdBuf,
			userIdBuf,
			authLenBuf,
			authBytes,
			tail,
		]);

		return new Uint8Array(loginBuf);
	}

	private static randomLoginResource(): string {
		const chars = 'abcdefghijklmnopqrstuvwxyz';
		let out = '';
		for (let i = 0; i < 16; i += 1) {
			out += chars.charAt(Math.floor(Math.random() * chars.length));
		}
		return out;
	}
}
