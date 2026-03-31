# Auto Scroll Down + SPA Conversion Design Spec

## Overview

Add an "Auto Scroll Down" feature that scrolls the Target PC screen downward at a configurable speed via BLE-controlled firmware. Simultaneously convert the multi-page architecture to a Single Page Application (SPA) so BLE connections persist across feature tabs.

## 1. SPA Architecture

### Current State
- `index.html` — Home page
- `web/text.html` + `web/text.js` — Text Flush
- `web/files.html` + `web/files.js` — File Flush
- BLE connection is lost on page navigation

### Target State
- Single `index.html` with hash-based routing (`#text`, `#files`, `#scroll`, `#` = Home)
- BLE connection persists across tab switches

### New Modules

**`web/app.js`** — Application shell and routing
- Hash-based routing: listens to `hashchange`
- Tab switching: calls `destroy()` on current module, `init(container)` on new module
- Manages common sidebar (Device section) and tab navigation

**`web/ble.js`** — Shared BLE connection manager
- Exports: `connect()`, `disconnect()`, `getCharacteristic(uuid)`, `isConnected()`
- Connection state callbacks: `onConnect`, `onDisconnect`, `onStatusNotify`
- Device section UI: Connect/Disconnect/Bootloader buttons, Nickname input
- All BLE UUIDs defined here (single source of truth)

### Module Interface Pattern

Each feature module (text.js, files.js, scroll.js) exports:
- `init(container)` — Renders HTML into container, binds events, initializes state
- `destroy()` — Unbinds events, clears timers, cleans up state

### Sidebar Structure
- **Common (always visible):** Device section (Connect/Disconnect/Bootloader, Nickname) — managed by ble.js/app.js
- **Tab-specific (swapped on tab change):** Each module renders its own settings into a designated sidebar container

### Existing Module Refactoring (text.js, files.js)
- Remove BLE connection/disconnection code → use `ble.js`
- Remove duplicate UUID definitions → import from `ble.js`
- Add `init(container)` and `destroy()` exports
- Move inline HTML to JS-generated DOM within `init()`
- Existing `text.html` and `files.html` are deleted

## 2. Firmware — Auto Scroll

### New BLE Characteristic
- UUID: `f3641407-00b0-4240-ba50-05ca45bf8abc`
- Permission: WRITE (from Control PC)

### Protocol (3 bytes)
```
[command(u8)][interval_ms(u16 LE)]
```
- `command = 0x01`: Start scrolling with given interval
- `command = 0x00`: Stop scrolling (interval ignored)

### State Variables
```cpp
static volatile bool g_scroll_active = false;
static volatile uint16_t g_scroll_interval_ms = 100;
static uint32_t g_scroll_last_ms = 0;
```

### Firmware Logic — `try_auto_scroll()`
- Called in `loop()` after `try_jiggle_mouse()`
- Guard: `if (!g_scroll_active || !hid_ready()) return;`
- Interval check: `if (now - g_scroll_last_ms < g_scroll_interval_ms) return;`
- Execute: `usb_hid.mouseScroll(kReportIdMouse, -1, 0);` (negative = scroll down)
- Update: `g_scroll_last_ms = now;`

### Auto-Stop Conditions
- BLE disconnect → `g_scroll_active = false`
- Flush activity (buffer not idle) → pause scrolling (same pattern as mouse jiggler)

### BLE Callback — `scroll_write_cb()`
- Parse 3-byte payload
- Set `g_scroll_active` and `g_scroll_interval_ms`

### Interaction with Mouse Jiggler
- When auto scroll is active, mouse jiggler is implicitly suppressed (device is not idle from jiggler's perspective, since scroll generates HID activity)

## 3. Auto Scroll UI (scroll.js)

### Sidebar (tab-specific)
- **Speed setting:** Range slider
  - Range: 30ms (fast) to 500ms (slow)
  - Default: 100ms
  - Label shows "Slow" / "Fast" at extremes
  - Persisted to localStorage (`byteflusher.scrollIntervalMs`)
  - Disabled while scrolling

### Main Area
- **Start button:** Sends start command with current interval_ms via BLE. Disables Speed slider and Start button, enables Stop button.
- **Stop button:** Sends stop command via BLE. Re-enables Speed slider and Start button, disables Stop button.
- **Status text:** "Scrolling..." when active, "Stopped" when inactive.

### State Transitions
1. Speed slider → set interval
2. Start → speed disabled, start disabled, stop enabled, status = "Scrolling..."
3. Stop → speed enabled, start enabled, stop disabled, status = "Stopped"
4. BLE disconnect → auto-reset to stopped state

## 4. i18n

### New Keys (lang/en.json, lang/ko.json)

```json
{
  "scroll": {
    "title": "Auto Scroll Down",
    "speed": "Scroll Speed",
    "speedSlow": "Slow",
    "speedFast": "Fast",
    "start": "Start",
    "stop": "Stop",
    "statusScrolling": "Scrolling...",
    "statusStopped": "Stopped"
  },
  "home": {
    "autoScroll": "\ud83d\udd3d Auto Scroll",
    "autoScrollDesc": "Auto scroll down on Target PC"
  }
}
```

Korean translations will be added for all keys.

## 5. File Changes Summary

### New Files
- `web/ble.js` — Shared BLE module
- `web/app.js` — SPA routing and shell
- `web/scroll.js` — Auto Scroll feature module

### Modified Files
- `index.html` — SPA shell (tabs, routing, single page)
- `web/text.js` — Refactor to init/destroy pattern, use ble.js
- `web/files.js` — Refactor to init/destroy pattern, use ble.js
- `web/style.css` — Tab navigation styles (if needed)
- `web/i18n.js` — No changes expected (existing pattern supports SPA)
- `lang/en.json` — Add scroll keys
- `lang/ko.json` — Add scroll keys
- `src/main.cpp` — Add scroll characteristic, callback, loop logic

### Deleted Files
- `web/text.html` — Content moved into text.js init()
- `web/files.html` — Content moved into files.js init()
