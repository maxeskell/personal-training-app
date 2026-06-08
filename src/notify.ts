import { execFile } from "node:child_process";
import { platform } from "node:os";

/**
 * Best-effort desktop notification (for the unattended morning ping). macOS only, via osascript;
 * a no-op everywhere else and never throws — a failed notification must not break the ping.
 */
export function notify(title: string, message: string): Promise<void> {
  return new Promise((resolve) => {
    if (platform() !== "darwin") return resolve();
    // Escape double quotes for AppleScript string literals.
    const esc = (s: string) => s.replace(/["\\]/g, "\\$&").replace(/\n/g, " ");
    const script = `display notification "${esc(message)}" with title "${esc(title)}"`;
    execFile("osascript", ["-e", script], () => resolve());
  });
}
