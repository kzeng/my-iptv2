# My IPTV Tauri

My IPTV Tauri is a Tauri rebuild of the Electron-based `C:\Work\project\my-iptv` app.

## Features

- HLS.js IPTV playback with search, group filtering, favorites, keyboard navigation, screenshots, and WebM recording.
- Tauri command bridge replacing the original Electron `ipcRenderer` bridge.
- Rust-backed SQLite storage for playlist sources, channels, favorites, play history, channel health, settings, and last-channel state.
- Local `127.0.0.1:12999` proxy for HLS playback and logo caching.
- First-run bootstrap from the bundled `channels.m3u` playlist.

## Requirements

- Node.js and npm
- Rust toolchain
- Tauri system dependencies for Windows

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

The build command runs `tauri build` and writes release artifacts under `src-tauri/target/release`.

## Project Structure

- `src/` - static frontend files, player UI, HLS.js, and app logic.
- `src-tauri/` - Tauri configuration and Rust backend.
- `channels.m3u` - bundled bootstrap playlist.
