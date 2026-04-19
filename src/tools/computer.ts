import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {
	mouse,
	keyboard,
	Point,
	screen,
	Button,
	imageToJimp,
} from '@nut-tree-fork/nut-js';
import {execFileSync} from 'node:child_process';
import {setTimeout} from 'node:timers/promises';
import Jimp from 'jimp';
import sharp from 'sharp';
import {toKeys} from '../xdotoolStringToKeys.js';
import {jsonResult} from '../utils/response.js';
import {CursorOverlay} from './cursor-overlay.js';
import {getDisplayLayout, captureDisplay as captureDisplayNative} from '../utils/window-capture.js';

// Lazy-init virtual cursor overlay
let overlay: CursorOverlay | null = null;
async function getOverlay(): Promise<CursorOverlay | null> {
	if (!overlay) {
		overlay = new CursorOverlay();
		try {
			await overlay.start();
		} catch {
			// Overlay is optional
			overlay = null;
		}
	}
	return overlay;
}

/** Move virtual cursor to position if overlay is running. */
async function syncOverlay(x: number, y: number, style?: string): Promise<void> {
	const ov = await getOverlay();
	if (!ov?.isRunning) return;
	if (style) ov.setStyle(style as any);
	ov.move(x, y);
}

/**
 * Grab a single display as a Jimp image.
 *
 * On macOS, uses the native Swift binary (`capture-display --index N`) which calls
 * `screencapture -x -D <N>`. The image is at Retina resolution.
 * On Linux, falls back to nut-js screen.grab() (primary monitor only).
 *
 * @param displayIndex 1-based display index (1 = main display). Ignored on Linux.
 */
async function grabScreen(displayIndex: number = 1): Promise<ReturnType<typeof imageToJimp>> {
	if (process.platform === 'darwin') {
		const buffer = captureDisplayNative(displayIndex);
		return (await Jimp.read(buffer)) as unknown as ReturnType<typeof imageToJimp>;
	}

	// Linux / other: use nut-js (primary monitor only)
	return imageToJimp(await screen.grab());
}

// Configure nut-js
mouse.config.autoDelayMs = 100;
mouse.config.mouseSpeed = 1000;
keyboard.config.autoDelayMs = 10;

/**
 * Check if xdotool is available on this system.
 * Cached after first check.
 */
let xdotoolAvailable: boolean | undefined;
function hasXdotool(): boolean {
	if (xdotoolAvailable === undefined) {
		try {
			execFileSync('which', ['xdotool'], {stdio: 'ignore'});
			xdotoolAvailable = true;
		} catch {
			xdotoolAvailable = false;
		}
	}

	return xdotoolAvailable;
}

/**
 * Type text using xdotool, which correctly respects the X11 keyboard layout.
 *
 * nut-js's keyboard.type() uses libnut's typeString which maps characters to
 * X keycodes using a hardcoded US QWERTY lookup. This breaks when the X server's
 * keyboard layout differs, causing characters like : and ; to be swapped.
 * xdotool type uses XSendEvent with proper keymap lookups, so it works regardless
 * of the active keyboard layout.
 */
function xdotoolType(text: string): void {
	execFileSync('xdotool', [
		'type',
		'--clearmodifiers',
		'--delay',
		String(keyboard.config.autoDelayMs),
		'--',
		text,
	], {
		env: {...process.env, DISPLAY: process.env.DISPLAY || ':1'},
	});
}

// The Claude API automatically downsamples images larger than ~1.15MP or 1568px on the long edge.
// We pre-downsample screenshots to fit these limits and report the actual image dimensions.
// Claude sends coordinates in the downsampled image space, which we scale back up to
// logical screen coordinates accounting for multi-monitor offsets.
// See: https://docs.anthropic.com/en/docs/build-with-claude/vision#evaluate-image-size
const maxLongEdge = 1568;
const maxPixels = 1.15 * 1024 * 1024; // 1.15 megapixels

/**
 * Calculate the scale factor to downsample an image to fit API limits.
 * Returns a value <= 1 representing how much to shrink the image.
 */
function getSizeToApiScale(width: number, height: number): number {
	const longEdge = Math.max(width, height);
	const totalPixels = width * height;

	const longEdgeScale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
	const pixelScale = totalPixels > maxPixels ? Math.sqrt(maxPixels / totalPixels) : 1;

	return Math.min(longEdgeScale, pixelScale);
}

/**
 * Coordinate mapping between API image space and logical screen coordinates,
 * scoped to a single display.
 *
 * Per-display model:
 * - Each screenshot captures a SINGLE monitor, not all monitors.
 * - Coordinates (0,0) in the API image = top-left of THAT monitor.
 * - The model specifies which display to screenshot/interact with.
 * - Subsequent mouse/click actions map coordinates relative to the active display.
 *
 * The mapping chain:
 * 1. API image coords → global logical coords: multiply by scale + add display origin
 * 2. Global logical coords → API image coords: subtract display origin, divide by scale
 *
 * The Retina scale factor cancels out algebraically: using the display's logical
 * dimensions for getSizeToApiScale gives the same mapping as using Retina dimensions.
 */
interface ScreenMapping {
	/** Scale factor: multiply API coords by this to get display-local logical coords */
	scale: number;
	/** X origin of this display in global logical space */
	offsetX: number;
	/** Y origin of this display in global logical space */
	offsetY: number;
	/** Display width in logical pixels */
	displayWidth: number;
	/** Display height in logical pixels */
	displayHeight: number;
	/** 1-based display index */
	displayIndex: number;
}

/** Currently active display (set by get_screenshot, used by subsequent actions). */
let activeDisplayIndex = 1;

/**
 * Get the screen mapping for a specific display.
 *
 * @param displayIndex 1-based display index (1 = main display)
 */
function getScreenMapping(displayIndex: number = 1): ScreenMapping {
	if (process.platform === 'darwin') {
		const layout = getDisplayLayout();

		// Use the display order from CGGetActiveDisplayList directly.
		// This order matches `screencapture -D <N>`:
		//   Index 1 = main display (CGGetActiveDisplayList always returns main first)
		//   Index 2+ = secondary displays in macOS-internal order
		// We must NOT re-sort, or the indices will mismatch screencapture -D.
		const displays = layout.displays;
		if (displays.length === 0) {
			// No displays found — fall back to single-monitor defaults
			return {scale: 1, offsetX: 0, offsetY: 0, displayWidth: 1920, displayHeight: 1080, displayIndex: 1};
		}
		const idx = Math.max(1, Math.min(displayIndex, displays.length));
		const display = displays[idx - 1]!;

		const apiScale = getSizeToApiScale(display.bounds.width, display.bounds.height);
		return {
			scale: 1 / apiScale,
			offsetX: display.bounds.x,
			offsetY: display.bounds.y,
			displayWidth: display.bounds.width,
			displayHeight: display.bounds.height,
			displayIndex: idx,
		};
	}

	// Linux / other: single-monitor fallback using nut-js
	return getCachedLinuxMapping();
}

// Linux fallback: cache the screen dimensions
let linuxMapping: ScreenMapping | null = null;

function getCachedLinuxMapping(): ScreenMapping {
	if (linuxMapping) return linuxMapping;
	return {scale: 1, offsetX: 0, offsetY: 0, displayWidth: 1920, displayHeight: 1080, displayIndex: 1};
}

async function initLinuxMapping(): Promise<void> {
	if (process.platform !== 'darwin' && !linuxMapping) {
		const w = await screen.width();
		const h = await screen.height();
		const apiScale = getSizeToApiScale(w, h);
		linuxMapping = {
			scale: 1 / apiScale,
			offsetX: 0,
			offsetY: 0,
			displayWidth: w,
			displayHeight: h,
			displayIndex: 1,
		};
	}
}

/**
 * Convert API image coordinates to logical screen coordinates.
 */
function apiToLogical(apiX: number, apiY: number, mapping: ScreenMapping): [number, number] {
	return [
		Math.round(apiX * mapping.scale + mapping.offsetX),
		Math.round(apiY * mapping.scale + mapping.offsetY),
	];
}

/**
 * Convert logical screen coordinates to API image coordinates.
 */
function logicalToApi(logicalX: number, logicalY: number, mapping: ScreenMapping): [number, number] {
	return [
		Math.round((logicalX - mapping.offsetX) / mapping.scale),
		Math.round((logicalY - mapping.offsetY) / mapping.scale),
	];
}

/**
 * Validate that logical coordinates are within the active display's bounds.
 */
function validateLogicalCoords(x: number, y: number, mapping: ScreenMapping): void {
	const {offsetX, offsetY, displayWidth, displayHeight} = mapping;
	if (x < offsetX || x >= offsetX + displayWidth || y < offsetY || y >= offsetY + displayHeight) {
		throw new Error(
			`Coordinates (${x}, ${y}) are outside display ${mapping.displayIndex} bounds ` +
			`[${offsetX}, ${offsetY}] to [${offsetX + displayWidth}, ${offsetY + displayHeight}]`
		);
	}
}

// Define the action enum values
const ActionEnum = z.enum([
	'key',
	'type',
	'mouse_move',
	'left_click',
	'left_click_drag',
	'right_click',
	'middle_click',
	'double_click',
	'scroll',
	'get_screenshot',
	'get_cursor_position',
]);

const actionDescription = `The action to perform. The available actions are:
* key: Press a key or key-combination on the keyboard.
* type: Type a string of text on the keyboard.
* get_cursor_position: Get the current (x, y) pixel coordinate of the cursor relative to the active display.
* mouse_move: Move the cursor to a specified (x, y) pixel coordinate on the active display.
* left_click: Click the left mouse button. If coordinate is provided, moves to that position first.
* left_click_drag: Click and drag the cursor to a specified (x, y) pixel coordinate on the active display.
* right_click: Click the right mouse button. If coordinate is provided, moves to that position first.
* middle_click: Click the middle mouse button. If coordinate is provided, moves to that position first.
* double_click: Double-click the left mouse button. If coordinate is provided, moves to that position first.
* scroll: Scroll at a specified coordinate on the active display. Requires coordinate and text parameter with direction: "up", "down", "left", or "right". Optionally append ":N" to scroll N pixels (default 300), e.g. "down:500".
* get_screenshot: Take a screenshot of a single display. Use the \`display\` parameter to specify which monitor (1 = main, 2+ = secondary). All subsequent coordinates are relative to that display until the next screenshot.`;

const toolDescription = `Use a mouse and keyboard to interact with a computer, and take screenshots.
* This is an interface to a desktop GUI. You do not have access to a terminal or applications menu. You must click on desktop icons to start applications.
* Always prefer using keyboard shortcuts rather than clicking, where possible.
* If you see boxes with two letters in them, typing these letters will click that element. Use this instead of other shortcuts or clicking, where possible.
* Some applications may take time to start or process actions, so you may need to wait and take successive screenshots to see the results of your actions. E.g. if you click on Firefox and a window doesn't open, try taking another screenshot.
* Whenever you intend to move the cursor to click on an element like an icon, you should consult a screenshot to determine the coordinates of the element before moving the cursor.
* \`get_screenshot\` captures a single display. Use \`display\` to choose which monitor (1 = main). Coordinates (0,0) = top-left of that monitor. All click/move actions use the same coordinate space as the last screenshot. For background windows, covered windows, or windows you want to target without bringing them to the front, use the window tools: \`windows\`, \`capture_window\`, \`get_ax_tree\`, \`ax_click\`, \`ax_type\`, and \`click_bg_xy\`.
* If you tried clicking on a program or link but it failed to load, even after waiting, try adjusting your cursor position so that the tip of the cursor visually falls on the element that you want to click.
* Make sure to click any buttons, links, icons, etc with the cursor tip in the center of the element. Don't click boxes on their edges unless asked.

Multi-monitor:
* Each call to \`get_screenshot\` captures ONE monitor. Specify which monitor with the \`display\` parameter (1 = main, 2+ = secondary). Coordinates in the resulting image are relative to that monitor's top-left (0,0). All subsequent mouse/click actions use that monitor's coordinate space until you take a new screenshot.
* To see what's on another monitor, call \`get_screenshot\` with a different \`display\` value. Use the \`displays\` subcommand of the \`windows\` tool to list all connected monitors with their indices and dimensions.

Window focus:
* On macOS, clicking on a window that is not focused (e.g. behind another application) may only bring that window to the front without triggering the actual click on the element. If your click doesn't seem to have had an effect, take a screenshot to verify and click again — the window should now be focused and the second click will register.

Using the crosshair:
* Screenshots show a red crosshair at the current cursor position.
* After clicking, check where the crosshair appears vs your target. If it missed, adjust coordinates proportionally to the distance - start with large adjustments and refine. Avoid small incremental changes when the crosshair is far from the target (distances are often further than you expect).
* Consider display dimensions when estimating positions. E.g. if it's 90% to the bottom of the screen, the coordinates should reflect this.`;

const coordinateSchema = z
	.array(z.number())
	.length(2)
	.describe('(x, y): The x (pixels from the left edge) and y (pixels from the top edge) coordinates');

export function registerComputer(server: McpServer): void {
	server.registerTool(
		'computer',
		{
			title: 'Computer Control',
			description: toolDescription,
			inputSchema: z.object({
				action: ActionEnum.describe(actionDescription),
				coordinate: coordinateSchema.optional(),
				text: z.string().optional().describe('Text to type or key command to execute'),
				display: z.number().int().min(1).optional().describe(
					'Which display to screenshot (1-based, 1 = main display). Only used with get_screenshot. ' +
					'After a screenshot, all subsequent coordinate-based actions (clicks, moves) target that display ' +
					'until the next get_screenshot with a different display value.'
				),
			}).strict(),
			// Note: No outputSchema because this tool returns varying content types including images
			annotations: {
				readOnlyHint: false,
			},
		},
		async (args) => {
			const {action, coordinate, text, display} = args as {action: z.infer<typeof ActionEnum>; coordinate?: [number, number]; text?: string; display?: number};

			// Initialize Linux mapping if needed
			await initLinuxMapping();

			// For get_screenshot, update the active display if specified
			if (action === 'get_screenshot' && display !== undefined) {
				activeDisplayIndex = display;
			}

			// Get the screen mapping for the active display
			const mapping = getScreenMapping(activeDisplayIndex);

			// Scale coordinates from API image space to logical screen space
			let scaledCoordinate = coordinate;
			if (coordinate) {
				scaledCoordinate = apiToLogical(coordinate[0], coordinate[1], mapping) as [number, number];
				validateLogicalCoords(scaledCoordinate[0], scaledCoordinate[1], mapping);
			}

			// Implement system actions using nut-js
			switch (action) {
				case 'key': {
					if (!text) {
						throw new Error('Text required for key');
					}

					const keys = toKeys(text);
					await keyboard.pressKey(...keys);
					await keyboard.releaseKey(...keys);

					return jsonResult({ok: true});
				}

				case 'type': {
					if (!text) {
						throw new Error('Text required for type');
					}

					if (process.platform === 'linux' && hasXdotool()) {
						xdotoolType(text);
					} else {
						await keyboard.type(text);
					}

					return jsonResult({ok: true});
				}

				case 'get_cursor_position': {
					const pos = await mouse.getPosition();
					// Return coordinates in API image space relative to the active display
					// so Claude can correlate with what it sees in screenshots
					const [apiX, apiY] = logicalToApi(pos.x, pos.y, mapping);
					return jsonResult({
						x: apiX,
						y: apiY,
						display: activeDisplayIndex,
					});
				}

				case 'mouse_move': {
					if (!scaledCoordinate) {
						throw new Error('Coordinate required for mouse_move');
					}

					await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					await syncOverlay(scaledCoordinate[0], scaledCoordinate[1], 'pointer');
					return jsonResult({ok: true});
				}

				case 'left_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
						await syncOverlay(scaledCoordinate[0], scaledCoordinate[1], 'click');
					}

					await mouse.leftClick();
					return jsonResult({ok: true});
				}

				case 'left_click_drag': {
					if (!scaledCoordinate) {
						throw new Error('Coordinate required for left_click_drag');
					}

					await mouse.pressButton(Button.LEFT);
					await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					await syncOverlay(scaledCoordinate[0], scaledCoordinate[1]);
					await mouse.releaseButton(Button.LEFT);
					return jsonResult({ok: true});
				}

				case 'right_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
						await syncOverlay(scaledCoordinate[0], scaledCoordinate[1], 'click');
					}

					await mouse.rightClick();
					return jsonResult({ok: true});
				}

				case 'middle_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
						await syncOverlay(scaledCoordinate[0], scaledCoordinate[1]);
					}

					await mouse.click(Button.MIDDLE);
					return jsonResult({ok: true});
				}

				case 'double_click': {
					if (scaledCoordinate) {
						await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
						await syncOverlay(scaledCoordinate[0], scaledCoordinate[1], 'click');
					}

					await mouse.doubleClick(Button.LEFT);
					return jsonResult({ok: true});
				}

				case 'scroll': {
					if (!scaledCoordinate) {
						throw new Error('Coordinate required for scroll');
					}

					if (!text) {
						throw new Error('Text required for scroll (direction like "up", "down:5")');
					}

					// Parse direction and optional amount from text (e.g. "down" or "down:5")
					const parts = text.split(':');
					const direction = parts[0];
					const amountStr = parts[1];
					const amount = amountStr ? parseInt(amountStr, 10) : 300;

					if (!direction) {
						throw new Error('Scroll direction required');
					}

					if (amountStr !== undefined && (isNaN(amount) || amount <= 0)) {
						throw new Error(`Invalid scroll amount: ${amountStr}`);
					}

					// Move to position first
					await mouse.setPosition(new Point(scaledCoordinate[0], scaledCoordinate[1]));
					await syncOverlay(scaledCoordinate[0], scaledCoordinate[1]);

					// Scroll in the specified direction
					switch (direction.toLowerCase()) {
						case 'up':
							await mouse.scrollUp(amount);
							break;
						case 'down':
							await mouse.scrollDown(amount);
							break;
						case 'left':
							await mouse.scrollLeft(amount);
							break;
						case 'right':
							await mouse.scrollRight(amount);
							break;
						default:
							throw new Error(`Invalid scroll direction: ${direction}. Use "up", "down", "left", or "right"`);
					}

					return jsonResult({ok: true});
				}

				case 'get_screenshot': {
					// Wait a bit to let things load before showing it to Claude
					await setTimeout(1000);

					// Get cursor position in logical coordinates
					const cursorPos = await mouse.getPosition();

					// Capture the active display only (single monitor)
					const image = await grabScreen(activeDisplayIndex);

					// Then resize to fit within API limits
					const apiScaleFactor = getSizeToApiScale(image.getWidth(), image.getHeight());
					if (apiScaleFactor < 1) {
						image.resize(
							Math.floor(image.getWidth() * apiScaleFactor),
							Math.floor(image.getHeight() * apiScaleFactor),
						);
					}

					// Calculate cursor position in API image coordinates
					// relative to the active display
					const [cursorInImageX, cursorInImageY] = logicalToApi(cursorPos.x, cursorPos.y, mapping);

					// Draw a crosshair at cursor position (red color)
					const crosshairSize = 20;
					const crosshairColor = 0xFF0000FF; // Red with full opacity (RGBA)
					const imageWidth = image.getWidth();
					const imageHeight = image.getHeight();

					// Draw horizontal line
					for (let x = Math.max(0, cursorInImageX - crosshairSize); x <= Math.min(imageWidth - 1, cursorInImageX + crosshairSize); x++) {
						if (cursorInImageY >= 0 && cursorInImageY < imageHeight) {
							image.setPixelColor(crosshairColor, x, cursorInImageY);
							// Make it thicker
							if (cursorInImageY > 0) {
								image.setPixelColor(crosshairColor, x, cursorInImageY - 1);
							}

							if (cursorInImageY < imageHeight - 1) {
								image.setPixelColor(crosshairColor, x, cursorInImageY + 1);
							}
						}
					}

					// Draw vertical line
					for (let y = Math.max(0, cursorInImageY - crosshairSize); y <= Math.min(imageHeight - 1, cursorInImageY + crosshairSize); y++) {
						if (cursorInImageX >= 0 && cursorInImageX < imageWidth) {
							image.setPixelColor(crosshairColor, cursorInImageX, y);
							// Make it thicker
							if (cursorInImageX > 0) {
								image.setPixelColor(crosshairColor, cursorInImageX - 1, y);
							}

							if (cursorInImageX < imageWidth - 1) {
								image.setPixelColor(crosshairColor, cursorInImageX + 1, y);
							}
						}
					}

					// Get PNG buffer from Jimp
					const pngBuffer = await image.getBufferAsync('image/png');

					// Compress PNG using sharp, to fit size limits
					const optimizedBuffer = await sharp(pngBuffer)
						.png({quality: 80, compressionLevel: 9})
						.toBuffer();

					// Convert optimized buffer to base64
					const base64Data = optimizedBuffer.toString('base64');

					return {
						content: [
							{
								type: 'text',
								text: JSON.stringify({
									// Report the image dimensions - Claude should use coordinates within this space
									// These may differ from the actual display due to scaling for API limits
									image_width: imageWidth,
									image_height: imageHeight,
									display: activeDisplayIndex,
									display_width: mapping.displayWidth,
									display_height: mapping.displayHeight,
								}),
							},
							{
								type: 'image',
								data: base64Data,
								mimeType: 'image/png',
							},
						],
					};
				}
			}
		},
	);
}
