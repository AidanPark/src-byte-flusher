// File Flush page (Windows)
// - File/Folder -> Base64 -> Target PC PowerShell decodes and writes bytes
// - Accuracy-first: SHA-256 verified per file
// - Automation: Win+R -> PowerShell launch, then command typing via HID
// - Bootstrap: launch PowerShell with -EncodedCommand (define helper functions), then send Base64 chunks

const SERVICE_UUID = 'f3641400-00b0-4240-ba50-05ca45bf8abc';
const FLUSH_TEXT_CHAR_UUID = 'f3641401-00b0-4240-ba50-05ca45bf8abc';
const CONFIG_CHAR_UUID = 'f3641402-00b0-4240-ba50-05ca45bf8abc';
const STATUS_CHAR_UUID = 'f3641403-00b0-4240-ba50-05ca45bf8abc';
const MACRO_CHAR_UUID = 'f3641404-00b0-4240-ba50-05ca45bf8abc';

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
  statusText: document.getElementById('statusText'),
  detailsText: document.getElementById('detailsText'),
  deviceFieldset: document.getElementById('deviceFieldset'),

  targetSystemRow: document.getElementById('targetSystemRow'),

  settingsFieldset: document.getElementById('settingsFieldset'),
  btnApplyFilesSettings: document.getElementById('btnApplyFilesSettings'),
  btnResetFilesSettings: document.getElementById('btnResetFilesSettings'),
  keyDelayMsFiles: document.getElementById('keyDelayMsFiles'),
  lineDelayMsFiles: document.getElementById('lineDelayMsFiles'),
  commandDelayMsFiles: document.getElementById('commandDelayMsFiles'),
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

let device = null;
let server = null;
let flushChar = null;
let configChar = null;
let statusChar = null;
let macroChar = null;

let deviceBufCapacity = null;
let deviceBufFree = null;
let deviceBufUpdatedAt = 0;
let statusWaiters = [];

let running = false;
let paused = false;
let stopRequested = false;

let job = null;

let filesSettingsToastTimerId = null;

// selection state
let selectedKind = null; // 'file' | 'folder' | null
let selectedSummary = { title: '-', details: '' };

const kDefaultFileButtonText = '파일 선택';
const kDefaultFolderButtonText = '폴더 선택';

const kDefaultTargetDir = 'C:\\byteflusher';

const kFilesSettingsStorageKey = 'byteflusher_files_settings_v2';
const kFilesSettingsStorageKeyLegacy = 'byteflusher_files_settings_v1';

const kDefaultFilesSettings = Object.freeze({
  // Accuracy-first defaults (PowerShell + HID typing is sensitive)
  keyDelayMs: 10,
  lineDelayMs: 20,
  commandDelayMs: 50,
  chunkChars: 1200,
  chunkDelayMs: 20,
  overwritePolicy: 'fail', // 'fail' | 'overwrite' | 'backup'

  // Automation / bootstrap
  runDialogDelayMs: 250,
  psLaunchDelayMs: 1200,
  bootstrapDelayMs: 200,
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
  if (!dataView) return;
  if (dataView.byteLength < 4) return;
  const cap = dataView.getUint16(0, true);
  const free = dataView.getUint16(2, true);
  if (Number.isFinite(cap) && cap > 0) deviceBufCapacity = cap;
  if (Number.isFinite(free) && free >= 0) deviceBufFree = free;
  deviceBufUpdatedAt = performance.now();
  resolveStatusWaiters();
}

async function readStatusOnce() {
  if (!statusChar) return;
  try {
    const v = await statusChar.readValue();
    handleStatusValue(v);
  } catch {
    // ignore
  }
}

function waitForStatusUpdate(timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    statusWaiters.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function waitForDeviceRoom({ requiredBytes, maxBacklogBytes }) {
  if (!statusChar) return;
  const startedAt = performance.now();

  while (!stopRequested) {
    if (paused) return;
    if (!device?.gatt?.connected) return;

    const cap = deviceBufCapacity;
    const free = deviceBufFree;
    if (Number.isFinite(cap) && Number.isFinite(free)) {
      const used = Math.max(0, cap - free);
      const enoughFree = free >= requiredBytes;
      const backlogOk = used <= maxBacklogBytes;
      if (enoughFree && backlogOk) return;
    }

    const now = performance.now();
    if (!Number.isFinite(deviceBufUpdatedAt) || now - deviceBufUpdatedAt > 800) {
      await readStatusOnce();
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
  if (!configChar) return;
  const flags = (pausedFlag ? 0x01 : 0) | (abortFlag ? 0x02 : 0);
  const payload = buildDeviceConfigPayload({ typingDelayMs, modeSwitchDelayMs, keyPressDelayMs, toggleKeyId, flags });
  await configChar.writeValue(payload);
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
  if (!flushChar) throw new Error('flush characteristic이 없습니다.');
  if (!tx) throw new Error('tx가 없습니다.');
  let offset = 0;

  while (offset < bytes.length) {
    if (stopRequested) return;
    if (paused) {
      await sleep(120);
      continue;
    }
    if (!device?.gatt?.connected) throw new Error('BLE 연결이 끊어졌습니다.');

    const chunk = bytes.slice(offset, offset + chunkSize);
    const maxBacklogBytes = Math.max(32, chunkSize);
    await waitForDeviceRoom({ requiredBytes: chunk.length, maxBacklogBytes });
    const packet = buildPacket(tx.sessionId, tx.seq, chunk);
    await flushChar.writeValue(packet);
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
  if (!macroChar) throw new Error('macro characteristic이 없습니다(펌웨어 업데이트 필요).');
  while (paused && !stopRequested) await sleep(120);
  if (stopRequested) throw new Error('사용자 중지');
  const payload = payloadBytes ? new Uint8Array(payloadBytes) : new Uint8Array(0);
  if (payload.length > 255) throw new Error('macro payload too large');
  const buf = new Uint8Array(2 + payload.length);
  buf[0] = cmd & 0xff;
  buf[1] = payload.length & 0xff;
  buf.set(payload, 2);
  await macroChar.writeValue(buf);
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
    keyDelayMs: clampInt(els.keyDelayMsFiles?.value, 10, 120, kDefaultFilesSettings.keyDelayMs),
    lineDelayMs: clampInt(els.lineDelayMsFiles?.value, 20, 2000, kDefaultFilesSettings.lineDelayMs),
    commandDelayMs: clampInt(els.commandDelayMsFiles?.value, 50, 4000, kDefaultFilesSettings.commandDelayMs),
    chunkChars: clampInt(els.chunkCharsFiles?.value, 200, 4000, kDefaultFilesSettings.chunkChars),
    chunkDelayMs: clampInt(els.chunkDelayMsFiles?.value, 0, 2000, kDefaultFilesSettings.chunkDelayMs),
    overwritePolicy: String(els.overwritePolicyFiles?.value || kDefaultFilesSettings.overwritePolicy),

    runDialogDelayMs: clampInt(els.runDialogDelayMsFiles?.value, 100, 2000, kDefaultFilesSettings.runDialogDelayMs),
    psLaunchDelayMs: clampInt(els.psLaunchDelayMsFiles?.value, 1200, 8000, kDefaultFilesSettings.psLaunchDelayMs),
    bootstrapDelayMs: clampInt(els.bootstrapDelayMsFiles?.value, 200, 3000, kDefaultFilesSettings.bootstrapDelayMs),
    diagLog: Boolean(els.diagLogFiles?.checked),
  };
}

function applyFilesSettingsToUi(s) {
  if (els.keyDelayMsFiles) els.keyDelayMsFiles.value = String(s.keyDelayMs);
  if (els.lineDelayMsFiles) els.lineDelayMsFiles.value = String(s.lineDelayMs);
  if (els.commandDelayMsFiles) els.commandDelayMsFiles.value = String(s.commandDelayMs);
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
      raw = localStorage.getItem(kFilesSettingsStorageKeyLegacy);
      if (!raw) return { ...kDefaultFilesSettings };
      const parsedLegacy = JSON.parse(raw);
      const migrated = { ...kDefaultFilesSettings, ...(parsedLegacy || {}), diagLog: true };
      // sanitize
      migrated.keyDelayMs = clampInt(migrated.keyDelayMs, 10, 120, kDefaultFilesSettings.keyDelayMs);
      migrated.lineDelayMs = clampInt(migrated.lineDelayMs, 20, 2000, kDefaultFilesSettings.lineDelayMs);
      migrated.commandDelayMs = clampInt(migrated.commandDelayMs, 50, 4000, kDefaultFilesSettings.commandDelayMs);
      migrated.chunkChars = clampInt(migrated.chunkChars, 200, 4000, kDefaultFilesSettings.chunkChars);
      migrated.chunkDelayMs = clampInt(migrated.chunkDelayMs, 0, 2000, kDefaultFilesSettings.chunkDelayMs);
      migrated.overwritePolicy = String(migrated.overwritePolicy || kDefaultFilesSettings.overwritePolicy);

      migrated.runDialogDelayMs = clampInt(migrated.runDialogDelayMs, 100, 2000, kDefaultFilesSettings.runDialogDelayMs);
      migrated.psLaunchDelayMs = clampInt(migrated.psLaunchDelayMs, 1200, 8000, kDefaultFilesSettings.psLaunchDelayMs);
      migrated.bootstrapDelayMs = clampInt(migrated.bootstrapDelayMs, 200, 3000, kDefaultFilesSettings.bootstrapDelayMs);
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
    s.keyDelayMs = clampInt(s.keyDelayMs, 10, 120, kDefaultFilesSettings.keyDelayMs);
    s.lineDelayMs = clampInt(s.lineDelayMs, 20, 2000, kDefaultFilesSettings.lineDelayMs);
    s.commandDelayMs = clampInt(s.commandDelayMs, 50, 4000, kDefaultFilesSettings.commandDelayMs);
    s.chunkChars = clampInt(s.chunkChars, 200, 4000, kDefaultFilesSettings.chunkChars);
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
  showFilesSettingsToast('저장됨', 1000);
  updateStartEnabled();
}

function resetFilesSettings() {
  const cfg = { ...kDefaultFilesSettings };
  applyFilesSettingsToUi(cfg);
  saveFilesSettings(cfg);
  console.log('[files] settings reset', cfg);
  showFilesSettingsToast('초기화됨', 1000);
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
  const compactReadinessHint = (hint) => {
    const s = String(hint ?? '').trim();
    if (!s) return '조건 불충족';
    if (s.includes('장치를 먼저 연결')) return '장치 연결 필요';
    if (s.includes('Windows만')) return 'Windows만 지원';
    if (s.includes('대상 디렉토리')) return '대상 디렉토리 오류';
    if (s.includes('파일 또는 폴더를 선택')) return '소스 선택 필요';
    if (s.includes('선택 오류')) return '소스 선택 오류';
    if (s.includes('단일 파일이 너무 큽니다')) return '단일 파일 용량 초과';
    if (s.includes('전체 용량이 너무 큽니다')) return '전체 용량 초과';
    if (s.includes('청크 길이')) return '청크 설정 오류';
    return s;
  };

  const isConnected = Boolean(device?.gatt?.connected);
  const targetSystem = getSelectedTargetSystem();
  const dirOk = isValidWindowsAbsolutePath(els.targetDir?.value ?? '');
  const sourceOk = selectedKind != null && selectedSummary?.title !== '오류';
  const notRunning = !running;
  const ready = computeStartReadiness();

  const stats = computeSelectionStats();
  const singleOk = stats.fileCount > 0 && stats.maxFileBytes <= kMaxSingleFileBytes;
  const totalOk = stats.fileCount > 0 && stats.totalBytes <= kMaxTotalBytes;

  const sourceLabel =
    selectedKind === 'file'
      ? '소스: 파일 1개 선택'
      : selectedKind === 'folder'
        ? '소스: 폴더 1개 선택'
        : '소스: 파일/폴더 선택 필요';

  return [
    { ok: isConnected, label: isConnected ? '장치 연결됨' : '장치 연결 필요' },
    { ok: targetSystem === 'windows', label: targetSystem === 'windows' ? '타겟 시스템: Windows' : '타겟 시스템: Windows 선택 필요' },
    { ok: dirOk, label: dirOk ? '타겟 디렉토리: OK' : '타겟 디렉토리: 절대경로(ASCII, 공백 불가) 필요' },
    { ok: sourceOk, label: sourceLabel },
    {
      ok: singleOk,
      label:
        stats.fileCount === 0
          ? `단일 파일 크기 제한: ${formatBytes(kMaxSingleFileBytes)} 이하`
          : `단일 파일 크기: ${formatBytes(stats.maxFileBytes)} / 제한 ${formatBytes(kMaxSingleFileBytes)}`,
    },
    {
      ok: totalOk,
      label:
        stats.fileCount === 0
          ? `전체 용량 제한: ${formatBytes(kMaxTotalBytes)} 이하`
          : `전체 용량: ${formatBytes(stats.totalBytes)} / 제한 ${formatBytes(kMaxTotalBytes)}`,
    },
    {
      ok: ready.ok,
      label:
        running
          ? '상태: 실행 중(Stop 후 Start 가능)'
          : ready.ok
            ? '상태: 시작 가능'
            : `상태: 시작 불가 (${compactReadinessHint(ready.hint)})`,
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
  if (!v) return { ok: false, reason: '필수' };
  if (!isAllAsciiNoSpace(v)) return { ok: false, reason: 'ASCII만/공백불가' };

  // Very strict per policy: drive absolute path only (e.g., C:\Users\me)
  // (UNC paths intentionally excluded for simplicity/accuracy)
  if (!/^[A-Za-z]:\\/.test(v)) return { ok: false, reason: '예: C:\\Users\\me\\out' };

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
  if (paused) return `${stage} (일시정지)`;
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

const kStages = Object.freeze({
  prepare: '준비',
  bootstrap: '부트',
  sendChunks: '전송',
  decode: '복원',
  verifyHash: '검증',
  cleanup: '정리',
});

function setJobStage(stage, { statusText, statusDetails } = {}) {
  if (!job) return;
  job.stage = String(stage ?? '').trim() || '-';
  updateJobMetrics();
  if (statusText) {
    setStatus(String(statusText), String(statusDetails ?? renderStageText()));
  }
}

function stagePrepare() {
  setJobStage(kStages.prepare);
}

function stageBootstrap() {
  setJobStage(kStages.bootstrap);
}

function stageSendChunks() {
  setJobStage(kStages.sendChunks);
}

function stageDecode() {
  setJobStage(kStages.decode);
}

function stageVerifyHash() {
  setJobStage(kStages.verifyHash);
}

function stageCleanup() {
  setJobStage(kStages.cleanup);
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
}

function setUiRunState({ isRunning, isPaused }) {
  running = Boolean(isRunning);
  paused = Boolean(isPaused);

  const isConnected = Boolean(device?.gatt?.connected);

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
  return new Date(ts).toLocaleString('ko-KR', {
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
  const perCharMs = Math.max(0, Number(cfg?.keyDelayMs) || 0) * 3; // keyPress*2 + typingDelay
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

  if (selectedKind == null || selectedSummary?.title === '오류') {
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

  if (els.fileCountTextFiles) els.fileCountTextFiles.textContent = `${fileCount}개`;
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
    els.estimateBasisTextFiles.textContent = `preview / os=${os} / ${kind} / files=${fileCount} / bytes=${totalBytes} / dir=${dir || '-'} / chunk=${cfg.chunkChars}ch@${cfg.chunkDelayMs}ms / key=${cfg.keyDelayMs}ms / cmd=${cfg.commandDelayMs}ms / ow=${cfg.overwritePolicy}`;
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
      // Policy: ETA is calculated once at start and must remain stable until the end.
      // Progress is shown separately; ETA does not update during the run.
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
      bootChunkLines = splitStringIntoChunks(bootstrapEncoded, 200).length;
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
  const perCharMs = Math.max(0, Number(c.keyDelayMs) || 0) * 3; // keyPress*2 + typingDelay

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

  let ms = 0;

  // Run dialog + PowerShell launch overhead (best-effort, mirrors code order)
  ms += 40 + 40; // two Esc sleeps
  ms += Math.max(0, Number(c.runDialogDelayMs) || 0);
  ms += 50; // after force English

  // Typing the Run command itself also costs time; approximate with the same perCharMs.
  const runCmd = 'powershell -NoProfile -ExecutionPolicy Bypass -NoExit';
  ms += runCmd.length * perCharMs;
  ms += Math.max(0, Number(c.psLaunchDelayMs) || 0);

  // Extra settle time (same clamp as code)
  ms += Math.max(200, Math.min(2000, Number(c.commandDelayMs) || 0));

  // Warmup lines + BF_READY
  const warmDelay = Math.max(Number(c.lineDelayMs) || 0, Number(c.commandDelayMs) || 0);
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
  try {
    const bootstrapScript = buildBootstrapScript({
      targetDir,
      tmpB64Path: tempB64Path,
      overwritePolicy,
      diagLog,
    });
    const bootstrapEncoded = encodePowerShellEncodedCommandBase64(bootstrapScript);
    bootChunkCount = splitStringIntoChunks(bootstrapEncoded, 200).length;
  } catch {
    bootChunkCount = 0;
  }

  for (let i = 0; i < bootChunkCount; i += 1) {
    ms += lineCostMs(`bf_boot_append '${'x'.repeat(200)}'`, Number(c.lineDelayMs) || 0);
    ms += Math.max(0, Number(c.chunkDelayMs) || 0);
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

    for (let i = 0; i < chunks; i += 1) {
      ms += lineCostMs(`bf_tmp_append '${'x'.repeat(chunkChars)}'`, Number(c.lineDelayMs) || 0);
      ms += Math.max(0, Number(c.chunkDelayMs) || 0);
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
    stage: '준비',
    intervalId: null,
    initialEtaMs,
    lastEtaText: initialEtaMs ? formatDuration(initialEtaMs) : null,
    workTotalLines: Math.max(0, Number(workTotalLines) || 0),
    workDoneLines: 0,
  };

  if (els.startTimeTextFiles) els.startTimeTextFiles.textContent = formatWallClock(job.startedWallMs);
  if (els.fileCountTextFiles) els.fileCountTextFiles.textContent = `${fileCount}개`;
  if (els.totalBytesTextFiles) els.totalBytesTextFiles.textContent = `${formatBytes(job.totalBytes)} (${job.totalBytes} bytes)`;
  if (els.stageTextFiles) els.stageTextFiles.textContent = renderStageText();
  if (els.endTimeTextFiles) els.endTimeTextFiles.textContent = '-';
  if (els.estimateBasisTextFiles) {
    const dir = String(targetDir ?? '').trim();
    const os = String(targetSystem ?? 'windows');
    const cfg = cfgForEta;
    const tmp = String(tempB64Path ?? '').trim();
    els.estimateBasisTextFiles.textContent = `os=${os} / ${kind} / files=${fileCount} / bytes=${job.totalBytes} / dir=${dir || '-'} / tmp=${tmp || '-'} / chunk=${cfg.chunkChars}ch@${cfg.chunkDelayMs}ms / key=${cfg.keyDelayMs}ms / cmd=${cfg.commandDelayMs}ms / ow=${cfg.overwritePolicy}`;
  }

  stopJobMetricsTimer();
  job.intervalId = setInterval(() => {
    updateJobMetrics();
  }, 250);

  updateJobMetrics();
}

function finishJobMetrics() {
  if (!job) return;
  job.stage = '정리';
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
  if (els.btnPickFile) els.btnPickFile.textContent = kDefaultFileButtonText;
}

function resetFolderSelection() {
  if (els.folderInput) els.folderInput.value = '';
  if (els.btnPickFolder) els.btnPickFolder.textContent = kDefaultFolderButtonText;
}

function clearSelection() {
  selectedKind = null;
  selectedSummary = { title: '-', details: '' };
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
  selectedSummary = { title: '파일 1개', details: `${f.name} (${formatBytes(f.size)} / ${f.size} bytes)` };

  const label = shortLabel(f.name, 24);
  if (els.btnPickFile) els.btnPickFile.textContent = `파일 변경 (${label})`;

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
    selectedSummary = { title: '오류', details: '폴더 구조를 읽을 수 없습니다. Chrome/Edge에서 시도하세요.' };
    updateSelectionUi();
    if (!running) clearJobState();
    updateStartEnabled();
    return;
  }

  const differentRoot = paths.some((p) => (p.split('/')[0] || '') !== root);
  if (differentRoot) {
    selectedKind = null;
    selectedSummary = { title: '오류', details: '폴더 선택은 최상위 폴더 1개만 허용합니다.' };
    updateSelectionUi();
    if (!running) clearJobState();
    updateStartEnabled();
    return;
  }

  selectedKind = 'folder';
  const stats = computeSelectionStats();
  selectedSummary = {
    title: '폴더 1개',
    details: `${root} (files: ${files.length} / total: ${formatBytes(stats.totalBytes)} / max: ${formatBytes(stats.maxFileBytes)})`,
  };

  const label = shortLabel(root, 24);
  if (els.btnPickFolder) els.btnPickFolder.textContent = `폴더 변경 (${label})`;

  // mutually exclusive
  resetFileSelection();

  updateSelectionUi();
  if (!running) clearJobState();
  updateStartEnabled();
}

function computeStartReadiness() {
  const isConnected = Boolean(device?.gatt?.connected);
  if (!isConnected) return { ok: false, hint: '장치를 먼저 연결하세요.' };
  if (running) return { ok: false, hint: '' };

  const targetSystem = getSelectedTargetSystem();
  if (targetSystem !== 'windows') return { ok: false, hint: '현재는 Windows만 지원합니다.' };

  // Settings sanity checks (accuracy first)
  const cfg = getFilesSettingsFromUi();
  if (cfg.chunkChars < 200 || cfg.chunkChars > 4000) return { ok: false, hint: '청크 길이(Chars)는 200~4000 사이로 설정하세요.' };
  const dirValidity = getWindowsAbsolutePathValidity(els.targetDir?.value ?? '');
  if (!dirValidity.ok) return { ok: false, hint: `대상 디렉토리: INVALID (${dirValidity.reason})` };

  if (selectedKind == null) return { ok: false, hint: '파일 또는 폴더를 선택하세요.' };
  if (selectedSummary?.title === '오류') return { ok: false, hint: '선택 오류를 먼저 해결하세요.' };

  const stats = computeSelectionStats();
  if (stats.fileCount <= 0) return { ok: false, hint: '파일 또는 폴더를 선택하세요.' };
  if (stats.maxFileBytes > kMaxSingleFileBytes) {
    const label = stats.maxFileLabel ? ` (${stats.maxFileLabel})` : '';
    return {
      ok: false,
      hint: `단일 파일이 너무 큽니다${label}: ${formatBytes(stats.maxFileBytes)} / 제한 ${formatBytes(kMaxSingleFileBytes)}`,
    };
  }
  if (stats.totalBytes > kMaxTotalBytes) {
    return { ok: false, hint: `전체 용량이 너무 큽니다: ${formatBytes(stats.totalBytes)} / 제한 ${formatBytes(kMaxTotalBytes)}` };
  }

  return { ok: true, hint: '' };
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

function handleDisconnected() {
  setUiRunState({ isRunning: false, isPaused: false });
  setStatus('연결 끊김', 'BLE 연결이 끊어졌습니다. 다시 연결하세요.');
  device = null;
  server = null;
  flushChar = null;
  configChar = null;
  statusChar = null;
  macroChar = null;

  deviceBufCapacity = null;
  deviceBufFree = null;
  deviceBufUpdatedAt = 0;
  statusWaiters = [];

  stopRequested = false;
  updateStartEnabled();
}

async function connect() {
  if (!navigator.bluetooth) {
    throw new Error('이 브라우저는 Web Bluetooth를 지원하지 않습니다(Chrome/Edge 권장).');
  }

  setStatus('장치 선택 중...', 'BLE 장치 선택 팝업을 확인하세요.');

  const requestOptions = {
    filters: [{ services: [SERVICE_UUID] }, { namePrefix: 'ByteFlusher' }],
    optionalServices: [SERVICE_UUID],
  };

  const d = await navigator.bluetooth.requestDevice(requestOptions);
  d.addEventListener('gattserverdisconnected', handleDisconnected);

  setStatus('연결 중...', 'GATT 연결을 설정 중입니다.');
  const s = await d.gatt.connect();
  const service = await s.getPrimaryService(SERVICE_UUID);
  const fc = await service.getCharacteristic(FLUSH_TEXT_CHAR_UUID);
  const cc = await service.getCharacteristic(CONFIG_CHAR_UUID);
  const sc = await service.getCharacteristic(STATUS_CHAR_UUID);
  const mc = await service.getCharacteristic(MACRO_CHAR_UUID);

  // Flow control status notifications
  sc.addEventListener('characteristicvaluechanged', (ev) => {
    try {
      handleStatusValue(ev?.target?.value);
    } catch {
      // ignore
    }
  });
  try {
    await sc.startNotifications();
  } catch {
    // Some environments may fail notify; we still have read fallback.
  }

  device = d;
  server = s;
  flushChar = fc;
  configChar = cc;
  statusChar = sc;
  macroChar = mc;

  // Prime status values once.
  await readStatusOnce();

  setStatus('연결됨', `${d.name || 'ByteFlusher'} (files)`);
  setUiRunState({ isRunning: false, isPaused: false });
  updateStartEnabled();
}

async function disconnect() {
  if (!device?.gatt?.connected) return;
  setStatus('연결 해제 중...', '');
  try {
    device.gatt.disconnect();
  } catch {
    // ignore
  }
  handleDisconnected();
}

async function startRun() {
  if (!flushChar) {
    setStatus('오류', '먼저 장치를 연결하세요.');
    return;
  }

  const ready = computeStartReadiness();
  if (!ready.ok) {
    setStatus('준비 필요', ready.hint);
    return;
  }

  stopRequested = false;
  setUiRunState({ isRunning: true, isPaused: false });
  setStatus('실행 중', renderStageText());

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

  try {
    stagePrepare();

    if (!macroChar) {
      throw new Error('macro characteristic이 없습니다. (펌웨어 업데이트 필요)');
    }

    // Configure device delays for accuracy.
    const toggleKeyId = toggleKeyStringToId(getToggleKeySetting());
    await writeDeviceConfig({
      typingDelayMs: cfg.keyDelayMs,
      modeSwitchDelayMs: cfg.keyDelayMs,
      keyPressDelayMs: cfg.keyDelayMs,
      toggleKeyId,
      pausedFlag: false,
      abortFlag: false,
    });

    // Open PowerShell via Run dialog (Win+R) and wait for prompt.
    setStatus('실행 중', 'PowerShell 실행');
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

    // Extra settle time: the first few keystrokes are the most likely to drop
    // while the console window is still finishing focus / initialization.
    await sleep(Math.max(200, Math.min(2000, cfg.commandDelayMs)));
    const tx = createBleTextTx();

    // Warm up the console prompt: send a few empty lines first.
    // This helps when the first line tends to lose leading characters.
    const warmDelay = Math.max(cfg.lineDelayMs, cfg.commandDelayMs);
    for (let i = 0; i < 3; i += 1) {
      if (stopRequested) break;
      while (paused && !stopRequested) await sleep(120);
      if (stopRequested) break;
      await psLine(tx, '', { commandDelayMs: warmDelay });
    }
    if (stopRequested) throw new Error('사용자 중지');
    await psLine(tx, `Write-Host 'BF_READY_${runToken}'`, { commandDelayMs: cfg.commandDelayMs, guard: 'strong' });

    // Send the (potentially large) bootstrap encoded command in chunks, then execute via IEX.
    stageBootstrap();
    setStatus('실행 중', '부트스트랩 전송');

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
    if (stopRequested) throw new Error('사용자 중지');

    const bootstrapScript = buildBootstrapScript({
      targetDir: dir,
      tmpB64Path: tempB64Path,
      overwritePolicy: ow,
      diagLog: cfg.diagLog,
    });
    const bootstrapEncoded = encodePowerShellEncodedCommandBase64(bootstrapScript);
    // Keep each PowerShell line short to reduce keystroke drops.
    const bootChunks = splitStringIntoChunks(bootstrapEncoded, 200);
    for (let i = 0; i < bootChunks.length; i += 1) {
      if (stopRequested) break;
      while (paused && !stopRequested) await sleep(120);
      if (stopRequested) break;
      await psLine(tx, `bf_boot_append '${bootChunks[i]}'`, { commandDelayMs: cfg.lineDelayMs });
      if (cfg.chunkDelayMs > 0) await sleep(cfg.chunkDelayMs);
    }
    if (stopRequested) throw new Error('사용자 중지');
    await psLine(tx, 'bf_boot_run', { commandDelayMs: cfg.commandDelayMs, guard: 'strong' });
    bootstrapInstalled = true;
    if (cfg.bootstrapDelayMs > 0) await sleep(cfg.bootstrapDelayMs);

    const makeOutPath = (f) => {
      if (!f) return null;
      if (selectedKind === 'folder') {
        const rel = String(f.webkitRelativePath || f.name || '').replace(/\//g, '\\');
        return `${dir}\\${rel}`;
      }
      return `${dir}\\${String(f.name || 'payload.bin')}`;
    };

    setStatus('실행 중', `파일 ${files.length}개 처리`);
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
        setStatus('실행 중', `${processed}/${files.length} ${f.name || f.webkitRelativePath || ''}`);

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
      setStatus('중지됨', '사용자 중지');
    } else {
      // Success: remove work artifacts under targetDir\.tmp
      await psLine(tx, 'bf_finalize', { commandDelayMs: cfg.commandDelayMs });
      if (job && Number(job.workTotalLines) > 0) {
        job.workDoneLines = job.workTotalLines;
      }
      setStatus('완료', `완료: ${processed}/${files.length} 파일`);
    }
  } catch (err) {
    setStatus('오류', String(err?.message || err));
  } finally {
    setUiRunState({ isRunning: false, isPaused: false });
    finishJobMetrics();
    updateStartEnabled();
  }
}

function pauseRun() {
  if (!running) return;
  void (async () => {
    setUiRunState({ isRunning: true, isPaused: true });
    setStatus('일시정지', renderStageText());
    try {
      const cfg = getFilesSettingsFromUi();
      const toggleKeyId = toggleKeyStringToId(getToggleKeySetting());
      await writeDeviceConfig({
        typingDelayMs: cfg.keyDelayMs,
        modeSwitchDelayMs: cfg.keyDelayMs,
        keyPressDelayMs: cfg.keyDelayMs,
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
    setStatus('실행 중', renderStageText());
    try {
      const cfg = getFilesSettingsFromUi();
      const toggleKeyId = toggleKeyStringToId(getToggleKeySetting());
      await writeDeviceConfig({
        typingDelayMs: cfg.keyDelayMs,
        modeSwitchDelayMs: cfg.keyDelayMs,
        keyPressDelayMs: cfg.keyDelayMs,
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
        typingDelayMs: cfg.keyDelayMs,
        modeSwitchDelayMs: cfg.keyDelayMs,
        keyPressDelayMs: cfg.keyDelayMs,
        toggleKeyId,
        pausedFlag: false,
        abortFlag: true,
      });
    } catch {
      // ignore
    }
  })();
  setUiRunState({ isRunning: false, isPaused: false });
  setStatus('중지됨', '');
  stageCleanup();
  finishJobMetrics();
  updateStartEnabled();
}

function wireEvents() {
  if (els.btnConnect) {
    els.btnConnect.addEventListener('click', async () => {
      try {
        await connect();
      } catch (err) {
        setStatus('오류', String(err?.message || err));
        setUiConnected(false);
        updateStartEnabled();
      }
    });
  }

  if (els.btnDisconnect) {
    els.btnDisconnect.addEventListener('click', async () => {
      await disconnect();
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

  if (els.keyDelayMsFiles) els.keyDelayMsFiles.addEventListener('input', onSettingsChanged);
  if (els.lineDelayMsFiles) els.lineDelayMsFiles.addEventListener('input', onSettingsChanged);
  if (els.commandDelayMsFiles) els.commandDelayMsFiles.addEventListener('input', onSettingsChanged);
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

  if (els.btnStartFiles) els.btnStartFiles.addEventListener('click', startRun);
  if (els.btnPauseFiles) els.btnPauseFiles.addEventListener('click', pauseRun);
  if (els.btnResumeFiles) els.btnResumeFiles.addEventListener('click', resumeRun);
  if (els.btnStopFiles) els.btnStopFiles.addEventListener('click', stopRun);
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

  setStatus('연결 안 됨', '');
  setUiRunState({ isRunning: false, isPaused: false });
  clearJobMetrics();

  wireEvents();
  updateStartEnabled();
}

init();
