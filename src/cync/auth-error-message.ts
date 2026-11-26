/** Preserve only authentication vocabulary; never pass through arbitrary server text. */
const vocabulary = new Set(('a an the is are was be been not no or and for to of with without '
	+ 'please required require requires missing invalid incorrect expired error failed failure denied '
	+ 'unsupported unavailable enabled disabled mandatory authentication authorization verification '
	+ 'two factor two-factor 2fa mfa multi-factor code login log in sign signin sign-in password '
	+ 'account user email token refresh access request parameter parameters device trusted trust '
	+ 'session security must need needs use provide enter verify authenticate authorized unauthorized '
	+ 'does do support supported this that has have been cannot can only').split(' '));

export function sanitizeAuthErrorMessage(message: unknown, sensitive: readonly string[]): {
	message: string; redacted: boolean;
} {
	if (typeof message !== 'string' || !message.trim()) {
		return { message: '[unavailable]', redacted: true };
	}
	let text = message.toLowerCase();
	let redacted = false;
	// Remove known credentials before vocabulary matching, even if a password is an ordinary word.
	for (const value of sensitive) {
		if (value && text.includes(value.toLowerCase())) {
			text = text.replaceAll(value.toLowerCase(), '[redacted]');
			redacted = true;
		}
	}
	const parts = text.split(/\s+/);
	const output: string[] = [];
	for (const part of parts.slice(0, 64)) {
		// Only sentence punctuation is stripped. Emails, URLs, quoted values and token fragments stay opaque.
		const word = part.replace(/[.,;:!?]+$/, '');
		const safe = vocabulary.has(word) ? word : '[redacted]';
		if (safe === '[redacted]') {
			redacted = true;
		}
		if (safe !== '[redacted]' || output.at(-1) !== safe) {
			output.push(safe);
		}
	}
	if (parts.length > 64) {
		output.push('[redacted]');
		redacted = true;
	}
	return { message: output.join(' '), redacted };
}
