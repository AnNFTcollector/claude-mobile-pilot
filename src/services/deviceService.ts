import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  describeError,
  execCommand,
  execCommandBuffer,
  log,
  sanitizeArg,
  sanitizeIdentifier,
  spawnDetached,
} from "../utils/executor.js";

export type Platform = "ios" | "android";

export interface DeviceInfo {
  platform: Platform;
  id: string;
  name: string;
  state: string;
  runtime?: string;
}

export interface DeviceListing {
  devices: DeviceInfo[];
  errors: { platform: Platform; message: string }[];
}

export interface ScreenshotResult {
  base64: string;
  mimeType: "image/png";
  savedTo?: string;
  bytes: number;
}

export function assertPlatform(value: unknown): Platform {
  if (value === "ios" || value === "android") return value;
  throw new TypeError(`platform must be "ios" or "android" (got ${JSON.stringify(value)})`);
}

function assertCoordinate(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
  return Math.round(value);
}

async function resolveExistingPath(p: string, label: string): Promise<string> {
  sanitizeArg(p, label);
  if (!path.isAbsolute(p)) throw new TypeError(`${label} must be an absolute path (got "${p}")`);
  const resolved = path.resolve(p);
  try {
    await stat(resolved);
  } catch {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

function resolveOutputPath(p: string): string {
  sanitizeArg(p, "outputPath");
  const resolved = path.resolve(p);
  return resolved.toLowerCase().endsWith(".png") ? resolved : `${resolved}.png`;
}

// ---------------------------------------------------------------------------
// iOS (xcrun simctl)
// ---------------------------------------------------------------------------

interface SimctlDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable?: boolean;
}

async function listIosDevices(): Promise<DeviceInfo[]> {
  const { stdout } = await execCommand("xcrun", ["simctl", "list", "devices", "available", "--json"]);
  let parsed: { devices?: Record<string, SimctlDevice[]> };
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    throw new Error("Failed to parse `xcrun simctl list` JSON output.");
  }
  const result: DeviceInfo[] = [];
  for (const [runtimeKey, devices] of Object.entries(parsed.devices ?? {})) {
    const runtime = runtimeKey.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "").replace(/-/g, ".");
    for (const d of devices) {
      result.push({ platform: "ios", id: d.udid, name: d.name, state: d.state, runtime });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Android (adb / emulator)
// ---------------------------------------------------------------------------

async function listAndroidDevices(): Promise<DeviceInfo[]> {
  const [avdResult, adbResult] = await Promise.allSettled([
    execCommand("emulator", ["-list-avds"]),
    execCommand("adb", ["devices"]),
  ]);

  if (avdResult.status === "rejected" && adbResult.status === "rejected") {
    throw new Error(`${describeError(avdResult.reason)}\n${describeError(adbResult.reason)}`);
  }

  const avdNames =
    avdResult.status === "fulfilled"
      ? avdResult.value.stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("INFO") && !l.includes(" "))
      : [];

  // Connected devices: "emulator-5554\tdevice"
  const connected: { serial: string; state: string }[] = [];
  if (adbResult.status === "fulfilled") {
    for (const line of adbResult.value.stdout.split(/\r?\n/).slice(1)) {
      const [serial, state] = line.trim().split(/\s+/);
      if (serial && state) connected.push({ serial, state });
    }
  }

  // Map running emulators back to their AVD names.
  const runningAvds = new Map<string, { serial: string; state: string }>();
  await Promise.all(
    connected
      .filter((c) => c.serial.startsWith("emulator-") && c.state === "device")
      .map(async (c) => {
        try {
          const { stdout } = await execCommand("adb", ["-s", c.serial, "emu", "avd", "name"], { timeoutMs: 5_000 });
          const name = stdout.split(/\r?\n/)[0]?.trim();
          if (name) runningAvds.set(name, c);
        } catch (err) {
          log(`could not resolve AVD name for ${c.serial}:`, describeError(err));
        }
      }),
  );

  const result: DeviceInfo[] = avdNames.map((name) => {
    const running = runningAvds.get(name);
    return {
      platform: "android",
      id: name,
      name: running ? `${name} (${running.serial})` : name,
      state: running ? "Booted" : "Shutdown",
    };
  });

  // Physical devices or emulators without a matching AVD entry.
  const mappedSerials = new Set([...runningAvds.values()].map((r) => r.serial));
  for (const c of connected) {
    if (!mappedSerials.has(c.serial)) {
      result.push({
        platform: "android",
        id: c.serial,
        name: c.serial,
        state: c.state === "device" ? "Booted" : c.state,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function listDevices(): Promise<DeviceListing> {
  const [ios, android] = await Promise.allSettled([listIosDevices(), listAndroidDevices()]);
  const listing: DeviceListing = { devices: [], errors: [] };
  if (ios.status === "fulfilled") listing.devices.push(...ios.value);
  else listing.errors.push({ platform: "ios", message: describeError(ios.reason) });
  if (android.status === "fulfilled") listing.devices.push(...android.value);
  else listing.errors.push({ platform: "android", message: describeError(android.reason) });
  return listing;
}

export async function bootDevice(platform: Platform, deviceId: string): Promise<string> {
  const id = sanitizeIdentifier(deviceId, "deviceId");
  if (platform === "ios") {
    try {
      await execCommand("xcrun", ["simctl", "boot", id]);
    } catch (err) {
      // simctl errors if the device is already booted; treat as success.
      if (/current state: Booted/i.test(describeError(err))) {
        return `iOS simulator ${id} is already booted.`;
      }
      throw err;
    }
    // Best effort: bring Simulator.app to the foreground so the device is visible.
    execCommand("open", ["-a", "Simulator"]).catch((e) => log("could not open Simulator.app:", describeError(e)));
    return `iOS simulator ${id} booted.`;
  }

  const pid = await spawnDetached("emulator", ["-avd", id, "-no-snapshot-load"]);
  return (
    `Android emulator "${id}" is starting (pid ${pid ?? "unknown"}). ` +
    "Cold boot can take 30-120s; call list_mobile_devices to confirm it reports Booted."
  );
}

export async function takeScreenshot(platform: Platform, outputPath?: string): Promise<ScreenshotResult> {
  let png: Buffer;

  if (platform === "ios") {
    const dir = await mkdtemp(path.join(tmpdir(), "mvb-"));
    const tmpFile = path.join(dir, "screenshot.png");
    try {
      await execCommand("xcrun", ["simctl", "io", "booted", "screenshot", tmpFile]);
      png = await readFile(tmpFile);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else {
    // Equivalent of `adb exec-out screencap -p > <path>`, captured in-memory.
    const { stdout } = await execCommandBuffer("adb", ["exec-out", "screencap", "-p"]);
    png = stdout;
  }

  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  if (png.length < 8 || !png.subarray(0, 4).equals(PNG_MAGIC)) {
    throw new Error("Screenshot capture did not return a valid PNG. Is a device booted and unlocked?");
  }

  let savedTo: string | undefined;
  if (outputPath) {
    savedTo = resolveOutputPath(outputPath);
    await mkdir(path.dirname(savedTo), { recursive: true });
    await writeFile(savedTo, png);
  }

  return { base64: png.toString("base64"), mimeType: "image/png", savedTo, bytes: png.length };
}

export async function installApp(platform: Platform, appPath: string, deviceId: string): Promise<string> {
  const resolved = await resolveExistingPath(appPath, "appPath");
  const id = sanitizeIdentifier(deviceId, "deviceId");
  const ext = path.extname(resolved).toLowerCase();

  if (platform === "ios") {
    if (ext !== ".app" && ext !== ".ipa") {
      throw new TypeError(`iOS installs require a .app or .ipa (got "${ext || "no extension"}")`);
    }
    await execCommand("xcrun", ["simctl", "install", id, resolved], { timeoutMs: 180_000 });
    return `Installed ${path.basename(resolved)} on iOS simulator ${id}.`;
  }

  if (ext !== ".apk") throw new TypeError(`Android installs require an .apk (got "${ext || "no extension"}")`);
  // deviceId may be an adb serial or an AVD name; resolve to a connected serial.
  const serial = await resolveAndroidSerial(id);
  const serialArgs = serial ? ["-s", serial] : [];
  const { stdout } = await execCommand("adb", [...serialArgs, "install", "-r", resolved], { timeoutMs: 300_000 });
  if (!/Success/i.test(stdout)) throw new Error(`adb install did not report success:\n${stdout.trim()}`);
  return `Installed ${path.basename(resolved)} on Android device ${id}.`;
}

async function resolveAndroidSerial(id: string): Promise<string | undefined> {
  const listing = await listAndroidDevices();
  const match = listing.find((d) => d.id === id && d.state === "Booted");
  if (!match) {
    log(`deviceId ${id} not found among booted Android devices; using adb default device`);
    return undefined;
  }
  // Running AVDs are named "<avd> (<serial>)"; physical devices use the serial as name.
  return /\(([^)]+)\)$/.exec(match.name)?.[1] ?? match.id;
}

export async function tap(platform: Platform, x: unknown, y: unknown): Promise<string> {
  const px = String(assertCoordinate(x, "x"));
  const py = String(assertCoordinate(y, "y"));

  if (platform === "ios") {
    // Note: `simctl io/input` tap support depends on the Xcode version installed.
    await execCommand("xcrun", ["simctl", "input", "booted", "tap", px, py]);
  } else {
    await execCommand("adb", ["shell", "input", "tap", px, py]);
  }
  return `Tapped (${px}, ${py}) on ${platform}.`;
}
