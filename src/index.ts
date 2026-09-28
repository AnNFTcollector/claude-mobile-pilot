#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  assertPlatform,
  bootDevice,
  installApp,
  listDevices,
  takeScreenshot,
  tap,
} from "./services/deviceService.js";
import { describeError, log } from "./utils/executor.js";

const SERVER_NAME = "mobile-vision-bridge";
const SERVER_VERSION = "1.0.0";

const platformSchema = {
  type: "string",
  enum: ["ios", "android"],
  description: "Target platform.",
} as const;

const TOOLS: Tool[] = [
  {
    name: "list_mobile_devices",
    description:
      "Lists all available local iOS simulators and Android virtual devices (AVDs), along with their current operational state (Booted, Shutdown, etc.).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "boot_mobile_device",
    description: "Powers on a specific simulator or emulator so it is ready for interaction.",
    inputSchema: {
      type: "object",
      properties: {
        platform: platformSchema,
        deviceId: { type: "string", description: "The UUID for iOS or the AVD name for Android." },
      },
      required: ["platform", "deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "take_device_screenshot",
    description:
      "Takes a pixel-perfect snapshot of the currently active screen on the booted simulator/emulator and returns it as a base64 encoded string or saves it locally.",
    inputSchema: {
      type: "object",
      properties: {
        platform: platformSchema,
        outputPath: { type: "string", description: "Optional: where to save the PNG on the host machine." },
      },
      required: ["platform"],
      additionalProperties: false,
    },
  },
  {
    name: "install_app_on_device",
    description: "Installs a compiled binary (.app, .ipa, or .apk) onto the specified booted target device.",
    inputSchema: {
      type: "object",
      properties: {
        platform: platformSchema,
        appPath: { type: "string", description: "Absolute path to the local build file." },
        deviceId: { type: "string", description: "iOS simulator UDID, or Android adb serial / AVD name." },
      },
      required: ["platform", "appPath", "deviceId"],
      additionalProperties: false,
    },
  },
  {
    name: "input_tap_coordinate",
    description: "Simulates a physical finger tap at specific X and Y pixel coordinates on the active screen surface.",
    inputSchema: {
      type: "object",
      properties: {
        platform: platformSchema,
        x: { type: "number", description: "X coordinate in pixels." },
        y: { type: "number", description: "Y coordinate in pixels." },
      },
      required: ["platform", "x", "y"],
      additionalProperties: false,
    },
  },
];

function text(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim() === "") throw new TypeError(`"${key}" is required and must be a string`);
  return v;
}

async function handleTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  switch (name) {
    case "list_mobile_devices": {
      const listing = await listDevices();
      return text(JSON.stringify(listing, null, 2));
    }
    case "boot_mobile_device": {
      const platform = assertPlatform(args.platform);
      return text(await bootDevice(platform, requireString(args, "deviceId")));
    }
    case "take_device_screenshot": {
      const platform = assertPlatform(args.platform);
      const outputPath = args.outputPath === undefined ? undefined : requireString(args, "outputPath");
      const shot = await takeScreenshot(platform, outputPath);
      const summary = shot.savedTo
        ? `Screenshot (${shot.bytes} bytes) saved to ${shot.savedTo}`
        : `Screenshot captured (${shot.bytes} bytes).`;
      return {
        content: [
          { type: "text", text: summary },
          { type: "image", data: shot.base64, mimeType: shot.mimeType },
        ],
      };
    }
    case "install_app_on_device": {
      const platform = assertPlatform(args.platform);
      return text(await installApp(platform, requireString(args, "appPath"), requireString(args, "deviceId")));
    }
    case "input_tap_coordinate": {
      const platform = assertPlatform(args.platform);
      return text(await tap(platform, args.x, args.y));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function main(): Promise<void> {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    log(`tool call: ${name}`);
    try {
      return await handleTool(name, (rawArgs ?? {}) as Record<string, unknown>);
    } catch (err) {
      const message = describeError(err);
      log(`tool ${name} failed:`, message);
      return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
    }
  });

  server.onerror = (err) => log("server error:", describeError(err));

  const shutdown = async () => {
    log("shutting down");
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  log(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}

main().catch((err) => {
  log("fatal:", describeError(err));
  process.exit(1);
});
