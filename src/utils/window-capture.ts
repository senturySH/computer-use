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

export interface DisplayInfo {
	id: number;
	bounds: {x: number; y: number; width: number; height: number};
	isMain: boolean;
	scaleFactor: number;
}

export interface DisplayLayout {
	displays: DisplayInfo[];
	unifiedBounds: {x: number; y: number; width: number; height: number};
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

/**
 * Capture a single display by its 1-based index (1 = main display).
 * Returns a PNG buffer.
 */
export function captureDisplay(displayIndex: number): Buffer {
	return execFileSync(getBinaryPath(), ['capture-display', '--index', String(displayIndex)], {
		encoding: 'buffer',
		maxBuffer: 50 * 1024 * 1024,
		timeout: 15_000,
	}) as Buffer;
}

let cachedLayout: DisplayLayout | null = null;
let cachedLayoutTime = 0;
const LAYOUT_CACHE_MS = 10_000; // Cache for 10 seconds

export function getDisplayLayout(): DisplayLayout {
	const now = Date.now();
	if (cachedLayout && (now - cachedLayoutTime) < LAYOUT_CACHE_MS) {
		return cachedLayout;
	}

	try {
		const raw = execFileSync(getBinaryPath(), ['displays'], {
			encoding: 'utf-8',
			timeout: 15_000,
		});
		cachedLayout = JSON.parse(raw) as DisplayLayout;
		cachedLayoutTime = now;
		return cachedLayout;
	} catch {
		// Fallback: single display assumed
		return {
			displays: [{
				id: 0,
				bounds: {x: 0, y: 0, width: 1920, height: 1080},
				isMain: true,
				scaleFactor: 2,
			}],
			unifiedBounds: {x: 0, y: 0, width: 1920, height: 1080},
		};
	}
}
