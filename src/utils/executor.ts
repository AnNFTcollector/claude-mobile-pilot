import { execFile, spawn } from "node:child_process";

/**
 * Safe native command execution.
 *
 * Commands are run with `execFile` (argument vector, no shell) rather than
 * `exec`, so user-supplied values such as device IDs or file paths can never
 * be interpreted as shell syntax. Every argument is additionally validated
 * before execution.
 */

export const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024; // screenshots can be large

export class CommandError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly exitCode: number | string | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export interface ExecResult<T extends string | Buffer = string> {
  stdout: T;
  stderr: string;
}

export interface ExecOptions {
  timeoutMs?: number;
}

/** Hints shown when a required toolchain binary is missing. */
const INSTALL_HINTS: Record<string, string> = {
  xcrun:
    "Xcode command line tools were not found. iOS Simulator support requires macOS with Xcode installed " +
    "(install Xcode from the App Store, then run `xcode-select --install`).",
  adb:
    "`adb` was not found on PATH. Install Android Studio (or the Android SDK platform-tools) and add " +
    "`$ANDROID_HOME/platform-tools` to your PATH.",
  emulator:
    "The Android `emulator` binary was not found on PATH. Install it via Android Studio's SDK Manager and add " +
    "`$ANDROID_HOME/emulator` to your PATH.",
};

// Reject control characters (incl. NUL/newlines) in any argument.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Validate a single argument; throws on anything suspicious. */
export function sanitizeArg(value: string, label = "argument"): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  if (value.length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  if (value.length > 4096) {
    throw new TypeError(`${label} is too long`);
  }
  if (CONTROL_CHARS.test(value)) {
    throw new TypeError(`${label} contains control characters`);
  }
  return value;
}

/** Validate an identifier-like value (UDID, AVD name, adb serial). */
export function sanitizeIdentifier(value: string, label = "identifier"): string {
  sanitizeArg(value, label);
  if (!/^[A-Za-z0-9._:\-]+$/.test(value)) {
    throw new TypeError(
      `${label} "${value}" contains invalid characters (allowed: letters, digits, '.', '_', ':', '-')`,
    );
  }
  if (value.startsWith("-")) {
    throw new TypeError(`${label} must not start with '-'`);
  }
  return value;
}

export function log(...parts: unknown[]): void {
  // stdout is reserved for JSON-RPC; always log to stderr.
  console.error("[mobile-vision-bridge]", ...parts);
}

function formatCommand(file: string, args: readonly string[]): string {
  return [file, ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

function toCommandError(
  file: string,
  args: readonly string[],
  err: NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string | null },
  stderr: string,
  timeoutMs: number,
): CommandError {
  const cmd = formatCommand(file, args);
  if (err.code === "ENOENT") {
    const hint = INSTALL_HINTS[file] ?? `The executable "${file}" was not found on PATH.`;
    return new CommandError(hint, cmd, "ENOENT", stderr);
  }
  if (err.killed || err.signal === "SIGTERM") {
    return new CommandError(`Command timed out after ${timeoutMs}ms: ${cmd}`, cmd, err.code ?? null, stderr);
  }
  const detail = stderr.trim() || err.message;
  return new CommandError(`Command failed (exit ${String(err.code)}): ${cmd}\n${detail}`, cmd, err.code ?? null, stderr);
}

function run<T extends string | Buffer>(
  file: string,
  args: string[],
  encoding: "utf8" | "buffer",
  options: ExecOptions,
): Promise<ExecResult<T>> {
  sanitizeArg(file, "executable");
  args.forEach((a, i) => sanitizeArg(a, `argument ${i + 1}`));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cmd = formatCommand(file, args);
  log("exec:", cmd);

  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding, timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        const stderrText = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? "");
        if (error) {
          const e = toCommandError(file, args, error as NodeJS.ErrnoException, stderrText, timeoutMs);
          log("error:", e.message);
          reject(e);
          return;
        }
        if (stderrText.trim()) log("stderr:", stderrText.trim());
        resolve({ stdout: stdout as T, stderr: stderrText });
      },
    );
  });
}

/** Run a command and return its UTF-8 stdout/stderr. */
export function execCommand(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult<string>> {
  return run<string>(file, args, "utf8", options);
}

/** Run a command and return raw binary stdout (e.g. PNG screencaps). */
export function execCommandBuffer(
  file: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult<Buffer>> {
  return run<Buffer>(file, args, "buffer", options);
}

/**
 * Launch a long-running process fully detached (equivalent of `cmd &`).
 * Resolves once the process has spawned; rejects if the binary is missing.
 */
export function spawnDetached(file: string, args: string[]): Promise<number | undefined> {
  sanitizeArg(file, "executable");
  args.forEach((a, i) => sanitizeArg(a, `argument ${i + 1}`));
  const cmd = formatCommand(file, args);
  log("spawn (detached):", cmd);

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", (err: NodeJS.ErrnoException) => {
      reject(toCommandError(file, args, err, "", 0));
    });
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

/** Turn any thrown value into a user-readable message. */
export function describeError(err: unknown): string {
  if (err instanceof CommandError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
