import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface NativeWindowInfo {
	id: number;
	ownerPid: number;
	ownerName: string;
	name: string;
	bounds: {x: number; y: number; width: number; height: number};
	layer: number;
	alpha: number;
	onScreen: boolean;
}

function getBinaryPath(): string {
	const candidates = [
		process.env.WINDOW_CAPTURE_BIN,
		join(__dirname, '..', '..', 'bin', 'window-capture'),
		join(__dirname, '..', 'bin', 'window-capture'),
	].filter(Boolean) as string[];

	const binaryPath = candidates.find((candidate) => existsSync(candidate));
	if (!binaryPath) {
		throw new Error('window-capture binary not found. Run `npm run build:native` or set WINDOW_CAPTURE_BIN.');
	}

	return binaryPath;
}

export function listNativeWindows(): NativeWindowInfo[] {
	const raw = execFileSync(getBinaryPath(), ['list'], {
		encoding: 'utf-8',
		timeout: 15_000,
	});
	return JSON.parse(raw) as NativeWindowInfo[];
}

export function captureNativeWindow(windowId: number): Buffer {
	return execFileSync(getBinaryPath(), ['capture', '--id', String(windowId)], {
		encoding: 'buffer',
		maxBuffer: 25 * 1024 * 1024,
		timeout: 15_000,
	}) as Buffer;
}

export function clickNativeWindow(windowId: number, relativeX: number, relativeY: number): void {
	execFileSync(getBinaryPath(), ['click', '--id', String(windowId), '--x', String(relativeX), '--y', String(relativeY)], {
		encoding: 'utf-8',
		timeout: 15_000,
	});
}
