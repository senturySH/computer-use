import CoreGraphics
import Foundation

struct WindowBounds: Codable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
}

struct WindowInfo: Codable {
    let id: UInt32
    let ownerPid: pid_t
    let ownerName: String
    let name: String
    let bounds: WindowBounds
    let layer: Int
    let alpha: Double
    let onScreen: Bool
}

struct DisplayInfo: Codable {
    let id: UInt32
    let bounds: WindowBounds
    let isMain: Bool
    let scaleFactor: Double
}

struct DisplayLayout: Codable {
    let displays: [DisplayInfo]
    let unifiedBounds: WindowBounds
}

enum WindowCaptureError: Error {
    case invalidArguments(String)
    case windowNotFound(UInt32)
    case captureFailed(UInt32)
    case clickFailed(UInt32)
}

func writeStderr(_ message: String) {
    if let data = (message + "\n").data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

func allWindows() -> [WindowInfo] {
    guard let raw = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else {
        return []
    }

    return raw.compactMap { entry in
        guard let id = entry[kCGWindowNumber as String] as? UInt32 else {
            return nil
        }

        let ownerPid = entry[kCGWindowOwnerPID as String] as? pid_t ?? 0
        let ownerName = entry[kCGWindowOwnerName as String] as? String ?? ""
        let name = entry[kCGWindowName as String] as? String ?? ""
        let layer = entry[kCGWindowLayer as String] as? Int ?? 0
        let alpha = entry[kCGWindowAlpha as String] as? Double ?? 1
        let onScreen = entry[kCGWindowIsOnscreen as String] as? Bool ?? false
        let boundsDict = entry[kCGWindowBounds as String] as? [String: Any] ?? [:]

        let bounds = WindowBounds(
            x: Int((boundsDict["X"] as? Double) ?? 0),
            y: Int((boundsDict["Y"] as? Double) ?? 0),
            width: Int((boundsDict["Width"] as? Double) ?? 0),
            height: Int((boundsDict["Height"] as? Double) ?? 0)
        )

        return WindowInfo(
            id: id,
            ownerPid: ownerPid,
            ownerName: ownerName,
            name: name,
            bounds: bounds,
            layer: layer,
            alpha: alpha,
            onScreen: onScreen
        )
    }
}

func clickWindow(id: UInt32, relativeX: Double, relativeY: Double) throws {
    guard let window = allWindows().first(where: { $0.id == id }) else {
        throw WindowCaptureError.windowNotFound(id)
    }

    let clampedX = min(max(relativeX, 0), 1)
    let clampedY = min(max(relativeY, 0), 1)
    let absoluteX = Double(window.bounds.x) + (Double(window.bounds.width) * clampedX)
    let absoluteY = Double(window.bounds.y) + (Double(window.bounds.height) * clampedY)
    let point = CGPoint(x: absoluteX, y: absoluteY)

    guard
        let mouseDown = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
        let mouseUp = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    else {
        throw WindowCaptureError.clickFailed(id)
    }

    mouseDown.postToPid(window.ownerPid)
    mouseUp.postToPid(window.ownerPid)
}

func listDisplays() throws {
    var displayCount: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &displayCount)

    var displayIds = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
    CGGetActiveDisplayList(displayCount, &displayIds, &displayCount)

    var displays: [DisplayInfo] = []
    var minX = Int.max
    var minY = Int.max
    var maxX = Int.min
    var maxY = Int.min

    for displayId in displayIds {
        let rect = CGDisplayBounds(displayId)
        let x = Int(rect.origin.x)
        let y = Int(rect.origin.y)
        let w = Int(rect.size.width)
        let h = Int(rect.size.height)

        minX = min(minX, x)
        minY = min(minY, y)
        maxX = max(maxX, x + w)
        maxY = max(maxY, y + h)

        // CGDisplayPixelsWide / CGDisplayPixelsHigh give native (backing) pixels
        // CGDisplayBounds gives logical (point) dimensions
        let nativeWidth = CGDisplayPixelsWide(displayId)
        let scaleFactor = w > 0 ? Double(nativeWidth) / Double(w) : 1.0

        displays.append(DisplayInfo(
            id: UInt32(displayId),
            bounds: WindowBounds(x: x, y: y, width: w, height: h),
            isMain: CGDisplayIsMain(displayId) != 0,
            scaleFactor: scaleFactor
        ))
    }

    let unified = WindowBounds(
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY
    )

    let layout = DisplayLayout(displays: displays, unifiedBounds: unified)
    let encoder = JSONEncoder()
    let data = try encoder.encode(layout)
    FileHandle.standardOutput.write(data)
}

func listWindows() throws {
    let encoder = JSONEncoder()
    let data = try encoder.encode(allWindows())
    FileHandle.standardOutput.write(data)
}

/// Capture a single display by its 1-based index (matching screencapture -D).
/// Index 1 is the main display. Writes PNG to stdout.
func captureDisplay(displayIndex: Int) throws {
    let outputUrl = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("screen-capture-\(ProcessInfo.processInfo.processIdentifier).png")

    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    task.arguments = ["-x", "-t", "png", "-D", String(displayIndex), outputUrl.path]
    task.standardError = Pipe()

    try task.run()
    task.waitUntilExit()

    guard let data = try? Data(contentsOf: outputUrl), !data.isEmpty else {
        try? FileManager.default.removeItem(at: outputUrl)
        throw WindowCaptureError.captureFailed(0)
    }
    try? FileManager.default.removeItem(at: outputUrl)
    FileHandle.standardOutput.write(data)
}

func captureWindow(id: UInt32) throws {
    let known = allWindows().contains(where: { $0.id == id })
    if !known {
        throw WindowCaptureError.windowNotFound(id)
    }

    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    let outputUrl = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("window-capture-\(ProcessInfo.processInfo.processIdentifier)-\(id).png")
    task.arguments = ["-x", "-t", "png", "-l", String(id), outputUrl.path]

    let error = Pipe()
    task.standardError = error

    try task.run()
    task.waitUntilExit()

    let data = try? Data(contentsOf: outputUrl)
    try? FileManager.default.removeItem(at: outputUrl)

    if task.terminationStatus != 0 || data == nil || data?.isEmpty == true {
        throw WindowCaptureError.captureFailed(id)
    }

    FileHandle.standardOutput.write(data!)
}

func parseWindowId(args: [String]) throws -> UInt32 {
    guard let idIndex = args.firstIndex(of: "--id"), args.indices.contains(idIndex + 1) else {
        throw WindowCaptureError.invalidArguments("Missing --id <window-id>")
    }

    guard let id = UInt32(args[idIndex + 1]) else {
        throw WindowCaptureError.invalidArguments("Invalid window id: \(args[idIndex + 1])")
    }

    return id
}

func parseRelativeCoordinate(flag: String, args: [String]) throws -> Double {
    guard let index = args.firstIndex(of: flag), args.indices.contains(index + 1) else {
        throw WindowCaptureError.invalidArguments("Missing \(flag) <relative-coordinate>")
    }

    guard let value = Double(args[index + 1]) else {
        throw WindowCaptureError.invalidArguments("Invalid value for \(flag): \(args[index + 1])")
    }

    return value
}

do {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let command = args.first else {
        throw WindowCaptureError.invalidArguments("Usage: window-capture <list|capture|capture-display|click|displays> [--id <window-id>] [--index <display-index>] [--x <relative-x>] [--y <relative-y>]")
    }

    switch command {
    case "list":
        try listWindows()
    case "displays":
        try listDisplays()
    case "capture":
        try captureWindow(id: parseWindowId(args: args))
    case "capture-display":
        guard let idxPos = args.firstIndex(of: "--index"), args.indices.contains(idxPos + 1),
              let idx = Int(args[idxPos + 1]), idx >= 1 else {
            throw WindowCaptureError.invalidArguments("Usage: window-capture capture-display --index <1-based display index>")
        }
        try captureDisplay(displayIndex: idx)
    case "click":
        try clickWindow(
            id: parseWindowId(args: args),
            relativeX: parseRelativeCoordinate(flag: "--x", args: args),
            relativeY: parseRelativeCoordinate(flag: "--y", args: args)
        )
    default:
        throw WindowCaptureError.invalidArguments("Unknown command: \(command)")
    }
} catch WindowCaptureError.invalidArguments(let message) {
    writeStderr(message)
    exit(2)
} catch WindowCaptureError.windowNotFound(let id) {
    writeStderr("Window not found: \(id)")
    exit(3)
} catch WindowCaptureError.captureFailed(let id) {
    writeStderr("Failed to capture window: \(id)")
    exit(4)
} catch WindowCaptureError.clickFailed(let id) {
    writeStderr("Failed to click window: \(id)")
    exit(5)
} catch {
    writeStderr(String(describing: error))
    exit(1)
}
