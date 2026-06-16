# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
cd netmon3 && npm start      # Run the Electron app
cd netmon3 && npm run build  # Build Windows portable .exe via electron-builder
```

No test suite, linter, or formatter is configured.

## Architecture

NetMon is a **Windows desktop network speed monitor widget** — a small transparent overlay showing real-time download/upload speeds, public IP, and GeoIP location. There are two versions in this repo:

- **`netmon3/`** — Current version. Electron 29 desktop app with system tray, settings, and stats windows.
- **`netmon.hta`** — Legacy single-file HTML Application (IE engine + ActiveX). Kept for reference.

### Electron process model (netmon3/)

**`main.js`** is the central hub. It owns everything and exposes data to renderers via IPC:

| Responsibility | Implementation |
|---|---|
| Settings | `electron-store` (JSON file in userData). Defaults: 2s poll interval, always-on-top, 30-day retention. |
| Speed monitoring | Spawns `netstat -e`, computes delta bytes/second between polls. |
| Data storage | `sql.js` (pure JS SQLite, no native compilation). Single `speed_records` table. DB kept in memory, saved to `data/stats.db` every 30s and on quit. |
| GeoIP | Two-phase: Phase 1 gets public IP via HTTPS (3 services with `Promise.any`), Phase 2 enriches with location. Quick IP check every 30s (round-robin across 3 APIs, 960 req/day each); full GeoIP every 5 min or when IP changes. |
| IPC handlers | `get-settings`, `save-settings`, `get-hourly-data`, `get-daily-data`, `get-today-peaks`, `get-interfaces`, `close-widget`, `hide-to-tray` |
| Windows | Three `BrowserWindow` instances — widget, settings, stats (see below) |
| System tray | Icon with context menu: toggle visibility, settings, stats, quit. Double-click toggles widget. |
| Single instance | `app.requestSingleInstanceLock()` prevents multiple windows. |

**`preload.js`** — `contextBridge.exposeInMainWorld('netmon', {...})` exposes IPC channels to renderers. Renderers call `window.netmon.*`. ⚠️ **This file is currently corrupted on disk** — restore with: `git show 9da04d4:netmon3/preload.js > netmon3/preload.js`

**Three renderer windows:**

| Window | Source | Size | Features |
|---|---|---|---|
| Widget | `src/widget.html` + `src/widget.js` | 220×100 | Transparent overlay, no frame, always-on-top, skip taskbar. Download (cyan) and upload (red) columns with animated progress bars. IP + location display. Draggable (`-webkit-app-region: drag`). Esc hides to tray. |
| Settings | `src/settings.html` | 420×480 | Auto-start, interval, opacity, always-on-top, interface selection, data retention. Saving applies changes immediately (updates timers, window properties). |
| Stats | `src/stats.html` | 700×520 | Today's peak download/upload, Chart.js line chart (hourly averages today), bar chart (daily averages, 30 days). Chart.js loaded from CDN. |

### Key patterns

- **Settings changes are applied immediately** in `save-settings` handler — restarts the monitor timer with new interval, updates alwaysOnTop/opacity on the widget window.
- **All renderer ↔ main communication** goes through `ipcRenderer.invoke` (request/response) or `ipcRenderer.on` (push events: `speed-update`, `ip-update`). No `nodeIntegration` — strict context isolation.
- **sql.js has no persistence layer** — the DB lives in memory and is manually serialized to disk via `db.export()` / `fs.writeFileSync`. `PRAGMA journal_mode=OFF` avoids WAL file issues.
- **Network interface detection** uses PowerShell: `Get-NetAdapter | Where-Object Status -eq 'Up'`.
