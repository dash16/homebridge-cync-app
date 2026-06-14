// src/cync/cync-client.ts
import {
	ConfigClient,
	CyncCloudConfig,
	CyncLoginSession,
	CyncLogger,
} from './config-client.js';
import { TcpClient } from './tcp-client.js';
import { CyncTokenStore, CyncTokenData } from './token-store.js';
import { parseLightShows } from './light-shows.js';

type SessionWithPossibleTokens = {
	accessToken?: string;
	jwt?: string;
	refreshToken?: string;
	refreshJwt?: string;
	expiresAt?: number;
};

const defaultLogger: CyncLogger = {
	debug: (...args: unknown[]) => console.debug('[cync-client]', ...args),
	info: (...args: unknown[]) => console.info('[cync-client]', ...args),
	warn: (...args: unknown[]) => console.warn('[cync-client]', ...args),
	error: (...args: unknown[]) => console.error('[cync-client]', ...args),
};

export class CyncClient {
	private readonly log: CyncLogger;
	private readonly configClient: ConfigClient;
	private readonly tcpClient: TcpClient;
	private readonly unsupportedPropertiesProductIds = new Set<string>();
	private readonly tokenStore: CyncTokenStore;
	private tokenData: CyncTokenData | null = null;
	private unwrapApiError(err: unknown): { status?: number; code?: number; msg?: string } {
		if (!err || typeof err !== 'object') {
			return {};
		}

		if (err instanceof Error) {
			return { msg: err.message };
		}

		if (typeof err !== 'object') {
			return {};
		}

		const e = err as Record<string, unknown>;

		const status = typeof e.status === 'number' ? e.status : undefined;
		const code = typeof e.code === 'number' ? e.code : undefined;
		const msg = typeof e.msg === 'string' ? e.msg : undefined;

		// Some errors embed the cloud payload under "body"
		const body = e.body;
		if (body && typeof body === 'object') {
			const b = body as Record<string, unknown>;
			const errorObj = b.error;

			if (errorObj && typeof errorObj === 'object') {
				const eo = errorObj as Record<string, unknown>;
				const bodyCode = typeof eo.code === 'number' ? eo.code : undefined;
				const bodyMsg = typeof eo.msg === 'string' ? eo.msg : undefined;

				return {
					status,
					code: code ?? bodyCode,
					msg: msg ?? bodyMsg,
				};
			}
		}

		// Fallback: standard Error.message
		if (err instanceof Error) {
			return { status, code, msg: msg ?? err.message };
		}

		return { status, code, msg };
	}

	private formatApiError(err: unknown): string {
		const u = this.unwrapApiError(err);
		const parts: string[] = [];
		if (u.status !== undefined) {
			parts.push(`status=${u.status}`);
		}
		if (u.code !== undefined) {
			parts.push(`code=${u.code}`);
		}
		if (u.msg) {
			parts.push(`msg=${u.msg}`);
		}
		return parts.length > 0 ? parts.join(' ') : String(err);
	}

	private isDevicePropertyNotExistsError(err: unknown): boolean {
		const u = this.unwrapApiError(err);

		// Observed cloud response:
		// HTTP 404 Not Found { error: { msg: 'device property not exists', code: 4041009 } }
		if (u.status === 404 && (u.code === 4041009 || u.msg === 'device property not exists')) {
			return true;
		}

		if (u.msg && u.msg.includes('device property not exists')) {
			return true;
		}

		return false;
	}

	private formatMeshLabel(mesh: { name?: string | null; id: string | number }): string {
		const rawName = typeof mesh.name === 'string' ? mesh.name.trim() : '';
		return rawName.length > 0 ? rawName : `No Name (id=${String(mesh.id)})`;
	}
	// Populated after successful login.
	private session: CyncLoginSession | null = null;
	private cloudConfig: CyncCloudConfig | null = null;

	// LAN Topology Cache: mirrors HA's home_devices / home_controllers / switchID_to_homeID
	private homeDevices: Record<string, string[]> = {};
	private homeControllers: Record<string, number[]> = {};
	private switchIdToHomeId: Record<number, string> = {};

	// Credentials from config.json, used to drive 2FA bootstrap.
	//
	// Canonical keys (must match platform + config):
	//   - username: login identifier (email address used in Cync app)
	//   - password: account password
	//   - twoFactor: 6-digit OTP, optional; when present we complete 2FA on restart.
	private readonly loginConfig: { username: string; password: string; twoFactor?: string };

	// Optional LAN update hook for the platform
	private lanUpdateHandler: ((update: unknown) => void) | null = null;

	// LAN Update Bridge: allow platform to handle device updates
	public onLanDeviceUpdate(handler: (update: unknown) => void): void {
		this.lanUpdateHandler = handler;
	}

	// LAN Auth Blob Getter: Returns the LAN login code if available
	public getLanLoginCode(): Uint8Array {
		if (!this.tokenData?.lanLoginCode) {
			this.log.debug('CyncClient: getLanLoginCode() → no LAN blob in token store.');
			return new Uint8Array();
		}

		try {
			return Uint8Array.from(Buffer.from(this.tokenData.lanLoginCode, 'base64'));
		} catch {
			this.log.warn('CyncClient: stored LAN login code is invalid base64.');
			return new Uint8Array();
		}
	}

	constructor(
		configClient: ConfigClient,
		tcpClient: TcpClient,
		loginConfig: { username: string; password: string; twoFactor?: string },
		storagePath: string,
		logger?: CyncLogger,
	) {
		this.configClient = configClient;
		this.tcpClient = tcpClient;
		this.log = logger ?? defaultLogger;

		this.loginConfig = loginConfig;
		this.tokenStore = new CyncTokenStore(storagePath);

		// One-time sanity log so we can see exactly what was passed in from platform/config.
		this.log.debug(
			'CyncClient: constructed with loginConfig=%o',
			{
				username: loginConfig.username,
				hasPassword: !!loginConfig.password,
				twoFactor: loginConfig.twoFactor,
			},
		);
	}
	private hasConfiguredTwoFactorCode(): boolean {
		const code = this.loginConfig.twoFactor?.trim() ?? '';
		return code.length > 0;
	}

	private isTokenExpiredOrStale(expiresAt: number | undefined, skewMs = 60_000): boolean {
		if (!expiresAt || !Number.isFinite(expiresAt)) {
			return false;
		}
		return Date.now() >= (expiresAt - skewMs);
	}

	/**
		 * Ensure we are logged in:
		 * 1) Try stored token.
		 * 2) If none/invalid, run 2FA flow (request or complete).
		 * Returns true on successful login, false if we need user input (2FA).
		 */
	public async ensureLoggedIn(): Promise<boolean> {
		// 1) Try stored token/session
		const stored = await this.tokenStore.load();
		if (stored) {
			this.log.info(
				'CyncClient: loaded stored token for userId=%s (expiresAt=%s)',
				stored.userId,
				stored.expiresAt ? new Date(stored.expiresAt).toISOString() : 'unknown',
			);

			this.tokenData = stored;

			// If the token is expired / near-expiry, refresh it now.
			if (this.isTokenExpiredOrStale(stored.expiresAt)) {
				this.log.warn(
					'CyncClient: stored access token is expired or near expiry; refreshing before use.',
				);

				const refreshed = await this.refreshAccessToken(stored);
				if (!refreshed) {
					this.log.error(
						'CyncClient: unable to refresh stored token; reauthentication is required.',
					);

					this.tokenData = null;

					if (this.hasConfiguredTwoFactorCode()) {
						this.log.error(
							'CyncClient: a twoFactor code is still present in config. Cync verification codes expire quickly, so this code will not be reused.',
						);
						this.log.error(
							'CyncClient: remove stale twoFactor value from config, request a fresh code, then add the new code and restart.',
						);
						return false;
					}
				} else {
					return true; // refreshAccessToken() already saves + applies
				}
			} else {
				// Token looks valid; apply it.
				this.applyAccessToken(stored);
				return true;
			}
		}

		// 2) No stored token OR refresh failed – run 2FA bootstrap
		const { username, password, twoFactor } = this.loginConfig;

		if (!username || !password) {
			this.log.error('CyncClient: username and password are required to obtain a new token.');
			return false;
		}

		const trimmedCode = typeof twoFactor === 'string' ? twoFactor.trim() : '';
		if (trimmedCode.length === 0) {
			this.log.info('Cync: starting 2FA handshake for %s', username);
			await this.requestTwoFactorCode(username);
			this.log.info(
				'Cync: 2FA code sent to your email. Enter the code as "twoFactor" in the plugin config and restart Homebridge to complete login.',
			);
			return false;
		}

		// We have a 2FA code – complete login and persist token
		this.log.info('Cync: completing 2FA login for %s', username);
		const loginResult = await this.completeTwoFactorLogin(username, password, trimmedCode);

		const authorize = typeof (loginResult.raw as Record<string, unknown>)?.authorize === 'string'
			? (loginResult.raw as Record<string, unknown>).authorize as string
			: undefined;

		let lanLoginCode: string | undefined;
		if (authorize) {
			const lanBlob = ConfigClient.buildLanLoginCode(String(loginResult.userId), authorize);
			lanLoginCode = Buffer.from(lanBlob).toString('base64');
		} else {
			this.log.warn('CyncClient: login response missing "authorize"; LAN login will be disabled.');
		}

		const tokenData: CyncTokenData = {
			userId: String(loginResult.userId),
			accessToken: loginResult.accessToken,
			refreshToken: loginResult.refreshToken,
			expiresAt: loginResult.expiresAt ?? undefined,
			authorize,
			lanLoginCode,
		};

		await this.tokenStore.save(tokenData);
		this.tokenData = tokenData;

		this.applyAccessToken(tokenData);

		this.log.info('Cync login successful; userId=%s (token stored)', tokenData.userId);
		return true;
	}

	/**
	 * Internal helper: request a 2FA email code using existing authenticate().
	 * Accepts the same username value we store in loginConfig (email address for Cync).
	 */
	private async requestTwoFactorCode(username: string): Promise<void> {
		await this.authenticate(username);
	}

	/**
	 * Internal helper: complete 2FA login using existing submitTwoFactor().
	 * This converts CyncLoginSession into the richer shape we want for token storage.
	 */
	private async completeTwoFactorLogin(
		email: string,
		password: string,
		code: string,
	): Promise<CyncLoginSession & { accessToken: string; refreshToken?: string; expiresAt?: number; authorize?: string }> {
		const session = await this.submitTwoFactor(email, password, code);

		const raw = session.raw as Record<string, unknown>;
		const authorize = typeof raw.authorize === 'string' ? raw.authorize : undefined;

		const s = session as unknown as SessionWithPossibleTokens;
		const access = s.accessToken ?? s.jwt;
		if (!access) {
			throw new Error('CyncClient: login session did not return an access token.');
		}

		return {
			...session,
			accessToken: access,
			refreshToken: s.refreshToken ?? s.refreshJwt,
			expiresAt: s.expiresAt,
			authorize,
		};
	}


	/**
	 * Apply an access token (and associated metadata) to the underlying ConfigClient,
	 * and hydrate our local session snapshot so ensureSession() passes.
	 */
	private applyAccessToken(tokenData: CyncTokenData): void {
		if (!tokenData.accessToken || !tokenData.userId) {
			this.log.warn(
				'CyncClient: applyAccessToken called with missing userId or accessToken; tokenData=%o',
				{
					userId: tokenData.userId,
					hasAccessToken: !!tokenData.accessToken,
					expiresAt: tokenData.expiresAt,
				},
			);
			return;
		}

		// Push into ConfigClient so cloud calls can use it.
		this.configClient.restoreSession(tokenData.accessToken, tokenData.userId);

		// Hydrate our own session snapshot so ensureSession() passes.
		this.session = {
			accessToken: tokenData.accessToken,
			userId: tokenData.userId,
			raw: {
				source: 'tokenStore',
				expiresAt: tokenData.expiresAt,
			},
		};
		// Restore LAN auth blob into memory
		if (tokenData.authorize && !tokenData.lanLoginCode) {
			const lanBlob = ConfigClient.buildLanLoginCode(tokenData.userId, tokenData.authorize);
			tokenData.lanLoginCode = Buffer.from(lanBlob).toString('base64');
			this.log.debug('CyncClient: LAN login code generated from stored authorize.');
		} else if (tokenData.authorize && tokenData.lanLoginCode) {
			this.log.debug('CyncClient: LAN login code present in token store.');
		} else {
			this.log.debug('CyncClient: token store missing LAN login fields.');
		}

		this.log.debug(
			'CyncClient: access token applied from %s; userId=%s, expiresAt=%s',
			'tokenStore',
			tokenData.userId,
			tokenData.expiresAt ? new Date(tokenData.expiresAt).toISOString() : 'unknown',
		);
	}


	/**
	 * Step 1 of 2FA flow:
	 *
	 * Trigger an email with a one-time code to the Cync account email.
	 *
	 * Call sequence:
	 *   await client.authenticate(username, password);  // sends email
	 *   // user reads email, gets code…
	 *   await client.submitTwoFactor(username, password, code); // completes login
	 */
	// Refresh Error Detector: identifies "Access-Token Expired" responses
	private isAccessTokenExpiredError(err: unknown): boolean {
		if (!err) {
			return false;
		}

		// Handle CyncApiError shape thrown by ConfigClient (status/code/msg/body)
		const u = this.unwrapApiError(err);
		if (
			u.code === 4031021 ||
			u.msg === 'Access-Token Expired' ||
			(u.msg && u.msg.includes('Access-Token Expired'))
		) {
			return true;
		}

		// Plain Error('Access-Token Expired') case
		if (err instanceof Error) {
			if (
				err.message === 'Access-Token Expired' ||
				err.message.includes('Access-Token Expired')
			) {
				return true;
			}
		}

		// Legacy / alternate shapes
		type ErrorWithShape = {
			status?: number;
			message?: string;
			error?: { msg?: string; code?: number };
		};

		const e = err as ErrorWithShape;

		if (e.error && (e.error.msg === 'Access-Token Expired' || e.error.code === 4031021)) {
			return true;
		}

		if (e.status === 403 && e.message && e.message.includes('Access-Token Expired')) {
			return true;
		}

		return false;
	}

	// Token Refresh Helper: exchanges refreshToken for a new accessToken (no password fallback)
	private async refreshAccessToken(
		stored: CyncTokenData,
	): Promise<CyncTokenData | null> {
		if (!stored.refreshToken) {
			this.log.warn(
				'CyncClient: refreshAccessToken() called but no refreshToken is stored; reauth will be required.',
			);
			return null;
		}

		try {
			const resp = await this.configClient.refreshAccessToken(stored.refreshToken);

			const next: CyncTokenData = {
				...stored,
				accessToken: resp.accessToken,
				refreshToken: resp.refreshToken ?? stored.refreshToken,
				expiresAt: resp.expiresAt ?? stored.expiresAt,
			};

			await this.tokenStore.save(next);
			this.tokenData = next;
			this.applyAccessToken(next);

			this.log.info(
				'CyncClient: refreshed access token for userId=%s; expiresAt=%s',
				next.userId,
				next.expiresAt ? new Date(next.expiresAt).toISOString() : 'unknown',
			);

			return next;
		} catch (err) {
			this.log.error('CyncClient: token refresh failed: %o', err);
			return null;
		}
	}

	// Cloud Config Wrapper: auto-refreshes access token
	private async getCloudConfigWithRefresh(): Promise<CyncCloudConfig> {
		try {
			return await this.configClient.getCloudConfig();
		} catch (err) {
			if (this.isAccessTokenExpiredError(err) && this.tokenData) {
				this.log.warn(
					'CyncClient: access token expired when calling getCloudConfig(); refreshing and retrying once.',
				);

				const refreshed = await this.refreshAccessToken(this.tokenData);
				if (refreshed) {
					return await this.configClient.getCloudConfig();
				}
			}

			throw err;
		}
	}

	// Device Properties Wrapper: auto-refresh on Access-Token Expired for mesh calls
	private async getDevicePropertiesWithRefresh(
		productId: string | number,
		meshId: string | number,
	): Promise<Record<string, unknown>> {
		const productIdStr = String(productId);

		// If we've already learned this product_id never supports the endpoint, skip.
		if (this.unsupportedPropertiesProductIds.has(productIdStr)) {
			return {};
		}

		try {
			return await this.configClient.getDeviceProperties(productIdStr, String(meshId));
		} catch (err) {
			// Expected case for some product lines: endpoint not implemented.
			if (this.isDevicePropertyNotExistsError(err)) {
				this.unsupportedPropertiesProductIds.add(productIdStr);
				this.log.debug(
					'CyncClient: properties unsupported for product_id=%s (mesh id=%s); caching and skipping.',
					productIdStr,
				);
				return {};
			}

			if (this.isAccessTokenExpiredError(err) && this.tokenData) {
				this.log.warn(
					'CyncClient: access token expired when calling getDeviceProperties(); refreshing and retrying once.',
				);

				const refreshed = await this.refreshAccessToken(this.tokenData);
				if (refreshed) {
					return await this.configClient.getDeviceProperties(productIdStr, String(meshId));
				}
			}

			throw err;
		}
	}

	public async authenticate(username: string): Promise<void> {
		const email = username.trim();

		this.log.info('CyncClient: requesting 2FA code for %s', email);
		await this.configClient.sendTwoFactorCode(email);
		this.log.info(
			'CyncClient: 2FA email requested; call submitTwoFactor() once the user has the code.',
		);
	}

	/**
	 * Step 2 of 2FA flow:
	 *
	 * Use the emailed OTP code to complete login.
	 * This method is stateless: it does not rely on prior calls to authenticate()
	 * in the same process, so it works across Homebridge restarts.
	 */
	public async submitTwoFactor(
		username: string,
		password: string,
		code: string,
	): Promise<CyncLoginSession> {
		const trimmedEmail = username.trim();
		const trimmedCode = code.trim();

		this.log.info('CyncClient: completing 2FA login for %s', trimmedEmail);

		const session = await this.configClient.loginWithTwoFactor(
			trimmedEmail,
			password,
			trimmedCode,
		);

		this.session = session;

		this.log.debug(
			'CyncClient: session snapshot after login; hasAccessToken=%s userId=%s',
			!!session.accessToken,
			session.userId,
		);

		this.log.info(
			'CyncClient: login successful; userId=%s',
			session.userId,
		);

		return session;
	}

	/**
	 * Fetch and cache the cloud configuration (meshes/devices) for the logged-in user.
	 * Also builds HA-style LAN topology mappings:
	 *  - homeDevices[homeId][meshIndex] -> deviceId
	 *  - homeControllers[homeId] -> controllerIds[]
	 *  - switchIdToHomeId[controllerId] -> homeId
	 */
	public async loadConfiguration(): Promise<CyncCloudConfig> {
		this.ensureSession();

		this.log.info('CyncClient: loading Cync cloud configuration…');
		const cfg = await this.getCloudConfigWithRefresh();

		// Reset LAN topology caches on each reload
		this.homeDevices = {};
		this.homeControllers = {};
		this.switchIdToHomeId = {};

		// Debug: inspect per-mesh properties so we can find the real devices.
		for (const mesh of cfg.meshes) {
			const meshName = this.formatMeshLabel({ name: mesh.name, id: mesh.id });
			const homeId = String(mesh.id);

			this.log.debug(
				'CyncClient: probing properties for mesh %s (id=%s, product_id=%s)',
				meshName,
				mesh.id,
				mesh.product_id,
			);

			// Per-home maps, mirroring HA's CyncUserData.get_cync_config()
			const homeDevices: string[] = [];
			const homeControllers: number[] = [];
			const productIdStr = String(mesh.product_id);
			if (this.unsupportedPropertiesProductIds.has(productIdStr)) {
				this.log.debug(
					'CyncClient: skipping properties probe for mesh %s (product_id=%s) — previously marked unsupported.',
					meshName,
					productIdStr,
				);
				continue;
			}
			try {
				const props = await this.getDevicePropertiesWithRefresh(
					mesh.product_id,
					mesh.id,
				);

				this.log.debug(
					'CyncClient: mesh %s properties keys=%o',
					meshName,
					Object.keys(props),
				);

				const propsRecord = props as Record<string, unknown>;

				(mesh as Record<string, unknown>).rawProperties = propsRecord;
				(mesh as Record<string, unknown>).lightShows = propsRecord.lightShows;
				(mesh as Record<string, unknown>).sceneArray = propsRecord.sceneArray;
				(mesh as Record<string, unknown>).musicShows = propsRecord.musicShows;

				this.log.debug(
					'CyncClient: mesh %s properties keys=%s',
					meshName,
					JSON.stringify(Object.keys(propsRecord).sort()),
				);

				if (propsRecord.sceneArray !== undefined) {
					this.log.debug(
						'CyncClient: mesh %s sceneArray=%s',
						meshName,
						JSON.stringify(propsRecord.sceneArray),
					);
				}

				if (propsRecord.lightShows !== undefined) {
					this.log.debug(
						'CyncClient: mesh %s lightShows=%s',
						meshName,
						JSON.stringify(propsRecord.lightShows),
					);
				}

				if (propsRecord.musicShows !== undefined) {
					this.log.debug(
						'CyncClient: mesh %s musicShows=%s',
						meshName,
						JSON.stringify(propsRecord.musicShows),
					);
				}

				type DeviceProps = Record<string, unknown>;
				const bulbsArray = (props as DeviceProps).bulbsArray as unknown;

				if (Array.isArray(bulbsArray)) {
					this.log.info(
						'CyncClient: mesh %s bulbsArray length=%d; first item keys=%o',
						meshName,
						bulbsArray.length,
						bulbsArray[0] ? Object.keys(bulbsArray[0] as Record<string, unknown>) : [],
					);

					// Bulb Capability Debug: log each bulb so we can classify plugs vs lights
					bulbsArray.forEach((bulb, index) => {
						const record = bulb as Record<string, unknown>;

						this.log.debug(
							'CyncClient: bulb #%d for mesh %s → %o',
							index,
							meshName,
							{
								displayName: record.displayName,
								deviceID: record.deviceID ?? record.deviceId,
								deviceType: record.deviceType,
								loadSelection: record.loadSelection,
								defaultBrightness: record.defaultBrightness,
								lightRingColor: record.lightRingColor,
								raw: record,
							},
						);
					});

					type RawDevice = Record<string, unknown>;
					const rawDevices = bulbsArray as unknown[];

					const devicesForMesh: unknown[] = [];

					for (const raw of rawDevices) {
						const d = raw as RawDevice;

						const displayName = d.displayName as string | undefined;

						// deviceID can be number or string – normalize to string
						const deviceIdRaw = (d.deviceID ?? d.deviceId) as string | number | undefined;
						const deviceIdStr =
							deviceIdRaw !== undefined && deviceIdRaw !== null
								? String(deviceIdRaw)
								: undefined;

						const wifiMac = d.wifiMac as string | undefined;
						const productId =
							(d.product_id as string | undefined) ?? mesh.product_id;

						// Reproduce HA's mesh index calculation:
						// current_index = ((deviceID % home_id) % 1000) + (int((deviceID % home_id) / 1000) * 256)
						const homeIdNum = Number(mesh.id);
						const deviceIdNum =
							typeof deviceIdRaw === 'number'
								? deviceIdRaw
								: deviceIdRaw !== undefined && deviceIdRaw !== null
									? Number(deviceIdRaw)
									: NaN;

						let meshIndex: number | undefined;
						if (!Number.isNaN(homeIdNum) && !Number.isNaN(deviceIdNum) && homeIdNum !== 0) {
							const mod = deviceIdNum % homeIdNum;
							meshIndex = (mod % 1000) + Math.floor(mod / 1000) * 256;
						}

						// The Cync REST API may return switchID as a composite value that
						// encodes a device index in the trailing 3 digits
						// (e.g. 1850364131001 → controller 1850364131, index 1).
						// rawSwitchId is preserved for accessory identity, API correlation, and logs.
						// controllerId is the uint32 value used for LAN packet writes (writeUInt32BE).
						const rawSwitchId = d.switchID as number | undefined;
						const isComposite = rawSwitchId !== undefined && rawSwitchId > 0xffffffff;
						const controllerId = isComposite ? Math.floor(rawSwitchId! / 1000) : rawSwitchId;
						const switchIndex = isComposite ? rawSwitchId! % 1000 : undefined;

						// Use deviceID first, then wifiMac (stripped), then a mesh-based fallback.
						const id =
							deviceIdStr ??
							(wifiMac ? wifiMac.replace(/:/g, '') : undefined) ??
							`${mesh.id}-${productId ?? 'unknown'}`;

						// Mirror HA's home_devices[homeId][meshIndex] = deviceId
						if (meshIndex !== undefined && deviceIdStr) {
							while (homeDevices.length <= meshIndex) {
								homeDevices.push('');
							}
							homeDevices[meshIndex] = deviceIdStr;
						}

						// Mirror HA's switchID_to_homeID + home_controllers (keyed by uint32 controllerId)
						if (controllerId !== undefined && Number.isFinite(controllerId) && controllerId > 0) {
							if (!this.switchIdToHomeId[controllerId]) {
								this.switchIdToHomeId[controllerId] = homeId;
							}
							if (!homeControllers.includes(controllerId)) {
								homeControllers.push(controllerId);
							}
						}

						const rawLightShowCrcMap = d.savedLightShowsCrcMap;

						const deviceLightShows =
							rawLightShowCrcMap &&
							typeof rawLightShowCrcMap === 'object'
								? parseLightShows(propsRecord.lightShows, rawLightShowCrcMap)
								: [];

						devicesForMesh.push({
							id,
							name: displayName ?? undefined,
							product_id: productId,
							device_id: deviceIdStr,
							mac: wifiMac,
							mesh_id: meshIndex,
							switch_controller: controllerId,
							raw_switch_id: rawSwitchId,
							...(switchIndex !== undefined && { switch_index: switchIndex }),
							raw: d,
							...(deviceLightShows.length > 0 && { light_shows: deviceLightShows }),
						});
					}

					// Attach per-mesh devices to the cloud config (what platform.ts already uses)
					(mesh as Record<string, unknown>).devices = devicesForMesh;

					// Persist per-home topology maps for TCP parsing later
					if (homeDevices.length > 0) {
						this.homeDevices[homeId] = homeDevices;
					}
					if (homeControllers.length > 0) {
						this.homeControllers[homeId] = homeControllers;
					}

					// Maintain the legacy controller→device mapping for now so existing TCP code keeps working.
					for (const dev of devicesForMesh) {
						const record = dev as Record<string, unknown>;
						const controllerId = record.switch_controller as number | undefined;

						const deviceId =
							(record.device_id as string | undefined) ??
							(record.id as string | undefined);

						if (controllerId !== undefined && deviceId) {
							this.tcpClient.registerSwitchMapping(controllerId, deviceId);
						}
					}
				} else {
					this.log.info(
						'CyncClient: mesh %s has no bulbsArray in properties; props keys=%o',
						meshName,
						Object.keys(props),
					);
				}
			} catch (err) {
				if (this.isDevicePropertyNotExistsError(err)) {
					this.log.debug(
						'CyncClient: getDeviceProperties not supported for mesh %s (%s).',
						meshName,
						String(mesh.id),
					);
					continue;
				}

				this.log.warn(
					'CyncClient: getDeviceProperties failed for mesh %s (%s): %s',
					meshName,
					String(mesh.id),
					this.formatApiError(err),
				);
			}
		}

		this.cloudConfig = cfg;
		this.log.info(
			'CyncClient: cloud configuration loaded; meshes=%d',
			cfg.meshes.length,
		);

		return cfg;
	}

	public async activateLightShow(
		deviceId: string,
		showIndex: number,
		crc?: number,
	): Promise<boolean> {
		return this.tcpClient.activateLightShow(deviceId, showIndex);
	}

	public async activateMusicShow(
		deviceId: string,
		showIndex: number,
		crc?: number,
	): Promise<boolean> {
		return this.tcpClient.activateMusicShow(deviceId, showIndex);
	}

	public async startTransport(
		config: CyncCloudConfig,
		loginCode: Uint8Array,
	): Promise<void> {
		this.ensureSession();
		this.log.info('CyncClient: starting TCP transport…');

		// Push current LAN topology (built in loadConfiguration) into the TCP client
		const topology = this.getLanTopology();
		this.tcpClient.applyLanTopology(topology);

		// REQUIRED: subscribe to parsed device updates
		this.tcpClient.onDeviceUpdate((update) => {
			if (this.lanUpdateHandler) {
				this.lanUpdateHandler(update);
			} else {
				// Fallback: log only
				this.log.debug('[Cync TCP] device update callback fired; payload=%o', update);
			}
		});

		await this.tcpClient.connect(loginCode, config);
	}

	public getSessionSnapshot(): CyncLoginSession | null {
		return this.session;
	}

	public getCloudConfigSnapshot(): CyncCloudConfig | null {
		return this.cloudConfig;
	}

	public getLanTopology(): {
		homeDevices: Record<string, string[]>;
		homeControllers: Record<string, number[]>;
		switchIdToHomeId: Record<number, string>;
		} {
		return {
			homeDevices: this.homeDevices,
			homeControllers: this.homeControllers,
			switchIdToHomeId: this.switchIdToHomeId,
		};
	}

	private ensureSession(): void {
		if (!this.session) {
			throw new Error(
				'Cync session not initialised; complete 2FA login first.',
			);
		}
	}
}
