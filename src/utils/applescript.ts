import {execFileSync} from 'node:child_process';

export type OsaLanguage = 'AppleScript' | 'JavaScript';

/**
 * Execute an AppleScript and return its stdout trimmed.
 * Throws on non-zero exit.
 */
export function osascript(script: string, language: OsaLanguage = 'AppleScript'): string {
	const args = language === 'JavaScript'
		? ['-l', 'JavaScript', '-e', script]
		: ['-e', script];

	return execFileSync('osascript', args, {
		encoding: 'utf-8',
		timeout: 15_000,
	}).trim();
}

/**
 * Execute an osascript snippet that returns JSON.
 */
export function osascriptJson<T>(script: string, language: OsaLanguage = 'JavaScript'): T {
	const raw = osascript(script, language);
	return JSON.parse(raw) as T;
}

/**
 * Execute an AppleScript that returns a list (comma-separated).
 * Returns an array of trimmed strings.
 */
export function osascriptList(script: string): string[] {
	const raw = osascript(script);
	if (!raw) return [];
	return raw.split(', ').map((s) => s.trim()).filter(Boolean);
}
