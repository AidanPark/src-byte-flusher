// ByteFlusher Web Bluetooth client (Text Flush only)
// - This file handles the "accurately type text" feature on web/text.html.
// - File/Folder Flush (base64/hash verification + PowerShell automation) is handled by web/files.js.
// Note: Web Bluetooth requires HTTPS or localhost.

import { initI18n, t, getLocale } from './i18n.js';

// BLE UUIDs must match firmware(src/main.cpp)
// 연결 방식은 기존(보안 서비스 UUID) 1개만 사용한다.
const SERVICE_UUID = 'f3641400-00b0-4240-ba50-05ca45bf8abc';
const FLUSH_TEXT_CHAR_UUID = 'f3641401-00b0-4240-ba50-05ca45bf8abc';
const CONFIG_CHAR_UUID = 'f3641402-00b0-4240-ba50-05ca45bf8abc';
const STATUS_CHAR_UUID = 'f3641403-00b0-4240-ba50-05ca45bf8abc';
const BOOTLOADER_CHAR_UUID = 'f3641405-00b0-4240-ba50-05ca45bf8abc';
const NICKNAME_CHAR_UUID = 'f3641406-00b0-4240-ba50-05ca45bf8abc';

// Flush Text 패킷 포맷(LE): [sessionId(2)][seq(2)][payload...]
const FLUSH_HEADER_SIZE = 4;

const LS_CHUNK_SIZE = 'byteflusher.chunkSize';
const LS_CHUNK_DELAY = 'byteflusher.chunkDelay';
const LS_RETRY_DELAY = 'byteflusher.retryDelay';
const LS_UNSUPPORTED_REPLACEMENT = 'byteflusher.unsupportedReplacement';
const LS_TYPING_DELAY_MS = 'byteflusher.typingDelayMs';
const LS_MODE_SWITCH_DELAY_MS = 'byteflusher.modeSwitchDelayMs';
const LS_KEY_PRESS_DELAY_MS = 'byteflusher.keyPressDelayMs';
const LS_TOGGLE_KEY = 'byteflusher.toggleKey';
const LS_IGNORE_LEADING_WHITESPACE = 'byteflusher.ignoreLeadingWhitespace';
const LS_DEVICE_NICKNAME = 'byteflusher.deviceNickname';

const DEFAULT_CHUNK_SIZE = 20;
const DEFAULT_CHUNK_DELAY = 30;
const DEFAULT_RETRY_DELAY = 300;
const DEFAULT_UNSUPPORTED_REPLACEMENT = '[?]';
const DEFAULT_TYPING_DELAY_MS = 30;
const DEFAULT_MODE_SWITCH_DELAY_MS = 100;
const DEFAULT_KEY_PRESS_DELAY_MS = 10;
const DEFAULT_TOGGLE_KEY = 'rightAlt';
const DEFAULT_IGNORE_LEADING_WHITESPACE = false;

const els = {
  btnConnect: document.getElementById('btnConnect'),
  btnDisconnect: document.getElementById('btnDisconnect'),
  btnBootloader: document.getElementById('btnBootloader'),
  btnStart: document.getElementById('btnStart'),
  btnPause: document.getElementById('btnPause'),
  btnResume: document.getElementById('btnResume'),
  btnStop: document.getElementById('btnStop'),
  statusText: document.getElementById('statusText'),
  detailsText: document.getElementById('detailsText'),
  startHintText: document.getElementById('startHintText'),
  startChecklistText: document.getElementById('startChecklistText'),
  deviceNickname: document.getElementById('deviceNickname'),
  btnApplyNickname: document.getElementById('btnApplyNickname'),
  textInput: document.getElementById('textInput'),
  chunkSize: document.getElementById('chunkSize'),
  chunkDelay: document.getElementById('chunkDelay'),
  retryDelay: document.getElementById('retryDelay'),
  unsupportedReplacement: document.getElementById('unsupportedReplacement'),
  ignoreLeadingWhitespace: document.getElementById('ignoreLeadingWhitespace'),
  btnResetSettings: document.getElementById('btnResetSettings'),
  typingDelayMs: document.getElementById('typingDelayMs'),
  toggleKey: document.getElementById('toggleKey'),
  modeSwitchDelayMs: document.getElementById('modeSwitchDelayMs'),
  keyPressDelayMs: document.getElementById('keyPressDelayMs'),
  btnApplyDeviceSettings: document.getElementById('btnApplyDeviceSettings'),
  textSettingsToast: document.getElementById('textSettingsToast'),
  settingsFieldset: document.getElementById('settingsFieldset'),
  deviceFieldset: document.getElementById('deviceFieldset'),
  etaText: document.getElementById('etaText'),
  startTimeText: document.getElementById('startTimeText'),
  elapsedText: document.getElementById('elapsedText'),
  progressText: document.getElementById('progressText'),
  endTimeText: document.getElementById('endTimeText'),
  estimateBasisText: document.getElementById('estimateBasisText'),
  totalBytesText: document.getElementById('totalBytesText'),
  stageText: document.getElementById('stageText'),
};

let textSettingsToastTimerId = null;

function showTextSettingsToast(text, ttlMs = 1000) {
  if (!els.textSettingsToast) return;
  if (textSettingsToastTimerId) {
    clearTimeout(textSettingsToastTimerId);
    textSettingsToastTimerId = null;
  }
  els.textSettingsToast.textContent = String(text ?? '').trim();
  textSettingsToastTimerId = setTimeout(() => {
    if (els.textSettingsToast) els.textSettingsToast.textContent = '';
    textSettingsToastTimerId = null;
  }, Math.max(200, Number(ttlMs) || 1000));
}

let device = null;
let server = null;
let flushChar = null;
let configChar = null;
let statusChar = null;
let bootloaderChar = null;
let nicknameChar = null;

let deviceBufCapacity = null;
let deviceBufFree = null;
let deviceBufUpdatedAt = 0;
let statusWaiters = [];

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

function sanitizeNickname(raw) {
  const s = String(raw ?? '').trim();
  return s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12);
}

function loadSavedNickname() {
  return sanitizeNickname(localStorage.getItem(LS_DEVICE_NICKNAME) || '');
}

function saveNicknameToLocalStorage(v) {
  const s = sanitizeNickname(v);
  if (s) localStorage.setItem(LS_DEVICE_NICKNAME, s);
  else localStorage.removeItem(LS_DEVICE_NICKNAME);
}

function setNicknameUiValue(v) {
  if (!els.deviceNickname) return;
  els.deviceNickname.value = sanitizeNickname(v);
}

async function readDeviceNicknameOnce() {
  if (!nicknameChar) return '';
  try {
    const v = await nicknameChar.readValue();
    const u8 = new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
    const s = new TextDecoder().decode(u8);
    return sanitizeNickname(s);
  } catch {
    return '';
  }
}

async function writeDeviceNickname(nickname) {
  if (!nicknameChar) {
    setStatus(t('status.error'), t('error.noNicknameChar'));
    return;
  }

  const raw = String(nickname ?? '').trim();
  const s = sanitizeNickname(raw);
  if (raw && !s) {
    setStatus(t('status.error'), t('error.nicknameInvalid'));
    return;
  }
  try {
    if (!s) {
      await nicknameChar.writeValue(Uint8Array.of(0));
    } else {
      await nicknameChar.writeValue(new TextEncoder().encode(s));
    }
    saveNicknameToLocalStorage(s);
    setNicknameUiValue(s);
    setStatus(t('status.connected'), t('status.nicknameSaved', { name: s || '-' }));
  } catch (err) {
    const msg = err?.message ?? String(err ?? '');
    setStatus(t('status.error'), t('status.nicknameSaveFailed', { msg }));
  }
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

    // notify가 누락될 수 있으니, 주기적으로 read로 폴백한다.
    const now = performance.now();
    if (!Number.isFinite(deviceBufUpdatedAt) || now - deviceBufUpdatedAt > 800) {
      await readStatusOnce();
    }

    // 너무 오래 기다리면 UX가 이상해지므로 가벼운 타임아웃 이후에도 계속 폴링/대기.
    const waitedMs = now - startedAt;
    const stepMs = waitedMs < 2000 ? 120 : 200;
    await waitForStatusUpdate(stepMs);
  }
}

let flushInProgress = false;
let stopRequested = false;
let paused = false;
let pauseStatusShown = false;

let job = null;

// 두벌식 매핑(펌웨어 src/main.cpp와 동일한 문자열 테이블)
const K_CHO_DATA = [
  'r', 'R', 's', 'e', 'E', 'f', 'a', 'q', 'Q', 't', 'T', 'd', 'w', 'W', 'c', 'z', 'x', 'v', 'g',
];
const K_JUNG_DATA = [
  'k', 'o', 'i', 'O', 'j', 'p', 'u', 'P', 'h', 'hk', 'ho', 'hl', 'y', 'n', 'nj', 'np', 'nl', 'b', 'm', 'ml', 'l',
];
const K_JONG_DATA = [
  '', 'r', 'R', 'rt', 's', 'sw', 'sg', 'e', 'f', 'fr', 'fa', 'fq', 'ft', 'fx', 'fv', 'fg', 'a', 'q', 'qt', 't', 'T', 'd', 'w', 'c', 'z', 'x', 'v', 'g',
];

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

function formatMinutes(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  return (ms / 60000).toFixed(1);
}

function normalizeForEstimate(text) {
  return (text ?? '').toString().replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function estimateKeystrokesAndSwitches(text) {
  const normalized = normalizeForEstimate(text);
  let isKorean = false;
  let keystrokes = 0;
  let modeSwitches = 0;

  for (const ch of normalized) {
    const cp = ch.codePointAt(0);
    if (cp == null) continue;

    if (cp <= 0x7f) {
      if (isKorean) {
        modeSwitches += 1;
        isKorean = false;
      }
      keystrokes += 1;
      continue;
    }

    if (cp >= 0xac00 && cp <= 0xd7a3) {
      if (!isKorean) {
        modeSwitches += 1;
        isKorean = true;
      }

      const code = cp - 0xac00;
      const cho = Math.floor(code / (21 * 28));
      const jung = Math.floor((code % (21 * 28)) / 28);
      const jong = code % 28;

      keystrokes += (K_CHO_DATA[cho]?.length ?? 0);
      keystrokes += (K_JUNG_DATA[jung]?.length ?? 0);
      if (jong > 0) keystrokes += (K_JONG_DATA[jong]?.length ?? 0);
      continue;
    }

    // 기타 유니코드: 펌웨어 정책대로 '?' 1회로 추정
    if (isKorean) {
      modeSwitches += 1;
      isKorean = false;
    }
    keystrokes += 1;
  }

  return { keystrokes, modeSwitches, normalizedLength: normalized.length };
}

function computeEstimateMs({
  text,
  totalBytes,
  chunkSize,
  chunkDelayMs,
  typingDelayMs,
  modeSwitchDelayMs,
  keyPressDelayMs,
}) {
  const { keystrokes, modeSwitches } = estimateKeystrokesAndSwitches(text);

  const perKeyMs = typingDelayMs + 2 * keyPressDelayMs;
  const perSwitchMs = modeSwitchDelayMs + 2 * keyPressDelayMs;
  const deviceMs = keystrokes * perKeyMs + modeSwitches * perSwitchMs;

  const chunks = totalBytes > 0 ? Math.ceil(totalBytes / chunkSize) : 0;
  const txMs = chunks > 1 ? (chunks - 1) * chunkDelayMs : 0;

  return {
    estimatedMs: Math.max(deviceMs, txMs),
    deviceMs,
    txMs,
    chunks,
    keystrokes,
    modeSwitches,
  };
}

function clearJobMetrics() {
  if (els.etaText) els.etaText.textContent = '-';
  if (els.startTimeText) els.startTimeText.textContent = '-';
  if (els.totalBytesText) els.totalBytesText.textContent = '-';
  if (els.stageText) els.stageText.textContent = '-';
  if (els.elapsedText) els.elapsedText.textContent = '-';
  if (els.progressText) els.progressText.textContent = '-';
  if (els.endTimeText) els.endTimeText.textContent = '-';
  if (els.estimateBasisText) els.estimateBasisText.textContent = '-';
}

function setStartHint(text) {
  if (!els.startHintText) return;
  els.startHintText.textContent = String(text ?? '');
}

function setStartChecklist(text) {
  if (!els.startChecklistText) return;
  els.startChecklistText.textContent = String(text ?? '');
}

function updateStartEnabled() {
  // Match Files page UX: show hint + checklist even before connection.
  const isConnected = Boolean(device?.gatt?.connected);
  const isRunning = Boolean(flushInProgress);

  const rawText = els.textInput?.value ?? '';
  const pre = preprocessTextForFirmware(rawText);
  const bytes = new TextEncoder().encode(pre.text);
  const hasText = bytes.length > 0;

  const ok = isConnected && !isRunning && hasText;
  if (els.btnStart) els.btnStart.disabled = !ok;

  let hint = '';
  if (!isConnected) hint = t('text.connectFirst');
  else if (!hasText) hint = t('text.enterText');
  setStartHint(hint);

  const statusReason = ok ? '' : ` (${!isConnected ? t('text.needConnection') : t('text.needText')})`;
  const checklist = [
    `${isConnected ? '[OK]' : '[ ]'} ${isConnected ? t('text.checkDeviceConnected') : t('text.checkDeviceNeeded')}`,
    `${hasText ? '[OK]' : '[ ]'} ${hasText ? t('text.checkSourceEntered') : t('text.checkSourceNeeded')}`,
    `${ok ? '[OK]' : '[ ]'} ${ok ? t('text.checkReady') : t('text.checkNotReady', { reason: statusReason })}`,
  ].join('\n');
  setStartChecklist(checklist);
}

function updatePreStartMetrics() {
  // Policy: when input changes, show a fresh estimate basis and reset other metrics.
  // Do not override metrics during an active flush.
  if (flushInProgress) return;

  // Clear any previous job state so metrics don't look like they belong to the last run.
  if (job?.intervalId) {
    try {
      clearInterval(job.intervalId);
    } catch {
      // ignore
    }
  }
  job = null;

  const rawText = els.textInput?.value ?? '';
  const pre = preprocessTextForFirmware(rawText);
  const bytes = new TextEncoder().encode(pre.text);

  const chunkSize = clampNumber(els.chunkSize?.value, 1, 200, DEFAULT_CHUNK_SIZE);
  const chunkDelayMs = clampNumber(els.chunkDelay?.value, 0, 200, DEFAULT_CHUNK_DELAY);
  const timing = getDeviceTimingSettings();
  const toggleKey = getToggleKeySetting();

  const est = computeEstimateMs({
    text: pre.text,
    totalBytes: bytes.length,
    chunkSize,
    chunkDelayMs,
    typingDelayMs: timing.typingDelayMs,
    modeSwitchDelayMs: timing.modeSwitchDelayMs,
    keyPressDelayMs: timing.keyPressDelayMs,
  });

  // Reset runtime-only metrics.
  if (els.startTimeText) els.startTimeText.textContent = '-';
  if (els.totalBytesText) els.totalBytesText.textContent = bytes.length > 0 ? `${bytes.length} bytes` : '-';
  if (els.stageText) els.stageText.textContent = '-';
  if (els.elapsedText) els.elapsedText.textContent = '-';
  if (els.progressText) els.progressText.textContent = '-';
  if (els.endTimeText) els.endTimeText.textContent = '-';

  // Preview-only metrics.
  if (els.etaText) {
    els.etaText.textContent = bytes.length > 0 ? t('metric.totalMinutes', { min: formatMinutes(est.estimatedMs) }) : '-';
  }
  if (els.estimateBasisText) {
    const replacedNote = pre.replacedCount > 0 ? ` / ${t('text.replacedNote', { count: pre.replacedCount, replacement: pre.replacement })}` : '';
    els.estimateBasisText.textContent = `preview / ${bytes.length} bytes / ${est.keystrokes} keys, switch ${est.modeSwitches}${replacedNote} / chunk=${chunkSize}, delay=${chunkDelayMs}ms / typing=${timing.typingDelayMs}ms, mode=${timing.modeSwitchDelayMs}ms, key=${timing.keyPressDelayMs}ms / toggle=${toggleKey}`;
  }

  updateStartEnabled();
}

function startJobMetrics({
  rawText,
  preprocessedText,
  totalBytes,
  chunkSize,
  chunkDelayMs,
  typingDelayMs,
  modeSwitchDelayMs,
  keyPressDelayMs,
  toggleKey,
}) {
  const nowWall = Date.now();
  const nowPerf = performance.now();

  const est = computeEstimateMs({
    text: preprocessedText,
    totalBytes,
    chunkSize,
    chunkDelayMs,
    typingDelayMs,
    modeSwitchDelayMs,
    keyPressDelayMs,
  });

  job = {
    startedWallMs: nowWall,
    startedPerfMs: nowPerf,
    pausedAccumMs: 0,
    pausedStartPerfMs: null,
    endedWallMs: null,
    totalBytes,
    sentBytes: 0,
    estimatedMs: est.estimatedMs,
    deviceMs: est.deviceMs,
    txMs: est.txMs,
    chunks: est.chunks,
    chunkSize,
    chunkDelayMs,
    typingDelayMs,
    modeSwitchDelayMs,
    keyPressDelayMs,
    keystrokes: est.keystrokes,
    modeSwitches: est.modeSwitches,
    intervalId: null,
    rawTextLength: (rawText ?? '').toString().length,
  };

  if (els.startTimeText) els.startTimeText.textContent = formatWallClock(job.startedWallMs);
  if (els.endTimeText) els.endTimeText.textContent = '-';

  if (els.estimateBasisText) {
    els.estimateBasisText.textContent = `${job.totalBytes} bytes / ${job.keystrokes} keys, switch ${job.modeSwitches} / chunk=${job.chunkSize}, delay=${job.chunkDelayMs}ms / typing=${job.typingDelayMs}ms, mode=${job.modeSwitchDelayMs}ms, key=${job.keyPressDelayMs}ms / toggle=${toggleKey}`;
  }

  if (job.intervalId) {
    clearInterval(job.intervalId);
  }

  job.intervalId = setInterval(() => {
    updateJobMetrics();
  }, 250);

  updateJobMetrics();
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

function setJobProgress(sentBytes) {
  if (!job) return;
  job.sentBytes = Math.max(0, Math.min(job.totalBytes, sentBytes));
}

function finishJobMetrics() {
  if (!job) return;
  if (job.endedWallMs == null) {
    job.endedWallMs = Date.now();
  }
  if (job.intervalId) {
    clearInterval(job.intervalId);
    job.intervalId = null;
  }
  if (els.endTimeText) els.endTimeText.textContent = formatWallClock(job.endedWallMs);
  updateJobMetrics();
}

function updateJobMetrics() {
  if (!job) {
    clearJobMetrics();
    return;
  }

  const nowWall = job.endedWallMs ?? Date.now();
  const elapsedWallMs = nowWall - job.startedWallMs;

  const currentPausedMs = job.pausedStartPerfMs != null ? (performance.now() - job.pausedStartPerfMs) : 0;
  const pausedTotalMs = job.pausedAccumMs + currentPausedMs;

  if (els.elapsedText) els.elapsedText.textContent = formatDuration(elapsedWallMs);

  if (els.totalBytesText) {
    const total = Math.max(0, Number(job.totalBytes) || 0);
    const sent = Math.max(0, Math.min(total, Number(job.sentBytes) || 0));
    els.totalBytesText.textContent = total > 0 ? `${sent}/${total} bytes` : '-';
  }

  const byteRatio = job.totalBytes > 0 ? Math.max(0, Math.min(1, job.sentBytes / job.totalBytes)) : 0;
  const totalKeys = Math.max(0, Number(job.keystrokes) || 0);
  const sentKeys = totalKeys > 0 ? Math.min(totalKeys, Math.round(totalKeys * byteRatio)) : 0;
  const pctKeys = totalKeys > 0 ? (sentKeys / totalKeys) * 100 : 0;

  if (els.progressText) {
    els.progressText.textContent = t('metric.keysProgress', { pct: pctKeys.toFixed(1), sent: sentKeys, total: totalKeys });
  }

  if (els.etaText) {
    // '예상'은 시간(분) 기준으로 표시한다.
    const nowPerf = job.endedWallMs != null ? null : performance.now();
    const activeElapsedMs = nowPerf != null ? Math.max(0, nowPerf - job.startedPerfMs - pausedTotalMs) : null;
    const remainingMs = activeElapsedMs != null ? Math.max(0, job.estimatedMs - activeElapsedMs) : 0;
    els.etaText.textContent = t('metric.totalMinutesRemaining', { total: formatMinutes(job.estimatedMs), remaining: formatMinutes(remainingMs) });
  }
}

function setStatus(text, details = '') {
  els.statusText.textContent = text;
  els.detailsText.textContent = details;

  // Files page shows current stage in the main panel; mirror that for Text runs.
  if (els.stageText && flushInProgress) {
    els.stageText.textContent = String(text ?? '-') || '-';
  }
}

function setUiConnected(connected) {
  els.btnConnect.disabled = connected;
  els.btnDisconnect.disabled = !connected;
  if (els.btnBootloader) els.btnBootloader.disabled = !connected || !bootloaderChar;
  if (els.btnApplyNickname) els.btnApplyNickname.disabled = !connected || !nicknameChar;
  if (els.btnPause) els.btnPause.disabled = true;
  if (els.btnResume) els.btnResume.disabled = true;
  if (els.btnApplyDeviceSettings) {
    els.btnApplyDeviceSettings.disabled = !connected;
  }
  if (!connected) {
    els.btnStop.disabled = true;
  }

  updateStartEnabled();
}

function setUiRunState({ running, paused: isPaused }) {
  flushInProgress = running;

  if (els.settingsFieldset) {
    // Start 이후 Stop 전까지는 모든 설정을 잠근다.
    els.settingsFieldset.disabled = running;
  }
  if (els.deviceFieldset) {
    els.deviceFieldset.disabled = running;
  }

  setJobPaused(isPaused);

  const isConnected = Boolean(device?.gatt?.connected);
  els.btnConnect.disabled = running || isConnected;
  els.btnDisconnect.disabled = running ? true : !isConnected;
  if (els.btnBootloader) els.btnBootloader.disabled = running || !isConnected || !bootloaderChar;

  if (els.btnPause) els.btnPause.disabled = !running || !isConnected || isPaused;
  if (els.btnResume) els.btnResume.disabled = !running || !isConnected || !isPaused;
  els.btnStop.disabled = !running;

  if (els.btnApplyDeviceSettings) {
    els.btnApplyDeviceSettings.disabled = running || !isConnected;
  }

  updateStartEnabled();
}

async function waitWhilePaused(offset, total) {
  while (paused && !stopRequested) {
    if (!pauseStatusShown) {
      pauseStatusShown = true;
      setStatus(t('status.paused'), `${offset}/${total} bytes`);
    }
    await sleep(120);
  }
  pauseStatusShown = false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function loadNumberSetting(key, fallback) {
  const raw = localStorage.getItem(key);
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function saveNumberSetting(key, value) {
  localStorage.setItem(key, String(value));
}

function getUnsupportedReplacement() {
  const raw = (els.unsupportedReplacement?.value ?? '').toString();
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_UNSUPPORTED_REPLACEMENT;
  return trimmed.slice(0, 16);
}

function setUnsupportedReplacement(value) {
  if (!els.unsupportedReplacement) return;
  const v = (value ?? '').toString();
  els.unsupportedReplacement.value = v || DEFAULT_UNSUPPORTED_REPLACEMENT;
}

function isSupportedCodePoint(cp) {
  // 펌웨어 지원 범위: ASCII + 한글 음절(가~힣)
  if (cp <= 0x7f) return true;
  if (cp >= 0xac00 && cp <= 0xd7a3) return true;
  return false;
}

function loadBoolSetting(key, fallback) {
  const raw = localStorage.getItem(key);
  if (raw == null) return fallback;
  return raw === '1' || raw === 'true';
}

function saveBoolSetting(key, value) {
  localStorage.setItem(key, value ? '1' : '0');
}

function getIgnoreLeadingWhitespaceSetting() {
  return Boolean(els.ignoreLeadingWhitespace?.checked);
}

function preprocessTextForFirmware(input) {
  const replacement = getUnsupportedReplacement();
  let replacedCount = 0;
  let normalized = (input ?? '').toString();
  if (getIgnoreLeadingWhitespaceSetting()) {
    normalized = normalized.replace(/^[\t ]+/gm, '');
  }
  let out = '';

  for (const ch of normalized) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isSupportedCodePoint(cp)) {
      out += ch;
    } else {
      out += replacement;
      replacedCount += 1;
    }
  }

  return { text: out, replacedCount, replacement };
}

function getConnectFailureHelpText(err) {
  const name = (err?.name ?? '').toString();
  const msg = (err?.message ?? String(err ?? '')).toString();

  if (/No\s+Characteristics\s+matching\s+UUID/i.test(msg) || /No\s+Services\s+matching\s+UUID/i.test(msg)) {
    return t('error.gattNotFound');
  }

  if (name === 'NotSupportedError') {
    return t('error.notSupported');
  }

  if (name === 'NotAllowedError') {
    return t('error.notAllowed');
  }

  return t('error.connectFailed', { msg });
}

async function connect() {
  if (!navigator.bluetooth) {
    throw new Error(t('error.noWebBluetooth'));
  }

  setStatus(t('status.selectingDevice'), t('status.selectDevicePopup'));

  const requestOptions = {
    // 동일한 BLE 장치가 많이 잡히는 환경에서 선택을 쉽게 한다.
    // - 펌웨어는 "ByteFlusher-XXXX" 형태로 광고 이름을 내보낸다.
    // - 서비스 UUID 필터로 다른 장치를 최대한 숨긴다.
    filters: [{ services: [SERVICE_UUID] }, { namePrefix: 'ByteFlusher' }],
    optionalServices: [SERVICE_UUID],
  };

  try {
    device = await navigator.bluetooth.requestDevice(requestOptions);
  } catch (err) {
    // 사용자가 취소한 경우 등은 조용히 기존 상태를 유지한다.
    const name = (err?.name ?? '').toString();
    if (name === 'NotFoundError') {
      setStatus(t('status.disconnected'), '');
      setUiConnected(false);
      return;
    }
    throw err;
  }

  device.addEventListener('gattserverdisconnected', () => {
    if (flushInProgress && !stopRequested) {
      if (paused) {
        setStatus(t('status.connectionLost'), t('status.connectionLostWhilePaused'));
      } else {
        setStatus(t('status.connectionLost'), t('status.connectionLostWhileTransfer'));
      }
    } else {
      setStatus(t('status.disconnected'), '');
    }
    setUiConnected(false);
    server = null;
    flushChar = null;
    configChar = null;
    statusChar = null;
    bootloaderChar = null;
    nicknameChar = null;
    deviceBufCapacity = null;
    deviceBufFree = null;
    deviceBufUpdatedAt = 0;
    resolveStatusWaiters();
  });

  setStatus(t('status.connecting'), device.name ?? '');
  let service = null;
  try {
    server = await device.gatt.connect();

    service = await server.getPrimaryService(SERVICE_UUID);
    flushChar = await service.getCharacteristic(FLUSH_TEXT_CHAR_UUID);
  } catch (err) {
    setStatus(t('status.connectionFailed'), getConnectFailureHelpText(err));
    setUiConnected(false);
    updateStartEnabled();
    return;
  }
  try {
    configChar = await service.getCharacteristic(CONFIG_CHAR_UUID);
  } catch {
    configChar = null;
  }

  try {
    statusChar = await service.getCharacteristic(STATUS_CHAR_UUID);
    statusChar.addEventListener('characteristicvaluechanged', (ev) => {
      handleStatusValue(ev?.target?.value);
    });
    await statusChar.startNotifications();
    await readStatusOnce();
  } catch {
    statusChar = null;
  }

  try {
    bootloaderChar = await service.getCharacteristic(BOOTLOADER_CHAR_UUID);
  } catch {
    bootloaderChar = null;
  }

  try {
    nicknameChar = await service.getCharacteristic(NICKNAME_CHAR_UUID);
  } catch {
    nicknameChar = null;
  }

  if (els.deviceNickname) {
    const deviceNick = await readDeviceNicknameOnce();
    const fallback = loadSavedNickname();
    setNicknameUiValue(deviceNick || fallback);
  }

  setStatus(t('status.connected'), `${device.name ?? 'ByteFlusher'} / ${SERVICE_UUID}`);
  setUiConnected(true);
}

async function reconnectLoop() {
  if (!device) {
    throw new Error(t('error.noDevice'));
  }

  let attempt = 0;
  while (!stopRequested) {
    attempt += 1;
    try {
      setStatus(t('status.reconnecting'), t('status.attempt', { n: attempt }));

      if (!device.gatt.connected) {
        server = await device.gatt.connect();
      } else {
        server = device.gatt;
      }

      const service = await server.getPrimaryService(SERVICE_UUID);
      flushChar = await service.getCharacteristic(FLUSH_TEXT_CHAR_UUID);
      try {
        configChar = await service.getCharacteristic(CONFIG_CHAR_UUID);
      } catch {
        configChar = null;
      }

      try {
        statusChar = await service.getCharacteristic(STATUS_CHAR_UUID);
        statusChar.addEventListener('characteristicvaluechanged', (ev) => {
          handleStatusValue(ev?.target?.value);
        });
        await statusChar.startNotifications();
        await readStatusOnce();
      } catch {
        statusChar = null;
      }

      try {
        bootloaderChar = await service.getCharacteristic(BOOTLOADER_CHAR_UUID);
      } catch {
        bootloaderChar = null;
      }

      try {
        nicknameChar = await service.getCharacteristic(NICKNAME_CHAR_UUID);
      } catch {
        nicknameChar = null;
      }

      if (els.deviceNickname) {
        const deviceNick = await readDeviceNicknameOnce();
        const fallback = loadSavedNickname();
        setNicknameUiValue(deviceNick || fallback);
      }

      setStatus(t('status.reconnectSuccess'), `${device.name ?? 'BLE Device'}`);
      setUiConnected(true);
      return;
    } catch (err) {
      const msg = err?.message ?? String(err);
      setStatus(t('status.reconnectFailed'), `${t('status.attempt', { n: attempt })}: ${msg}`);
      const backoffMs = Math.min(5000, 250 + attempt * 250);
      await sleep(backoffMs);
    }
  }
}

async function requestBootloader() {
  if (!bootloaderChar) {
    setStatus(t('status.error'), t('error.noBootloaderChar'));
    return;
  }
  if (flushInProgress) {
    setStatus(t('status.error'), t('error.bootloaderDuringTransfer'));
    return;
  }

  const ok = confirm(t('confirm.bootloader'));
  if (!ok) return;

  setStatus(t('status.rebootRequesting'), t('status.rebootEntering'));
  try {
    await bootloaderChar.writeValue(Uint8Array.of(1));
  } catch (err) {
    setStatus(t('status.failed'), t('error.bootloaderRequestFailed', { msg: String(err?.message ?? err ?? '') }));
  }
}

function getDeviceTimingSettings() {
  const typingDelayMs = clampNumber(els.typingDelayMs?.value, 0, 1000, DEFAULT_TYPING_DELAY_MS);
  const modeSwitchDelayMs = clampNumber(els.modeSwitchDelayMs?.value, 0, 3000, DEFAULT_MODE_SWITCH_DELAY_MS);
  const keyPressDelayMs = clampNumber(els.keyPressDelayMs?.value, 0, 300, DEFAULT_KEY_PRESS_DELAY_MS);
  return { typingDelayMs, modeSwitchDelayMs, keyPressDelayMs };
}

function getToggleKeySetting() {
  const v = (els.toggleKey?.value ?? DEFAULT_TOGGLE_KEY).toString();
  const allowed = new Set(['rightAlt', 'capsLock', 'leftAlt', 'rightCtrl', 'leftCtrl', 'rightGui', 'leftGui']);
  return allowed.has(v) ? v : DEFAULT_TOGGLE_KEY;
}

function setToggleKeySetting(value) {
  if (!els.toggleKey) return;
  const allowed = new Set(['rightAlt', 'capsLock', 'leftAlt', 'rightCtrl', 'leftCtrl', 'rightGui', 'leftGui']);
  const v = (value ?? '').toString();
  els.toggleKey.value = allowed.has(v) ? v : DEFAULT_TOGGLE_KEY;
}

function toggleKeyToByte(v) {
  switch (v) {
    case 'rightAlt':
      return 0;
    case 'capsLock':
      return 6;
    case 'leftAlt':
      return 1;
    case 'rightCtrl':
      return 2;
    case 'leftCtrl':
      return 3;
    case 'rightGui':
      return 4;
    case 'leftGui':
      return 5;
    default:
      return 0;
  }
}

function buildDeviceConfigPayload({ typingDelayMs, modeSwitchDelayMs, keyPressDelayMs, toggleKey }) {
  // LE u16 * 3 + u8 + u8:
  // [typingDelayMs][modeSwitchDelayMs][keyPressDelayMs][toggleKey][flags]
  // toggleKey: 0=RAlt,1=LAlt,2=RCtrl,3=LCtrl,4=RGui,5=LGui,6=CapsLock
  // flags(bit0): paused
  const buf = new Uint8Array(8);
  buf[0] = typingDelayMs & 0xff;
  buf[1] = (typingDelayMs >> 8) & 0xff;
  buf[2] = modeSwitchDelayMs & 0xff;
  buf[3] = (modeSwitchDelayMs >> 8) & 0xff;
  buf[4] = keyPressDelayMs & 0xff;
  buf[5] = (keyPressDelayMs >> 8) & 0xff;
  buf[6] = toggleKeyToByte(toggleKey);
  buf[7] = 0;
  return buf;
}

async function setDevicePaused(pausedState) {
  if (!device?.gatt?.connected) {
    return;
  }
  if (!configChar) {
    // 구버전 펌웨어(또는 config char 없음)에서는 장치 pause를 지원하지 않는다.
    return;
  }

  const timing = getDeviceTimingSettings();
  const toggleKey = getToggleKeySetting();
  const payload = buildDeviceConfigPayload({ ...timing, toggleKey });
  payload[7] = pausedState ? 1 : 0;
  await configChar.writeValue(payload);
}

async function abortDeviceQueueNow() {
  if (!device?.gatt?.connected) {
    return;
  }
  if (!configChar) {
    return;
  }

  const timing = getDeviceTimingSettings();
  const toggleKey = getToggleKeySetting();
  const payload = buildDeviceConfigPayload({ ...timing, toggleKey });
  // flags: bit1 abort(즉시 폐기)
  payload[7] = 0x02;
  await configChar.writeValue(payload);
}

async function applyDeviceSettings() {
  if (!device?.gatt?.connected) {
    throw new Error(t('error.bleNotConnected'));
  }
  if (!configChar) {
    throw new Error(t('error.noConfigChar'));
  }

  const timing = getDeviceTimingSettings();
  const toggleKey = getToggleKeySetting();
  const payload = buildDeviceConfigPayload({ ...timing, toggleKey });

  // pause 상태에서 설정을 적용해도, pause가 풀려버리면 안 된다.
  payload[7] = paused ? 1 : 0;

  setStatus(t('status.applyingSettings'), `typing=${timing.typingDelayMs}ms, modeSwitch=${timing.modeSwitchDelayMs}ms, keyPress=${timing.keyPressDelayMs}ms, toggle=${toggleKey}`);
  await configChar.writeValue(payload);
  setStatus(t('status.settingsApplied'), `typing=${timing.typingDelayMs}ms, modeSwitch=${timing.modeSwitchDelayMs}ms, keyPress=${timing.keyPressDelayMs}ms, toggle=${toggleKey}`);
}

async function disconnect() {
  stopRequested = true;
  paused = false;
  pauseStatusShown = false;
  setUiRunState({ running: false, paused: false });
  setStatus(t('status.disconnecting'), '');
  if (device?.gatt?.connected) {
    device.gatt.disconnect();
  }
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
  const packet = new Uint8Array(FLUSH_HEADER_SIZE + payload.length);
  packet[0] = sessionId & 0xff;
  packet[1] = (sessionId >> 8) & 0xff;
  packet[2] = seq & 0xff;
  packet[3] = (seq >> 8) & 0xff;
  packet.set(payload, FLUSH_HEADER_SIZE);
  return packet;
}

async function flushText() {
  if (!flushChar) {
    throw new Error(t('error.noFlushChar'));
  }

  const rawText = els.textInput.value ?? '';
  const pre = preprocessTextForFirmware(rawText);
  const bytes = new TextEncoder().encode(pre.text);
      setStatus(t('status.connected'), `${device.name ?? 'ByteFlusher'} / ${SERVICE_UUID}`);
  // NOTE: UI에서 설정은 Start~Stop 동안 잠긴다.
  const initialChunkSize = clampNumber(els.chunkSize.value, 1, 200, DEFAULT_CHUNK_SIZE);
  const initialDelayMs = clampNumber(els.chunkDelay.value, 0, 200, DEFAULT_CHUNK_DELAY);
  const initialRetryDelayMs = clampNumber(els.retryDelay?.value, 0, 5000, DEFAULT_RETRY_DELAY);

  const timing = getDeviceTimingSettings();
  const toggleKey = getToggleKeySetting();
  startJobMetrics({
    rawText,
    preprocessedText: pre.text,
    totalBytes: bytes.length,
    chunkSize: initialChunkSize,
    chunkDelayMs: initialDelayMs,
    typingDelayMs: timing.typingDelayMs,
    modeSwitchDelayMs: timing.modeSwitchDelayMs,
    keyPressDelayMs: timing.keyPressDelayMs,
    toggleKey,
  });

  stopRequested = false;
  paused = false;
  pauseStatusShown = false;
  setUiRunState({ running: true, paused: false });

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

  const sessionId = makeSessionId16();
  let seq = 0;
  let offset = 0;

  const replacedNote = pre.replacedCount > 0 ? ` / ${t('text.replacedNote', { count: pre.replacedCount, replacement: pre.replacement })}` : '';
  setStatus(t('status.transferStart'), `${bytes.length} bytes / chunk=${initialChunkSize}, delay=${initialDelayMs}ms / session=${sessionId}${replacedNote}`);

  // 속도보다 안정성 우선: 전송 시작 전에 현재 장치 타이밍 설정을 한 번 적용한다.
  // (configChar가 없으면 무시하고 계속 진행)
  try {
    if (configChar) {
      await configChar.writeValue(buildDeviceConfigPayload({ ...timing, toggleKey }));
    }
  } catch {
    // 설정 적용 실패는 전송 자체를 막지 않는다.
  }

  while (offset < bytes.length) {
    if (stopRequested) {
      setStatus(t('status.stopped'), `${offset}/${bytes.length} bytes`);
      setUiRunState({ running: false, paused: false });
      setJobProgress(offset);
      finishJobMetrics();
      return;
    }

    if (paused) {
      await waitWhilePaused(offset, bytes.length);
      continue;
    }

    if (!device?.gatt?.connected || !flushChar) {
      setStatus(t('status.connectionLost'), t('status.connectionLostWhileTransfer'));
      await reconnectLoop();
      continue;
    }

    const chunkSize = clampNumber(els.chunkSize.value, 1, 200, DEFAULT_CHUNK_SIZE);
    const delayMs = clampNumber(els.chunkDelay.value, 0, 200, DEFAULT_CHUNK_DELAY);
    const retryDelayMs = clampNumber(els.retryDelay?.value, 0, 5000, DEFAULT_RETRY_DELAY);

    const chunk = bytes.slice(offset, offset + chunkSize);
    const maxBacklogBytes = Math.max(32, chunkSize);
    await waitForDeviceRoom({ requiredBytes: chunk.length, maxBacklogBytes });
    const packet = buildPacket(sessionId, seq, chunk);

    try {
      await flushChar.writeValue(packet);

      offset += chunk.length;
      seq += 1;
      setJobProgress(offset);
      setStatus(t('status.transferring'), t('status.sendProgress', { offset, total: bytes.length, seq }));

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    } catch (err) {
      const msg = err?.message ?? String(err);
      setStatus(t('status.transferError'), t('status.chunkRetryPending', { msg }));

      try {
        if (!device?.gatt?.connected) {
          await reconnectLoop();
        }
      } catch {
        // reconnectLoop가 상태/지연을 처리한다.
      }

      await sleep(retryDelayMs);
    }
  }

  setStatus(t('status.transferComplete'), `${bytes.length} bytes / session=${sessionId}`);
  setUiRunState({ running: false, paused: false });
  setJobProgress(bytes.length);
  finishJobMetrics();

  } finally {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('beforeunload', onBeforeUnload);
  }
}

els.btnConnect.addEventListener('click', async () => {
  try {
    await connect();
  } catch (err) {
    setStatus(t('status.error'), err?.message ?? String(err));
    setUiConnected(false);
  }
});

els.btnDisconnect.addEventListener('click', async () => {
  try {
    await disconnect();
  } catch (err) {
    setStatus(t('status.error'), err?.message ?? String(err));
  }
});

if (els.deviceNickname) {
  setNicknameUiValue(loadSavedNickname());

  // IME(한글 등) 조합 입력 중에는 value를 건드리면 입력이 깨져서
  // "숫자만 입력되는 것처럼" 보일 수 있다. 조합이 끝난 뒤에만 sanitize한다.
  let nicknameComposing = false;
  els.deviceNickname.addEventListener('compositionstart', () => {
    nicknameComposing = true;
  });
  els.deviceNickname.addEventListener('compositionend', () => {
    nicknameComposing = false;
    const s = sanitizeNickname(els.deviceNickname.value);
    if (els.deviceNickname.value !== s) els.deviceNickname.value = s;
  });
  els.deviceNickname.addEventListener('input', (e) => {
    if (nicknameComposing || e?.isComposing) return;
    const s = sanitizeNickname(els.deviceNickname.value);
    if (els.deviceNickname.value !== s) els.deviceNickname.value = s;
  });
}

if (els.btnApplyNickname) {
  els.btnApplyNickname.addEventListener('click', async () => {
    const v = els.deviceNickname ? els.deviceNickname.value : '';
    await writeDeviceNickname(v);
  });
}

if (els.btnBootloader) {
  els.btnBootloader.addEventListener('click', async () => {
    try {
      await requestBootloader();
    } catch {
      // ignore
    }
  });
}

els.btnStop.addEventListener('click', async () => {
  stopRequested = true;
  paused = false;
  pauseStatusShown = false;

  try {
    await abortDeviceQueueNow();
  } catch {
    // ignore
  }

  setStatus(t('status.stopped'), t('status.deviceQueueAborted'));
});

if (els.btnStart) {
  els.btnStart.addEventListener('click', async () => {
    try {
      await flushText();
    } catch (err) {
      setStatus(t('status.error'), err?.message ?? String(err));
      setUiRunState({ running: false, paused: false });
      finishJobMetrics();
    }
  });
}

if (els.btnPause) {
  els.btnPause.addEventListener('click', async () => {
    if (!flushInProgress) return;
    paused = true;
    pauseStatusShown = false;
    setUiRunState({ running: true, paused: true });
    setStatus(t('status.pauseRequested'), t('status.pauseHint'));

    try {
      await setDevicePaused(true);
    } catch {
      // ignore
    }
  });
}

if (els.btnResume) {
  els.btnResume.addEventListener('click', async () => {
    if (!flushInProgress) return;
    paused = false;
    pauseStatusShown = false;
    setUiRunState({ running: true, paused: false });
    setStatus(t('status.resumed'), t('status.resumeHint'));

    try {
      await setDevicePaused(false);
    } catch {
      // ignore
    }
  });
}

if (els.unsupportedReplacement) {
  const saved = localStorage.getItem(LS_UNSUPPORTED_REPLACEMENT);
  setUnsupportedReplacement(saved || DEFAULT_UNSUPPORTED_REPLACEMENT);

  els.unsupportedReplacement.addEventListener('input', () => {
    localStorage.setItem(LS_UNSUPPORTED_REPLACEMENT, getUnsupportedReplacement());
    updatePreStartMetrics();
  });
}

if (els.chunkSize) {
  const saved = loadNumberSetting(LS_CHUNK_SIZE, DEFAULT_CHUNK_SIZE);
  els.chunkSize.value = String(clampNumber(saved, 1, 200, DEFAULT_CHUNK_SIZE));
  els.chunkSize.addEventListener('input', () => {
    const v = clampNumber(els.chunkSize.value, 1, 200, DEFAULT_CHUNK_SIZE);
    saveNumberSetting(LS_CHUNK_SIZE, v);
    updatePreStartMetrics();
  });
}

if (els.chunkDelay) {
  const saved = loadNumberSetting(LS_CHUNK_DELAY, DEFAULT_CHUNK_DELAY);
  els.chunkDelay.value = String(clampNumber(saved, 0, 200, DEFAULT_CHUNK_DELAY));
  els.chunkDelay.addEventListener('input', () => {
    const v = clampNumber(els.chunkDelay.value, 0, 200, DEFAULT_CHUNK_DELAY);
    saveNumberSetting(LS_CHUNK_DELAY, v);
    updatePreStartMetrics();
  });
}

if (els.retryDelay) {
  const saved = loadNumberSetting(LS_RETRY_DELAY, DEFAULT_RETRY_DELAY);
  els.retryDelay.value = String(clampNumber(saved, 0, 5000, DEFAULT_RETRY_DELAY));
  els.retryDelay.addEventListener('input', () => {
    const v = clampNumber(els.retryDelay.value, 0, 5000, DEFAULT_RETRY_DELAY);
    saveNumberSetting(LS_RETRY_DELAY, v);
  });
}

if (els.ignoreLeadingWhitespace) {
  const saved = loadBoolSetting(LS_IGNORE_LEADING_WHITESPACE, DEFAULT_IGNORE_LEADING_WHITESPACE);
  els.ignoreLeadingWhitespace.checked = saved;
  els.ignoreLeadingWhitespace.addEventListener('change', () => {
    saveBoolSetting(LS_IGNORE_LEADING_WHITESPACE, getIgnoreLeadingWhitespaceSetting());
    updatePreStartMetrics();
  });
}

if (els.btnResetSettings) {
  els.btnResetSettings.addEventListener('click', () => {
    localStorage.removeItem(LS_CHUNK_SIZE);
    localStorage.removeItem(LS_CHUNK_DELAY);
    localStorage.removeItem(LS_RETRY_DELAY);
    localStorage.removeItem(LS_UNSUPPORTED_REPLACEMENT);
    localStorage.removeItem(LS_TYPING_DELAY_MS);
    localStorage.removeItem(LS_MODE_SWITCH_DELAY_MS);
    localStorage.removeItem(LS_KEY_PRESS_DELAY_MS);
    localStorage.removeItem(LS_TOGGLE_KEY);
    localStorage.removeItem(LS_IGNORE_LEADING_WHITESPACE);

    if (els.chunkSize) els.chunkSize.value = String(DEFAULT_CHUNK_SIZE);
    if (els.chunkDelay) els.chunkDelay.value = String(DEFAULT_CHUNK_DELAY);
    if (els.retryDelay) els.retryDelay.value = String(DEFAULT_RETRY_DELAY);
    setUnsupportedReplacement(DEFAULT_UNSUPPORTED_REPLACEMENT);

    if (els.typingDelayMs) els.typingDelayMs.value = String(DEFAULT_TYPING_DELAY_MS);
    if (els.modeSwitchDelayMs) els.modeSwitchDelayMs.value = String(DEFAULT_MODE_SWITCH_DELAY_MS);
    if (els.keyPressDelayMs) els.keyPressDelayMs.value = String(DEFAULT_KEY_PRESS_DELAY_MS);
    setToggleKeySetting(DEFAULT_TOGGLE_KEY);

    if (els.ignoreLeadingWhitespace) els.ignoreLeadingWhitespace.checked = DEFAULT_IGNORE_LEADING_WHITESPACE;

    setStatus(t('status.settingsReset'), t('status.settingsResetDetail'));
    showTextSettingsToast(t('toast.reset'), 1000);
  });
}

function initDeviceTimingSettingInput(el, key, min, max, fallback) {
  if (!el) return;
  const saved = loadNumberSetting(key, fallback);
  el.value = String(clampNumber(saved, min, max, fallback));
  el.addEventListener('input', () => {
    const v = clampNumber(el.value, min, max, fallback);
    saveNumberSetting(key, v);
  });
}

initDeviceTimingSettingInput(els.typingDelayMs, LS_TYPING_DELAY_MS, 0, 1000, DEFAULT_TYPING_DELAY_MS);
initDeviceTimingSettingInput(els.modeSwitchDelayMs, LS_MODE_SWITCH_DELAY_MS, 0, 3000, DEFAULT_MODE_SWITCH_DELAY_MS);
initDeviceTimingSettingInput(els.keyPressDelayMs, LS_KEY_PRESS_DELAY_MS, 0, 300, DEFAULT_KEY_PRESS_DELAY_MS);

// Update estimate preview when device timing changes.
for (const el of [els.typingDelayMs, els.modeSwitchDelayMs, els.keyPressDelayMs]) {
  if (!el) continue;
  el.addEventListener('input', () => {
    updatePreStartMetrics();
  });
}

if (els.toggleKey) {
  const saved = localStorage.getItem(LS_TOGGLE_KEY);
  setToggleKeySetting(saved || DEFAULT_TOGGLE_KEY);
  els.toggleKey.addEventListener('input', () => {
    localStorage.setItem(LS_TOGGLE_KEY, getToggleKeySetting());
    updatePreStartMetrics();
  });
}

if (els.textInput) {
  els.textInput.addEventListener('input', () => {
    updatePreStartMetrics();
  });
}

if (els.btnApplyDeviceSettings) {
  els.btnApplyDeviceSettings.addEventListener('click', async () => {
    try {
      await applyDeviceSettings();
      showTextSettingsToast(t('toast.saved'), 1000);
    } catch (err) {
      setStatus(t('status.error'), err?.message ?? String(err));
    }
  });
}

setUiConnected(false);
setUiRunState({ running: false, paused: false });
setStatus(t('status.disconnected'), '');
clearJobMetrics();

// Initialize i18n (applies translations to DOM after JSON load)
await initI18n();
