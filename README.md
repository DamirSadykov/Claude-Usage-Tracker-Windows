# Claude Usage Tracker for Windows

<p align="center">
  <img src="src-tauri/icons/mark-512.png" width="128" height="128" alt="Claude Usage Tracker">
</p>

A Windows alternative to [Claude Usage Tracker](https://github.com/hamed-elfayome/Claude-Usage-Tracker) (macOS, Swift) — a native app for real-time monitoring of Claude AI usage limits.

The original tracker is macOS-only. This project brings the core functionality to Windows using **Tauri v2 + Vue 3 + Rust**.

## Features

- **Usage monitoring** — 5-hour session, weekly limit, Opus tier (if available)
- **Countdown timer** — reset time displayed as "Resets in 4h 8m (Today 14:10)"
- **System tray** — lives in the tray, doesn't occupy the taskbar
- **Auto-start session** — automatically creates a chat in a separate project when the limit resets, starting a new countdown (doesn't mix with your normal conversations)
- **Configurable interval** — polling rate from 10 to 300 seconds

## Screenshots

<p align="center">
  <img src="docs/screenshot-usage.png" width="380" alt="Usage panel">&nbsp;&nbsp;
  <img src="docs/screenshot-settings.png" width="380" alt="Settings panel">
</p>

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Native wrapper | [Tauri v2](https://v2.tauri.app/) |
| Backend (API requests) | Rust + reqwest |
| Frontend | Vue 3 + TypeScript + Vite |
| Settings storage | tauri-plugin-store |
| Windows autostart | tauri-plugin-autostart |

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Rust](https://rustup.rs/) 1.77+
- Windows 10/11 with WebView2 (pre-installed on Win 11)

### Build from Source

```bash
git clone https://github.com/YOUR_USERNAME/claude-usage-tracker-windows.git
cd claude-usage-tracker-windows
npm install
npm run tauri build
```

The installer will be available at `src-tauri/target/release/bundle/`.

### Development

```bash
npm run tauri dev
```

## Configuration

On first launch the settings panel will open:

1. **Session Key** — `sessionKey` cookie from claude.ai
   - Open claude.ai → DevTools (F12) → Application → Cookies → `sessionKey`
2. **Organization ID** — your organization UUID
   - Navigate to `claude.ai/api/organizations` and copy the `uuid`
3. **Refresh interval** — how often to poll the API (default: 60 sec)
4. **Auto-start session** — enable to automatically create a chat when the limit resets

## How Auto-Start Works

When the 5-hour limit resets, the app:
1. Finds (or creates) a project called "Usage Tracker - Auto Session"
2. Creates a new chat with a "ping" message
3. This starts a new 5-hour countdown

All automatic chats are isolated in a separate project and won't clutter your normal conversations.

## Comparison with the Original

| | [Original (macOS)](https://github.com/hamed-elfayome/Claude-Usage-Tracker) | This project (Windows) |
|---|---|---|
| Platform | macOS 14+ | Windows 10/11 |
| Stack | Swift / SwiftUI | Tauri v2 / Vue 3 / Rust |
| Profiles | Multiple | Single |
| Menu bar icons | 5 styles | System tray |
| Languages | 13 | English, Russian |
| Claude Code CLI integration | Yes | No |
| Auto-start session | Yes | Yes |

## Security

- Session Key is stored locally in the encrypted Tauri Store
- No data is sent to third-party servers
- The app only communicates with `claude.ai`

## License

MIT
