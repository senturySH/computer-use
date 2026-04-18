import { ChildProcess, spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type CursorStyle = "default" | "pointer" | "text" | "wait" | "click";

/**
 * Controls the cursor-overlay Swift binary via stdin commands.
 * The overlay is a transparent always-on-top click-through window.
 */
export class CursorOverlay {
  private proc: ChildProcess | null = null;
  private ready = false;
  private binaryPath: string;

  constructor(binaryPath?: string) {
    const candidates = [
      binaryPath,
      process.env.CURSOR_OVERLAY_BIN,
      join(__dirname, "..", "..", "bin", "cursor-overlay"),
      join(__dirname, "..", "bin", "cursor-overlay"),
    ].filter(Boolean) as string[];

    this.binaryPath = candidates.find((p) => existsSync(p)) ?? "";
  }

  /** Start the overlay process. Resolves when the binary prints READY. */
  async start(): Promise<void> {
    if (this.proc) return;
    if (!this.binaryPath) {
      throw new Error(
        "cursor-overlay binary not found. Run `npm run build:native` or set CURSOR_OVERLAY_BIN.",
      );
    }

    return new Promise<void>((resolve, reject) => {
      this.proc = spawn(this.binaryPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let buf = "";
      const onData = (data: Buffer) => {
        buf += data.toString();
        if (buf.includes("READY")) {
          this.proc?.stdout?.off("data", onData);
          this.ready = true;
          resolve();
        }
      };
      this.proc.stdout?.on("data", onData);
      this.proc.on("error", reject);
      this.proc.on("exit", () => {
        this.proc = null;
        this.ready = false;
      });

      setTimeout(() => {
        if (!this.ready) reject(new Error("cursor-overlay start timeout"));
      }, 5000);
    });
  }

  private send(cmd: string): void {
    if (!this.proc?.stdin || !this.ready) return;
    this.proc.stdin.write(cmd + "\n");
  }

  move(x: number, y: number): void {
    this.send(`MOVE ${Math.round(x)},${Math.round(y)}`);
  }

  show(): void {
    this.send("SHOW");
  }

  hide(): void {
    this.send("HIDE");
  }

  setStyle(style: CursorStyle): void {
    this.send(`STYLE ${style}`);
  }

  pulse(): void {
    this.send("PULSE");
  }

  /** Move + pulse — visual click feedback. */
  async clickAt(x: number, y: number): Promise<void> {
    this.move(x, y);
    this.pulse();
    await new Promise((r) => setTimeout(r, 300));
  }

  stop(): void {
    if (this.proc) {
      this.send("QUIT");
      this.proc.kill("SIGTERM");
      this.proc = null;
      this.ready = false;
    }
  }

  get isRunning(): boolean {
    return this.ready && this.proc !== null;
  }
}
