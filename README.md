# mobile-vision-bridge

An MCP server that lets an AI assistant drive a local **iOS Simulator** (`xcrun simctl`) and **Android Emulator** (`adb` / `emulator`).

## Tools

| Tool | Arguments |
| --- | --- |
| `list_mobile_devices` | none |
| `boot_mobile_device` | `platform` (`ios`\|`android`), `deviceId` (iOS UDID or AVD name) |
| `take_device_screenshot` | `platform`, `outputPath?` — returns the PNG as an MCP image, and saves it if a path is given |
| `install_app_on_device` | `platform`, `appPath` (absolute `.app`/`.ipa`/`.apk`), `deviceId` |
| `input_tap_coordinate` | `platform`, `x`, `y` |

## Requirements

- Node.js 18+
- iOS: macOS with Xcode (`xcrun` on PATH)
- Android: Android SDK with `platform-tools` and `emulator` on PATH

If a toolchain is missing, the tools return an error that says what to install. The server keeps running.

## Build

```bash
npm install
npm run build
```

## Add to Claude Desktop

Edit `claude_desktop_config.json`:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mobile-vision-bridge": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/claude-mobile-pilot/build/index.js"],
      "env": {
        "PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/Users/YOU/Library/Android/sdk/platform-tools:/Users/YOU/Library/Android/sdk/emulator"
      }
    }
  }
}
```

Restart Claude Desktop afterwards. Claude Desktop does not inherit your shell `PATH`, so set `env.PATH` explicitly to include `adb` and `emulator`.

For Claude Code: `claude mcp add mobile-vision-bridge -- node /ABSOLUTE/PATH/TO/build/index.js`

## Notes

- Commands run through `execFile` with no shell, and every argument is validated, so inputs cannot be used for shell injection.
- All logs go to stderr. stdout carries only the JSON-RPC stream.
- `xcrun simctl input ... tap` is only available in some Xcode versions. If your Xcode doesn't support it, iOS taps will return that error.
