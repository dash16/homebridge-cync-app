// homebridge-ui/server.js
import { HomebridgePluginUiServer } from '@homebridge/plugin-ui-utils';
import { ConfigClient } from '../dist/cync/config-client.js';
import { format } from 'node:util';
import { CyncTokenStore, isRefreshTokenRejected } from '../dist/cync/token-store.js';
import { getCyncApkDeviceProfile } from '../dist/cync/device-capabilities.js';

function asShowList(value, crcMap) {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.filter(show =>
			show &&
			typeof show.index === 'number' &&
			typeof show.name === 'string' &&
			typeof crcMap[String(show.index)] === 'number',
		)
		.map(show => ({ index: show.index, name: show.name }));
}

class CyncUiServer extends HomebridgePluginUiServer {
	constructor() {
		super();

		this.configClient = new ConfigClient({
			debug: (...a) => console.debug('[cync-ui-config]', format(...a)),
			info:  (...a) => console.info('[cync-ui-config]', format(...a)),
			warn:  (...a) => console.warn('[cync-ui-config]', format(...a)),
			error: (...a) => console.error('[cync-ui-config]', format(...a)),
		});

		this.tokenStore = new CyncTokenStore(this.homebridgeStoragePath);

		this.onRequest('/request-otp', this.handleRequestOtp.bind(this));
		this.onRequest('/sign-out', this.handleSignOut.bind(this));
		this.onRequest('/status', this.handleStatus.bind(this));
		this.onRequest('/devices', this.handleDevices.bind(this));

		this.ready();
	}

	async handleRequestOtp(payload) {
		const email = typeof payload?.email === 'string' ? payload.email.trim() : '';
		if (!email) {
			return { ok: false, error: 'Missing email' };
		}

		await this.configClient.sendTwoFactorCode(email);
		return { ok: true };
	}

	// Delete token file
	async handleSignOut() {
		await this.tokenStore.clear();
		return { ok: true };
	}

	// Report whether a token exists
	async handleStatus() {
		try {
			const token = await this.tokenStore.load();
			if (!token) {
				return { ok: true, hasToken: false };
			}
			return {
				ok: true,
				hasToken: true,
				reauthenticationRequired: token.refreshRejected === true,
				userId: token.userId,
				expiresAt: token.expiresAt ?? null,
			};
		} catch {
			return { ok: false, error: 'Unable to read the saved Cync session. Check storage access and retry.' };
		}
	}

	async restoreCloudSession() {
		let token = await this.tokenStore.load();
		if (!token) {
			throw new Error('Sign in to Cync before loading devices.');
		}

		if (
			token.refreshRejected ||
			(token.expiresAt && Date.now() >= token.expiresAt - 60_000)
		) {
			try {
				token = await this.tokenStore.refresh(token, value => this.configClient.refreshAccessToken(value), false);
			} catch (error) {
				if (isRefreshTokenRejected(error)) {
					throw new Error('Cync rejected the refresh token. Sign out, request a fresh 2FA code, enter it in the plugin settings, and restart Homebridge.');
				}
				throw error;
			}
		}

		this.configClient.restoreSession(token.accessToken, token.userId);
	}

	async handleDevices() {
		try {
			await this.restoreCloudSession();
			const cloudConfig = await this.configClient.getCloudConfig();
			const devices = [];

			for (const mesh of cloudConfig.meshes) {
				let properties;
				try {
					properties = await this.configClient.getDeviceProperties(
						String(mesh.product_id),
						String(mesh.id),
					);
				} catch (error) {
					console.warn('[cync-ui-config] Unable to inspect mesh %s: %s', mesh.id, error?.message ?? error);
					continue;
				}

				const lightShows = properties.lightShows;
				const musicShows = properties.musicShows;
				const multiColorSchemes = properties.multiColorSchemes;
				const bulbs = Array.isArray(properties.bulbsArray) ? properties.bulbsArray : [];

				for (const bulb of bulbs) {
					const deviceId = bulb?.deviceID ?? bulb?.deviceId;
					const deviceType = Number(bulb?.deviceType);
					const profile = getCyncApkDeviceProfile(
						Number.isFinite(deviceType) ? deviceType : undefined,
					);

					if (deviceId === undefined || profile?.supportsLightShows !== true) {
						continue;
					}

					const showCrcMap = bulb.savedLightShowsCrcMap ??
						bulb.savedShowCrcMap ?? bulb.savedShowsCrcMap ?? {};
					const multiColorCrcMap = bulb.savedMultiColorSchemesCrcMap ??
						bulb.savedMultiColorSchemes ?? bulb.savedMulticolorSchemes ??
						bulb.multiColorSchemeCrcMap ?? bulb.schemeCrcMap ?? {};

					devices.push({
						deviceId: String(deviceId),
						name: typeof bulb.displayName === 'string' ? bulb.displayName : `Cync ${deviceId}`,
						deviceType: Number.isFinite(deviceType) ? deviceType : null,
						supportsLightShows: profile.supportsLightShows,
						supportsMusicShows: profile.supportsMusicShows,
						supportsSegmentedControl: profile.supportsSegmentedControl,
						customLightShows: asShowList(lightShows, showCrcMap),
						customMusicShows: asShowList(musicShows, showCrcMap),
						multiColorSchemes: asShowList(multiColorSchemes, multiColorCrcMap),
					});
				}
			}

			devices.sort((a, b) => a.name.localeCompare(b.name));
			return { ok: true, devices };
		} catch (error) {
			console.error('[cync-ui-config] Device discovery failed:', error);
			return { ok: false, error: error?.message ?? error?.msg ?? String(error), devices: [] };
		}
	}
}

(() => new CyncUiServer())();
