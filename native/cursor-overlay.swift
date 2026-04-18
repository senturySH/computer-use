import Cocoa
import Foundation

// Virtual Cursor Overlay
// Always-on-top, click-through window showing an SVG-style cursor.
// Controlled via stdin commands. Writes "READY\n" to stdout on startup.
//
// Commands (one per line on stdin):
//   MOVE x,y          Move cursor to screen position
//   SHOW              Show the overlay
//   HIDE              Hide the overlay
//   STYLE name        Set cursor style (default|pointer|text|wait|click)
//   PULSE             Play a brief scale-bounce animation
//   QUIT              Exit

class OverlayWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var window: OverlayWindow!
    var imageView: NSImageView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let sz: CGFloat = 32
        let frame = NSRect(x: 0, y: 0, width: sz, height: sz)

        window = OverlayWindow(
            contentRect: frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.level = .statusBar
        window.isOpaque = false
        window.backgroundColor = .clear
        window.ignoresMouseEvents = true
        window.hasShadow = false
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]

        imageView = NSImageView(frame: frame)
        imageView.imageScaling = .scaleProportionallyUpOrDown
        window.contentView?.addSubview(imageView)

        applyStyle("default")
        window.orderFront(nil)
        listenStdin()

        FileHandle.standardOutput.write("READY\n".data(using: .utf8)!)
    }

    @objc func onData(_ n: Notification) {
        guard let data = n.userInfo?[NSFileHandleNotificationDataItem] as? Data,
              data.count > 0 else { NSApp.terminate(nil); return }

        for raw in (String(data: data, encoding: .utf8) ?? "").split(separator: "\n") {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line == "QUIT" { NSApp.terminate(nil); return }
            dispatch(line)
        }
        (n.object as? FileHandle)?.readInBackgroundAndNotify()
    }

    func dispatch(_ line: String) {
        let parts = line.split(separator: " ", maxSplits: 1)
        guard let cmd = parts.first else { return }
        let arg = parts.count > 1 ? String(parts[1]) : ""

        switch cmd {
        case "MOVE":
            let c = arg.split(separator: ",")
            if c.count == 2, let x = Double(c[0]), let y = Double(c[1]) {
                window.setFrameOrigin(NSPoint(x: x, y: y))
            }
        case "SHOW": window.orderFront(nil)
        case "HIDE": window.orderOut(nil)
        case "STYLE": applyStyle(arg.isEmpty ? "default" : arg)
        case "PULSE": pulse()
        default: break
        }
    }

    func applyStyle(_ style: String) {
        let img = NSImage(size: NSSize(width: 32, height: 32))
        img.lockFocus()
        let ctx = NSGraphicsContext.current!.cgContext

        switch style {
        case "pointer":
            drawArrow(ctx, fill: .systemBlue, stroke: .white)
        case "text":
            drawIBeam(ctx)
        case "wait":
            drawSpinner(ctx)
        case "click":
            drawArrow(ctx, fill: .systemGreen, stroke: .white)
        default:
            drawArrow(ctx, fill: .white, stroke: .black)
        }
        img.unlockFocus()
        imageView.image = img
    }

    func pulse() {
        let orig = imageView.frame
        let big = NSRect(x: orig.origin.x - 4, y: orig.origin.y - 4,
                         width: orig.width + 8, height: orig.height + 8)
        NSAnimationContext.runAnimationGroup({ $0.duration = 0.12; self.imageView.animator().frame = big }) {
            NSAnimationContext.runAnimationGroup({ $0.duration = 0.15; self.imageView.animator().frame = orig })
        }
    }

    // MARK: - Private

    private func listenStdin() {
        let h = FileHandle.standardInput
        NotificationCenter.default.addObserver(
            self, selector: #selector(onData(_:)),
            name: FileHandle.readCompletionNotification, object: h)
        h.readInBackgroundAndNotify()
    }

    private func drawArrow(_ ctx: CGContext, fill: NSColor, stroke: NSColor) {
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 1, height: -1), blur: 2, color: CGColor(gray: 0, alpha: 0.35))
        ctx.setFillColor(fill.cgColor)
        ctx.setStrokeColor(stroke.cgColor)
        ctx.setLineWidth(1.2)
        let p = CGMutablePath()
        p.move(to: CGPoint(x: 2, y: 30))
        p.addLine(to: CGPoint(x: 2, y: 8))
        p.addLine(to: CGPoint(x: 8, y: 13))
        p.addLine(to: CGPoint(x: 14, y: 3))
        p.addLine(to: CGPoint(x: 18, y: 5))
        p.addLine(to: CGPoint(x: 12, y: 15))
        p.addLine(to: CGPoint(x: 20, y: 15))
        p.closeSubpath()
        ctx.addPath(p)
        ctx.drawPath(using: .fillStroke)
        ctx.restoreGState()
    }

    private func drawIBeam(_ ctx: CGContext) {
        ctx.setStrokeColor(NSColor.black.cgColor)
        ctx.setLineWidth(2)
        ctx.move(to: CGPoint(x: 16, y: 2));  ctx.addLine(to: CGPoint(x: 16, y: 30)); ctx.strokePath()
        ctx.setLineWidth(2.5)
        ctx.move(to: CGPoint(x: 11, y: 2));  ctx.addLine(to: CGPoint(x: 21, y: 2));  ctx.strokePath()
        ctx.move(to: CGPoint(x: 11, y: 30)); ctx.addLine(to: CGPoint(x: 21, y: 30)); ctx.strokePath()
    }

    private func drawSpinner(_ ctx: CGContext) {
        let r = CGRect(x: 4, y: 4, width: 24, height: 24)
        ctx.setFillColor(NSColor.white.cgColor)
        ctx.setStrokeColor(NSColor.black.cgColor)
        ctx.setLineWidth(1.5)
        ctx.addEllipse(in: r); ctx.drawPath(using: .fillStroke)
        ctx.setFillColor(NSColor.black.cgColor)
        ctx.fillEllipse(in: CGRect(x: 13, y: 13, width: 6, height: 6))
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
