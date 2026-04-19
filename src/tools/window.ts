import { execFileSync } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import sharp from "sharp";
import { z } from "zod";
import { osascriptJson } from "../utils/applescript.js";
import {
  captureNativeWindow,
  clickNativeWindow,
  listNativeWindows,
  type NativeWindowInfo,
} from "../utils/window-capture.js";
import { CursorOverlay } from "./cursor-overlay.js";
import { jsonResult } from "../utils/response.js";

let overlay: CursorOverlay | null = null;

async function getOverlay(): Promise<CursorOverlay> {
  if (!overlay) {
    overlay = new CursorOverlay();
    try {
      await overlay.start();
    } catch {
      // The overlay is optional. AX actions still work without it.
    }
  }
  return overlay;
}

interface AppInfo {
  name: string;
  bundleId: string;
  pid: number;
}

interface WindowInfo {
  appName: string;
  windowTitle: string;
  windowIndex: number;
  windowId?: number | undefined;
  position: { x: number; y: number };
  size: { width: number; height: number };
  minimized: boolean;
}

interface DesktopInfo {
  id: number;
  name: string;
}

interface AXElement {
  path: string;
  role: string;
  subrole?: string | undefined;
  title?: string | undefined;
  value?: string | undefined;
  description?: string | undefined;
  enabled: boolean;
  focused: boolean;
  frame?: { x: number; y: number; width: number; height: number } | undefined;
  children?: AXElement[] | undefined;
}

interface AXTarget {
  path?: string | undefined;
  role?: string | undefined;
  title?: string | undefined;
}

const maxLongEdge = 1568;
const maxPixels = 1.15 * 1024 * 1024;

const axPreamble = String.raw`
const se = Application("System Events");

function safe(fn, fallback = null) {
	try {
		const value = fn();
		return value === undefined ? fallback : value;
	} catch (error) {
		return fallback;
	}
}

function childElements(el) {
	return safe(() => el.uiElements(), []) || [];
}

function textOrNull(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") return value.length > 0 ? value : null;
	return String(value);
}

function boolOrFalse(fn) {
	return Boolean(safe(fn, false));
}

function frameFor(el) {
	const position = safe(() => el.position(), null);
	const size = safe(() => el.size(), null);
	if (!Array.isArray(position) || !Array.isArray(size)) return null;
	return {
		x: Number(position[0]) || 0,
		y: Number(position[1]) || 0,
		width: Number(size[0]) || 0,
		height: Number(size[1]) || 0,
	};
}

function elementLabel(el) {
	const candidates = [
		safe(() => el.title(), null),
		safe(() => el.description(), null),
		safe(() => el.value(), null),
		safe(() => el.name(), null),
	];

	for (const candidate of candidates) {
		const text = textOrNull(candidate);
		if (text !== null) return text;
	}

	return null;
}

function elementFromPath(root, path) {
	if (!path) return null;
	const indexes = String(path).split(".").map((part) => Number(part));
	if (indexes.some((index) => !Number.isInteger(index) || index < 0)) {
		throw new Error("Invalid element path");
	}

	let current = null;
	let siblings = childElements(root);
	for (const index of indexes) {
		current = siblings[index];
		if (!current) throw new Error("Element path not found");
		siblings = childElements(current);
	}

	return current;
}

// Roles that are text-accepting in web/Electron apps
var textAcceptingRoles = new Set([
	"axtextfield", "axtextarea", "axcombobox", "axsearchfield",
]);

function findElement(root, roleCandidates, title) {
	const wantedTitle = title === null ? null : String(title).toLowerCase();
	const wantedRoles = Array.isArray(roleCandidates)
		? roleCandidates.map((role) => String(role).toLowerCase())
		: [];
	const queue = childElements(root).slice();

	// Phase 1: Exact title match
	var exactMatch = null;
	// Phase 2: Substring/contains title match (fallback)
	var substringMatch = null;

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;

		const role = String(safe(() => current.role(), "")).toLowerCase();
		const label = safe(() => elementLabel(current), null);
		const labelLower = String(label || "").toLowerCase();
		const matchesRole = wantedRoles.length === 0 || wantedRoles.includes(role);

		if (matchesRole) {
			if (wantedTitle === null) {
				return current; // No title constraint, first role match wins
			}
			if (labelLower === wantedTitle && !exactMatch) {
				exactMatch = current;
			} else if (!substringMatch && labelLower.indexOf(wantedTitle) !== -1) {
				substringMatch = current;
			}
		}

		queue.push(...childElements(current));
	}

	return exactMatch || substringMatch || null;
}

// Find the currently focused element in the tree (useful as fallback)
function findFocusedElement(root) {
	const queue = childElements(root).slice();
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;

		if (boolOrFalse(() => current.focused())) {
			return current;
		}
		queue.push(...childElements(current));
	}
	return null;
}

// Find any element that can accept text input (useful as fallback for ax_type)
function findAnyTextInput(root) {
	const queue = childElements(root).slice();
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;

		const role = String(safe(() => current.role(), "")).toLowerCase();
		if (textAcceptingRoles.has(role)) {
			return current;
		}
		queue.push(...childElements(current));
	}
	return null;
}
`;

function runJxaJson<T>(body: string): T {
  return osascriptJson<T>(`${axPreamble}
${body}`);
}

function roleCandidates(role?: string): string[] {
  if (!role) return [];

  const normalized = role.trim().toLowerCase();
  const aliases: Record<string, string[]> = {
    // Buttons
    button: ["axbutton"],
    axbutton: ["axbutton"],
    // Checkboxes
    checkbox: ["axcheckbox"],
    axcheckbox: ["axcheckbox"],
    // Menus
    menu: ["axmenu"],
    axmenu: ["axmenu"],
    menuitem: ["axmenuitem"],
    axmenuitem: ["axmenuitem"],
    menubar: ["axmenubar"],
    axmenubar: ["axmenubar"],
    // Radio buttons
    radio: ["axradiobutton"],
    axradiobutton: ["axradiobutton"],
    // Sliders
    slider: ["axslider"],
    axslider: ["axslider"],
    // Tabs
    tab: ["axradiobutton", "axtabgroup"],
    axtabgroup: ["axtabgroup"],
    // Text fields — match all text-accepting roles (native + web)
    text: ["axtextfield", "axtextarea", "axcombobox"],
    textfield: ["axtextfield", "axtextarea", "axcombobox"],
    axtextfield: ["axtextfield"],
    // Text areas
    textarea: ["axtextarea", "axtextfield"],
    axtextarea: ["axtextarea"],
    // Combo boxes (dropdowns with text input)
    combobox: ["axcombobox"],
    axcombobox: ["axcombobox"],
    // Input — generic alias that matches any text-accepting element
    input: ["axtextfield", "axtextarea", "axcombobox", "axsearchfield"],
    // Search fields
    search: ["axsearchfield", "axtextfield"],
    searchfield: ["axsearchfield", "axtextfield"],
    axsearchfield: ["axsearchfield"],
    // Images
    image: ["aximage"],
    aximage: ["aximage"],
    // Links
    link: ["axlink"],
    axlink: ["axlink"],
    // Web-specific roles
    webarea: ["axwebarea"],
    axwebarea: ["axwebarea"],
    // Scroll areas
    scrollarea: ["axscrollarea"],
    axscrollarea: ["axscrollarea"],
    // Groups
    group: ["axgroup"],
    axgroup: ["axgroup"],
    // Tables
    table: ["axtable"],
    axtable: ["axtable"],
    row: ["axrow"],
    axrow: ["axrow"],
    cell: ["axcell"],
    axcell: ["axcell"],
    // Static text
    statictext: ["axstatictext"],
    axstatictext: ["axstatictext"],
    label: ["axstatictext"],
    // Popups
    popupbutton: ["axpopupbutton"],
    axpopupbutton: ["axpopupbutton"],
    popup: ["axpopupbutton"],
    dropdown: ["axpopupbutton", "axcombobox"],
    select: ["axpopupbutton", "axcombobox"],
    // Toolbars
    toolbar: ["axtoolbar"],
    axtoolbar: ["axtoolbar"],
    // Disclosure triangles
    disclosure: ["axdisclosuretriangle"],
    axdisclosuretriangle: ["axdisclosuretriangle"],
  };

  return aliases[normalized] ?? [normalized];
}

function escapeJs(value: string): string {
  return JSON.stringify(value);
}

function listRunningApps(): AppInfo[] {
  return runJxaJson<AppInfo[]>(String.raw`
const apps = se.applicationProcesses.whose({backgroundOnly: false})().map((process) => ({
	name: String(safe(() => process.name(), "")),
	bundleId: String(safe(() => process.bundleIdentifier(), "")),
	pid: Number(safe(() => process.unixId(), 0)) || 0,
}));

JSON.stringify(apps);
`);
}

function listAllWindows(): WindowInfo[] {
  const axWindows = runJxaJson<WindowInfo[]>(String.raw`
const windows = [];

for (const process of se.applicationProcesses.whose({backgroundOnly: false})()) {
	const appName = String(safe(() => process.name(), ""));
	const appWindows = safe(() => process.windows(), []);

	for (let index = 0; index < appWindows.length; index += 1) {
		const window = appWindows[index];
		const position = safe(() => window.position(), [0, 0]) || [0, 0];
		const size = safe(() => window.size(), [0, 0]) || [0, 0];
		const minimized = Boolean(safe(() => window.attributes.byName("AXMinimized").value(), false));

		windows.push({
			appName,
			windowTitle: String(safe(() => window.name(), "")),
			windowIndex: index + 1,
			position: {x: Number(position[0]) || 0, y: Number(position[1]) || 0},
			size: {width: Number(size[0]) || 0, height: Number(size[1]) || 0},
			minimized,
		});
	}
}

JSON.stringify(windows);
`);

  return attachNativeWindowIds(axWindows);
}

function listDesktops(): DesktopInfo[] {
  try {
    const raw = execFileSync("defaults", ["read", "com.apple.spaces"], {
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();

    const uuids = [
      ...new Set(
        [...raw.matchAll(/^\s*name = "([0-9A-F-]{36})";$/gm)].map(
          (match) => match[1],
        ),
      ),
    ];
    if (uuids.length === 0) {
      return [{ id: 1, name: "Desktop 1" }];
    }

    return uuids.map((_, index) => ({
      id: index + 1,
      name: `Desktop ${index + 1}`,
    }));
  } catch {
    return [{ id: 1, name: "Desktop 1" }];
  }
}

function attachNativeWindowIds(windows: WindowInfo[]): WindowInfo[] {
  let nativeWindows: NativeWindowInfo[] = [];
  try {
    nativeWindows = listNativeWindows();
  } catch {
    return windows;
  }

  const usedIds = new Set<number>();
  return windows.map((window) => {
    const match = bestNativeWindowMatch(window, nativeWindows, usedIds);
    if (match) {
      usedIds.add(match.id);
      return { ...window, windowId: match.id };
    }

    return window;
  });
}

function bestNativeWindowMatch(
  window: WindowInfo,
  nativeWindows: NativeWindowInfo[],
  usedIds: Set<number>,
): NativeWindowInfo | null {
  let best: NativeWindowInfo | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of nativeWindows) {
    if (usedIds.has(candidate.id)) continue;
    if (candidate.ownerName.toLowerCase() !== window.appName.toLowerCase())
      continue;
    if (candidate.layer !== 0) continue;
    if (candidate.alpha <= 0) continue;

    let score = 0;
    if ((candidate.name || "") === window.windowTitle) score += 50;
    if (!candidate.name && !window.windowTitle) score += 20;

    const dx = Math.abs(candidate.bounds.x - window.position.x);
    const dy = Math.abs(candidate.bounds.y - window.position.y);
    const dw = Math.abs(candidate.bounds.width - window.size.width);
    const dh = Math.abs(candidate.bounds.height - window.size.height);
    const distancePenalty = dx + dy + dw + dh;
    score -= distancePenalty / 10;
    if (candidate.onScreen) score += 5;

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function resolveWindowId(
  appName: string,
  windowIndex: number,
  windowId?: number,
): number {
  if (windowId !== undefined) return windowId;

  const windows = listAllWindows().filter(
    (window) => window.appName.toLowerCase() === appName.toLowerCase(),
  );
  const target = windows.find((window) => window.windowIndex === windowIndex);
  if (!target) {
    throw new Error(`Window ${windowIndex} not found for ${appName}`);
  }

  if (target.windowId === undefined) {
    throw new Error(
      "No native window ID found for this window. Use `windows` with `action=list_windows` and choose a visible window.",
    );
  }

  return target.windowId;
}

function getNativeWindow(windowId: number): NativeWindowInfo {
  const window = listNativeWindows().find(
    (candidate) => candidate.id === windowId,
  );
  if (!window) {
    throw new Error(`Window ${windowId} not found`);
  }

  return window;
}

async function clickInsideBackgroundWindow(
  windowId: number,
  x: number,
  y: number,
  showCursor?: boolean,
): Promise<void> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("x and y must be finite numbers");
  }

  const window = getNativeWindow(windowId);
  const image = await prepareWindowImage(captureNativeWindow(windowId));

  if (x < 0 || x > image.width || y < 0 || y > image.height) {
    throw new Error(
      `Coordinates (${x}, ${y}) are outside captured window bounds of ${image.width}x${image.height}`,
    );
  }

  const relativeX = image.width === 0 ? 0 : x / image.width;
  const relativeY = image.height === 0 ? 0 : y / image.height;
  const absoluteX = window.bounds.x + window.bounds.width * relativeX;
  const absoluteY = window.bounds.y + window.bounds.height * relativeY;

  if (showCursor) {
    const ov = await getOverlay();
    if (ov?.isRunning) {
      await ov.clickAt(absoluteX, absoluteY);
    }
  }

  clickNativeWindow(windowId, relativeX, relativeY);
}

function getSizeToApiScale(width: number, height: number): number {
  const longEdge = Math.max(width, height);
  const totalPixels = width * height;
  const longEdgeScale = longEdge > maxLongEdge ? maxLongEdge / longEdge : 1;
  const pixelScale =
    totalPixels > maxPixels ? Math.sqrt(maxPixels / totalPixels) : 1;
  return Math.min(longEdgeScale, pixelScale);
}

async function prepareWindowImage(
  buffer: Buffer,
): Promise<{
  buffer: Buffer;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
}> {
  const metadata = await sharp(buffer).metadata();
  const originalWidth = metadata.width ?? 0;
  const originalHeight = metadata.height ?? 0;
  if (originalWidth === 0 || originalHeight === 0) {
    throw new Error("Captured window image has invalid dimensions");
  }

  const scale = getSizeToApiScale(originalWidth, originalHeight);
  const resized =
    scale < 1
      ? sharp(buffer).resize(
          Math.floor(originalWidth * scale),
          Math.floor(originalHeight * scale),
        )
      : sharp(buffer);
  const output = await resized
    .png({ quality: 80, compressionLevel: 9 })
    .toBuffer();
  const finalMetadata = await sharp(output).metadata();

  return {
    buffer: output,
    width: finalMetadata.width ?? originalWidth,
    height: finalMetadata.height ?? originalHeight,
    originalWidth,
    originalHeight,
  };
}

function getAXTree(
  appName: string,
  windowIndex: number,
  maxDepth: number = 6,
): AXElement[] {
  return runJxaJson<AXElement[]>(String.raw`
const appName = ${escapeJs(appName)};
const windowIndex = ${windowIndex};
const maxDepth = ${maxDepth};
const process = se.applicationProcesses.byName(appName);
const window = safe(() => process.windows()[windowIndex - 1], null);

if (!window) {
	throw new Error("Window " + windowIndex + " not found for " + appName);
}

// Roles that are structural wrappers in Electron/web-based apps.
// When we hit these, allow going deeper to find actual interactive content.
const webContainerRoles = new Set([
	"axwebarea", "axscrollarea", "axgroup", "axlayoutarea",
	"axsplitgroup", "axtabgroup", "axlist", "axoutline",
]);

function effectiveMaxDepth(role, baseDepth) {
	if (webContainerRoles.has(role.toLowerCase())) {
		// Allow going 2 levels deeper than the configured max for structural wrappers
		return Math.max(baseDepth, maxDepth + 2);
	}
	return baseDepth;
}

function serialize(el, path, depth, depthLimit) {
	if (depth > depthLimit) return null;

	const role = String(safe(() => el.role(), "AXUnknown"));
	const currentLimit = effectiveMaxDepth(role, depthLimit);
	const children = childElements(el);

	return {
		path,
		role,
		subrole: textOrNull(safe(() => el.subrole(), null)),
		title: textOrNull(safe(() => el.title(), null)),
		value: textOrNull(safe(() => el.value(), null)),
		description: textOrNull(safe(() => el.description(), null)),
		enabled: boolOrFalse(() => el.enabled()),
		focused: boolOrFalse(() => el.focused()),
		frame: frameFor(el),
		children: depth >= currentLimit
			? []
			: children.slice(0, 80).map((child, index) => serialize(child, path + "." + index, depth + 1, currentLimit)).filter(Boolean),
	};
}

const result = childElements(window)
	.slice(0, 80)
	.map((child, index) => serialize(child, String(index), 1, maxDepth))
	.filter(Boolean);

JSON.stringify(result);
`);
}

function buildTargetLookup(
  appName: string,
  windowIndex: number,
  target: AXTarget,
  mode: "click" | "type" = "click",
): string {
  const path = target.path ? escapeJs(target.path) : "null";
  const title = target.title ? escapeJs(target.title) : "null";
  const roles = JSON.stringify(roleCandidates(target.role));

  // For type mode, add fallback chain: role/title search → focused element → any text input
  const fallbackCode =
    mode === "type"
      ? String.raw`
if (!target) {
	// Fallback 1: try the currently focused element
	target = findFocusedElement(window);
}
if (!target) {
	// Fallback 2: try any text-accepting element in the tree
	target = findAnyTextInput(window);
}
`
      : "";

  return String.raw`
const appName = ${escapeJs(appName)};
const windowIndex = ${windowIndex};
const targetPath = ${path};
const targetTitle = ${title};
const targetRoles = ${roles};
const process = se.applicationProcesses.byName(appName);
const window = safe(() => process.windows()[windowIndex - 1], null);

if (!window) {
	throw new Error("Window " + windowIndex + " not found for " + appName);
}

var target = targetPath !== null
	? elementFromPath(window, targetPath)
	: findElement(window, targetRoles, targetTitle);
${fallbackCode}
if (!target) {
	throw new Error("Target element not found");
}
`;
}

function axClick(
  appName: string,
  windowIndex: number,
  target: AXTarget,
): boolean {
  return runJxaJson<{
    ok: boolean;
  }>(`${buildTargetLookup(appName, windowIndex, target, "click")}
let ok = false;

try {
	target.actions.byName("AXPress").perform();
	ok = true;
} catch (error) {
	try {
		const actions = safe(() => target.actions(), []);
		if (actions.length > 0) {
			actions[0].perform();
			ok = true;
		}
	} catch (innerError) {
		ok = false;
	}
}

if (!ok) {
	throw new Error("Element does not support AXPress");
}

JSON.stringify({ok});
`).ok;
}

function axType(
  appName: string,
  windowIndex: number,
  target: AXTarget,
  text: string,
): boolean {
  return runJxaJson<{
    ok: boolean;
  }>(`${buildTargetLookup(appName, windowIndex, target, "type")}
target.value = ${escapeJs(text)};
JSON.stringify({ok: true});
`).ok;
}

function getElementFrame(
  appName: string,
  windowIndex: number,
  target: AXTarget,
): { x: number; y: number; width: number; height: number } | null {
  return runJxaJson<{
    frame: { x: number; y: number; width: number; height: number } | null;
  }>(`${buildTargetLookup(appName, windowIndex, target, "click")}
JSON.stringify({frame: frameFor(target)});
`).frame;
}

async function moveOverlayToElement(
  appName: string,
  windowIndex: number,
  target: AXTarget,
): Promise<void> {
  const ov = await getOverlay();
  if (!ov?.isRunning) return;

  try {
    const frame = getElementFrame(appName, windowIndex, target);
    if (!frame) return;
    await ov.clickAt(frame.x + frame.width / 2, frame.y + frame.height / 2);
  } catch {
    // Visual feedback is best effort only.
  }
}

function validateTarget(path?: string, role?: string): void {
  if (!path && !role) {
    throw new Error(
      "Provide either `path` from get_ax_tree or a `role` to search for",
    );
  }
}

export function registerWindowTools(server: McpServer): void {
  server.registerTool(
    "windows",
    {
      title: "Query Windows, Apps, and Desktops",
      description:
        "Query macOS application and window state. " +
        "Set `action` to one of: " +
        "`list_apps` to return running foreground applications with name, bundle ID, and PID; " +
        "`list_windows` to return open windows across apps, including background and minimized windows, with bounds and native window IDs; " +
        "`list_desktops` to return numbered macOS desktops (Spaces). " +
        "Start here to discover app names, window indexes, and window IDs before using `capture_window`, `get_ax_tree`, `ax_click`, `ax_type`, or `click_bg_xy`.",
      inputSchema: z
        .object({
          action: z
            .enum(["list_apps", "list_windows", "list_desktops"])
            .describe("What to query from macOS"),
          app: z
            .string()
            .optional()
            .describe(
              "Optional app name filter. Only used when action is list_windows.",
            ),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { action, app } = args as {
        action: "list_apps" | "list_windows" | "list_desktops";
        app?: string;
      };

      if (action === "list_apps") {
        return jsonResult({ apps: listRunningApps() });
      }

      if (action === "list_windows") {
        const windows = app
          ? listAllWindows().filter(
              (window) => window.appName.toLowerCase() === app.toLowerCase(),
            )
          : listAllWindows();
        return jsonResult({ windows });
      }

      return jsonResult({ desktops: listDesktops() });
    },
  );

  server.registerTool(
    "capture_window",
    {
      title: "Capture Window Screenshot",
      description:
        "Capture a screenshot of a specific window, including background windows that are covered, unfocused, or not currently visible in the main screen screenshot. " +
        "Provide `window_id` from `windows` with `action=list_windows`, or provide `app` and `window_index`. " +
        "Prefer this when Electron or custom-rendered apps do not expose a useful AX tree.",
      inputSchema: z
        .object({
          app: z
            .string()
            .optional()
            .describe("Application name, used with window_index"),
          window_index: z
            .number()
            .optional()
            .describe(
              "Window index from windows(action=list_windows), used with app",
            ),
          window_id: z
            .number()
            .optional()
            .describe(
              "Native window ID from windows(action=list_windows). Most reliable when provided directly.",
            ),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { app, window_index, window_id } = args as {
        app?: string;
        window_index?: number;
        window_id?: number;
      };

      if (window_id === undefined && (!app || window_index === undefined)) {
        throw new Error(
          "Provide either `window_id` or both `app` and `window_index`.",
        );
      }

      const resolvedWindowId =
        window_id ?? resolveWindowId(app!, window_index!);
      const image = await prepareWindowImage(
        captureNativeWindow(resolvedWindowId),
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              window_id: resolvedWindowId,
              image_width: image.width,
              image_height: image.height,
            }),
          },
          {
            type: "image",
            data: image.buffer.toString("base64"),
            mimeType: "image/png",
          },
        ],
      };
    },
  );

  server.registerTool(
    "ax_click",
    {
      title: "Click Element in Window",
      description:
        "Press a UI element through the macOS Accessibility API without moving the real mouse cursor or changing window focus. " +
        "Use `path` from `get_ax_tree` for precise targeting, or provide `role` and optional `title` to find an element by search. " +
        "Use `show_cursor` for optional visual feedback through the internal overlay.",
      inputSchema: z
        .object({
          app: z
            .string()
            .describe(
              "Application name as returned by windows(action=list_apps)",
            ),
          window_index: z
            .number()
            .optional()
            .describe("1-based window index. Defaults to 1."),
          path: z
            .string()
            .optional()
            .describe(
              "Stable element path from get_ax_tree, for precise AX targeting",
            ),
          role: z
            .string()
            .optional()
            .describe("AX role to search for, such as button or textfield"),
          title: z
            .string()
            .optional()
            .describe(
              "Exact element label/title to match when searching by role",
            ),
          show_cursor: z
            .boolean()
            .optional()
            .describe(
              "Show the internal cursor overlay at the target element before clicking",
            ),
        })
        .strict(),
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const { app, window_index, path, role, title, show_cursor } = args as {
        app: string;
        window_index?: number;
        path?: string;
        role?: string;
        title?: string;
        show_cursor?: boolean;
      };

      validateTarget(path, role);
      const target = { path, role, title };

      if (show_cursor) {
        await moveOverlayToElement(app, window_index ?? 1, target);
      }

      const ok = axClick(app, window_index ?? 1, target);
      return ok
        ? jsonResult({
            ok: true,
            app,
            window_index: window_index ?? 1,
            path,
            role,
            title,
          })
        : jsonResult({
            ok: false,
            error: "Click failed. Check the target from get_ax_tree.",
          });
    },
  );

  server.registerTool(
    "ax_type",
    {
      title: "Type Into Element in Window",
      description:
        "Set the value of a text field in a background or unfocused window through the macOS Accessibility API. " +
        "Use `path` from `get_ax_tree` for precise targeting, or provide `role` and optional `title` to find an element by search. " +
        "If `role` is omitted, text-field lookup is used by default.",
      inputSchema: z
        .object({
          app: z
            .string()
            .describe(
              "Application name as returned by windows(action=list_apps)",
            ),
          window_index: z
            .number()
            .optional()
            .describe("1-based window index. Defaults to 1."),
          path: z
            .string()
            .optional()
            .describe(
              "Stable element path from get_ax_tree, for precise AX targeting",
            ),
          role: z
            .string()
            .optional()
            .describe(
              "AX role to search for. Defaults to textfield lookup when omitted",
            ),
          title: z
            .string()
            .optional()
            .describe(
              "Exact element label/title to match when searching by role",
            ),
          text: z.string().describe("Text to set as the element value"),
        })
        .strict(),
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const { app, window_index, path, role, title, text } = args as {
        app: string;
        window_index?: number;
        path?: string;
        role?: string;
        title?: string;
        text: string;
      };

      validateTarget(path, role ?? "text");
      const target = { path, role: role ?? "text", title };
      const ok = axType(app, window_index ?? 1, target, text);

      return ok
        ? jsonResult({
            ok: true,
            app,
            window_index: window_index ?? 1,
            path,
            role: role ?? "text",
            title,
          })
        : jsonResult({
            ok: false,
            error: "Type failed. Check the target from get_ax_tree.",
          });
    },
  );

  server.registerTool(
    "click_bg_xy",
    {
      title: "Click Background Window by Image Coordinates",
      description:
        "Click a pixel coordinate inside a specific window using the image returned by `capture_window`, without moving the real mouse cursor or bringing the window to the front. " +
        "Use this for background, covered, or unfocused windows that are not reliably targetable through the visible screen screenshot.",
      inputSchema: z
        .object({
          app: z
            .string()
            .optional()
            .describe("Application name, used with window_index"),
          window_index: z
            .number()
            .optional()
            .describe(
              "1-based window index from windows(action=list_windows), used with app",
            ),
          window_id: z
            .number()
            .optional()
            .describe(
              "Native window ID from windows(action=list_windows). Most reliable when provided directly.",
            ),
          x: z
            .number()
            .describe(
              "Horizontal pixel coordinate in the capture_window image space",
            ),
          y: z
            .number()
            .describe(
              "Vertical pixel coordinate in the capture_window image space",
            ),
          show_cursor: z
            .boolean()
            .optional()
            .describe(
              "Show the internal cursor overlay at the computed click position",
            ),
        })
        .strict(),
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const { app, window_index, window_id, x, y, show_cursor } = args as {
        app?: string;
        window_index?: number;
        window_id?: number;
        x: number;
        y: number;
        show_cursor?: boolean;
      };

      if (window_id === undefined && (!app || window_index === undefined)) {
        throw new Error(
          "Provide either `window_id` or both `app` and `window_index`.",
        );
      }

      const resolvedWindowId =
        window_id ?? resolveWindowId(app!, window_index!);
      await clickInsideBackgroundWindow(resolvedWindowId, x, y, show_cursor);

      return jsonResult({
        ok: true,
        window_id: resolvedWindowId,
        x,
        y,
      });
    },
  );

  server.registerTool(
    "get_ax_tree",
    {
      title: "Get Accessibility Tree",
      description:
        "Get the accessibility tree for a specific window. Works for background windows and returns JSON with stable element paths for later use with `ax_click` or `ax_type`. " +
        "Default depth is 6, but Electron/web-based apps may need higher values (8-10) to reach interactive elements buried under AXWebArea containers. " +
        "The tree automatically goes 2 levels deeper for structural web roles (AXWebArea, AXScrollArea, AXGroup, etc.).",
      inputSchema: z
        .object({
          app: z
            .string()
            .describe(
              "Application name as returned by windows(action=list_apps)",
            ),
          window_index: z
            .number()
            .optional()
            .describe("Window index (1-based). Defaults to 1."),
          max_depth: z
            .number()
            .optional()
            .describe(
              "Maximum tree traversal depth. Defaults to 6. Use 8-10 for Electron/web-based apps. Web container roles (AXWebArea, AXScrollArea, AXGroup) automatically get +2 extra depth.",
            ),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const { app, window_index, max_depth } = args as {
        app: string;
        window_index?: number;
        max_depth?: number;
      };
      const depth = Math.min(max_depth ?? 6, 15); // Cap at 15 to avoid perf issues
      return jsonResult({
        app,
        window_index: window_index ?? 1,
        max_depth: depth,
        elements: getAXTree(app, window_index ?? 1, depth),
      });
    },
  );
}
