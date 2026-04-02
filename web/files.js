// File Flush page (Windows)
// - File/Folder -> Base64 -> Target PC PowerShell decodes and writes bytes
// - Accuracy-first: SHA-256 verified per file
// - Automation: Win+R -> PowerShell launch, then command typing via HID
// - Bootstrap: launch PowerShell with -EncodedCommand (define helper functions), then send Base64 chunks

import { t, getLocale, applyDom } from './i18n.js';
import * as ble from './ble.js';

// Shared localStorage keys (same meaning as text flusher)
const LS_TYPING_DELAY_MS = 'byteflusher.typingDelayMs';
const LS_MODE_SWITCH_DELAY_MS = 'byteflusher.modeSwitchDelayMs';
const LS_KEY_PRESS_DELAY_MS = 'byteflusher.keyPressDelayMs';
const LS_TOGGLE_KEY = 'byteflusher.toggleKey';

const DEFAULT_TYPING_DELAY_MS = 30;
const DEFAULT_MODE_SWITCH_DELAY_MS = 100;
const DEFAULT_KEY_PRESS_DELAY_MS = 10;
const DEFAULT_TOGGLE_KEY = 'rightAlt';

const els = {
  btnConnect: document.getElementById('btnConnect'),
  btnDisconnect: document.getElementById('btnDisconnect'),
  btnBootloader: document.getElementById('btnBootloader'),
  statusText: document.getElementById('statusText'),
  detailsText: document.getElementById('detailsText'),
  deviceFieldset: document.getElementById('deviceFieldset'),
  deviceNickname: document.getElementById('deviceNickname'),
  btnApplyNickname: document.getElementById('btnApplyNickname'),

  targetSystemRow: document.getElementById('targetSystemRow'),

  settingsFieldset: document.getElementById('settingsFieldset'),
  btnApplyFilesSettings: document.getElementById('btnApplyFilesSettings'),
  btnResetFilesSettings: document.getElementById('btnResetFilesSettings'),
  typingDelayMsFiles: document.getElementById('typingDelayMsFiles'),
  keyPressDelayMsFiles: document.getElementById('keyPressDelayMsFiles'),
  lineDelayMsFiles: document.getElementById('lineDelayMsFiles'),
  commandDelayMsFiles: document.getElementById('commandDelayMsFiles'),
  bootChunkCharsFiles: document.getElementById('bootChunkCharsFiles'),
  chunkCharsFiles: document.getElementById('chunkCharsFiles'),
  chunkDelayMsFiles: document.getElementById('chunkDelayMsFiles'),
  overwritePolicyFiles: document.getElementById('overwritePolicyFiles'),

  runDialogDelayMsFiles: document.getElementById('runDialogDelayMsFiles'),
  psLaunchDelayMsFiles: document.getElementById('psLaunchDelayMsFiles'),
  bootstrapDelayMsFiles: document.getElementById('bootstrapDelayMsFiles'),
  diagLogFiles: document.getElementById('diagLogFiles'),

  filesSettingsToast: document.getElementById('filesSettingsToast'),

  targetDir: document.getElementById('targetDir'),
  targetDirValidityFiles: document.getElementById('targetDirValidityFiles'),
  startHint: document.getElementById('startHint'),
  startChecklistFiles: document.getElementById('startChecklistFiles'),

  btnPickFile: document.getElementById('btnPickFile'),
  btnPickFolder: document.getElementById('btnPickFolder'),
  fileInput: document.getElementById('fileInput'),
  folderInput: document.getElementById('folderInput'),
  filesSummary: document.getElementById('filesSummary'),
  filesDetails: document.getElementById('filesDetails'),

  btnStartFiles: document.getElementById('btnStartFiles'),
  btnPauseFiles: document.getElementById('btnPauseFiles'),
  btnResumeFiles: document.getElementById('btnResumeFiles'),
  btnStopFiles: document.getElementById('btnStopFiles'),

  etaTextFiles: document.getElementById('etaTextFiles'),
  startTimeTextFiles: document.getElementById('startTimeTextFiles'),
  fileCountTextFiles: document.getElementById('fileCountTextFiles'),
  totalBytesTextFiles: document.getElementById('totalBytesTextFiles'),
  stageTextFiles: document.getElementById('stageTextFiles'),
  elapsedTextFiles: document.getElementById('elapsedTextFiles'),
  progressTextFiles: document.getElementById('progressTextFiles'),
  endTimeTextFiles: document.getElementById('endTimeTextFiles'),
  estimateBasisTextFiles: document.getElementById('estimateBasisTextFiles'),
};

let running = false;
let paused = false;
let stopRequested = false;

let job = null;

let filesSettingsToastTimerId = null;

// selection state
let selectedKind = null; // 'file' | 'folder' | null
let selectedSummary = { title: '-', details: '' };
let selectedHasError = false;

const kDefaultTargetDir = 'C:\\byteflusher';

const kFilesSettingsStorageKey = 'byteflusher_files_settings_v3';
const kFilesSettingsStorageKeyV2 = 'byteflusher_files_settings_v2';
const kFilesSettingsStorageKeyLegacy = 'byteflusher_files_settings_v1';

const kDefaultFilesSettings = Object.freeze({
  // Accuracy-first defaults (PowerShell + HID typing is sensitive)
  // Per-character timing
  typingDelayMs: 3,
  keyPressDelayMs: 3,

  // Legacy (pre-v3): when present in saved settings, used for migration only.
  keyDelayMs: 10,
  lineDelayMs: 20,
  commandDelayMs: 50,
  // Bootstrap is more sensitive than data transfer; keep it short by default.
  bootChunkChars: 2000,
  chunkChars: 5000,
  chunkDelayMs: 20,
  overwritePolicy: 'fail', // 'fail' | 'overwrite' | 'backup'

  // Automation / bootstrap
  // NOTE: The first keystrokes after launching a console window are the most likely to drop.
  // Prefer conservative defaults; users can tune down if their environment is stable.
  runDialogDelayMs: 450,
  psLaunchDelayMs: 9000,
  bootstrapDelayMs: 1200,
  diagLog: true,
});

// Temp artifacts live under targetDir\.tmp
// - Accuracy-first: keep intermediate artifacts isolated.
// - Policy: removed on success and on user Stop(cancel).
const kTempSubdirName = '.tmp';
const kTempB64Prefix = 'bf_payload_';

// Size limits (browser-side safety)
// - 단일 파일이 너무 크면 ArrayBuffer/Base64 변환이 브라우저 메모리/시간 한계로 실패할 수 있다.
// - 전체(합계)가 너무 크면 작업 시간이 길어져 포커스 이탈/팝업 등 환경 리스크가 누적된다.
// 정확성 우선: 보수적으로 시작하고, 필요 시 상향한다.
const kMaxSingleFileBytes = 50 * 1024 * 1024; // 50 MiB
const kMaxTotalBytes = 200 * 1024 * 1024; // 200 MiB

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForStatusUpdate(timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    ble.addStatusWaiter(() => { clearTimeout(timer); resolve(); });
  });
}

async function waitForDeviceRoom({ requiredBytes, maxBacklogBytes }) {
  if (!ble.getChar(ble.STATUS_CHAR_UUID)) return;
  const startedAt = performance.now();

  while (!stopRequested) {
    if (paused) return;
    if (!ble.isConnected()) return;

    const cap = ble.getDeviceBufCapacity();
    const free = ble.getDeviceBufFree();
    if (Number.isFinite(cap) && Number.isFinite(free)) {
      const used = Math.max(0, cap - free);
      const enoughFree = free >= requiredBytes;
      const backlogOk = used <= maxBacklogBytes;
      if (enoughFree && backlogOk) return;
    }

    const now = performance.now();
    if (!Number.isFinite(ble.getDeviceBufUpdatedAt()) || now - ble.getDeviceBufUpdatedAt() > 800) {
      await ble.readStatusOnce();
    }

    const waitedMs = now - startedAt;
    const stepMs = waitedMs < 2000 ? 120 : 200;
    await waitForStatusUpdate(stepMs);
  }
}

function loadNumberSetting(key, fallback) {
  const raw = localStorage.getItem(key);
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function getToggleKeySetting() {
  const raw = String(localStorage.getItem(LS_TOGGLE_KEY) || DEFAULT_TOGGLE_KEY);
  return raw || DEFAULT_TOGGLE_KEY;
}

function toggleKeyStringToId(v) {
  // Must match firmware mapping
  // 0=RightAlt, 1=LeftAlt, 2=RightCtrl, 3=LeftCtrl, 4=RightGUI, 5=LeftGUI, 6=CapsLock
  const s = String(v || '').trim();
  if (s === 'leftAlt') return 1;
  if (s === 'rightCtrl') return 2;
  if (s === 'leftCtrl') return 3;
  if (s === 'rightGui') return 4;
  if (s === 'leftGui') return 5;
  if (s === 'capsLock') return 6;
  return 0;
}

function buildDeviceConfigPayload({ typingDelayMs, modeSwitchDelayMs, keyPressDelayMs, toggleKeyId, flags }) {
  const out = new Uint8Array(8);
  const setU16 = (off, n) => {
    const v = Math.max(0, Math.min(65535, Number(n) || 0));
    out[off] = v & 0xff;
    out[off + 1] = (v >> 8) & 0xff;
  };
  setU16(0, typingDelayMs);
  setU16(2, modeSwitchDelayMs);
  setU16(4, keyPressDelayMs);
  out[6] = Math.max(0, Math.min(6, Number(toggleKeyId) || 0));
  out[7] = Math.max(0, Math.min(255, Number(flags) || 0));
  return out;
}

async function writeDeviceConfig({ typingDelayMs, modeSwitchDelayMs, keyPressDelayMs, toggleKeyId, pausedFlag, abortFlag }) {
  if (!ble.getChar(ble.CONFIG_CHAR_UUID)) return;
  const flags = (pausedFlag ? 0x01 : 0) | (abortFlag ? 0x02 : 0);
  const payload = buildDeviceConfigPayload({ typingDelayMs, modeSwitchDelayMs, keyPressDelayMs, toggleKeyId, flags });
  await ble.getChar(ble.CONFIG_CHAR_UUID).writeValue(payload);
}

function makeSessionId16() {
  let v = 0;
  if (globalThis.crypto?.getRandomValues) {
    const u16 = new Uint16Array(1);
    globalThis.crypto.getRandomValues(u16);
    v = u16[0];
  } else {
    v = Math.floor(Math.random() * 0x10000);
  }
  if (v === 0) v = 1;
  return v;
}

function buildPacket(sessionId, seq, payload) {
  const headerSize = 4;
  const packet = new Uint8Array(headerSize + payload.length);
  packet[0] = sessionId & 0xff;
  packet[1] = (sessionId >> 8) & 0xff;
  packet[2] = seq & 0xff;
  packet[3] = (seq >> 8) & 0xff;
  packet.set(payload, headerSize);
  return packet;
}

function createBleTextTx() {
  return { sessionId: makeSessionId16(), seq: 0 };
}

async function txSendBytesWithFlowControl(tx, bytes, { chunkSize = 20, delayMs = 0 } = {}) {
  if (!ble.getChar(ble.FLUSH_TEXT_CHAR_UUID)) throw new Error(t('error.noFlushCharShort'));
  if (!tx) throw new Error(t('error.noTx'));
  let offset = 0;

  while (offset < bytes.length) {
    if (stopRequested) return;
    if (paused) {
      await sleep(120);
      continue;
    }
    if (!ble.isConnected()) throw new Error(t('error.bleDisconnected'));

    const chunk = bytes.slice(offset, offset + chunkSize);
    const maxBacklogBytes = Math.max(32, chunkSize);
    await waitForDeviceRoom({ requiredBytes: chunk.length, maxBacklogBytes });
    const packet = buildPacket(tx.sessionId, tx.seq, chunk);
    await ble.getChar(ble.FLUSH_TEXT_CHAR_UUID).writeValue(packet);
    offset += chunk.length;
    tx.seq += 1;
    if (delayMs > 0) await sleep(delayMs);
  }
}

async function txSendTextUtf8(tx, text, opts) {
  const bytes = new TextEncoder().encode(String(text ?? ''));
  await txSendBytesWithFlowControl(tx, bytes, opts);
}

function psEscapeSingleQuoted(s) {
  return String(s ?? '').replace(/'/g, "''");
}

// Guard prefix to absorb occasional leading-keystroke drops in console apps.
// If the first few characters get lost, they are likely to be ';' (no-op separators).
const kPsLineGuardPrefixStrong = ';;;;;;;;;;';
const kPsLineGuardPrefix = ';;;;;';

function bumpWorkLines(n = 1) {
  if (!job) return;
  const total = Number(job.workTotalLines);
  if (!Number.isFinite(total) || total <= 0) return;
  const cur = Math.max(0, Number(job.workDoneLines) || 0);
  // NOTE: total is an estimate; real work can exceed it (e.g., different chunk counts).
  // Don't clamp here; UI will cap percentage at 100% but still show the overrun.
  job.workDoneLines = cur + Math.max(0, Number(n) || 0);
}

async function psLine(tx, line, { commandDelayMs, guard = 'normal', trackWork = true } = {}) {
  const s = String(line ?? '');
  if (s.length === 0) {
    await txSendTextUtf8(tx, `\n`);
    if (commandDelayMs > 0) await sleep(commandDelayMs);
    if (trackWork) bumpWorkLines(1);
    return;
  }

  const prefix = guard === 'strong' ? kPsLineGuardPrefixStrong : guard === 'none' ? '' : kPsLineGuardPrefix;
  await txSendTextUtf8(tx, `${prefix}${s}\n`);
  if (commandDelayMs > 0) await sleep(commandDelayMs);
  if (trackWork) bumpWorkLines(1);
}

async function sha256Hex(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  const u8 = new Uint8Array(hash);
  let out = '';
  for (const b of u8) out += b.toString(16).padStart(2, '0');
  return out;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    // Avoid Array.from(slice) to reduce memory churn on large payloads.
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}


function splitStringIntoChunks(s, chunkLen) {
  const str = String(s ?? '');
  const n = Math.max(1, Number(chunkLen) || 1);
  const out = [];
  for (let i = 0; i < str.length; i += n) {
    out.push(str.slice(i, i + n));
  }
  return out;
}

async function macroWrite(cmd, payloadBytes) {
  if (!ble.getChar(ble.MACRO_CHAR_UUID)) throw new Error(t('error.noMacroChar'));
  while (paused && !stopRequested) await sleep(120);
  if (stopRequested) throw new Error(t('status.userStopped'));
  const payload = payloadBytes ? new Uint8Array(payloadBytes) : new Uint8Array(0);
  if (payload.length > 255) throw new Error('macro payload too large');
  const buf = new Uint8Array(2 + payload.length);
  buf[0] = cmd & 0xff;
  buf[1] = payload.length & 0xff;
  buf.set(payload, 2);
  await ble.getChar(ble.MACRO_CHAR_UUID).writeValue(buf);
}

async function macroOpenRun() {
  await macroWrite(0x01);
}

async function macroEnter() {
  await macroWrite(0x02);
}

async function macroEsc() {
  await macroWrite(0x03);
}

async function macroTypeAscii(text) {
  const s = String(text ?? '');
  // The macro protocol length field is u8 (max 255). Keep a safety margin for BLE MTU limits.
  const kChunk = 200;
  for (let offset = 0; offset < s.length; offset += kChunk) {
    const part = s.slice(offset, offset + kChunk);
    const bytes = new Uint8Array(part.length);
    for (let i = 0; i < part.length; i += 1) {
      const code = part.charCodeAt(i);
      bytes[i] = code & 0xff;
    }
    await macroWrite(0x04, bytes);
    await sleep(0);
  }
}

async function macroSleepMs(ms) {
  const v = Math.max(0, Math.min(60000, Number(ms) || 0));
  const b0 = v & 0xff;
  const b1 = (v >> 8) & 0xff;
  await macroWrite(0x05, [b0, b1]);
}

async function macroForceEnglish() {
  await macroWrite(0x06);
}

function makeRunToken() {
  // ASCII-safe, no spaces, collision-resistant enough for our use.
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function makeTempB64RelativePath(runToken) {
  const token = String(runToken || '').trim();
  return `${kTempSubdirName}\\${kTempB64Prefix}${token}.b64`;
}

function makeTempB64FullPath(targetDir, runToken) {
  const dir = String(targetDir || '').trim().replace(/[\\/]+$/g, '');
  const rel = makeTempB64RelativePath(runToken);
  return `${dir}\\${rel}`;
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function getFilesSettingsFromUi() {
  return {
    // Minimums are conservative to avoid dropped keystrokes in console apps.
    typingDelayMs: clampInt(els.typingDelayMsFiles?.value, 2, 1000, kDefaultFilesSettings.typingDelayMs),
    keyPressDelayMs: clampInt(els.keyPressDelayMsFiles?.value, 2, 300, kDefaultFilesSettings.keyPressDelayMs),
    lineDelayMs: clampInt(els.lineDelayMsFiles?.value, 0, 2000, kDefaultFilesSettings.lineDelayMs),
    commandDelayMs: clampInt(els.commandDelayMsFiles?.value, 50, 4000, kDefaultFilesSettings.commandDelayMs),
    bootChunkChars: clampInt(els.bootChunkCharsFiles?.value, 200, 4000, kDefaultFilesSettings.bootChunkChars),
    chunkChars: clampInt(els.chunkCharsFiles?.value, 1000, 10000, kDefaultFilesSettings.chunkChars),
    chunkDelayMs: clampInt(els.chunkDelayMsFiles?.value, 0, 2000, kDefaultFilesSettings.chunkDelayMs),
    overwritePolicy: String(els.overwritePolicyFiles?.value || kDefaultFilesSettings.overwritePolicy),

    runDialogDelayMs: clampInt(els.runDialogDelayMsFiles?.value, 100, 4000, kDefaultFilesSettings.runDialogDelayMs),
    psLaunchDelayMs: clampInt(els.psLaunchDelayMsFiles?.value, 1200, 20000, kDefaultFilesSettings.psLaunchDelayMs),
    bootstrapDelayMs: clampInt(els.bootstrapDelayMsFiles?.value, 200, 10000, kDefaultFilesSettings.bootstrapDelayMs),
    diagLog: Boolean(els.diagLogFiles?.checked),
  };
}

function applyFilesSettingsToUi(s) {
  if (els.typingDelayMsFiles) els.typingDelayMsFiles.value = String(s.typingDelayMs);
  if (els.keyPressDelayMsFiles) els.keyPressDelayMsFiles.value = String(s.keyPressDelayMs);
  if (els.lineDelayMsFiles) els.lineDelayMsFiles.value = String(s.lineDelayMs);
  if (els.commandDelayMsFiles) els.commandDelayMsFiles.value = String(s.commandDelayMs);
  if (els.bootChunkCharsFiles) els.bootChunkCharsFiles.value = String(s.bootChunkChars);
  if (els.chunkCharsFiles) els.chunkCharsFiles.value = String(s.chunkChars);
  if (els.chunkDelayMsFiles) els.chunkDelayMsFiles.value = String(s.chunkDelayMs);
  if (els.overwritePolicyFiles) els.overwritePolicyFiles.value = String(s.overwritePolicy);

  if (els.runDialogDelayMsFiles) els.runDialogDelayMsFiles.value = String(s.runDialogDelayMs);
  if (els.psLaunchDelayMsFiles) els.psLaunchDelayMsFiles.value = String(s.psLaunchDelayMs);
  if (els.bootstrapDelayMsFiles) els.bootstrapDelayMsFiles.value = String(s.bootstrapDelayMs);
  if (els.diagLogFiles) els.diagLogFiles.checked = Boolean(s.diagLog);
}

function loadFilesSettings() {
  try {
    let raw = localStorage.getItem(kFilesSettingsStorageKey);
    if (!raw) {
      // Migration: keep previous tuned timings, but enable diagLog by default (accuracy-first).
      raw = localStorage.getItem(kFilesSettingsStorageKeyV2);
      if (!raw) raw = localStorage.getItem(kFilesSettingsStorageKeyLegacy);
      if (!raw) return { ...kDefaultFilesSettings };

      const parsedLegacy = JSON.parse(raw);
      const migrated = { ...kDefaultFilesSettings, ...(parsedLegacy || {}), diagLog: true };

      // v2/v1 used a single keyDelayMs; map it to both typing/press.
      const legacyKey = clampInt(migrated.keyDelayMs, 0, 1000, kDefaultFilesSettings.keyDelayMs);
      migrated.typingDelayMs = clampInt(migrated.typingDelayMs ?? legacyKey, 0, 1000, kDefaultFilesSettings.typingDelayMs);
      migrated.keyPressDelayMs = clampInt(migrated.keyPressDelayMs ?? legacyKey, 0, 300, kDefaultFilesSettings.keyPressDelayMs);

      // sanitize other fields
      migrated.lineDelayMs = clampInt(migrated.lineDelayMs, 0, 2000, kDefaultFilesSettings.lineDelayMs);
      migrated.commandDelayMs = clampInt(migrated.commandDelayMs, 50, 4000, kDefaultFilesSettings.commandDelayMs);
      migrated.bootChunkChars = clampInt(migrated.bootChunkChars, 50, 4000, kDefaultFilesSettings.bootChunkChars);
      migrated.chunkChars = clampInt(migrated.chunkChars, 200, 10000, kDefaultFilesSettings.chunkChars);
      migrated.chunkDelayMs = clampInt(migrated.chunkDelayMs, 0, 2000, kDefaultFilesSettings.chunkDelayMs);
      migrated.overwritePolicy = String(migrated.overwritePolicy || kDefaultFilesSettings.overwritePolicy);

      migrated.runDialogDelayMs = clampInt(migrated.runDialogDelayMs, 100, 2000, kDefaultFilesSettings.runDialogDelayMs);
      migrated.psLaunchDelayMs = clampInt(migrated.psLaunchDelayMs, 1200, 20000, kDefaultFilesSettings.psLaunchDelayMs);
      migrated.bootstrapDelayMs = clampInt(migrated.bootstrapDelayMs, 200, 10000, kDefaultFilesSettings.bootstrapDelayMs);
      migrated.diagLog = Boolean(migrated.diagLog);

      try {
        localStorage.setItem(kFilesSettingsStorageKey, JSON.stringify(migrated));
      } catch {
        // ignore
      }
      return migrated;
    }
    const parsed = JSON.parse(raw);
    const s = { ...kDefaultFilesSettings, ...(parsed || {}) };
    // sanitize
    const legacyKey = clampInt(s.keyDelayMs, 0, 1000, kDefaultFilesSettings.keyDelayMs);
    s.typingDelayMs = clampInt(s.typingDelayMs ?? legacyKey, 0, 1000, kDefaultFilesSettings.typingDelayMs);
    s.keyPressDelayMs = clampInt(s.keyPressDelayMs ?? legacyKey, 0, 300, kDefaultFilesSettings.keyPressDelayMs);
    s.lineDelayMs = clampInt(s.lineDelayMs, 0, 2000, kDefaultFilesSettings.lineDelayMs);
    s.commandDelayMs = clampInt(s.commandDelayMs, 50, 4000, kDefaultFilesSettings.commandDelayMs);
    s.bootChunkChars = clampInt(s.bootChunkChars, 50, 4000, kDefaultFilesSettings.bootChunkChars);
    s.chunkChars = clampInt(s.chunkChars, 200, 10000, kDefaultFilesSettings.chunkChars);
    s.chunkDelayMs = clampInt(s.chunkDelayMs, 0, 2000, kDefaultFilesSettings.chunkDelayMs);
    s.overwritePolicy = String(s.overwritePolicy || kDefaultFilesSettings.overwritePolicy);

    s.runDialogDelayMs = clampInt(s.runDialogDelayMs, 100, 2000, kDefaultFilesSettings.runDialogDelayMs);
    s.psLaunchDelayMs = clampInt(s.psLaunchDelayMs, 1200, 8000, kDefaultFilesSettings.psLaunchDelayMs);
    s.bootstrapDelayMs = clampInt(s.bootstrapDelayMs, 200, 3000, kDefaultFilesSettings.bootstrapDelayMs);
    s.diagLog = Boolean(s.diagLog);
    return s;
  } catch {
    return { ...kDefaultFilesSettings };
  }
}

function saveFilesSettings(s) {
  try {
    localStorage.setItem(kFilesSettingsStorageKey, JSON.stringify(s));
  } catch {
    // ignore
  }
}

function applyFilesSettings() {
  const cfg = getFilesSettingsFromUi();
  applyFilesSettingsToUi(cfg); // clamp & reflect
  saveFilesSettings(cfg);
  console.log('[files] settings applied', cfg);
  showFilesSettingsToast(t('toast.saved'), 1000);
  updateStartEnabled();
}

function resetFilesSettings() {
  const cfg = { ...kDefaultFilesSettings };
  applyFilesSettingsToUi(cfg);
  saveFilesSettings(cfg);
  console.log('[files] settings reset', cfg);
  showFilesSettingsToast(t('toast.reset'), 1000);
  updateStartEnabled();
}

function getSelectedTargetSystem() {
  const checked = document.querySelector('input[name="targetSystem"]:checked');
  const v = String(checked?.value || 'windows');
  if (v === 'mac') return 'mac';
  if (v === 'linux') return 'linux';
  return 'windows';
}

function setTargetSystemLocked(isLocked) {
  const row = els.targetSystemRow;
  if (!row) return;
  const radios = Array.from(row.querySelectorAll('input[type="radio"][name="targetSystem"]'));
  for (const r of radios) {
    const v = String(r.value || '');
    if (isLocked) {
      r.disabled = true;
    } else {
      // Policy for now: Windows only
      r.disabled = v !== 'windows';
    }
  }
}

function setStatus(text, details = '') {
  if (els.statusText) els.statusText.textContent = text;
  if (els.detailsText) els.detailsText.textContent = details;
}


function setSummary(text, details) {
  if (els.filesSummary) els.filesSummary.textContent = text ?? '-';
  if (els.filesDetails) els.filesDetails.textContent = details ?? '';
}

function setStartHint(text) {
  if (!els.startHint) return;
  els.startHint.textContent = text ?? '';
}

function setStartChecklist(items) {
  if (!els.startChecklistFiles) return;
  if (!Array.isArray(items) || items.length === 0) {
    els.startChecklistFiles.textContent = '';
    return;
  }

  const lines = items.map((it) => {
    const ok = Boolean(it?.ok);
    const label = String(it?.label || '').trim();
    return `${ok ? '[OK]' : '[ ]'} ${label}`;
  });
  els.startChecklistFiles.textContent = lines.join('\n');
}

function getSelectedFilesList() {
  if (selectedKind === 'file') {
    const f = Array.from(els.fileInput?.files ?? [])[0];
    return f ? [f] : [];
  }
  if (selectedKind === 'folder') {
    return Array.from(els.folderInput?.files ?? []);
  }
  return [];
}

function computeSelectionStats() {
  const files = getSelectedFilesList();
  let totalBytes = 0;
  let maxFileBytes = 0;
  let maxFileLabel = '';

  for (const f of files) {
    const size = Math.max(0, Number(f?.size) || 0);
    totalBytes += size;
    if (size > maxFileBytes) {
      maxFileBytes = size;
      maxFileLabel = String(f?.webkitRelativePath || f?.name || '');
    }
  }

  return {
    fileCount: files.length,
    totalBytes,
    maxFileBytes,
    maxFileLabel,
  };
}

function computeStartChecklist() {
  const compactReadinessHint = (hintKey) => {
    if (!hintKey) return t('files.compactConditionNotMet');
    const map = {
      connectFirst: t('files.compactConnectNeeded'),
      windowsOnly: t('files.compactWindowsOnly'),
      targetDirInvalid: t('files.compactTargetDirError'),
      selectSource: t('files.compactSourceNeeded'),
      selectionError: t('files.compactSelectionError'),
      singleFileTooLarge: t('files.compactSingleFileTooLarge'),
      totalTooLarge: t('files.compactTotalTooLarge'),
      chunkCharsRange: t('files.compactChunkError'),
      bootChunkCharsRange: t('files.compactChunkError'),
    };
    return map[hintKey] || t('files.compactConditionNotMet');
  };

  const isConnected = ble.isConnected();
  const targetSystem = getSelectedTargetSystem();
  const dirOk = isValidWindowsAbsolutePath(els.targetDir?.value ?? '');
  const sourceOk = selectedKind != null && !selectedHasError;
  const notRunning = !running;
  const ready = computeStartReadiness();

  const stats = computeSelectionStats();
  const singleOk = stats.fileCount > 0 && stats.maxFileBytes <= kMaxSingleFileBytes;
  const totalOk = stats.fileCount > 0 && stats.totalBytes <= kMaxTotalBytes;

  const sourceLabel =
    selectedKind === 'file'
      ? t('files.checkSourceFile')
      : selectedKind === 'folder'
        ? t('files.checkSourceFolder')
        : t('files.checkSourceNeeded');

  return [
    { ok: isConnected, label: isConnected ? t('files.checkDeviceConnected') : t('files.checkDeviceNeeded') },
    { ok: targetSystem === 'windows', label: targetSystem === 'windows' ? t('files.checkTargetWindows') : t('files.checkTargetWindowsNeeded') },
    { ok: dirOk, label: dirOk ? t('files.checkTargetDirOk') : t('files.checkTargetDirInvalid') },
    { ok: sourceOk, label: sourceLabel },
    {
      ok: singleOk,
      label:
        stats.fileCount === 0
          ? t('files.checkSingleSizeLimit', { limit: formatBytes(kMaxSingleFileBytes) })
          : t('files.checkSingleSize', { size: formatBytes(stats.maxFileBytes), limit: formatBytes(kMaxSingleFileBytes) }),
    },
    {
      ok: totalOk,
      label:
        stats.fileCount === 0
          ? t('files.checkTotalSizeLimit', { limit: formatBytes(kMaxTotalBytes) })
          : t('files.checkTotalSize', { size: formatBytes(stats.totalBytes), limit: formatBytes(kMaxTotalBytes) }),
    },
    {
      ok: ready.ok,
      label:
        running
          ? t('files.checkRunning')
          : ready.ok
            ? t('files.checkReady')
            : t('files.checkNotReady', { reason: compactReadinessHint(ready.hintKey) }),
    },
  ];
}

function shortLabel(text, maxLen) {
  const s = String(text ?? '');
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - 1)) + '…';
}

function isAllAsciiNoSpace(s) {
  const v = String(s ?? '');
  if (!v) return false;
  for (let i = 0; i < v.length; i += 1) {
    const code = v.charCodeAt(i);
    if (code > 0x7f) return false;
    if (code <= 0x20) return false; // includes spaces & control chars
  }
  return true;
}

function getWindowsAbsolutePathValidity(s) {
  const v = String(s ?? '').trim();
  if (!v) return { ok: false, reason: t('files.targetDirRequired') };
  if (!isAllAsciiNoSpace(v)) return { ok: false, reason: t('files.targetDirAsciiOnly') };

  // Very strict per policy: drive absolute path only (e.g., C:\Users\me)
  // (UNC paths intentionally excluded for simplicity/accuracy)
  if (!/^[A-Za-z]:\\/.test(v)) return { ok: false, reason: t('files.targetDirExample') };

  return { ok: true, reason: '' };
}

function isValidWindowsAbsolutePath(s) {
  return getWindowsAbsolutePathValidity(s).ok;
}

function setTargetDirValidityUi() {
  if (!els.targetDirValidityFiles) return;
  const v = getWindowsAbsolutePathValidity(els.targetDir?.value ?? '');
  if (v.ok) {
    els.targetDirValidityFiles.textContent = 'OK';
    els.targetDirValidityFiles.classList.remove('validityBad');
    els.targetDirValidityFiles.classList.add('validityOk');
  } else {
    els.targetDirValidityFiles.textContent = `INVALID (${v.reason})`;
    els.targetDirValidityFiles.classList.remove('validityOk');
    els.targetDirValidityFiles.classList.add('validityBad');
  }
}

function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (!Number.isFinite(n)) return '-';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}

function renderStageText() {
  if (!job) return '-';
  const stage = String(job.stage ?? '').trim() || '-';
  if (paused) return `${stage} ${t('metric.pausedSuffix')}`;
  return stage;
}

function showFilesSettingsToast(text, ttlMs = 1000) {
  if (!els.filesSettingsToast) return;
  if (filesSettingsToastTimerId) {
    clearTimeout(filesSettingsToastTimerId);
    filesSettingsToastTimerId = null;
  }

  els.filesSettingsToast.textContent = String(text ?? '').trim();
  filesSettingsToastTimerId = setTimeout(() => {
    if (els.filesSettingsToast) els.filesSettingsToast.textContent = '';
    filesSettingsToastTimerId = null;
  }, Math.max(200, Number(ttlMs) || 1000));
}

function getStageLabel(key) { return t(`files.stages.${key}`); }

function setJobStage(stage, { statusText, statusDetails } = {}) {
  if (!job) return;
  job.stage = String(stage ?? '').trim() || '-';
  updateJobMetrics();
  if (statusText) {
    setStatus(String(statusText), String(statusDetails ?? renderStageText()));
  }
}

function stagePrepare() {
  setJobStage(getStageLabel('prepare'));
}

function stageBootstrap() {
  setJobStage(getStageLabel('bootstrap'));
}

function stageSendChunks() {
  setJobStage(getStageLabel('sendChunks'));
}

function stageDecode() {
  setJobStage(getStageLabel('decode'));
}

function stageVerifyHash() {
  setJobStage(getStageLabel('verifyHash'));
}

function stageCleanup() {
  setJobStage(getStageLabel('cleanup'));
}

function u8ToBinaryString(u8) {
  const bytes = new Uint8Array(u8);
  const chunk = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    out += String.fromCharCode.apply(null, slice);
  }
  return out;
}

function encodePowerShellEncodedCommandBase64(script) {
  // PowerShell -EncodedCommand expects Base64(UTF-16LE bytes of the script)
  const s = String(script ?? '');
  const u8 = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    u8[i * 2] = code & 0xff;
    u8[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return btoa(u8ToBinaryString(u8));
}

function buildBootstrapChunkLauncherLines({ runToken, targetDir }) {
  // Define bf_boot_append / bf_boot_run using short lines to minimize keystroke drops.
  const rt = String(runToken || 'run').replace(/[^a-z0-9_\-]/gi, '_');
  const td = String(targetDir || '').trim();
  return [
    "$ErrorActionPreference='Stop'",
    '[Console]::InputEncoding=[Text.Encoding]::UTF8',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    // Keep all work artifacts under targetDir.
    `$global:bf_root='${td}'`,
    "$global:bf_work=(Join-Path $global:bf_root '.tmp')",
    'New-Item -ItemType Directory -Force -Path $global:bf_work | Out-Null',
    `$global:bf_bootPath=(Join-Path $global:bf_work 'bf_boot_${rt}.b64')`,
    'Remove-Item -Force -ErrorAction SilentlyContinue $global:bf_bootPath',
    "[IO.File]::WriteAllText($global:bf_bootPath,'',[Text.Encoding]::ASCII)",
    'function bf_boot_append([string]$c) {',
    '  [IO.File]::AppendAllText($global:bf_bootPath,$c,[Text.Encoding]::ASCII)',
    '}',
    'function bf_boot_run() {',
    "  $e=(Get-Content -Raw -Encoding ASCII $global:bf_bootPath) -replace '\\s',''",
    '  Remove-Item -Force -ErrorAction SilentlyContinue $global:bf_bootPath',
    '  $s=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($e))',
    '  iex $s',
    '}',
  ];
}

function buildBootstrapScript({ targetDir, tmpB64Path, overwritePolicy, diagLog }) {
  // Executed via IEX from Base64(UTF-16LE). Can safely contain non-ASCII after decoding.
  // Still, pass user-provided strings as Base64 to avoid quoting edge cases.
  const tdB64 = encodePowerShellEncodedCommandBase64(String(targetDir ?? ''));
  const tmpB64 = encodePowerShellEncodedCommandBase64(String(tmpB64Path ?? ''));
  const opB64 = encodePowerShellEncodedCommandBase64(String(overwritePolicy ?? 'fail'));
  const d = diagLog ? 1 : 0;

  return [
    "$ErrorActionPreference='Stop'",
    '[Console]::InputEncoding=[Text.Encoding]::UTF8',
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    // NOTE: This script is executed inside bf_boot_run() (a function). Use global: scope so
    // variables/functions persist after bf_boot_run returns.
    `$global:td=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${tdB64}'))`,
    `$global:tmp=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${tmpB64}'))`,
    `$global:overwritePolicy=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${opB64}'))`,
    `$global:d=${d}`,
    "$global:t=(Join-Path $global:td '.tmp')",
    'New-Item -ItemType Directory -Force -Path $global:td | Out-Null',
    'New-Item -ItemType Directory -Force -Path $global:t | Out-Null',
    "$global:l=(Join-Path $global:t 'bf_last_error.txt')",
    'if ($global:d) { Remove-Item -Force -ErrorAction SilentlyContinue $global:l }',
    // Output helpers: keep per-file commands short (fewer keystrokes => faster, more reliable).
    // IMPORTANT: persist $out across calls (bf_commit expects it).
    "function global:bf_prepare_out_b64([string]$b64){$global:out=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($b64));$outDir=Split-Path -Parent $global:out;if($outDir){New-Item -ItemType Directory -Force -Path $outDir|Out-Null};if(Test-Path -LiteralPath $global:out){if($global:overwritePolicy -eq 'fail'){throw('File exists: '+$global:out)}elseif($global:overwritePolicy -eq 'overwrite'){Remove-Item -Force -LiteralPath $global:out}elseif($global:overwritePolicy -eq 'backup'){$bak=($global:out+'.bak');while(Test-Path -LiteralPath $bak){$bak=($bak+'.bak')};Move-Item -Force -LiteralPath $global:out -Destination $bak}}}",

    // Commit helper: decodes tmp->out, verifies hash, cleans tmp. Logs on error if enabled.
    "function global:bf_commit([string]$expected){try{if(!$global:out){throw('Missing out path (call bf_prepare_out_b64 first)')};$b=(Get-Content -Raw -Encoding ASCII $global:tmp)-replace'\\s','';[IO.File]::WriteAllBytes($global:out,[Convert]::FromBase64String($b));$a=(Get-FileHash -Algorithm SHA256 -LiteralPath $global:out).Hash.ToLower();if($a -ne $expected){throw('SHA256 mismatch: '+$global:out)};Remove-Item -Force -ErrorAction SilentlyContinue $global:tmp}catch{if($global:d){try{($_|Out-String)|Set-Content -Encoding UTF8 -LiteralPath $global:l}catch{}};throw}}",

    // Temp helpers: keep per-chunk commands short (fewer keystrokes => faster, more reliable).
    "function global:bf_tmp_reset(){Remove-Item -Force -ErrorAction SilentlyContinue $global:tmp;[IO.File]::WriteAllText($global:tmp,'',[Text.Encoding]::ASCII)}",
    "function global:bf_tmp_append([string]$s){[IO.File]::AppendAllText($global:tmp,$s,[Text.Encoding]::ASCII)}",

    // Final cleanup on success/cancel: remove temp file + logs + work dir.
    "function global:bf_finalize(){try{Remove-Item -Force -ErrorAction SilentlyContinue $global:tmp;if(Test-Path -LiteralPath $global:l){Remove-Item -Force -ErrorAction SilentlyContinue $global:l};if(Test-Path -LiteralPath $global:t){Remove-Item -Force -Recurse -ErrorAction SilentlyContinue $global:t}}catch{}}",
  ].join(';');
}

function setUiConnected(isConnected) {
  if (els.btnConnect) els.btnConnect.disabled = isConnected || running;
  if (els.btnDisconnect) els.btnDisconnect.disabled = !isConnected || running;
  if (els.btnApplyNickname) els.btnApplyNickname.disabled = !isConnected || running || !ble.getChar(ble.NICKNAME_CHAR_UUID);
}

function setUiRunState({ isRunning, isPaused }) {
  running = Boolean(isRunning);
  paused = Boolean(isPaused);

  const isConnected = ble.isConnected();

  setUiConnected(isConnected);

  // During a run, lock inputs to avoid accidental changes.
  const lockInputs = running;
  if (els.deviceFieldset) els.deviceFieldset.disabled = lockInputs;
  if (els.settingsFieldset) els.settingsFieldset.disabled = lockInputs;

  if (els.targetDir) els.targetDir.disabled = lockInputs;
  if (els.btnPickFile) els.btnPickFile.disabled = lockInputs;
  if (els.btnPickFolder) els.btnPickFolder.disabled = lockInputs;

  setTargetSystemLocked(lockInputs);

  if (els.btnStartFiles) els.btnStartFiles.disabled = true; // computed in updateStartEnabled()

  if (els.btnPauseFiles) els.btnPauseFiles.disabled = !running || !isConnected || paused;
  if (els.btnResumeFiles) els.btnResumeFiles.disabled = !running || !isConnected || !paused;
  if (els.btnStopFiles) els.btnStopFiles.disabled = !running;

  updateStartEnabled();

  setJobPaused(paused);
}

function formatWallClock(ts) {
  if (!Number.isFinite(ts)) return '-';
  return new Date(ts).toLocaleString(getLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const totalSec = Math.floor(ms / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad2 = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`;
  return `${m}:${pad2(s)}`;
}

function clearJobMetrics() {
  if (els.etaTextFiles) els.etaTextFiles.textContent = '-';
  if (els.startTimeTextFiles) els.startTimeTextFiles.textContent = '-';
  if (els.fileCountTextFiles) els.fileCountTextFiles.textContent = '-';
  if (els.totalBytesTextFiles) els.totalBytesTextFiles.textContent = '-';
  if (els.stageTextFiles) els.stageTextFiles.textContent = '-';
  if (els.elapsedTextFiles) els.elapsedTextFiles.textContent = '-';
  if (els.progressTextFiles) els.progressTextFiles.textContent = '-';
  if (els.endTimeTextFiles) els.endTimeTextFiles.textContent = '-';
  if (els.estimateBasisTextFiles) els.estimateBasisTextFiles.textContent = '-';
}

function stopJobMetricsTimer() {
  if (!job?.intervalId) return;
  try {
    clearInterval(job.intervalId);
  } catch {
    // ignore
  }
  job.intervalId = null;
}

function clearJobState() {
  stopJobMetricsTimer();
  job = null;
}

function computeInitialEtaMs({
  totalBytes,
  fileCount,
  cfg,
  files,
  targetDir,
  tempB64Path,
  runToken,
  overwritePolicy,
  diagLog,
}) {
  const bytesForEta = Math.max(0, Number(totalBytes) || 0);
  const filesForEta = Math.max(0, Number(fileCount) || 0);
  if (bytesForEta <= 0 || filesForEta <= 0) return null;

  // Best estimate: include bootstrap/overhead/verification using the same work model.
  if (files && targetDir && tempB64Path && runToken) {
    return estimateTotalWorkMs({ files, cfg, targetDir, tempB64Path, runToken, overwritePolicy, diagLog });
  }

  // Fallback (legacy callers): approximate typed characters + fixed overhead.
  const typingMs = Math.max(0, Number(cfg?.typingDelayMs) || 0);
  const pressMs = Math.max(0, Number(cfg?.keyPressDelayMs) || 0);
  const legacyKeyMs = Math.max(0, Number(cfg?.keyDelayMs) || 0);
  const perCharMs = typingMs > 0 || pressMs > 0 ? typingMs + pressMs * 2 : legacyKeyMs * 3;
  const b64Chars = bytesForEta > 0 ? Math.ceil(bytesForEta / 3) * 4 : 0;
  const dataTypingMs = b64Chars * perCharMs;

  const fixedMs =
    Math.max(0, Number(cfg?.runDialogDelayMs) || 0) +
    Math.max(0, Number(cfg?.psLaunchDelayMs) || 0) +
    800 +
    Math.max(0, Number(cfg?.bootstrapDelayMs) || 0);

  const perFileMs = 900;
  return fixedMs + dataTypingMs + filesForEta * perFileMs;
}

function updatePreStartMetrics() {
  // Pre-start preview: show ETA + selection stats before the run begins.
  // Keep completed-run metrics until the user changes selection.
  if (running) return;
  if (job) return;

  if (selectedKind == null || selectedHasError) {
    clearJobMetrics();
    return;
  }

  const stats = computeSelectionStats();
  if (stats.fileCount <= 0) {
    clearJobMetrics();
    return;
  }

  const cfgForEta = getFilesSettingsFromUi();
  const totalBytes = Math.max(0, Number(stats.totalBytes) || 0);
  const fileCount = Math.max(0, Number(stats.fileCount) || 0);
  const files = getSelectedFilesList();
  const dir = String(els.targetDir?.value ?? '').trim();
  const runToken = 'preview';
  const tempB64Path = makeTempB64FullPath(dir, runToken);
  const initialEtaMs = computeInitialEtaMs({
    totalBytes,
    fileCount,
    cfg: cfgForEta,
    files,
    targetDir: dir,
    tempB64Path,
    runToken,
    overwritePolicy: cfgForEta.overwritePolicy,
    diagLog: cfgForEta.diagLog,
  });

  // Only show what helps preflight: ETA + file/bytes + basis.
  if (els.startTimeTextFiles) els.startTimeTextFiles.textContent = '-';
  if (els.endTimeTextFiles) els.endTimeTextFiles.textContent = '-';
  if (els.elapsedTextFiles) els.elapsedTextFiles.textContent = '-';
  if (els.stageTextFiles) els.stageTextFiles.textContent = '-';

  if (els.fileCountTextFiles) els.fileCountTextFiles.textContent = t('metric.nItems', { n: fileCount });
  if (els.totalBytesTextFiles) els.totalBytesTextFiles.textContent = `${formatBytes(totalBytes)} (${totalBytes} bytes)`;

  if (els.progressTextFiles) els.progressTextFiles.textContent = '-';

  if (els.etaTextFiles) {
    els.etaTextFiles.textContent = initialEtaMs && initialEtaMs > 0 ? formatDuration(initialEtaMs) : '-';
  }

  if (els.estimateBasisTextFiles) {
    const dir = String(els.targetDir?.value ?? '').trim();
    const os = String(getSelectedTargetSystem() ?? 'windows');
    const kind = String(selectedKind ?? '-');
    const cfg = cfgForEta;
    els.estimateBasisTextFiles.textContent = `preview / os=${os} / ${kind} / files=${fileCount} / bytes=${totalBytes} / dir=${dir || '-'} / bootChunk=${cfg.bootChunkChars}ch / dataChunk=${cfg.chunkChars}ch@${cfg.chunkDelayMs}ms / typing=${cfg.typingDelayMs}ms / press=${cfg.keyPressDelayMs}ms / cmd=${cfg.commandDelayMs}ms / ow=${cfg.overwritePolicy}`;
  }
}

function updateJobMetrics() {
  if (!job) {
    clearJobMetrics();
    return;
  }

  if (els.stageTextFiles) els.stageTextFiles.textContent = renderStageText();

  const nowWall = job.endedWallMs ?? Date.now();
  const elapsedWallMs = nowWall - job.startedWallMs;

  const currentPausedMs = job.pausedStartPerfMs != null ? performance.now() - job.pausedStartPerfMs : 0;
  const pausedTotalMs = job.pausedAccumMs + currentPausedMs;
  const activeElapsedMs = job.endedWallMs != null ? null : Math.max(0, performance.now() - job.startedPerfMs - pausedTotalMs);

  if (els.elapsedTextFiles) {
    // UI는 wall-clock 기반 표시를 유지하되, pause 시간은 내부 계산에서 제외한다.
    els.elapsedTextFiles.textContent = formatDuration(elapsedWallMs);
  }

  const totalBytes = Math.max(0, Number(job.totalBytes) || 0);
  const sentBytes = Math.max(0, Math.min(totalBytes, Number(job.sentBytes) || 0));
  const bytePct = totalBytes > 0 ? (sentBytes / totalBytes) * 100 : 0;

  const totalLines = Math.max(0, Number(job.workTotalLines) || 0);
  const doneLines = Math.max(0, Math.min(totalLines, Number(job.workDoneLines) || 0));
  const rawDoneLines = Math.max(0, Number(job.workDoneLines) || 0);
  const displayDoneLines = totalLines > 0 ? rawDoneLines : doneLines;
  const overallPct = totalLines > 0 ? Math.min(100, (displayDoneLines / totalLines) * 100) : bytePct;

  if (els.totalBytesTextFiles) {
    els.totalBytesTextFiles.textContent = `${formatBytes(totalBytes)} (${totalBytes} bytes)`;
  }

  if (els.progressTextFiles) {
    if (totalLines > 0) {
      const plus = displayDoneLines > totalLines ? '+' : '';
      els.progressTextFiles.textContent = `${overallPct.toFixed(1)}% (${displayDoneLines}/${totalLines}${plus} lines) / ${sentBytes}/${totalBytes} bytes`;
    } else {
      els.progressTextFiles.textContent = `${bytePct.toFixed(1)}% (${sentBytes}/${totalBytes} bytes)`;
    }
  }

  if (els.etaTextFiles) {
    if (job.endedWallMs != null) {
      // Keep the last ETA text shown (user wants ETA to remain even after completion).
      // Completion is already indicated via stage/end time.
      els.etaTextFiles.textContent = String(job.lastEtaText ?? els.etaTextFiles.textContent ?? '-');
    } else if (job.lastEtaText) {
      // Policy: ETA is calculated at start and kept stable during the run,
      // except for a small number of explicit recalibration points (display-only).
      els.etaTextFiles.textContent = String(job.lastEtaText);
    } else if (Number.isFinite(job.initialEtaMs) && job.initialEtaMs > 0) {
      const t = formatDuration(job.initialEtaMs);
      els.etaTextFiles.textContent = t;
      job.lastEtaText = t;
    } else {
      els.etaTextFiles.textContent = '-';
    }
  }
}

function getJobActiveElapsedMs() {
  if (!job) return null;
  if (job.endedWallMs != null) return null;
  const currentPausedMs = job.pausedStartPerfMs != null ? performance.now() - job.pausedStartPerfMs : 0;
  const pausedTotalMs = job.pausedAccumMs + currentPausedMs;
  return Math.max(0, performance.now() - job.startedPerfMs - pausedTotalMs);
}

function maybeRecalibrateEtaTotalMs(reason) {
  // Display-only: adjusts the shown total ETA based on measured progress so far.
  // Does not change any transfer timings.
  if (!job) return;
  if (job.endedWallMs != null) return;

  const totalLines = Math.max(0, Number(job.workTotalLines) || 0);
  if (totalLines <= 0) return;
  const doneLines = Math.max(0, Math.min(totalLines, Number(job.workDoneLines) || 0));
  if (doneLines < 5) return;
  const frac = doneLines / totalLines;
  if (!Number.isFinite(frac) || frac <= 0.01) return;

  const activeElapsedMs = getJobActiveElapsedMs();
  if (!Number.isFinite(activeElapsedMs) || activeElapsedMs <= 0) return;

  const empiricalTotalMs = activeElapsedMs / frac;
  if (!Number.isFinite(empiricalTotalMs) || empiricalTotalMs <= 0) return;

  const baselineMs = Number.isFinite(job.lastEtaMs) && job.lastEtaMs > 0 ? job.lastEtaMs : job.initialEtaMs;
  let nextTotalMs = empiricalTotalMs;

  if (Number.isFinite(baselineMs) && baselineMs > 0) {
    const minMs = baselineMs * 0.25;
    const maxMs = baselineMs * 4.0;
    nextTotalMs = Math.min(maxMs, Math.max(minMs, nextTotalMs));
    // Mild smoothing to avoid big jumps.
    nextTotalMs = Math.round(baselineMs * 0.5 + nextTotalMs * 0.5);
  } else {
    nextTotalMs = Math.round(nextTotalMs);
  }

  if (!Number.isFinite(nextTotalMs) || nextTotalMs <= 0) return;

  job.lastEtaMs = nextTotalMs;
  job.lastEtaText = formatDuration(nextTotalMs);
  job.lastEtaReason = String(reason || 'recalib');
}

function setJobPaused(isPaused) {
  if (!job) return;
  if (isPaused) {
    if (job.pausedStartPerfMs == null) {
      job.pausedStartPerfMs = performance.now();
    }
  } else {
    if (job.pausedStartPerfMs != null) {
      job.pausedAccumMs += performance.now() - job.pausedStartPerfMs;
      job.pausedStartPerfMs = null;
    }
  }
}

function estimateTotalWorkLines({ files, cfg, targetDir, tempB64Path, runToken, overwritePolicy, diagLog }) {
  const warmupLines = 3;
  const readyLine = 1;

  let launcherLines = 0;
  let bootChunkLines = 0;
  const dir = String(targetDir ?? '').trim();
  const token = String(runToken ?? '').trim();
  if (dir && token) {
    try {
      launcherLines = buildBootstrapChunkLauncherLines({ runToken: token, targetDir: dir }).length;
      const bootstrapScript = buildBootstrapScript({
        targetDir: dir,
        tmpB64Path: String(tempB64Path ?? '').trim(),
        overwritePolicy: String(overwritePolicy ?? 'fail'),
        diagLog: Boolean(diagLog),
      });
      const bootstrapEncoded = encodePowerShellEncodedCommandBase64(bootstrapScript);
      const bootChunkChars = Math.max(50, Number(cfg?.bootChunkChars) || 200);
      bootChunkLines = splitStringIntoChunks(bootstrapEncoded, bootChunkChars).length;
    } catch {
      // ignore; keep best-effort estimate
    }
  }

  const bootRunLine = 1;

  const list = Array.isArray(files) ? files : [];
  const chunkChars = Math.max(200, Number(cfg?.chunkChars) || 200);

  const perFileFixedLines = 3; // prepare_out + tmp_reset + commit

  let dataChunkLines = 0;
  for (const f of list) {
    const bytes = Math.max(0, Number(f?.size) || 0);
    const b64Chars = bytes > 0 ? Math.ceil(bytes / 3) * 4 : 0;
    const chunks = b64Chars > 0 ? Math.ceil(b64Chars / chunkChars) : 0;
    dataChunkLines += perFileFixedLines + chunks;
  }

  const finalizeLine = 1;

  return warmupLines + readyLine + launcherLines + bootChunkLines + bootRunLine + dataChunkLines + finalizeLine;
}

function estimateTotalWorkMs({ files, cfg, targetDir, tempB64Path, runToken, overwritePolicy, diagLog }) {
  const c = cfg || {};
  const typingMs = Math.max(0, Number(c.typingDelayMs) || 0);
  const pressMs = Math.max(0, Number(c.keyPressDelayMs) || 0);
  const perCharMs = typingMs + pressMs * 2;

  const normalPrefixChars = kPsLineGuardPrefix.length;
  const strongPrefixChars = kPsLineGuardPrefixStrong.length;

  const lineCostMs = (line, postDelayMs, { strong = false } = {}) => {
    const s = String(line ?? '');
    if (!s) {
      // Empty warmup line: just Enter (no prefix)
      return Math.max(0, Number(postDelayMs) || 0);
    }
    const prefixChars = strong ? strongPrefixChars : normalPrefixChars;
    const charsTyped = prefixChars + s.length + 1; // + '\n'
    return charsTyped * perCharMs + Math.max(0, Number(postDelayMs) || 0);
  };

  // Same as lineCostMs, but avoids allocating large strings (used for chunk lines).
  const lineCostMsByLen = (lineLen, postDelayMs, { strong = false } = {}) => {
    const n = Math.max(0, Number(lineLen) || 0);
    if (n <= 0) return Math.max(0, Number(postDelayMs) || 0);
    const prefixChars = strong ? strongPrefixChars : normalPrefixChars;
    const charsTyped = prefixChars + n + 1; // + '\n'
    return charsTyped * perCharMs + Math.max(0, Number(postDelayMs) || 0);
  };

  let ms = 0;

  // Run dialog + PowerShell launch overhead (best-effort, mirrors code order)
  ms += 40 + 40; // two Esc sleeps
  ms += Math.max(0, Number(c.runDialogDelayMs) || 0);
  ms += 50; // after force English

  // Typing the Run command itself also costs time; approximate with the same perCharMs.
  const runCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -NoExit';
  ms += runCmd.length * perCharMs;
  ms += Math.max(0, Number(c.psLaunchDelayMs) || 0);

  // Extra settle time (mirrors code)
  ms += Math.max(600, Math.min(2500, Math.floor(Number(c.psLaunchDelayMs) / 2) || 0));

  // Warmup lines + BF_READY
  const warmDelay = Math.max(Number(c.lineDelayMs) || 0, Number(c.commandDelayMs) || 0, 120);
  ms += lineCostMs('', warmDelay);
  ms += lineCostMs('', warmDelay);
  ms += lineCostMs('', warmDelay);
  ms += lineCostMs('', warmDelay);
  ms += lineCostMs('', warmDelay);
  ms += lineCostMs('', warmDelay);
  ms += lineCostMs(`Write-Host 'BF_READY_${String(runToken || 'run')}'`, Number(c.commandDelayMs) || 0, { strong: true });

  // Launcher lines
  let launcherLines = [];
  try {
    launcherLines = buildBootstrapChunkLauncherLines({ runToken, targetDir });
  } catch {
    launcherLines = [];
  }
  for (const line of launcherLines) {
    const trimmed = String(line || '').trim();
    const delayMs = trimmed.startsWith('function ') || trimmed === '}' ? Number(c.commandDelayMs) || 0 : Number(c.lineDelayMs) || 0;
    ms += lineCostMs(line, delayMs, { strong: true });
  }

  // Bootstrap chunks (bf_boot_append)
  let bootChunkCount = 0;
  const bootChunkChars = Math.max(50, Number(c.bootChunkChars) || 200);
  let bootstrapEncodedLen = 0;
  try {
    const bootstrapScript = buildBootstrapScript({
      targetDir,
      tmpB64Path: tempB64Path,
      overwritePolicy,
      diagLog,
    });
    const bootstrapEncoded = encodePowerShellEncodedCommandBase64(bootstrapScript);
    bootstrapEncodedLen = bootstrapEncoded.length;
    bootChunkCount = splitStringIntoChunks(bootstrapEncoded, bootChunkChars).length;
  } catch {
    bootChunkCount = 0;
  }

  // bf_boot_append '<chunk>' lines: all chunks are bootChunkChars except the last.
  // Sleep(chunkDelayMs) is applied after every chunk (including the last).
  const bootAppendBaseLen = "bf_boot_append ''".length;
  if (bootChunkCount > 0) {
    const fullChunks = Math.max(0, bootChunkCount - 1);
    const perFullChunkMs =
      lineCostMsByLen(bootAppendBaseLen + bootChunkChars, Number(c.lineDelayMs) || 0) +
      Math.max(0, Number(c.chunkDelayMs) || 0);
    ms += fullChunks * perFullChunkMs;

    const lastChunkLen = Math.max(0, bootstrapEncodedLen - fullChunks * bootChunkChars);
    ms +=
      lineCostMsByLen(bootAppendBaseLen + lastChunkLen, Number(c.lineDelayMs) || 0) +
      Math.max(0, Number(c.chunkDelayMs) || 0);
  }

  ms += lineCostMs('bf_boot_run', Number(c.commandDelayMs) || 0, { strong: true });
  ms += Math.max(0, Number(c.bootstrapDelayMs) || 0);

  // File processing
  const list = Array.isArray(files) ? files : [];
  const chunkChars = Math.max(200, Number(c.chunkChars) || 200);
  const perFileComputeMs = 900; // Decode+WriteAllBytes+Get-FileHash costs time on target

  for (const f of list) {
    const bytes = Math.max(0, Number(f?.size) || 0);
    const b64Chars = bytes > 0 ? Math.ceil(bytes / 3) * 4 : 0;
    const chunks = b64Chars > 0 ? Math.ceil(b64Chars / chunkChars) : 0;

    ms += lineCostMs(`bf_prepare_out_b64 '${'x'.repeat(64)}'`, Number(c.commandDelayMs) || 0);
    ms += lineCostMs('bf_tmp_reset', Number(c.commandDelayMs) || 0);

    // bf_tmp_append '<chunk>' lines: all chunks are chunkChars except the last.
    // Sleep(chunkDelayMs) is applied after every chunk (including the last).
    const tmpAppendBaseLen = "bf_tmp_append ''".length;
    if (chunks > 0) {
      const fullChunks = Math.max(0, chunks - 1);
      const perFullChunkMs =
        lineCostMsByLen(tmpAppendBaseLen + chunkChars, Number(c.lineDelayMs) || 0) +
        Math.max(0, Number(c.chunkDelayMs) || 0);
      ms += fullChunks * perFullChunkMs;

      const lastChunkLen = Math.max(0, b64Chars - fullChunks * chunkChars);
      ms +=
        lineCostMsByLen(tmpAppendBaseLen + lastChunkLen, Number(c.lineDelayMs) || 0) +
        Math.max(0, Number(c.chunkDelayMs) || 0);
    }

    ms += perFileComputeMs;
    ms += lineCostMs(`bf_commit '${'x'.repeat(64)}'`, Number(c.commandDelayMs) || 0);
  }

  // Finalize
  ms += lineCostMs('bf_finalize', Number(c.commandDelayMs) || 0);

  return Math.max(0, Math.round(ms));
}

function startJobMetrics({ totalBytes, fileCount, kind, targetDir, targetSystem, tempB64Path, files, runToken, overwritePolicy, diagLog }) {
  const nowWall = Date.now();
  const nowPerf = performance.now();

  const cfgForEta = getFilesSettingsFromUi();
  const initialEtaMs = computeInitialEtaMs({
    totalBytes,
    fileCount,
    cfg: cfgForEta,
    files,
    targetDir,
    tempB64Path,
    runToken,
    overwritePolicy,
    diagLog,
  });
  const workTotalLines = estimateTotalWorkLines({
    files,
    cfg: cfgForEta,
    targetDir,
    tempB64Path,
    runToken,
    overwritePolicy,
    diagLog,
  });

  job = {
    startedWallMs: nowWall,
    startedPerfMs: nowPerf,
    pausedAccumMs: 0,
    pausedStartPerfMs: null,
    endedWallMs: null,
    totalBytes: Math.max(0, Number(totalBytes) || 0),
    sentBytes: 0,
    stage: getStageLabel('prepare'),
    intervalId: null,
    initialEtaMs,
    lastEtaText: initialEtaMs ? formatDuration(initialEtaMs) : null,
    lastEtaMs: initialEtaMs ?? null,
    lastEtaReason: null,
    etaRecalibBootDone: false,
    etaRecalibFirstDataDone: false,
    workTotalLines: Math.max(0, Number(workTotalLines) || 0),
    workDoneLines: 0,
  };

  if (els.startTimeTextFiles) els.startTimeTextFiles.textContent = formatWallClock(job.startedWallMs);
  if (els.fileCountTextFiles) els.fileCountTextFiles.textContent = t('metric.nItems', { n: fileCount });
  if (els.totalBytesTextFiles) els.totalBytesTextFiles.textContent = `${formatBytes(job.totalBytes)} (${job.totalBytes} bytes)`;
  if (els.stageTextFiles) els.stageTextFiles.textContent = renderStageText();
  if (els.endTimeTextFiles) els.endTimeTextFiles.textContent = '-';
  if (els.estimateBasisTextFiles) {
    const dir = String(targetDir ?? '').trim();
    const os = String(targetSystem ?? 'windows');
    const cfg = cfgForEta;
    const tmp = String(tempB64Path ?? '').trim();
    els.estimateBasisTextFiles.textContent = `os=${os} / ${kind} / files=${fileCount} / bytes=${job.totalBytes} / dir=${dir || '-'} / tmp=${tmp || '-'} / bootChunk=${cfg.bootChunkChars}ch / dataChunk=${cfg.chunkChars}ch@${cfg.chunkDelayMs}ms / typing=${cfg.typingDelayMs}ms / press=${cfg.keyPressDelayMs}ms / cmd=${cfg.commandDelayMs}ms / ow=${cfg.overwritePolicy}`;
  }

  stopJobMetricsTimer();
  job.intervalId = setInterval(() => {
    updateJobMetrics();
  }, 250);

  updateJobMetrics();
}

function finishJobMetrics() {
  if (!job) return;
  job.stage = getStageLabel('cleanup');
  if (job.endedWallMs == null) job.endedWallMs = Date.now();
  if (job.intervalId) {
    clearInterval(job.intervalId);
    job.intervalId = null;
  }
  if (els.endTimeTextFiles) els.endTimeTextFiles.textContent = formatWallClock(job.endedWallMs);
  updateJobMetrics();
}

function resetFileSelection() {
  if (els.fileInput) els.fileInput.value = '';
  if (els.btnPickFile) els.btnPickFile.textContent = t('files.selectFile');
}

function resetFolderSelection() {
  if (els.folderInput) els.folderInput.value = '';
  if (els.btnPickFolder) els.btnPickFolder.textContent = t('files.selectFolder');
}

function clearSelection() {
  selectedKind = null;
  selectedSummary = { title: '-', details: '' };
  selectedHasError = false;
  setSummary(selectedSummary.title, selectedSummary.details);
}

function updateSelectionUi() {
  setSummary(selectedSummary.title, selectedSummary.details);
}

function onFilePicked() {
  const files = Array.from(els.fileInput?.files ?? []);
  if (files.length === 0) {
    resetFileSelection();
    clearSelection();
    if (!running) clearJobState();
    updateStartEnabled();
    return;
  }

  // single file only
  const f = files[0];
  selectedKind = 'file';
  selectedHasError = false;
  selectedSummary = { title: t('files.oneFile'), details: `${f.name} (${formatBytes(f.size)} / ${f.size} bytes)` };

  const label = shortLabel(f.name, 24);
  if (els.btnPickFile) els.btnPickFile.textContent = t('files.changeFile', { label });

  // mutually exclusive
  resetFolderSelection();

  updateSelectionUi();
  if (!running) clearJobState();
  updateStartEnabled();
}

function onFolderPicked() {
  const files = Array.from(els.folderInput?.files ?? []);
  if (files.length === 0) {
    resetFolderSelection();
    clearSelection();
    if (!running) clearJobState();
    updateStartEnabled();
    return;
  }

  const paths = files.map((f) => f.webkitRelativePath || f.name);
  const first = paths[0] || '';
  const root = first.split('/')[0] || '';
  if (!root) {
    selectedKind = null;
    selectedHasError = true;
    selectedSummary = { title: t('files.errorTitle'), details: t('error.folderStructure') };
    updateSelectionUi();
    if (!running) clearJobState();
    updateStartEnabled();
    return;
  }

  const differentRoot = paths.some((p) => (p.split('/')[0] || '') !== root);
  if (differentRoot) {
    selectedKind = null;
    selectedHasError = true;
    selectedSummary = { title: t('files.errorTitle'), details: t('error.folderSingleRoot') };
    updateSelectionUi();
    if (!running) clearJobState();
    updateStartEnabled();
    return;
  }

  selectedKind = 'folder';
  selectedHasError = false;
  const stats = computeSelectionStats();
  selectedSummary = {
    title: t('files.oneFolder'),
    details: `${root} (files: ${files.length} / total: ${formatBytes(stats.totalBytes)} / max: ${formatBytes(stats.maxFileBytes)})`,
  };

  const label = shortLabel(root, 24);
  if (els.btnPickFolder) els.btnPickFolder.textContent = t('files.changeFolder', { label });

  // mutually exclusive
  resetFileSelection();

  updateSelectionUi();
  if (!running) clearJobState();
  updateStartEnabled();
}

function computeStartReadiness() {
  const isConnected = ble.isConnected();
  if (!isConnected) return { ok: false, hint: t('files.hintConnectFirst'), hintKey: 'connectFirst' };
  if (running) return { ok: false, hint: '', hintKey: '' };

  const targetSystem = getSelectedTargetSystem();
  if (targetSystem !== 'windows') return { ok: false, hint: t('files.hintWindowsOnly'), hintKey: 'windowsOnly' };

  // Settings sanity checks (accuracy first)
  const cfg = getFilesSettingsFromUi();
  if (cfg.chunkChars < 200 || cfg.chunkChars > 10000) return { ok: false, hint: t('files.hintChunkCharsRange'), hintKey: 'chunkCharsRange' };
  if (cfg.bootChunkChars < 50 || cfg.bootChunkChars > 4000) return { ok: false, hint: t('files.hintBootChunkCharsRange'), hintKey: 'bootChunkCharsRange' };
  const dirValidity = getWindowsAbsolutePathValidity(els.targetDir?.value ?? '');
  if (!dirValidity.ok) return { ok: false, hint: t('files.hintTargetDirInvalid', { reason: dirValidity.reason }), hintKey: 'targetDirInvalid' };

  if (selectedKind == null) return { ok: false, hint: t('files.hintSelectSource'), hintKey: 'selectSource' };
  if (selectedHasError) return { ok: false, hint: t('files.hintSelectionError'), hintKey: 'selectionError' };

  const stats = computeSelectionStats();
  if (stats.fileCount <= 0) return { ok: false, hint: t('files.hintSelectSource'), hintKey: 'selectSource' };
  if (stats.maxFileBytes > kMaxSingleFileBytes) {
    const label = stats.maxFileLabel ? ` (${stats.maxFileLabel})` : '';
    return {
      ok: false,
      hint: t('files.hintSingleFileTooLarge', { label, size: formatBytes(stats.maxFileBytes), limit: formatBytes(kMaxSingleFileBytes) }),
      hintKey: 'singleFileTooLarge',
    };
  }
  if (stats.totalBytes > kMaxTotalBytes) {
    return { ok: false, hint: t('files.hintTotalTooLarge', { size: formatBytes(stats.totalBytes), limit: formatBytes(kMaxTotalBytes) }), hintKey: 'totalTooLarge' };
  }

  return { ok: true, hint: '', hintKey: '' };
}

function updateStartEnabled() {
  if (!els.btnStartFiles) return;

  setTargetDirValidityUi();

  const ready = computeStartReadiness();
  els.btnStartFiles.disabled = !ready.ok;

  setStartHint(ready.hint);
  setStartChecklist(computeStartChecklist());
  updatePreStartMetrics();
}

async function startRun() {
  if (!ble.getChar(ble.FLUSH_TEXT_CHAR_UUID)) {
    setStatus(t('status.error'), t('error.connectDevice'));
    return;
  }

  const ready = computeStartReadiness();
  if (!ready.ok) {
    setStatus(t('status.readyRequired'), ready.hint);
    return;
  }

  stopRequested = false;
  setUiRunState({ isRunning: true, isPaused: false });
  setStatus(t('status.running'), renderStageText());

  // 최소한의 작업정보(파일/폴더, 크기, 시작/경과)를 표시한다.
  const dir = String(els.targetDir?.value ?? '').trim();
  const targetSystem = getSelectedTargetSystem();
  const cfg = getFilesSettingsFromUi();
  saveFilesSettings(cfg);

  // Temp Base64 file: stored under targetDir\.tmp on the target PC; auto-unique per run.
  // Deletion-before-start is implemented in the PowerShell script phase (next step).
  const runToken = makeRunToken();
  const tempB64Path = makeTempB64FullPath(dir, runToken);

  const tmpDir = `${dir}\\${kTempSubdirName}`;
  let bootstrapInstalled = false;

  const files =
    selectedKind === 'folder' ? Array.from(els.folderInput?.files ?? []) : Array.from(els.fileInput?.files ?? []).slice(0, 1);
  const totalBytes = files.reduce((acc, f) => acc + (Number(f?.size) || 0), 0);
  const fileCount = files.length;
  const kind = selectedKind || '-';

  console.log('[files] start', {
    targetSystem,
    targetDir: dir,
    kind,
    fileCount,
    totalBytes,
    tempB64Path,
    settings: cfg,
  });
  startJobMetrics({
    totalBytes,
    fileCount,
    kind,
    targetDir: dir,
    targetSystem,
    tempB64Path,
    files,
    runToken,
    overwritePolicy: cfg.overwritePolicy,
    diagLog: cfg.diagLog,
  });

  // -- Tab visibility / beforeunload guards --
  const onVisibilityChange = () => {
    if (document.hidden) {
      setStatus(t('warn.tabBackground'), t('warn.tabBackgroundHint'));
    }
  };
  const onBeforeUnload = (e) => { e.preventDefault(); };
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('beforeunload', onBeforeUnload);

  try {
    stagePrepare();

    if (!ble.getChar(ble.MACRO_CHAR_UUID)) {
      throw new Error(t('error.noMacroChar'));
    }

    // Configure device delays for accuracy.
    const toggleKeyId = toggleKeyStringToId(getToggleKeySetting());
    const typingMs = Math.max(0, Number(cfg.typingDelayMs) || 0);
    const pressMs = Math.max(0, Number(cfg.keyPressDelayMs) || 0);
    await writeDeviceConfig({
      typingDelayMs: typingMs,
      // File Flush is intended to keep English mode; use typing delay as a reasonable default for mode-switch settle.
      modeSwitchDelayMs: typingMs,
      keyPressDelayMs: pressMs,
      toggleKeyId,
      pausedFlag: false,
      abortFlag: false,
    });

    // Open PowerShell via Run dialog (Win+R) and wait for prompt.
    setStatus(t('status.running'), t('status.psLaunching'));
    await macroEsc();
    await sleep(40);
    await macroEsc();
    await sleep(40);
    await macroOpenRun();
    await sleep(cfg.runDialogDelayMs);
    await macroForceEnglish();
    await sleep(50);
    const ow = String(cfg.overwritePolicy || 'fail');

    // Keep Run(Win+R) line short; large payloads can exceed macro limits.
    await macroTypeAscii('powershell -NoProfile -ExecutionPolicy Bypass -NoExit');
    await macroEnter();
    await sleep(cfg.psLaunchDelayMs);

    // Extra settle time: after the console becomes visible, focus/initialization can still
    // steal the first few characters. Use a delay related to launch wait, not commandDelay.
    await sleep(Math.max(600, Math.min(2500, Math.floor(Number(cfg.psLaunchDelayMs) / 2) || 0)));
    const tx = createBleTextTx();

    // Warm up the console prompt: send a few empty lines first.
    // This helps when the first line tends to lose leading characters.
    const warmDelay = Math.max(cfg.lineDelayMs, cfg.commandDelayMs, 120);
    for (let i = 0; i < 6; i += 1) {
      if (stopRequested) break;
      while (paused && !stopRequested) await sleep(120);
      if (stopRequested) break;
      await psLine(tx, '', { commandDelayMs: warmDelay });
    }
    if (stopRequested) throw new Error(t('status.userStopped'));
    await psLine(tx, `Write-Host 'BF_READY_${runToken}'`, { commandDelayMs: cfg.commandDelayMs, guard: 'strong' });

    // Send the (potentially large) bootstrap encoded command in chunks, then execute via IEX.
    stageBootstrap();
    setStatus(t('status.running'), t('status.bootstrapSending'));

    // Install the chunk launcher inside PowerShell (psLine uses BLE text channel and is chunked).
    const launcherLines = buildBootstrapChunkLauncherLines({ runToken, targetDir: dir });
    for (const line of launcherLines) {
      if (stopRequested) break;
      while (paused && !stopRequested) await sleep(120);
      if (stopRequested) break;
      const trimmed = String(line || '').trim();
      const delayMs = trimmed.startsWith('function ') || trimmed === '}' ? cfg.commandDelayMs : cfg.lineDelayMs;
      await psLine(tx, line, { commandDelayMs: delayMs, guard: 'strong' });
    }
    if (stopRequested) throw new Error(t('status.userStopped'));

    const bootstrapScript = buildBootstrapScript({
      targetDir: dir,
      tmpB64Path: tempB64Path,
      overwritePolicy: ow,
      diagLog: cfg.diagLog,
    });
    const bootstrapEncoded = encodePowerShellEncodedCommandBase64(bootstrapScript);
    // Keep each PowerShell line short to reduce keystroke drops.
    const bootChunks = splitStringIntoChunks(bootstrapEncoded, cfg.bootChunkChars);
    for (let i = 0; i < bootChunks.length; i += 1) {
      if (stopRequested) break;
      while (paused && !stopRequested) await sleep(120);
      if (stopRequested) break;
      await psLine(tx, `bf_boot_append '${bootChunks[i]}'`, { commandDelayMs: cfg.lineDelayMs });
      if (cfg.chunkDelayMs > 0) await sleep(cfg.chunkDelayMs);
    }
    if (stopRequested) throw new Error(t('status.userStopped'));
    await psLine(tx, 'bf_boot_run', { commandDelayMs: cfg.commandDelayMs, guard: 'strong' });
    bootstrapInstalled = true;
    if (cfg.bootstrapDelayMs > 0) await sleep(cfg.bootstrapDelayMs);

    // ETA recalibration point #1: after bootstrap completes.
    if (job && !job.etaRecalibBootDone) {
      job.etaRecalibBootDone = true;
      maybeRecalibrateEtaTotalMs('after_bootstrap');
    }

    const makeOutPath = (f) => {
      if (!f) return null;
      if (selectedKind === 'folder') {
        const rel = String(f.webkitRelativePath || f.name || '').replace(/\//g, '\\');
        return `${dir}\\${rel}`;
      }
      return `${dir}\\${String(f.name || 'payload.bin')}`;
    };

    setStatus(t('status.running'), t('status.processingFiles', { count: files.length }));
    stageSendChunks();

    let processed = 0;
    let sentBytesEquiv = 0;

    for (const f of files) {
        if (stopRequested) break;
        while (paused && !stopRequested) await sleep(120);
        if (stopRequested) break;

        const outPath = makeOutPath(f);
        if (!outPath) continue;

        processed += 1;
        setStatus(t('status.running'), t('status.processingFile', { processed, total: files.length, name: f.name || f.webkitRelativePath || '' }));

        const buf = await f.arrayBuffer();
        const b64 = arrayBufferToBase64(buf);
        const expectedHash = await sha256Hex(buf);

        const fileSize = Math.max(0, Number(f.size) || 0);
        let fileSentEquiv = 0;

        const outB64 = encodePowerShellEncodedCommandBase64(outPath);
        await psLine(tx, `bf_prepare_out_b64 '${outB64}'`, { commandDelayMs: cfg.commandDelayMs });

        // Write base64 chunks to temp file
        await psLine(tx, `bf_tmp_reset`, { commandDelayMs: cfg.commandDelayMs });

        const chunks = splitStringIntoChunks(b64, cfg.chunkChars);
        for (let i = 0; i < chunks.length; i += 1) {
          if (stopRequested) break;
          while (paused && !stopRequested) await sleep(120);
          if (stopRequested) break;
          const c = chunks[i];
          await psLine(tx, `bf_tmp_append '${c}'`, { commandDelayMs: cfg.lineDelayMs });

          // Metrics: bytes-equivalent progress (original bytes) based on chunk ratio.
          if (job && fileSize > 0) {
            const nextEquiv = Math.min(fileSize, Math.floor(((i + 1) / chunks.length) * fileSize));
            const delta = Math.max(0, nextEquiv - fileSentEquiv);
            fileSentEquiv += delta;
            sentBytesEquiv = Math.min(job.totalBytes, sentBytesEquiv + delta);
            job.sentBytes = sentBytesEquiv;
          }

          if (cfg.chunkDelayMs > 0) await sleep(cfg.chunkDelayMs);

          // ETA recalibration point #2: after the first data chunk append finishes.
          if (job && !job.etaRecalibFirstDataDone) {
            job.etaRecalibFirstDataDone = true;
            maybeRecalibrateEtaTotalMs('after_first_data_chunk');
          }
        }
        if (stopRequested) break;

        // Decode + hash verify + cleanup (inside bf_commit). Stage labels kept for UX.
        stageVerifyHash();
        const psExpected = psEscapeSingleQuoted(expectedHash);
        stageDecode();
        await psLine(tx, `bf_commit '${psExpected}'`, { commandDelayMs: cfg.commandDelayMs });

        stageCleanup();
        stageSendChunks();
      }

    if (stopRequested) {
      // Cancel: remove temp artifacts (best effort). If bootstrap is installed, use bf_finalize;
      // otherwise delete the temp directory directly.
      try {
        if (bootstrapInstalled) {
          await psLine(tx, 'bf_finalize', { commandDelayMs: cfg.commandDelayMs });
        } else {
          await psLine(tx, `Remove-Item -Force -Recurse -ErrorAction SilentlyContinue '${tmpDir}'`, {
            commandDelayMs: cfg.commandDelayMs,
            guard: 'strong',
          });
        }
      } catch {
        // ignore cleanup errors on cancel
      }
      setStatus(t('status.stopped'), t('status.userStopped'));
    } else {
      // Success: remove work artifacts under targetDir\.tmp
      await psLine(tx, 'bf_finalize', { commandDelayMs: cfg.commandDelayMs });
      if (job && Number(job.workTotalLines) > 0) {
        job.workDoneLines = job.workTotalLines;
      }
      setStatus(t('status.complete'), t('status.completeFiles', { processed, total: files.length }));
    }
  } catch (err) {
    setStatus(t('status.error'), String(err?.message || err));
  } finally {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('beforeunload', onBeforeUnload);
    setUiRunState({ isRunning: false, isPaused: false });
    finishJobMetrics();
    updateStartEnabled();
  }
}

function pauseRun() {
  if (!running) return;
  void (async () => {
    setUiRunState({ isRunning: true, isPaused: true });
    setStatus(t('status.paused'), renderStageText());
    try {
      const cfg = getFilesSettingsFromUi();
      const toggleKeyId = toggleKeyStringToId(getToggleKeySetting());
      await writeDeviceConfig({
        typingDelayMs: cfg.typingDelayMs,
        modeSwitchDelayMs: cfg.typingDelayMs,
        keyPressDelayMs: cfg.keyPressDelayMs,
        toggleKeyId,
        pausedFlag: true,
        abortFlag: false,
      });
    } catch {
      // ignore: pause should still work on host side
    }
  })();
}

function resumeRun() {
  if (!running) return;
  void (async () => {
    setUiRunState({ isRunning: true, isPaused: false });
    setStatus(t('status.running'), renderStageText());
    try {
      const cfg = getFilesSettingsFromUi();
      const toggleKeyId = toggleKeyStringToId(getToggleKeySetting());
      await writeDeviceConfig({
        typingDelayMs: cfg.typingDelayMs,
        modeSwitchDelayMs: cfg.typingDelayMs,
        keyPressDelayMs: cfg.keyPressDelayMs,
        toggleKeyId,
        pausedFlag: false,
        abortFlag: false,
      });
    } catch {
      // ignore
    }
  })();
}

function stopRun() {
  if (!running) return;
  stopRequested = true;
  void (async () => {
    try {
      const cfg = getFilesSettingsFromUi();
      const toggleKeyId = toggleKeyStringToId(getToggleKeySetting());
      await writeDeviceConfig({
        typingDelayMs: cfg.typingDelayMs,
        modeSwitchDelayMs: cfg.typingDelayMs,
        keyPressDelayMs: cfg.keyPressDelayMs,
        toggleKeyId,
        pausedFlag: false,
        abortFlag: true,
      });
    } catch {
      // ignore
    }
  })();
  setUiRunState({ isRunning: false, isPaused: false });
  setStatus(t('status.stopped'), '');
  stageCleanup();
  finishJobMetrics();
  updateStartEnabled();
}

function wireEvents() {
  if (els.btnConnect) {
    els.btnConnect.addEventListener('click', async () => {
      try {
        await ble.connect();
      } catch (err) {
        setStatus(t('status.error'), String(err?.message || err));
        setUiConnected(false);
        updateStartEnabled();
      }
    });
  }

  if (els.btnDisconnect) {
    els.btnDisconnect.addEventListener('click', async () => {
      ble.disconnect();
    });
  }

  if (els.btnBootloader) {
    els.btnBootloader.addEventListener('click', async () => {
      await ble.requestBootloader();
    });
  }

  if (els.btnPickFile && els.fileInput) {
    els.btnPickFile.addEventListener('click', () => {
      if (running) return;
      resetFolderSelection();
      clearSelection();
      els.fileInput.click();
    });
  }

  if (els.btnPickFolder && els.folderInput) {
    els.btnPickFolder.addEventListener('click', () => {
      if (running) return;
      resetFileSelection();
      clearSelection();
      els.folderInput.click();
    });
  }

  if (els.fileInput) els.fileInput.addEventListener('change', onFilePicked);
  if (els.folderInput) els.folderInput.addEventListener('change', onFolderPicked);

  if (els.targetDir) {
    els.targetDir.addEventListener('input', () => {
      updateStartEnabled();
    });
  }

  if (els.targetSystemRow) {
    els.targetSystemRow.addEventListener('change', () => {
      updateStartEnabled();
    });
  }

  const onSettingsChanged = () => {
    const cfg = getFilesSettingsFromUi();
    applyFilesSettingsToUi(cfg); // clamp & reflect
    updateStartEnabled();
  };

  if (els.typingDelayMsFiles) els.typingDelayMsFiles.addEventListener('input', onSettingsChanged);
  if (els.keyPressDelayMsFiles) els.keyPressDelayMsFiles.addEventListener('input', onSettingsChanged);
  if (els.lineDelayMsFiles) els.lineDelayMsFiles.addEventListener('input', onSettingsChanged);
  if (els.commandDelayMsFiles) els.commandDelayMsFiles.addEventListener('input', onSettingsChanged);
  if (els.bootChunkCharsFiles) els.bootChunkCharsFiles.addEventListener('input', onSettingsChanged);
  if (els.chunkCharsFiles) els.chunkCharsFiles.addEventListener('input', onSettingsChanged);
  if (els.chunkDelayMsFiles) els.chunkDelayMsFiles.addEventListener('input', onSettingsChanged);
  if (els.overwritePolicyFiles) els.overwritePolicyFiles.addEventListener('change', onSettingsChanged);

  if (els.btnApplyFilesSettings) {
    els.btnApplyFilesSettings.addEventListener('click', () => {
      if (running) return;
      applyFilesSettings();
    });
  }

  if (els.btnResetFilesSettings) {
    els.btnResetFilesSettings.addEventListener('click', () => {
      if (running) return;
      resetFilesSettings();
    });
  }

  if (els.deviceNickname) {
    els.deviceNickname.value = ble.loadSavedNickname();

    // IME(한글 등) 조합 입력 중에는 value를 건드리면 입력이 깨질 수 있다.
    // 조합이 끝난 뒤에만 sanitize한다.
    let nicknameComposing = false;
    els.deviceNickname.addEventListener('compositionstart', () => {
      nicknameComposing = true;
    });
    els.deviceNickname.addEventListener('compositionend', () => {
      nicknameComposing = false;
      const s = ble.sanitizeNickname(els.deviceNickname.value);
      if (els.deviceNickname.value !== s) els.deviceNickname.value = s;
    });
    els.deviceNickname.addEventListener('input', (e) => {
      if (nicknameComposing || e?.isComposing) return;
      const s = ble.sanitizeNickname(els.deviceNickname.value);
      if (els.deviceNickname.value !== s) els.deviceNickname.value = s;
    });
  }

  if (els.btnApplyNickname) {
    els.btnApplyNickname.addEventListener('click', async () => {
      const v = els.deviceNickname ? els.deviceNickname.value : '';
      await ble.writeDeviceNickname(v);
    });
  }

  if (els.btnStartFiles) els.btnStartFiles.addEventListener('click', startRun);
  if (els.btnPauseFiles) els.btnPauseFiles.addEventListener('click', pauseRun);
  if (els.btnResumeFiles) els.btnResumeFiles.addEventListener('click', resumeRun);
  if (els.btnStopFiles) els.btnStopFiles.addEventListener('click', stopRun);
}

// ---------------------------------------------------------------------------
// DOM creation — sidebar (excluding Device section)
// ---------------------------------------------------------------------------

function createFilesSidebar() {
  const frag = document.createDocumentFragment();

  // ── Cautions card ──
  const cautionsCard = document.createElement('section');
  cautionsCard.className = 'card';

  const cautionsTitle = document.createElement('h2');
  cautionsTitle.className = 'sidebarTitle';
  cautionsTitle.setAttribute('data-i18n', 'common.cautions');
  cautionsTitle.textContent = 'Cautions';
  cautionsCard.appendChild(cautionsTitle);

  const cautionsUl = document.createElement('ul');
  cautionsUl.className = 'muted small';
  cautionsUl.style.cssText = 'margin: 0; padding-left: 18px;';

  const cautionItems = [
    { attr: 'data-i18n-html', key: 'files.cautionAuthBold' },
    { attr: 'data-i18n', key: 'files.cautionIllegalFiles', text: 'Do not use for unauthorized access, security bypass, unauthorized file creation/input, or any illegal/unethical purpose.' },
    { attr: 'data-i18n-html', key: 'common.cautionNoPairing' },
    { attr: 'data-i18n', key: 'files.cautionTargetDir', text: 'Target directory: absolute path / ASCII only / no spaces' },
    { attr: 'data-i18n', key: 'files.cautionInput', text: 'Input: one top-level folder or one file' },
    { attr: 'data-i18n', key: 'files.cautionContent', text: 'Content: bytes preserved as-is (Base64 \u2192 WriteAllBytes)' },
    { attr: 'data-i18n', key: 'files.cautionPowerShell', text: 'PowerShell: auto-launched via Win+R (vulnerable to focus/popup/UAC/IME)' },
    { attr: 'data-i18n', key: 'files.cautionFocusSteal', text: 'Even without user interaction, system UI (notifications/antivirus/updates/UAC) can steal focus and cause failure' },
    { attr: 'data-i18n', key: 'files.cautionRecommend', text: 'Recommended: screen saver/auto-lock/sleep OFF, notifications OFF, no mouse/keyboard use during operation' },
    { attr: 'data-i18n', key: 'files.cautionUserFolder', text: 'Recommended: use a path under user folder to avoid permission issues (e.g. C:\\Users\\me\\...)' },
  ];
  for (const item of cautionItems) {
    const li = document.createElement('li');
    if (item.attr === 'data-i18n-html') {
      li.setAttribute('data-i18n-html', item.key);
    } else {
      li.setAttribute('data-i18n', item.key);
      li.textContent = item.text;
    }
    cautionsUl.appendChild(li);
  }
  cautionsCard.appendChild(cautionsUl);
  frag.appendChild(cautionsCard);

  // ── Transfer Settings card ──
  const settingsDetails = document.createElement('details');
  settingsDetails.className = 'card cardCollapsible';
  settingsDetails.id = 'settingsCardFiles';

  const settingsSummary = document.createElement('summary');
  settingsSummary.className = 'cardSummary';
  const summaryTitle = document.createElement('span');
  summaryTitle.className = 'cardSummaryTitle';
  summaryTitle.setAttribute('data-i18n', 'common.transferSettings');
  summaryTitle.textContent = 'Transfer Settings';
  settingsSummary.appendChild(summaryTitle);
  settingsDetails.appendChild(settingsSummary);

  const fieldset = document.createElement('fieldset');
  fieldset.id = 'settingsFieldset';

  function addNumberInput(parent, labelI18n, labelText, inputId, min, max, step, value) {
    const label = document.createElement('label');
    label.className = 'inline';
    label.style.cssText = 'width: 100%; justify-content: space-between;';
    const span = document.createElement('span');
    span.setAttribute('data-i18n', labelI18n);
    span.textContent = labelText;
    const input = document.createElement('input');
    input.id = inputId;
    input.type = 'number';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    label.appendChild(span);
    label.appendChild(input);
    parent.appendChild(label);
  }

  function addHint(parent, i18nKey, text) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.style.cssText = 'margin: -2px 0 0;';
    p.setAttribute('data-i18n', i18nKey);
    p.textContent = text;
    parent.appendChild(p);
  }

  function addDivider(parent) {
    const hr = document.createElement('hr');
    hr.className = 'sidebarDivider';
    parent.appendChild(hr);
  }

  function addSectionTitle(parent, i18nKey, text) {
    const h2 = document.createElement('h2');
    h2.className = 'settingsTitle';
    h2.style.marginTop = '14px';
    h2.setAttribute('data-i18n', i18nKey);
    h2.textContent = text;
    parent.appendChild(h2);
  }

  // -- Timing settings grid --
  const grid1 = document.createElement('div');
  grid1.className = 'grid2';

  addNumberInput(grid1, 'files.settingsTypingDelay', 'Typing delay (ms)', 'typingDelayMsFiles', 2, 1000, 1, 3);
  addHint(grid1, 'files.settingsTypingDelayHint', 'Wait time after each keystroke. Too short may cause drops in console/IME environments. (Aggressive tuning possible: 0~)');

  addNumberInput(grid1, 'files.settingsKeyPressDelay', 'Key press hold (ms)', 'keyPressDelayMsFiles', 2, 300, 1, 3);
  addHint(grid1, 'files.settingsKeyPressDelayHint', 'How long a key is held down. Too short may not register in some environments.');

  addNumberInput(grid1, 'files.settingsLineDelay', 'Line (Enter) delay (ms)', 'lineDelayMsFiles', 0, 2000, 1, 20);
  addHint(grid1, 'files.settingsLineDelayHint', 'Stabilization wait after Enter. Helps in environments with slow command processing/screen refresh.');

  addNumberInput(grid1, 'files.settingsCommandDelay', 'Command interval (ms)', 'commandDelayMsFiles', 0, 4000, 5, 50);
  addHint(grid1, 'files.settingsCommandDelayHint', 'Wait after a PowerShell command (one line) before the next (important for chunk loops).');

  fieldset.appendChild(grid1);

  // -- Divider + Base64/Chunk Settings --
  addDivider(fieldset);
  addSectionTitle(fieldset, 'files.settingsBase64ChunkTitle', 'Base64 / Chunk Settings');

  const grid2 = document.createElement('div');
  grid2.className = 'grid2';
  grid2.style.marginTop = '12px';

  addNumberInput(grid2, 'files.settingsBootChunkChars', 'Bootstrap chunk length (Chars)', 'bootChunkCharsFiles', 200, 4000, 50, 2000);
  addHint(grid2, 'files.settingsBootChunkCharsHint', 'Determines how many characters per bf_boot_append chunk (bootstrap -EncodedCommand Base64). Longer is faster but increases risk of keystroke drops.');

  addNumberInput(grid2, 'files.settingsChunkChars', 'Chunk length (Chars)', 'chunkCharsFiles', 1000, 10000, 50, 5000);
  addHint(grid2, 'files.settingsChunkCharsHint', 'Determines how many characters per Base64 chunk. Longer is faster but increases error/drop risk.');

  addNumberInput(grid2, 'files.settingsChunkDelay', 'Inter-chunk delay (ms)', 'chunkDelayMsFiles', 0, 2000, 5, 20);
  addHint(grid2, 'files.settingsChunkDelayHint', 'Wait after sending one chunk before the next (for input/processing stabilization).');

  fieldset.appendChild(grid2);

  // -- Divider + Write Settings --
  addDivider(fieldset);
  addSectionTitle(fieldset, 'files.settingsWriteTitle', 'Write Settings');

  const grid3 = document.createElement('div');
  grid3.className = 'grid2';
  grid3.style.marginTop = '12px';

  // Overwrite policy select
  const owLabel = document.createElement('label');
  owLabel.className = 'inline';
  owLabel.style.cssText = 'width: 100%; justify-content: space-between;';
  const owSpan = document.createElement('span');
  owSpan.setAttribute('data-i18n', 'files.overwritePolicy');
  owSpan.textContent = 'Overwrite Policy';
  const owSelect = document.createElement('select');
  owSelect.id = 'overwritePolicyFiles';

  const owOptions = [
    { value: 'fail', i18n: 'files.overwriteFail', text: 'fail (recommended)', selected: true },
    { value: 'overwrite', i18n: 'files.overwriteOverwrite', text: 'overwrite' },
    { value: 'backup', i18n: 'files.overwriteBackup', text: 'backup (.bak)' },
  ];
  for (const opt of owOptions) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.setAttribute('data-i18n', opt.i18n);
    option.textContent = opt.text;
    if (opt.selected) option.selected = true;
    owSelect.appendChild(option);
  }
  owLabel.appendChild(owSpan);
  owLabel.appendChild(owSelect);
  grid3.appendChild(owLabel);

  addHint(grid3, 'files.overwritePolicyHint', "Behavior when a target file already exists. Keep 'fail' by default; use overwrite/backup only when needed.");

  fieldset.appendChild(grid3);

  // -- Divider + Automation / Bootstrap --
  addDivider(fieldset);
  addSectionTitle(fieldset, 'files.settingsAutomationTitle', 'Automation / Bootstrap');

  const grid4 = document.createElement('div');
  grid4.className = 'grid2';
  grid4.style.marginTop = '12px';

  addNumberInput(grid4, 'files.settingsRunDialogDelay', 'Run (Win+R) dialog delay (ms)', 'runDialogDelayMsFiles', 100, 4000, 10, 350);
  addHint(grid4, 'files.settingsRunDialogDelayHint', 'Wait for the Run dialog to fully gain focus after Win+R.');

  addNumberInput(grid4, 'files.settingsPsLaunchDelay', 'PowerShell launch delay (ms)', 'psLaunchDelayMsFiles', 1200, 20000, 50, 9000);
  addHint(grid4, 'files.settingsPsLaunchDelayHint', 'Wait for PowerShell to open and the prompt to become ready for input.');

  addNumberInput(grid4, 'files.settingsBootstrapDelay', 'Post-bootstrap delay (ms)', 'bootstrapDelayMsFiles', 200, 10000, 10, 800);
  addHint(grid4, 'files.settingsBootstrapDelayHint', 'Stabilization wait after bootstrap script initialization before continuing.');

  // diagLog checkbox
  const diagLabel = document.createElement('label');
  diagLabel.className = 'inline';
  diagLabel.style.cssText = 'width: 100%; justify-content: space-between;';
  const diagSpan = document.createElement('span');
  diagSpan.setAttribute('data-i18n', 'files.settingsDiagLog');
  diagSpan.textContent = 'Enable diagnostic logging';
  const diagCheck = document.createElement('input');
  diagCheck.id = 'diagLogFiles';
  diagCheck.type = 'checkbox';
  diagCheck.checked = true;
  diagLabel.appendChild(diagSpan);
  diagLabel.appendChild(diagCheck);
  grid4.appendChild(diagLabel);

  addHint(grid4, 'files.settingsDiagLogHint', 'On failure, writes error log to targetDir\\.tmp\\bf_last_error.txt.');

  fieldset.appendChild(grid4);

  // Apply/Reset buttons row
  const btnRow = document.createElement('div');
  btnRow.className = 'row';
  btnRow.style.marginTop = '12px';

  const applyBtn = document.createElement('button');
  applyBtn.id = 'btnApplyFilesSettings';
  applyBtn.className = 'primary';
  applyBtn.type = 'button';
  applyBtn.setAttribute('data-i18n', 'common.applySettings');
  applyBtn.textContent = 'Apply Settings';
  btnRow.appendChild(applyBtn);

  const resetBtn = document.createElement('button');
  resetBtn.id = 'btnResetFilesSettings';
  resetBtn.type = 'button';
  resetBtn.setAttribute('data-i18n', 'common.resetSettings');
  resetBtn.textContent = 'Reset Settings';
  btnRow.appendChild(resetBtn);

  const toast = document.createElement('span');
  toast.id = 'filesSettingsToast';
  toast.className = 'muted small settingsToast';
  toast.setAttribute('aria-live', 'polite');
  btnRow.appendChild(toast);

  fieldset.appendChild(btnRow);
  settingsDetails.appendChild(fieldset);
  frag.appendChild(settingsDetails);

  // ── Notes card ──
  const notesCard = document.createElement('section');
  notesCard.className = 'card';

  const notesTitle = document.createElement('h2');
  notesTitle.className = 'sidebarTitle';
  notesTitle.setAttribute('data-i18n', 'common.notes');
  notesTitle.textContent = 'Notes';
  notesCard.appendChild(notesTitle);

  const notesDiv = document.createElement('div');
  notesDiv.className = 'muted small';
  notesDiv.style.cssText = 'margin: 0 0 10px 0;';

  const procTitle = document.createElement('div');
  procTitle.style.cssText = 'font-weight: 600; margin-bottom: 4px;';
  procTitle.setAttribute('data-i18n', 'files.procedureSummaryTitle');
  procTitle.textContent = 'Execution procedure (summary)';
  notesDiv.appendChild(procTitle);

  const procSummary = document.createElement('div');
  procSummary.setAttribute('data-i18n', 'files.procedureSummary');
  procSummary.textContent = 'PowerShell launch (Win+R) \u2192 console warmup/BF_READY \u2192 launcher install (bf_boot_append/run) \u2192 bootstrap send (bf_boot_append\u2026) \u2192 bootstrap execute (bf_boot_run) \u2192 file loop (prepare_out \u2192 tmp_reset \u2192 tmp_append\u2026 \u2192 commit) \u2192 decode (WriteAllBytes) \u2192 SHA-256 verify (Get-FileHash) \u2192 cleanup (.tmp delete) \u2192 done';
  notesDiv.appendChild(procSummary);

  const stageMapping = document.createElement('div');
  stageMapping.style.marginTop = '6px';
  stageMapping.setAttribute('data-i18n', 'files.stageMapping');
  stageMapping.textContent = 'Stage display mapping: Prepare (Win+R/warmup/BF_READY) \u2192 Boot (launcher+bootstrap install) \u2192 Send (Base64 chunk input) \u2192 Decode (WriteAllBytes) \u2192 Verify (Get-FileHash) \u2192 Cleanup (temp file delete)';
  notesDiv.appendChild(stageMapping);

  notesCard.appendChild(notesDiv);

  const notesUl = document.createElement('ul');
  notesUl.className = 'muted small';
  notesUl.style.cssText = 'margin: 0; padding-left: 18px;';

  const noteItems = [
    { attr: 'data-i18n', key: 'text.noteBluetooth', text: 'Web Bluetooth only works in Chrome/Edge.' },
    { attr: 'data-i18n', key: 'text.noteUSB', text: 'Target PC must allow USB keyboard devices.' },
    { attr: 'data-i18n', key: 'files.noteVerify', text: 'Verification uses SHA-256; mismatches stop immediately.' },
    { attr: 'data-i18n', key: 'files.noteTempFiles', text: 'Temporary Base64 files are auto-created as targetDir\\.tmp\\bf_payload_<auto>.b64; existing temp files are deleted before start.' },
    { attr: 'data-i18n', key: 'files.noteAutoDir', text: 'If targetDir does not exist, folders are created automatically.' },
    { attr: 'data-i18n', key: 'files.notePermission', text: 'May fail depending on security policy/write permissions.' },
    { attr: 'data-i18n', key: 'files.noteDiagLog', text: 'When diagnostic logging is enabled, targetDir\\.tmp\\bf_last_error.txt may be created on failure.' },
  ];
  for (const item of noteItems) {
    const li = document.createElement('li');
    li.setAttribute('data-i18n', item.key);
    li.textContent = item.text;
    notesUl.appendChild(li);
  }
  notesCard.appendChild(notesUl);
  frag.appendChild(notesCard);

  return frag;
}

// ---------------------------------------------------------------------------
// DOM creation — main content
// ---------------------------------------------------------------------------

function createFilesMain() {
  const frag = document.createDocumentFragment();

  const card = document.createElement('section');
  card.className = 'card';

  // Title
  const title = document.createElement('h2');
  title.className = 'settingsTitle';
  title.style.marginTop = '0';
  title.setAttribute('data-i18n', 'files.multiFileTitle');
  title.textContent = 'Multi-file Creation';
  card.appendChild(title);

  // Description
  const desc = document.createElement('p');
  desc.className = 'muted small';
  desc.style.marginTop = '6px';
  desc.setAttribute('data-i18n', 'files.multiFileDesc');
  desc.textContent = 'Select a single file or folder to create files on the Target PC under targetDir, preserving the selected structure. Each file is verified with SHA-256 after creation; mismatches/failures stop immediately with an error. If the run completes and no error report (targetDir\\.tmp\\bf_last_error.txt) is generated, the created files are error-free.';
  card.appendChild(desc);

  // Main grid2
  const grid = document.createElement('div');
  grid.className = 'grid2';
  grid.style.marginTop = '12px';

  // -- Source Selection --
  const srcTitle = document.createElement('h2');
  srcTitle.className = 'settingsTitle';
  srcTitle.style.cssText = 'margin: 0; padding-top: 14px;';
  srcTitle.setAttribute('data-i18n', 'files.sourceSelect');
  srcTitle.textContent = 'Source Selection';
  grid.appendChild(srcTitle);

  const srcHint = document.createElement('p');
  srcHint.className = 'muted small';
  srcHint.style.cssText = 'margin: -2px 0 0;';
  srcHint.setAttribute('data-i18n-html', 'files.sourceSelectHint');
  grid.appendChild(srcHint);

  // File/Folder pick buttons row
  const pickRow = document.createElement('div');
  pickRow.className = 'row';

  const btnPickFile = document.createElement('button');
  btnPickFile.id = 'btnPickFile';
  btnPickFile.type = 'button';
  btnPickFile.className = 'controlButton';
  btnPickFile.setAttribute('data-i18n', 'files.selectFile');
  btnPickFile.textContent = 'Select File';
  pickRow.appendChild(btnPickFile);

  const btnPickFolder = document.createElement('button');
  btnPickFolder.id = 'btnPickFolder';
  btnPickFolder.type = 'button';
  btnPickFolder.className = 'controlButton';
  btnPickFolder.setAttribute('data-i18n', 'files.selectFolder');
  btnPickFolder.textContent = 'Select Folder';
  pickRow.appendChild(btnPickFolder);

  // Hidden file inputs
  const fileInput = document.createElement('input');
  fileInput.id = 'fileInput';
  fileInput.type = 'file';
  fileInput.style.display = 'none';
  pickRow.appendChild(fileInput);

  const folderInput = document.createElement('input');
  folderInput.id = 'folderInput';
  folderInput.type = 'file';
  folderInput.setAttribute('webkitdirectory', '');
  folderInput.multiple = true;
  folderInput.style.display = 'none';
  pickRow.appendChild(folderInput);

  grid.appendChild(pickRow);

  // Summary / details
  const summaryDiv = document.createElement('div');
  summaryDiv.className = 'muted small';
  summaryDiv.style.marginTop = '4px';

  const summaryLine = document.createElement('div');
  const summaryLabel = document.createElement('span');
  summaryLabel.className = 'label';
  summaryLabel.setAttribute('data-i18n', 'files.selectedItems');
  summaryLabel.textContent = 'Selected items';
  const summaryValue = document.createElement('span');
  summaryValue.id = 'filesSummary';
  summaryValue.textContent = '-';
  summaryLine.appendChild(summaryLabel);
  summaryLine.appendChild(document.createTextNode(' '));
  summaryLine.appendChild(summaryValue);
  summaryDiv.appendChild(summaryLine);

  const detailsDiv = document.createElement('div');
  detailsDiv.className = 'muted small';
  detailsDiv.id = 'filesDetails';
  detailsDiv.style.cssText = 'margin-top: 4px; white-space: pre-wrap;';
  summaryDiv.appendChild(detailsDiv);

  grid.appendChild(summaryDiv);

  // -- Target System --
  const tsTitle = document.createElement('h2');
  tsTitle.className = 'settingsTitle';
  tsTitle.style.cssText = 'margin: 0; padding-top: 18px;';
  tsTitle.setAttribute('data-i18n', 'files.targetSystemSelect');
  tsTitle.textContent = 'Target System';
  grid.appendChild(tsTitle);

  const tsRow = document.createElement('div');
  tsRow.className = 'row';
  tsRow.id = 'targetSystemRow';

  const radioItems = [
    { value: 'windows', i18n: 'files.targetSystemWindows', text: 'Windows', checked: true, disabled: false },
    { value: 'mac', i18n: 'files.macOSComingSoon', text: 'macOS (coming soon)', checked: false, disabled: true },
    { value: 'linux', i18n: 'files.linuxComingSoon', text: 'Linux (coming soon)', checked: false, disabled: true },
  ];
  for (const ri of radioItems) {
    const lbl = document.createElement('label');
    lbl.className = 'controlOption';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'targetSystem';
    radio.value = ri.value;
    if (ri.checked) radio.checked = true;
    if (ri.disabled) radio.disabled = true;
    const span = document.createElement('span');
    span.setAttribute('data-i18n', ri.i18n);
    span.textContent = ri.text;
    lbl.appendChild(radio);
    lbl.appendChild(span);
    tsRow.appendChild(lbl);
  }
  grid.appendChild(tsRow);

  // -- Target Directory --
  const tdTitle = document.createElement('h2');
  tdTitle.className = 'settingsTitle';
  tdTitle.style.cssText = 'margin: 0; padding-top: 18px;';
  tdTitle.setAttribute('data-i18n', 'files.targetDirSelect');
  tdTitle.textContent = 'Target Directory';
  grid.appendChild(tdTitle);

  const tdHint = document.createElement('p');
  tdHint.className = 'muted small';
  tdHint.style.cssText = 'margin: -2px 0 0;';
  tdHint.setAttribute('data-i18n-html', 'files.targetDirHint');
  grid.appendChild(tdHint);

  const tdInput = document.createElement('input');
  tdInput.id = 'targetDir';
  tdInput.className = 'textField';
  tdInput.type = 'text';
  tdInput.value = 'C:\\byteflusher';
  tdInput.placeholder = 'e.g. C:\\Users\\me\\Documents\\byteflusher_out';
  tdInput.setAttribute('data-i18n-placeholder', 'files.targetDirPlaceholder');
  grid.appendChild(tdInput);

  const tdValidity = document.createElement('div');
  tdValidity.id = 'targetDirValidityFiles';
  tdValidity.className = 'muted small validityLine';
  tdValidity.setAttribute('aria-live', 'polite');
  grid.appendChild(tdValidity);

  const tdAsciiHint = document.createElement('p');
  tdAsciiHint.className = 'muted small';
  tdAsciiHint.style.cssText = 'margin: -2px 0 0;';
  tdAsciiHint.setAttribute('data-i18n', 'files.targetDirAsciiHint');
  tdAsciiHint.textContent = 'ASCII only, no spaces. (Recommended: use a path under user folder to avoid permission issues)';
  grid.appendChild(tdAsciiHint);

  card.appendChild(grid);

  // Control buttons row
  const ctrlRow = document.createElement('div');
  ctrlRow.className = 'row';
  ctrlRow.style.marginTop = '24px';

  const ctrlButtons = [
    { id: 'btnStartFiles', cls: 'primary controlButton', i18n: 'common.startFiles', text: 'Start (Files)', disabled: true },
    { id: 'btnPauseFiles', cls: 'controlButton', i18n: 'common.pause', text: 'Pause', disabled: true },
    { id: 'btnResumeFiles', cls: 'controlButton', i18n: 'common.resume', text: 'Resume', disabled: true },
    { id: 'btnStopFiles', cls: 'danger controlButton', i18n: 'common.stop', text: 'Stop', disabled: true },
  ];
  for (const b of ctrlButtons) {
    const btn = document.createElement('button');
    btn.id = b.id;
    btn.className = b.cls;
    btn.disabled = b.disabled;
    btn.setAttribute('data-i18n', b.i18n);
    btn.textContent = b.text;
    ctrlRow.appendChild(btn);
  }
  card.appendChild(ctrlRow);

  // Hint / checklist
  const hintDiv = document.createElement('div');
  hintDiv.className = 'muted small';
  hintDiv.id = 'startHint';
  hintDiv.style.marginTop = '8px';
  card.appendChild(hintDiv);

  const checklistDiv = document.createElement('div');
  checklistDiv.className = 'muted small';
  checklistDiv.id = 'startChecklistFiles';
  checklistDiv.style.cssText = 'margin-top: 6px; white-space: pre-wrap;';
  card.appendChild(checklistDiv);

  // Job metrics
  const metricsDiv = document.createElement('div');
  metricsDiv.id = 'jobMetricsFiles';
  metricsDiv.className = 'jobMetrics';
  metricsDiv.setAttribute('aria-live', 'polite');
  metricsDiv.style.marginTop = '10px';

  const metrics = [
    { keyI18n: 'metric.estimate', keyText: 'ETA', valueId: 'etaTextFiles' },
    { keyI18n: 'metric.startTime', keyText: 'Start', valueId: 'startTimeTextFiles' },
    { keyI18n: 'metric.files', keyText: 'Files', valueId: 'fileCountTextFiles' },
    { keyI18n: 'metric.bytes', keyText: 'Bytes', valueId: 'totalBytesTextFiles' },
    { keyI18n: 'metric.stage', keyText: 'Stage', valueId: 'stageTextFiles' },
    { keyI18n: 'metric.elapsed', keyText: 'Elapsed', valueId: 'elapsedTextFiles' },
    { keyI18n: 'metric.progress', keyText: 'Progress', valueId: 'progressTextFiles' },
    { keyI18n: 'metric.endTime', keyText: 'End', valueId: 'endTimeTextFiles' },
    { keyI18n: 'metric.basis', keyText: 'Basis', valueId: 'estimateBasisTextFiles', wide: true },
  ];
  for (const m of metrics) {
    const line = document.createElement('div');
    line.className = m.wide ? 'jobLine jobLineWide' : 'jobLine';
    const keySpan = document.createElement('span');
    keySpan.className = 'jobKey';
    keySpan.setAttribute('data-i18n', m.keyI18n);
    keySpan.textContent = m.keyText;
    const valSpan = document.createElement('span');
    valSpan.id = m.valueId;
    valSpan.className = 'muted small';
    valSpan.textContent = '-';
    line.appendChild(keySpan);
    line.appendChild(valSpan);
    metricsDiv.appendChild(line);
  }
  card.appendChild(metricsDiv);

  frag.appendChild(card);
  return frag;
}

function init() {
  resetFileSelection();
  resetFolderSelection();
  clearSelection();

  if (els.targetDir && !String(els.targetDir.value || '').trim()) {
    els.targetDir.value = kDefaultTargetDir;
  }

  setTargetSystemLocked(false);

  const cfg = loadFilesSettings();
  applyFilesSettingsToUi(cfg);
  saveFilesSettings(cfg);

  setStatus(t('status.disconnected'), '');
  setUiRunState({ isRunning: false, isPaused: false });
  clearJobMetrics();

  wireEvents();
  updateStartEnabled();
}

async function boot() {
  await initI18n();
  init();
}

boot();
