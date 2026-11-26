/** Diagnostic-only serialization. No raw values or untrusted field names leave this module. */
const names = new Set([
	'access_token', 'accessToken', 'refresh_token', 'refreshToken', 'expires_at', 'expiresAt',
	'expire_in', 'expires_in', 'expireIn', 'expiresIn', 'token', 'tokens', 'data', 'result', 'session',
	'credentials', 'auth', 'authentication', 'jwt', 'accessJwt', 'refreshJwt', 'refresh_jwt', 'access_jwt',
	'renewal_token', 'renewalToken', 'refresh', 'access', 'error', 'code', 'msg', 'message',
	'exp', 'ttl', 'expiration', 'expiration_time', 'expirationTime', 'expires', 'expiry',
	'refresh_expires_in', 'refresh_expires_at', 'refreshExpiresIn', 'refreshExpiresAt',
	'access_expires_in', 'access_expires_at', 'refresh_token_expires_in', 'refresh_token_expires_at',
]);
const expirationNames = new Set([
	'expires_at', 'expiresAt', 'expire_in', 'expires_in', 'expireIn', 'expiresIn',
	'exp', 'ttl', 'expiration', 'expiration_time', 'expirationTime', 'expires', 'expiry',
	'refresh_expires_in', 'refresh_expires_at', 'refreshExpiresIn', 'refreshExpiresAt',
	'access_expires_in', 'access_expires_at', 'refresh_token_expires_in', 'refresh_token_expires_at',
]);
const parserNames = new Set(['access_token', 'accessToken', 'refresh_token', 'refreshToken',
	'expires_at', 'expiresAt', 'expire_in', 'expires_in', 'expireIn', 'expiresIn']);

export interface RefreshInspectionOptions {
	previousAccessToken: string;
	emit: (event: object) => void;
}

export function inspectRefreshResponse(
	body: unknown, status: number, contentType: string | null | undefined, previousAccess: string, previousRefresh: string,
) {
	const fields: Record<string, unknown>[] = [];
	const root = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
	const comparison = (value: unknown, previous: string) => typeof value === 'string' && value.length > 0
		? (value === previous ? 'same' : 'different') : 'unrecognized';
	const candidate = (keys: string[], previous: string) => {
		const key = keys.find(key => root[key] !== null && root[key] !== undefined);
		return key === undefined ? 'absent' : comparison(root[key], previous);
	};
	// Iterative traversal covers nested arrays/objects without recursion depth failures.
	const pending = [{ value: body, path: '$', key: '', depth: 0 }];
	while (pending.length) {
		const { value, path, key, depth } = pending.pop()!;
		const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
		const normalized = key.replace(/[_-]/g, '').toLowerCase();
		const credential = /token|jwt|credential|authorize|authorization|password|secret|cookie|verification|otp/.test(normalized)
			|| normalized === 'refresh' || normalized === 'access'
			|| (typeof value === 'string' && (value === previousAccess || value === previousRefresh));
		const row: Record<string, unknown> = { path, type, parserRecognized: depth === 1 && parserNames.has(key) };
		if (credential) {
			row.credential = true;
			row.matchesAccess = comparison(value, previousAccess);
			row.matchesRefresh = comparison(value, previousRefresh);
		}
		if (expirationNames.has(key)) {
			row.expiration = true;
			if (typeof value === 'number' && Number.isFinite(value)) {
				row.numericValue = value;
			}
		}
		fields.push(row);
		if (value && typeof value === 'object') {
			const entries = Object.entries(value);
			for (let index = entries.length - 1; index >= 0; index--) {
				const [childKey, child] = entries[index];
				const segment = Array.isArray(value) ? `[${index}]` : `.${names.has(childKey) ? childKey : `<field${index}>`}`;
				pending.push({ value: child, path: path + segment, key: childKey, depth: depth + 1 });
			}
		}
	}
	const mime = contentType?.split(';')[0].trim().toLowerCase();
	return { event: 'response_inspected', status,
		contentType: ['application/json', 'text/json', 'text/html', 'text/plain'].includes(mime ?? '') ? mime : 'unrecognized',
		accessCredential: candidate(['access_token', 'accessToken'], previousAccess),
		refreshCredential: candidate(['refresh_token', 'refreshToken'], previousRefresh), fields };
}

/** Observer failures must not prevent saving credentials after an exchange. */
export function emitInspection(options: RefreshInspectionOptions | undefined, event: object): void {
	try {
		options?.emit(event);
	} catch {
		// Never expose observer exceptions, which can themselves contain secrets.
	}
}
