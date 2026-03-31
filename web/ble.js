// ByteFlusher shared BLE connection module
// Provides a single, shared BLE connection used by all pages (text.js, files.js).
// All BLE state is managed here; consumers subscribe via on/off events.

import { t } from './i18n.js';

// ---------------------------------------------------------------------------
// UUID Constants (exported)
// ---------------------------------------------------------------------------

export const SERVICE_UUID          = 'f3641400-00b0-4240-ba50-05ca45bf8abc';
export const FLUSH_TEXT_CHAR_UUID  = 'f3641401-00b0-4240-ba50-05ca45bf8abc';
export const CONFIG_CHAR_UUID      = 'f3641402-00b0-4240-ba50-05ca45bf8abc';
export const STATUS_CHAR_UUID      = 'f3641403-00b0-4240-ba50-05ca45bf8abc';
export const MACRO_CHAR_UUID       = 'f3641404-00b0-4240-ba50-05ca45bf8abc';
export const BOOTLOADER_CHAR_UUID  = 'f3641405-00b0-4240-ba50-05ca45bf8abc';
export const NICKNAME_CHAR_UUID    = 'f3641406-00b0-4240-ba50-05ca45bf8abc';
export const SCROLL_CHAR_UUID      = 'f3641407-00b0-4240-ba50-05ca45bf8abc';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let device = null;
let server = null;

// UUID → BLECharacteristic (internal, not exported directly)
const chars = {};

let deviceBufCapacity = null;
let deviceBufFree     = null;
let deviceBufUpdatedAt = 0;
let statusWaiters = [];

// Simple array-based event system
const listeners = {
  connect:    [],
  disconnect: [],
  status:     [],
};

// ---------------------------------------------------------------------------
// Event system
// ---------------------------------------------------------------------------

export function on(event, fn) {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(fn);
}

export function off(event, fn) {
  if (!listeners[event]) return;
  listeners[event] = listeners[event].filter((f) => f !== fn);
}

function emit(event, ...args) {
  const fns = listeners[event];
  if (!fns) return;
  for (const fn of fns) {
    try {
      fn(...args);
    } catch {
      // ignore listener errors
    }
  }
}

// ---------------------------------------------------------------------------
// Connection State
// ---------------------------------------------------------------------------

export function isConnected() {
  return !!(device?.gatt?.connected);
}

export function getDevice() {
  return device;
}

export function getDeviceName() {
  return device?.name ?? '';
}

/**
 * Returns the cached BLECharacteristic for the given UUID, or null if not available.
 * @param {string} uuid
 * @returns {BluetoothRemoteGATTCharacteristic | null}
 */
export function getChar(uuid) {
  return chars[uuid] ?? null;
}

// ---------------------------------------------------------------------------
// Buffer State (Flow Control)
// ---------------------------------------------------------------------------

export function getDeviceBufCapacity() {
  return deviceBufCapacity;
}

export function getDeviceBufFree() {
  return deviceBufFree;
}

export function getDeviceBufUpdatedAt() {
  return deviceBufUpdatedAt;
}

export async function readStatusOnce() {
  const statusChar = chars[STATUS_CHAR_UUID];
  if (!statusChar) return;
  try {
    const v = await statusChar.readValue();
    handleStatusValue(v);
  } catch {
    // ignore
  }
}

/**
 * Push a one-shot callback that fires on the next status update.
 * @param {() => void} fn
 */
export function addStatusWaiter(fn) {
  statusWaiters.push(fn);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveStatusWaiters() {
  const waiters = statusWaiters;
  statusWaiters = [];
  for (const fn of waiters) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
}

function handleStatusValue(dataView) {
  if (!dataView || dataView.byteLength < 4) return;
  const cap  = dataView.getUint16(0, true);
  const free = dataView.getUint16(2, true);
  if (Number.isFinite(cap)  && cap  > 0)  deviceBufCapacity = cap;
  if (Number.isFinite(free) && free >= 0) deviceBufFree     = free;
  deviceBufUpdatedAt = performance.now();
  resolveStatusWaiters();
  emit('status', { capacity: deviceBufCapacity, free: deviceBufFree });
}

function clearConnectionState() {
  server = null;
  for (const uuid of Object.keys(chars)) {
    delete chars[uuid];
  }
  deviceBufCapacity  = null;
  deviceBufFree      = null;
  deviceBufUpdatedAt = 0;
  resolveStatusWaiters();
}

/**
 * Acquire all characteristics from a connected GATT service.
 * FLUSH_TEXT_CHAR is required; all others are optional.
 * STATUS_CHAR gets notifications started.
 * @param {BluetoothRemoteGATTService} service
 */
async function acquireCharacteristics(service) {
  // Required
  chars[FLUSH_TEXT_CHAR_UUID] = await service.getCharacteristic(FLUSH_TEXT_CHAR_UUID);

  // Optional characteristics
  const optionalUuids = [
    CONFIG_CHAR_UUID,
    MACRO_CHAR_UUID,
    BOOTLOADER_CHAR_UUID,
    NICKNAME_CHAR_UUID,
    SCROLL_CHAR_UUID,
  ];
  for (const uuid of optionalUuids) {
    try {
      chars[uuid] = await service.getCharacteristic(uuid);
    } catch {
      delete chars[uuid];
    }
  }

  // Status char: optional, but needs notifications
  try {
    const statusChar = await service.getCharacteristic(STATUS_CHAR_UUID);
    chars[STATUS_CHAR_UUID] = statusChar;
    statusChar.addEventListener('characteristicvaluechanged', (ev) => {
      handleStatusValue(ev?.target?.value);
    });
    await statusChar.startNotifications();
    await readStatusOnce();
  } catch {
    delete chars[STATUS_CHAR_UUID];
  }
}

// ---------------------------------------------------------------------------
// Nickname
// ---------------------------------------------------------------------------

const LS_DEVICE_NICKNAME = 'byteflusher.deviceNickname';

export function sanitizeNickname(raw) {
  return String(raw ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12);
}

export function loadSavedNickname() {
  return sanitizeNickname(localStorage.getItem(LS_DEVICE_NICKNAME) || '');
}

export function saveNicknameToLocalStorage(v) {
  const s = sanitizeNickname(v);
  if (s) localStorage.setItem(LS_DEVICE_NICKNAME, s);
  else localStorage.removeItem(LS_DEVICE_NICKNAME);
}

export async function readDeviceNicknameOnce() {
  const nicknameChar = chars[NICKNAME_CHAR_UUID];
  if (!nicknameChar) return '';
  try {
    const v  = await nicknameChar.readValue();
    const u8 = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    const s  = new TextDecoder().decode(u8);
    return sanitizeNickname(s);
  } catch {
    return '';
  }
}

/**
 * Write a nickname to the device and persist it in localStorage.
 * @param {string} nickname
 * @returns {Promise<string>} The sanitized nickname that was saved.
 */
export async function writeDeviceNickname(nickname) {
  const nicknameChar = chars[NICKNAME_CHAR_UUID];
  if (!nicknameChar) {
    throw new Error(t('error.noNicknameChar'));
  }

  const raw = String(nickname ?? '').trim();
  const s   = sanitizeNickname(raw);
  if (raw && !s) {
    throw new Error(t('error.nicknameInvalid'));
  }

  if (!s) {
    await nicknameChar.writeValue(Uint8Array.of(0));
  } else {
    await nicknameChar.writeValue(new TextEncoder().encode(s));
  }

  saveNicknameToLocalStorage(s);
  return s;
}

// ---------------------------------------------------------------------------
// Connection / Disconnection
// ---------------------------------------------------------------------------

/**
 * Open the browser BLE device picker and establish a connection.
 * @returns {Promise<{cancelled: boolean, device?: BluetoothDevice}>}
 */
export async function connect() {
  if (!navigator.bluetooth) {
    throw new Error(t('error.noWebBluetooth'));
  }

  const requestOptions = {
    filters: [{ services: [SERVICE_UUID] }, { namePrefix: 'ByteFlusher' }],
    optionalServices: [SERVICE_UUID],
  };

  let selectedDevice;
  try {
    selectedDevice = await navigator.bluetooth.requestDevice(requestOptions);
  } catch (err) {
    const name = (err?.name ?? '').toString();
    if (name === 'NotFoundError') {
      // User cancelled the picker
      return { cancelled: true };
    }
    throw err;
  }

  device = selectedDevice;

  device.addEventListener('gattserverdisconnected', () => {
    clearConnectionState();
    emit('disconnect');
  });

  server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  await acquireCharacteristics(service);

  emit('connect', device);
  return { cancelled: false, device };
}

/**
 * Reconnect to the already-selected device (e.g. after a transient disconnect).
 * Throws if no device has been selected yet.
 * @returns {Promise<void>}
 */
export async function reconnect() {
  if (!device) throw new Error(t('error.noDevice'));

  if (!device.gatt.connected) {
    server = await device.gatt.connect();
  } else {
    server = device.gatt;
  }

  const service = await server.getPrimaryService(SERVICE_UUID);
  await acquireCharacteristics(service);
  emit('connect', device);
}

/**
 * Gracefully disconnect from the BLE device.
 */
export function disconnect() {
  if (device?.gatt?.connected) {
    device.gatt.disconnect();
  }
  // The 'gattserverdisconnected' event listener will clear state and emit 'disconnect'.
}

/**
 * Request the device to enter bootloader (DFU) mode.
 * @returns {Promise<void>}
 */
export async function requestBootloader() {
  const bootloaderChar = chars[BOOTLOADER_CHAR_UUID];
  if (!bootloaderChar) {
    throw new Error(t('error.noBootloaderChar'));
  }
  await bootloaderChar.writeValue(Uint8Array.of(1));
}
