import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeAuthErrorMessage } from '../dist/cync/auth-error-message.js';

test('authentication wording remains readable without inferring code meanings', () => {
	assert.deepEqual(sanitizeAuthErrorMessage('Two factor authentication is required.', []), {
		message: 'two factor authentication is required', redacted: false,
	});
});

test('known credentials are removed even when they are allowlisted ordinary words', () => {
	const result = sanitizeAuthErrorMessage('Password required for user alice@example.com code 123456 token abc.def.xyz',
		['required', 'alice@example.com', 'abc.def.xyz']);
	assert.doesNotMatch(result.message, /required|alice|123456|abc|example/);
	assert.equal(result.redacted, true);
});

test('unknown text, names, URL queries, controls and quoted values are not passed through', () => {
	for (const value of ['https://example.com?token=secret', 'Dustin', 'secret-token', 'foo@example.com',
		'"password"', 'session=secret', 'secret\u001b[31m', '123456789']) {
		assert.equal(sanitizeAuthErrorMessage(value, []).message, '[redacted]');
	}
	assert.equal(sanitizeAuthErrorMessage(null, []).message, '[unavailable]');
});
