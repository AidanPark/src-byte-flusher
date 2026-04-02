// ByteFlusher Web Bluetooth client (Text Flush only)
// - This file handles the "accurately type text" feature on web/text.html.
// - File/Folder Flush (base64/hash verification + PowerShell automation) is handled by web/files.js.
// Note: Web Bluetooth requires HTTPS or localhost.

import { t, getLocale, applyDom } from './i18n.js';
import * as ble from './ble.js';
import { setStatus as setAppStatus } from './app.js';

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

const DEFAULT_CHUNK_SIZE = 20;
const DEFAULT_CHUNK_DELAY = 30;
const DEFAULT_RETRY_DELAY = 300;
const DEFAULT_UNSUPPORTED_REPLACEMENT = '[?]';
const DEFAULT_TYPING_DELAY_MS = 30;
const DEFAULT_MODE_SWITCH_DELAY_MS = 100;
const DEFAULT_KEY_PRESS_DELAY_MS = 10;
const DEFAULT_TOGGLE_KEY = 'rightAlt';
const DEFAULT_IGNORE_LEADING_WHITESPACE = false;

let els = {};

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

    // notify가 누락될 수 있으니, 주기적으로 read로 폴백한다.
    const now = performance.now();
    if (!Number.isFinite(ble.getDeviceBufUpdatedAt()) || now - ble.getDeviceBufUpdatedAt() > 800) {
      await ble.readStatusOnce();
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
  const isConnected = Boolean(ble.isConnected());
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
  setAppStatus(text, details);

  // Mirror status into the stage metric during active flush.
  if (els.stageText && flushInProgress) {
    els.stageText.textContent = String(text ?? '-') || '-';
  }
}

function setUiConnected(connected) {
  if (els.btnPause) els.btnPause.disabled = true;
  if (els.btnResume) els.btnResume.disabled = true;
  if (els.btnApplyDeviceSettings) {
    els.btnApplyDeviceSettings.disabled = !connected;
  }
  if (!connected && els.btnStop) {
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

  const isConnected = Boolean(ble.isConnected());

  if (els.btnPause) els.btnPause.disabled = !running || !isConnected || isPaused;
  if (els.btnResume) els.btnResume.disabled = !running || !isConnected || !isPaused;
  if (els.btnStop) els.btnStop.disabled = !running;

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
  if (!ble.isConnected()) {
    return;
  }
  if (!ble.getChar(ble.CONFIG_CHAR_UUID)) {
    // 구버전 펌웨어(또는 config char 없음)에서는 장치 pause를 지원하지 않는다.
    return;
  }

  const timing = getDeviceTimingSettings();
  const toggleKey = getToggleKeySetting();
  const payload = buildDeviceConfigPayload({ ...timing, toggleKey });
  payload[7] = pausedState ? 1 : 0;
  await ble.getChar(ble.CONFIG_CHAR_UUID).writeValue(payload);
}

async function abortDeviceQueueNow() {
  if (!ble.isConnected()) {
    return;
  }
  if (!ble.getChar(ble.CONFIG_CHAR_UUID)) {
    return;
  }

  const timing = getDeviceTimingSettings();
  const toggleKey = getToggleKeySetting();
  const payload = buildDeviceConfigPayload({ ...timing, toggleKey });
  // flags: bit1 abort(즉시 폐기)
  payload[7] = 0x02;
  await ble.getChar(ble.CONFIG_CHAR_UUID).writeValue(payload);
}

async function applyDeviceSettings() {
  if (!ble.isConnected()) {
    throw new Error(t('error.bleNotConnected'));
  }
  if (!ble.getChar(ble.CONFIG_CHAR_UUID)) {
    throw new Error(t('error.noConfigChar'));
  }

  const timing = getDeviceTimingSettings();
  const toggleKey = getToggleKeySetting();
  const payload = buildDeviceConfigPayload({ ...timing, toggleKey });

  // pause 상태에서 설정을 적용해도, pause가 풀려버리면 안 된다.
  payload[7] = paused ? 1 : 0;

  setStatus(t('status.applyingSettings'), `typing=${timing.typingDelayMs}ms, modeSwitch=${timing.modeSwitchDelayMs}ms, keyPress=${timing.keyPressDelayMs}ms, toggle=${toggleKey}`);
  await ble.getChar(ble.CONFIG_CHAR_UUID).writeValue(payload);
  setStatus(t('status.settingsApplied'), `typing=${timing.typingDelayMs}ms, modeSwitch=${timing.modeSwitchDelayMs}ms, keyPress=${timing.keyPressDelayMs}ms, toggle=${toggleKey}`);
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
  if (!ble.getChar(ble.FLUSH_TEXT_CHAR_UUID)) {
    throw new Error(t('error.noFlushChar'));
  }

  const rawText = els.textInput.value ?? '';
  const pre = preprocessTextForFirmware(rawText);
  const bytes = new TextEncoder().encode(pre.text);
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
  // (ble.getChar(ble.CONFIG_CHAR_UUID)가 없으면 무시하고 계속 진행)
  try {
    if (ble.getChar(ble.CONFIG_CHAR_UUID)) {
      await ble.getChar(ble.CONFIG_CHAR_UUID).writeValue(buildDeviceConfigPayload({ ...timing, toggleKey }));
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

    if (!ble.isConnected() || !ble.getChar(ble.FLUSH_TEXT_CHAR_UUID)) {
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
      await ble.getChar(ble.FLUSH_TEXT_CHAR_UUID).writeValue(packet);

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
        if (!ble.isConnected()) {
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

// ---------------------------------------------------------------------------
// BLE event handlers
// ---------------------------------------------------------------------------

function onBleConnect() {
  setUiConnected(true);
  updateStartEnabled();
}

function onBleDisconnect() {
  setUiConnected(false);
  updateStartEnabled();
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

// ---------------------------------------------------------------------------
// DOM creation helpers (SPA)
// ---------------------------------------------------------------------------

function createTextSidebar() {
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
    { attr: 'data-i18n', key: 'common.cautionAuth', text: 'Intended for testing/development automation/demo purposes on systems you own/manage or in explicitly authorized environments.' },
    { attr: 'data-i18n', key: 'common.cautionIllegal', text: 'Do not use for unauthorized access, security bypass, unauthorized input, or any illegal/unethical purpose.' },
    { attr: 'data-i18n-html', key: 'common.cautionNoPairing', html: true },
    { attr: 'data-i18n', key: 'common.cautionFocus', text: 'Verify cursor/focus position on the Target PC before starting.' },
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
  settingsDetails.id = 'settingsCardText';

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

  // -- Chunk/retry grid --
  const grid1 = document.createElement('div');
  grid1.className = 'grid2';

  function addNumberInput(parent, labelI18n, labelText, inputId, min, max, value) {
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
    input.value = String(value);
    label.appendChild(span);
    label.appendChild(input);
    parent.appendChild(label);
    return label;
  }

  function addHint(parent, i18nKey, text, marginTop) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.style.cssText = 'margin: ' + (marginTop || '-2px') + ' 0 0;';
    p.setAttribute('data-i18n', i18nKey);
    p.textContent = text;
    parent.appendChild(p);
  }

  addNumberInput(grid1, 'settings.chunkSize', 'Chunk size (bytes)', 'chunkSize', 1, 200, 20);
  addHint(grid1, 'settings.chunkSizeHint', 'Data size sent via BLE at once. Too large may increase failure rate.');

  addNumberInput(grid1, 'settings.chunkDelay', 'Chunk send interval (ms)', 'chunkDelay', 0, 200, 30);
  addHint(grid1, 'settings.chunkDelayHint', 'Wait time between chunks (for transfer stabilization).');

  addNumberInput(grid1, 'settings.retryDelay', 'Retry interval (ms)', 'retryDelay', 0, 5000, 300);
  addHint(grid1, 'settings.retryDelayHint', 'Wait time before reconnect/retry on disconnect or failure.');

  fieldset.appendChild(grid1);

  // -- Divider --
  const hr = document.createElement('hr');
  hr.className = 'sidebarDivider';
  fieldset.appendChild(hr);

  // -- Input Settings title --
  const inputSettingsTitle = document.createElement('h2');
  inputSettingsTitle.className = 'settingsTitle';
  inputSettingsTitle.style.marginTop = '14px';
  inputSettingsTitle.setAttribute('data-i18n', 'settings.inputSettings');
  inputSettingsTitle.textContent = 'Input Settings';
  fieldset.appendChild(inputSettingsTitle);

  // -- Input Settings grid --
  const grid2 = document.createElement('div');
  grid2.className = 'grid2';
  grid2.style.marginTop = '12px';

  // Toggle key select
  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'inline';
  toggleLabel.style.cssText = 'width: 100%; justify-content: space-between;';
  const toggleSpan = document.createElement('span');
  toggleSpan.setAttribute('data-i18n', 'settings.toggleKey');
  toggleSpan.textContent = 'KR/EN toggle key';
  const toggleSelect = document.createElement('select');
  toggleSelect.id = 'toggleKey';

  const toggleOptions = [
    { value: 'rightAlt', i18n: 'settings.toggleKeyRightAlt', text: 'Right Alt (Windows)' },
    { value: 'capsLock', i18n: 'settings.toggleKeyCapsLock', text: 'Caps Lock (mac)' },
    { value: 'leftAlt', i18n: 'settings.toggleKeyLeftAlt', text: 'Left Alt' },
    { value: 'rightCtrl', i18n: 'settings.toggleKeyRightCtrl', text: 'Right Ctrl' },
    { value: 'leftCtrl', i18n: 'settings.toggleKeyLeftCtrl', text: 'Left Ctrl' },
    { value: 'rightGui', i18n: 'settings.toggleKeyRightGui', text: 'Right GUI (Win/Cmd)' },
    { value: 'leftGui', i18n: 'settings.toggleKeyLeftGui', text: 'Left GUI (Win/Cmd)' },
  ];
  for (const opt of toggleOptions) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.setAttribute('data-i18n', opt.i18n);
    option.textContent = opt.text;
    toggleSelect.appendChild(option);
  }
  toggleLabel.appendChild(toggleSpan);
  toggleLabel.appendChild(toggleSelect);
  grid2.appendChild(toggleLabel);

  // Replacement string
  const replLabel = document.createElement('label');
  replLabel.className = 'inline';
  replLabel.style.cssText = 'width: 100%; justify-content: space-between;';
  const replSpan = document.createElement('span');
  replSpan.setAttribute('data-i18n', 'settings.unsupportedReplacement');
  replSpan.textContent = 'Replacement string';
  const replInput = document.createElement('input');
  replInput.id = 'unsupportedReplacement';
  replInput.type = 'text';
  replInput.value = '[?]';
  replInput.maxLength = 16;
  replLabel.appendChild(replSpan);
  replLabel.appendChild(replInput);
  grid2.appendChild(replLabel);

  addHint(grid2, 'settings.unsupportedReplacementHint', 'Characters not on the keyboard will be replaced with this string.', '9px');

  // Ignore leading whitespace checkbox
  const wsLabel = document.createElement('label');
  wsLabel.className = 'inline';
  wsLabel.style.cssText = 'width: 100%; justify-content: space-between;';
  const wsSpan = document.createElement('span');
  wsSpan.setAttribute('data-i18n', 'settings.ignoreLeadingWhitespace');
  wsSpan.textContent = 'Ignore leading spaces/tabs';
  const wsCheck = document.createElement('input');
  wsCheck.id = 'ignoreLeadingWhitespace';
  wsCheck.type = 'checkbox';
  wsLabel.appendChild(wsSpan);
  wsLabel.appendChild(wsCheck);
  grid2.appendChild(wsLabel);

  addHint(grid2, 'settings.ignoreLeadingWhitespaceHint', 'Leading spaces/tabs on each line will not be sent (useful for IDE auto-formatting).', '9px');

  // Typing delay
  addNumberInput(grid2, 'settings.typingDelay', 'Key typing delay (ms)', 'typingDelayMs', 0, 1000, 30);
  addHint(grid2, 'settings.typingDelayHint', 'Wait time after each keystroke. Too short may cause missed/garbled characters (especially HID/IME).');

  // Mode switch delay
  addNumberInput(grid2, 'settings.modeSwitchDelay', 'KR/EN switch delay (ms)', 'modeSwitchDelayMs', 0, 3000, 100);
  addHint(grid2, 'settings.modeSwitchDelayHint', 'Stabilization wait after IME toggle. Too short may cause input in the wrong mode.');

  // Key press delay
  addNumberInput(grid2, 'settings.keyPressDelay', 'Key press hold (ms)', 'keyPressDelayMs', 0, 300, 10);
  addHint(grid2, 'settings.keyPressDelayHint', 'How long a key is held down. Too short may not register in some environments.');

  fieldset.appendChild(grid2);

  // Timing note
  const timingNote = document.createElement('p');
  timingNote.className = 'muted small';
  timingNote.style.cssText = 'margin: 9px 0 0;';
  timingNote.setAttribute('data-i18n', 'settings.timingNote');
  timingNote.textContent = 'These values affect the actual typing speed/stability on the board (USB HID).';
  fieldset.appendChild(timingNote);

  // Apply/Reset buttons row
  const btnRow = document.createElement('div');
  btnRow.className = 'row';
  btnRow.style.marginTop = '12px';

  const applyBtn = document.createElement('button');
  applyBtn.id = 'btnApplyDeviceSettings';
  applyBtn.className = 'primary';
  applyBtn.disabled = true;
  applyBtn.setAttribute('data-i18n', 'common.applySettings');
  applyBtn.textContent = 'Apply Settings';
  btnRow.appendChild(applyBtn);

  const resetBtn = document.createElement('button');
  resetBtn.id = 'btnResetSettings';
  resetBtn.setAttribute('data-i18n', 'common.resetSettings');
  resetBtn.textContent = 'Reset Settings';
  btnRow.appendChild(resetBtn);

  const toast = document.createElement('span');
  toast.id = 'textSettingsToast';
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
  procTitle.setAttribute('data-i18n', 'text.procedureSummaryTitle');
  procTitle.textContent = 'Execution procedure (summary)';
  notesDiv.appendChild(procTitle);

  const procSummary = document.createElement('div');
  procSummary.setAttribute('data-i18n', 'text.procedureSummary');
  procSummary.textContent = 'Text preprocessing (replacement/whitespace options) \u2192 BLE packet splitting (chunks) \u2192 Start \u2192 (optional) device timing settings \u2192 chunk transmission loop (writeValue) \u2192 device (USB HID) types \u2192 complete (Stop/done)';
  notesDiv.appendChild(procSummary);

  const metricsNote = document.createElement('div');
  metricsNote.style.marginTop = '6px';
  metricsNote.setAttribute('data-i18n', 'text.metricsNote');
  metricsNote.textContent = 'Metric meanings: ETA/Basis are values calculated from input/settings (previewable), Progress is an approximation based on sent bytes ratio, Start/Elapsed/End are wall-clock based.';
  notesDiv.appendChild(metricsNote);

  notesCard.appendChild(notesDiv);

  const notesUl = document.createElement('ul');
  notesUl.className = 'muted small';
  notesUl.style.cssText = 'margin: 0; padding-left: 18px;';

  const noteItems = [
    { attr: 'data-i18n', key: 'text.noteBluetooth', text: 'Web Bluetooth only works in Chrome/Edge.' },
    { attr: 'data-i18n', key: 'text.noteUSB', text: 'Target PC must allow USB keyboard devices.' },
    { attr: 'data-i18n', key: 'text.noteFocusStart', text: 'Place the cursor at the target input position on the Target PC before starting (Flush).' },
    { attr: 'data-i18n-html', key: 'text.cautionEnglishMode' },
    { attr: 'data-i18n', key: 'text.noteBLESplit', text: 'BLE transfers have length limits and are split by default.' },
  ];
  for (const item of noteItems) {
    const li = document.createElement('li');
    if (item.attr === 'data-i18n-html') {
      li.setAttribute('data-i18n-html', item.key);
    } else {
      li.setAttribute('data-i18n', item.key);
      li.textContent = item.text;
    }
    notesUl.appendChild(li);
  }
  notesCard.appendChild(notesUl);
  frag.appendChild(notesCard);

  return frag;
}

function createTextMain() {
  const frag = document.createDocumentFragment();

  const card = document.createElement('section');
  card.className = 'card';

  // Label
  const label = document.createElement('label');
  label.setAttribute('for', 'textInput');
  label.className = 'label';
  label.setAttribute('data-i18n', 'text.flushLabel');
  label.textContent = 'Flush Text';
  card.appendChild(label);

  // Textarea
  const textarea = document.createElement('textarea');
  textarea.id = 'textInput';
  textarea.rows = 28;
  textarea.placeholder = 'Text entered here will be typed on the Target PC.';
  textarea.setAttribute('data-i18n-placeholder', 'text.textareaPlaceholder');
  card.appendChild(textarea);

  // Button row
  const btnRow = document.createElement('div');
  btnRow.className = 'row';
  btnRow.style.marginTop = '24px';

  const buttons = [
    { id: 'btnStart', cls: 'primary controlButton', i18n: 'common.startText', text: 'Start (Text)', disabled: true },
    { id: 'btnPause', cls: 'controlButton', i18n: 'common.pause', text: 'Pause', disabled: true },
    { id: 'btnResume', cls: 'controlButton', i18n: 'common.resume', text: 'Resume', disabled: true },
    { id: 'btnStop', cls: 'danger controlButton', i18n: 'common.stop', text: 'Stop', disabled: true },
  ];
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.id = b.id;
    btn.className = b.cls;
    btn.disabled = b.disabled;
    btn.setAttribute('data-i18n', b.i18n);
    btn.textContent = b.text;
    btnRow.appendChild(btn);
  }
  card.appendChild(btnRow);

  // Hint / checklist
  const hintDiv = document.createElement('div');
  hintDiv.className = 'muted small';
  hintDiv.id = 'startHintText';
  hintDiv.style.marginTop = '8px';
  card.appendChild(hintDiv);

  const checklistDiv = document.createElement('div');
  checklistDiv.className = 'muted small';
  checklistDiv.id = 'startChecklistText';
  checklistDiv.style.cssText = 'margin-top: 6px; white-space: pre-wrap;';
  card.appendChild(checklistDiv);

  // Job metrics
  const metricsDiv = document.createElement('div');
  metricsDiv.id = 'jobMetrics';
  metricsDiv.className = 'jobMetrics';
  metricsDiv.setAttribute('aria-live', 'polite');
  metricsDiv.style.marginTop = '10px';

  const metrics = [
    { keyI18n: 'metric.estimate', keyText: 'ETA', valueId: 'etaText' },
    { keyI18n: 'metric.startTime', keyText: 'Start', valueId: 'startTimeText' },
    { keyI18n: 'metric.bytes', keyText: 'Bytes', valueId: 'totalBytesText' },
    { keyI18n: 'metric.stage', keyText: 'Stage', valueId: 'stageText' },
    { keyI18n: 'metric.elapsed', keyText: 'Elapsed', valueId: 'elapsedText' },
    { keyI18n: 'metric.progress', keyText: 'Progress', valueId: 'progressText' },
    { keyI18n: 'metric.endTime', keyText: 'End', valueId: 'endTimeText' },
    { keyI18n: 'metric.basis', keyText: 'Basis', valueId: 'estimateBasisText', wide: true },
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

// ---------------------------------------------------------------------------
// Lifecycle — init / destroy
// ---------------------------------------------------------------------------

export function init(mainContainer, sidebarExtra) {
  // 1. Build and append DOM
  sidebarExtra.appendChild(createTextSidebar());
  mainContainer.appendChild(createTextMain());
  applyDom(sidebarExtra);
  applyDom(mainContainer);

  // 2. Bind els
  els = {
    btnStart: document.getElementById('btnStart'),
    btnPause: document.getElementById('btnPause'),
    btnResume: document.getElementById('btnResume'),
    btnStop: document.getElementById('btnStop'),
    startHintText: document.getElementById('startHintText'),
    startChecklistText: document.getElementById('startChecklistText'),
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

  // 3. Register event listeners

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

  if (els.btnStop) {
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
  }

  if (els.textInput) {
    els.textInput.addEventListener('input', () => {
      updatePreStartMetrics();
    });
  }

  // Transfer settings — load saved + register listeners
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

  if (els.unsupportedReplacement) {
    const saved = localStorage.getItem(LS_UNSUPPORTED_REPLACEMENT);
    setUnsupportedReplacement(saved || DEFAULT_UNSUPPORTED_REPLACEMENT);
    els.unsupportedReplacement.addEventListener('input', () => {
      localStorage.setItem(LS_UNSUPPORTED_REPLACEMENT, getUnsupportedReplacement());
      updatePreStartMetrics();
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

  // Device timing settings — load saved + register listeners
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

  // 5. Set initial UI state
  setUiConnected(ble.isConnected());
  setUiRunState({ running: false, paused: false });
  clearJobMetrics();

  // 6. Subscribe to BLE events
  ble.on('connect', onBleConnect);
  ble.on('disconnect', onBleDisconnect);
}

export function destroy() {
  // Stop any running transfer
  if (flushInProgress) {
    stopRequested = true;
  }

  // Unsubscribe BLE events
  ble.off('connect', onBleConnect);
  ble.off('disconnect', onBleDisconnect);

  // Clear job timer
  if (job?.intervalId) {
    clearInterval(job.intervalId);
    job.intervalId = null;
  }

  // Clear toast timer
  if (textSettingsToastTimerId) {
    clearTimeout(textSettingsToastTimerId);
    textSettingsToastTimerId = null;
  }

  // Reset state
  els = {};
  job = null;
}
