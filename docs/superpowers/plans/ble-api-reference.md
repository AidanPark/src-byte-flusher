# ble.js API Reference

This document defines the complete public API of `web/ble.js`. All subagents performing BLE refactoring MUST read this file first and follow the substitution rules exactly.

## UUID Constants (exported)

| Constant | Value |
|----------|-------|
| `SERVICE_UUID` | `'f3641400-00b0-4240-ba50-05ca45bf8abc'` |
| `FLUSH_TEXT_CHAR_UUID` | `'f3641401-00b0-4240-ba50-05ca45bf8abc'` |
| `CONFIG_CHAR_UUID` | `'f3641402-00b0-4240-ba50-05ca45bf8abc'` |
| `STATUS_CHAR_UUID` | `'f3641403-00b0-4240-ba50-05ca45bf8abc'` |
| `MACRO_CHAR_UUID` | `'f3641404-00b0-4240-ba50-05ca45bf8abc'` |
| `BOOTLOADER_CHAR_UUID` | `'f3641405-00b0-4240-ba50-05ca45bf8abc'` |
| `NICKNAME_CHAR_UUID` | `'f3641406-00b0-4240-ba50-05ca45bf8abc'` |
| `SCROLL_CHAR_UUID` | `'f3641407-00b0-4240-ba50-05ca45bf8abc'` |

## Connection State

| Function | Return | Description |
|----------|--------|-------------|
| `isConnected()` | `boolean` | Replaces `device?.gatt?.connected` |
| `getDevice()` | `BluetoothDevice \| null` | Raw device reference |
| `getDeviceName()` | `string` | Replaces `device.name` / `device?.name` |
| `getChar(uuid)` | `BLECharacteristic \| null` | Replaces `flushChar`, `configChar`, etc. |

## Buffer State (Flow Control)

| Function | Return | Description |
|----------|--------|-------------|
| `getDeviceBufCapacity()` | `number \| null` | Replaces `deviceBufCapacity` |
| `getDeviceBufFree()` | `number \| null` | Replaces `deviceBufFree` |
| `getDeviceBufUpdatedAt()` | `number` | Replaces `deviceBufUpdatedAt` |
| `readStatusOnce()` | `Promise<void>` | Replaces local `readStatusOnce()` |
| `addStatusWaiter(fn)` | `void` | Replaces `statusWaiters.push(fn)` |

## Nickname

| Function | Return | Description |
|----------|--------|-------------|
| `sanitizeNickname(raw)` | `string` | Clean nickname string |
| `loadSavedNickname()` | `string` | From localStorage |
| `saveNicknameToLocalStorage(v)` | `void` | To localStorage |
| `readDeviceNicknameOnce()` | `Promise<string>` | Read from device |
| `writeDeviceNickname(nickname)` | `Promise<string>` | Write to device, returns saved name |

## Connection / Disconnection

| Function | Return | Description |
|----------|--------|-------------|
| `connect()` | `Promise<{cancelled: boolean, device?}>` | BLE connect flow |
| `reconnect()` | `Promise<void>` | Reconnect during transfer |
| `disconnect()` | `void` | Disconnect BLE |
| `requestBootloader()` | `Promise<void>` | Enter bootloader mode |

## Events

| Function | Description |
|----------|-------------|
| `on(event, fn)` | Subscribe. Events: `'connect'`, `'disconnect'`, `'status'` |
| `off(event, fn)` | Unsubscribe |

### Event Details
- `'connect'` callback receives `(device)` — the BluetoothDevice
- `'disconnect'` callback receives no arguments
- `'status'` callback receives `({capacity, free})` — buffer status

## Refactoring Substitution Rules

When refactoring text.js or files.js to use ble.js, apply these substitutions:

| Old Code (module variable) | New Code (ble.js API) |
|---|---|
| `device?.gatt?.connected` | `ble.isConnected()` |
| `device.name` or `device?.name` | `ble.getDeviceName()` |
| `flushChar` | `ble.getChar(ble.FLUSH_TEXT_CHAR_UUID)` |
| `configChar` | `ble.getChar(ble.CONFIG_CHAR_UUID)` |
| `statusChar` | `ble.getChar(ble.STATUS_CHAR_UUID)` |
| `macroChar` | `ble.getChar(ble.MACRO_CHAR_UUID)` |
| `bootloaderChar` | `ble.getChar(ble.BOOTLOADER_CHAR_UUID)` |
| `nicknameChar` | `ble.getChar(ble.NICKNAME_CHAR_UUID)` |
| `deviceBufCapacity` | `ble.getDeviceBufCapacity()` |
| `deviceBufFree` | `ble.getDeviceBufFree()` |
| `deviceBufUpdatedAt` | `ble.getDeviceBufUpdatedAt()` |
| `readStatusOnce()` | `ble.readStatusOnce()` |
| `statusWaiters.push(fn)` | `ble.addStatusWaiter(fn)` |

### Functions to DELETE from text.js/files.js (now in ble.js)

- `resolveStatusWaiters()`
- `handleStatusValue()`
- `readStatusOnce()` (local version)
- `sanitizeNickname()`
- `loadSavedNickname()`
- `saveNicknameToLocalStorage()`
- `setNicknameUiValue()`
- `readDeviceNicknameOnce()`
- `writeDeviceNickname()`
- `getConnectFailureHelpText()`
- `connect()`
- `reconnectLoop()` (will be rewritten using ble.reconnect())
- `requestBootloader()`
- `disconnect()`
- `handleDisconnected()` (files.js only)

### Functions to KEEP but REWRITE

**`waitForStatusUpdate(timeoutMs)`** — Rewrite using ble.addStatusWaiter:
```javascript
function waitForStatusUpdate(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    ble.addStatusWaiter(() => { clearTimeout(timer); resolve(); });
  });
}
```

**`reconnectLoop()`** — Rewrite using ble.reconnect():
```javascript
async function reconnectLoop() {
  let attempt = 0;
  while (!stopRequested) {
    attempt += 1;
    try {
      setStatus(t('status.reconnecting'), t('status.attempt', { n: attempt }));
      await ble.reconnect();
      setStatus(t('status.reconnectSuccess'), ble.getDeviceName() || 'BLE Device');
      return;
    } catch (err) {
      const msg = err?.message ?? String(err);
      setStatus(t('status.reconnectFailed'), `${t('status.attempt', { n: attempt })}: ${msg}`);
      const backoffMs = Math.min(5000, 250 + attempt * 250);
      await sleep(backoffMs);
    }
  }
}
```

## Import Pattern

All modules using ble.js should import like this:
```javascript
import * as ble from './ble.js';
```

Then access via `ble.isConnected()`, `ble.getChar(ble.FLUSH_TEXT_CHAR_UUID)`, etc.
