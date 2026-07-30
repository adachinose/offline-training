'use strict';

const APP_VERSION = '1.5.0';
const STORAGE_KEY = 'offline-training-settings-v1';
const BLANK_MS = 180;
const START_COUNTDOWN_MS = 3000;

const DEFAULT_DATA = {
  timerPresets: [
    { id: 'sample-timer', name: '10-20-30 × 3', durations: [10, 20, 30], repeatCount: 3 }
  ],
  directionPresets: [
    { id: 'sample-direction', name: 'ランダム 2〜5秒', mode: 'random', fixed: 3, min: 2, max: 5, runSeconds: null }
  ],
  lastTimer: { durations: [10, 20, 30], repeatCount: 1 },
  lastDirection: { mode: 'random', fixed: 3, min: 2, max: 5, runSeconds: null }
};

const DIRECTIONS = [
  { label: '右', angle: 0 },
  { label: '右前', angle: -45 },
  { label: '左前', angle: -135 },
  { label: '左', angle: 180 },
  { label: '左後', angle: 135 },
  { label: '右後', angle: 45 }
];

const $ = (id) => document.getElementById(id);
const views = [...document.querySelectorAll('.view')];
let appData = loadData();
let toastTimer = null;
let audioContext = null;
let wakeLock = null;
const activeTimerCueOscillators = new Set();

const timerRun = {
  active: false,
  paused: false,
  phase: 'idle',
  durations: [],
  repeatCount: 1,
  roundIndex: 0,
  segmentIndex: 0,
  endAt: 0,
  remainingMs: 0,
  boundaryTimer: null,
  displayTimer: null
};

const directionRun = {
  active: false,
  paused: false,
  mode: 'fixed',
  fixed: 3,
  min: 2,
  max: 5,
  count: 0,
  phase: 'idle',
  transitionTimer: null,
  blankTimer: null,
  countdownTimer: null,
  countdownDisplayTimer: null,
  countdownEndAt: 0,
  countdownRemainingMs: 0,
  endTimer: null,
  progressTimer: null,
  nextTransitionAt: 0,
  remainingMs: 0,
  runSeconds: null,
  executionStarted: false,
  executionEndAt: 0,
  executionRemainingMs: 0
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadData() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!stored || typeof stored !== 'object') return clone(DEFAULT_DATA);
    return {
      timerPresets: Array.isArray(stored.timerPresets) ? stored.timerPresets : clone(DEFAULT_DATA.timerPresets),
      directionPresets: Array.isArray(stored.directionPresets) ? stored.directionPresets : clone(DEFAULT_DATA.directionPresets),
      lastTimer: stored.lastTimer || clone(DEFAULT_DATA.lastTimer),
      lastDirection: stored.lastDirection || clone(DEFAULT_DATA.lastDirection)
    };
  } catch (error) {
    console.warn('設定を読み込めませんでした。', error);
    return clone(DEFAULT_DATA);
  }
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
}

function makeId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function showView(id) {
  views.forEach((view) => view.classList.toggle('active', view.id === id));
  window.scrollTo(0, 0);
}

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1900);
}

function setError(id, message = '') {
  $(id).textContent = message;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function fillSecondSelect(select, selected) {
  select.innerHTML = '';
  for (let value = 1; value <= 10; value += 1) {
    const option = document.createElement('option');
    option.value = String(value);
    option.textContent = `${value}秒`;
    option.selected = value === selected;
    select.append(option);
  }
}

function renderTimerPresets(selectedId = '') {
  const select = $('timerPresetSelect');
  select.innerHTML = '<option value="">選択してください</option>';
  appData.timerPresets.forEach((preset) => {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name;
    option.selected = preset.id === selectedId;
    select.append(option);
  });
  $('deleteTimerPresetBtn').disabled = !select.value;
}

function renderDirectionPresets(selectedId = '') {
  const select = $('directionPresetSelect');
  select.innerHTML = '<option value="">選択してください</option>';
  appData.directionPresets.forEach((preset) => {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.name;
    option.selected = preset.id === selectedId;
    select.append(option);
  });
  $('deleteDirectionPresetBtn').disabled = !select.value;
}

function parseDurations(raw) {
  const tokens = raw.trim().split(/[\s,、，;；]+/).filter(Boolean);
  if (!tokens.length) throw new Error('秒数を1つ以上入力してください。');
  const values = tokens.map((token) => Number(token));
  if (values.some((value) => !Number.isInteger(value) || value < 1 || value > 3600)) {
    throw new Error('秒数は1〜3600の整数で入力してください。');
  }
  if (values.length > 50) throw new Error('秒数は50個以内にしてください。');
  return values;
}

function getTimerFormValues() {
  const durations = parseDurations($('durationInput').value);
  const repeatMode = document.querySelector('input[name="repeatMode"]:checked').value;
  const repeatCount = repeatMode === 'repeat'
    ? clampInteger($('repeatCountInput').value, 2, 99, 3)
    : 1;
  $('repeatCountInput').value = String(repeatCount === 1 ? 3 : repeatCount);
  return { durations, repeatCount };
}

function applyTimerSettings(settings) {
  const durations = Array.isArray(settings.durations) && settings.durations.length ? settings.durations : [10];
  const repeatCount = clampInteger(settings.repeatCount, 1, 99, 1);
  $('durationInput').value = durations.join(', ');
  const mode = repeatCount > 1 ? 'repeat' : 'once';
  document.querySelector(`input[name="repeatMode"][value="${mode}"]`).checked = true;
  $('repeatCountInput').value = String(Math.max(2, repeatCount));
  updateRepeatVisibility();
}

function updateRepeatVisibility() {
  const mode = document.querySelector('input[name="repeatMode"]:checked').value;
  $('repeatCountRow').classList.toggle('hidden', mode !== 'repeat');
}

function parseOptionalRunSeconds(raw) {
  const value = raw.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) {
    throw new Error('実行時間は1〜86400秒の整数、または未入力にしてください。');
  }
  return seconds;
}

function getDirectionFormValues() {
  const mode = document.querySelector('input[name="intervalMode"]:checked').value;
  const fixed = clampInteger($('fixedIntervalSelect').value, 1, 10, 3);
  let min = clampInteger($('randomMinSelect').value, 1, 10, 2);
  let max = clampInteger($('randomMaxSelect').value, 1, 10, 5);
  const runSeconds = parseOptionalRunSeconds($('directionRunSecondsInput').value);
  if (min > max) [min, max] = [max, min];
  $('randomMinSelect').value = String(min);
  $('randomMaxSelect').value = String(max);
  return { mode, fixed, min, max, runSeconds };
}

function applyDirectionSettings(settings) {
  const mode = settings.mode === 'random' ? 'random' : 'fixed';
  const fixed = clampInteger(settings.fixed, 1, 10, 3);
  let min = clampInteger(settings.min, 1, 10, 2);
  let max = clampInteger(settings.max, 1, 10, 5);
  const runSeconds = settings.runSeconds == null
    ? null
    : clampInteger(settings.runSeconds, 1, 86400, null);
  if (min > max) [min, max] = [max, min];
  document.querySelector(`input[name="intervalMode"][value="${mode}"]`).checked = true;
  fillSecondSelect($('fixedIntervalSelect'), fixed);
  fillSecondSelect($('randomMinSelect'), min);
  fillSecondSelect($('randomMaxSelect'), max);
  $('directionRunSecondsInput').value = runSeconds == null ? '' : String(runSeconds);
  updateIntervalVisibility();
}

function updateIntervalVisibility() {
  const mode = document.querySelector('input[name="intervalMode"]:checked').value;
  $('fixedIntervalRow').classList.toggle('hidden', mode !== 'fixed');
  $('randomIntervalRow').classList.toggle('hidden', mode !== 'random');
}

async function unlockAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('このブラウザーは音声出力に対応していません。');
  if (!audioContext) audioContext = new AudioContextClass();
  if (audioContext.state === 'suspended') await audioContext.resume();

  // iOSのユーザー操作要件を満たすため、開始ボタン操作中に無音を一度出力する。
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  gain.gain.value = 0.00001;
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + 0.01);
}

function stopTimerCue() {
  activeTimerCueOscillators.forEach((oscillator) => {
    try { oscillator.stop(); } catch (error) { /* すでに停止済み */ }
  });
  activeTimerCueOscillators.clear();
}

function scheduleTone(frequency, startOffset, duration, volume = 0.48, group = 'general') {
  if (!audioContext || audioContext.state !== 'running') return;
  const start = audioContext.currentTime + startOffset;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(audioContext.destination);
  if (group === 'timer') {
    activeTimerCueOscillators.add(oscillator);
    oscillator.addEventListener('ended', () => activeTimerCueOscillators.delete(oscillator), { once: true });
  }
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}

function playTimerRhythm(kind) {
  stopTimerCue();
  const notes = kind === 'finish'
    ? [
        [740, 0.00, 0.18], [920, 0.28, 0.18], [1160, 0.56, 0.28],
        [740, 1.05, 0.18], [920, 1.33, 0.18], [1160, 1.61, 0.28],
        [920, 2.10, 0.18], [1160, 2.38, 0.18], [1460, 2.66, 0.34]
      ]
    : [
        [880, 0.00, 0.16], [880, 0.28, 0.16], [1120, 0.56, 0.24],
        [880, 1.00, 0.16], [880, 1.28, 0.16], [1120, 1.56, 0.24],
        [880, 2.00, 0.16], [1120, 2.28, 0.16], [1320, 2.56, 0.34]
      ];
  notes.forEach(([frequency, offset, duration]) => {
    scheduleTone(frequency, offset, duration, 0.58, 'timer');
  });
}

function playCue(kind = 'segment') {
  if (!audioContext || audioContext.state !== 'running') return;
  if (kind === 'direction') {
    scheduleTone(920, 0, 0.12, 0.55);
    return;
  }
  if (kind === 'directionFinish') {
    scheduleTone(760, 0.00, 0.14, 0.55);
    scheduleTone(980, 0.22, 0.14, 0.58);
    scheduleTone(1240, 0.44, 0.24, 0.62);
    return;
  }
  playTimerRhythm(kind === 'finish' ? 'finish' : 'segment');
}

async function testSound(kind) {
  try {
    await unlockAudio();
    playCue(kind);
  } catch (error) {
    showToast(error.message);
  }
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return false;
  try {
    if (wakeLock && !wakeLock.released) return true;
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; }, { once: true });
    return true;
  } catch (error) {
    console.warn('画面の自動ロックを抑止できませんでした。', error);
    return false;
  }
}

async function releaseWakeLock() {
  try {
    if (wakeLock && !wakeLock.released) await wakeLock.release();
  } catch (error) {
    console.warn(error);
  } finally {
    wakeLock = null;
  }
}

async function enterFullscreen() {
  const element = document.documentElement;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (element.requestFullscreen) {
      await element.requestFullscreen();
    } else if (element.webkitRequestFullscreen) {
      await element.webkitRequestFullscreen();
    } else {
      showToast('ホーム画面から起動すると画面を広く使えます。');
    }
  } catch (error) {
    showToast('全画面表示を開始できませんでした。');
  }
}

function clearTimerHandles() {
  clearTimeout(timerRun.boundaryTimer);
  clearInterval(timerRun.displayTimer);
  timerRun.boundaryTimer = null;
  timerRun.displayTimer = null;
}

function updateTimerScreen() {
  if (!timerRun.active) return;
  const remaining = timerRun.paused
    ? timerRun.remainingMs
    : Math.max(0, timerRun.endAt - Date.now());
  const displaySeconds = String(Math.max(0, Math.ceil(remaining / 1000)));
  const countdown = $('countdownDisplay');
  countdown.textContent = displaySeconds;
  countdown.dataset.digits = String(displaySeconds.length);

  if (timerRun.phase === 'prestart') {
    $('timerProgress').textContent = '開始まで';
    $('timerSegmentInfo').textContent = '準備';
    $('timerNextInfo').textContent = `次: ${timerRun.durations[0]}秒`;
    return;
  }

  $('timerProgress').textContent = `セット ${timerRun.roundIndex + 1} / ${timerRun.repeatCount}`;
  $('timerSegmentInfo').textContent = `区間 ${timerRun.segmentIndex + 1} / ${timerRun.durations.length}`;

  const isLastSegment = timerRun.segmentIndex === timerRun.durations.length - 1;
  const isLastRound = timerRun.roundIndex === timerRun.repeatCount - 1;
  if (!isLastSegment) {
    $('timerNextInfo').textContent = `次: ${timerRun.durations[timerRun.segmentIndex + 1]}秒`;
  } else if (!isLastRound) {
    $('timerNextInfo').textContent = `次: セット ${timerRun.roundIndex + 2}・${timerRun.durations[0]}秒`;
  } else {
    $('timerNextInfo').textContent = '次: 終了';
  }
}

function scheduleTimer() {
  clearTimerHandles();
  updateTimerScreen();
  const delay = Math.max(0, timerRun.endAt - Date.now());
  const callback = timerRun.phase === 'prestart' ? beginTimerWorkout : advanceTimer;
  timerRun.boundaryTimer = setTimeout(callback, delay);
  timerRun.displayTimer = setInterval(updateTimerScreen, 100);
}

function beginTimerCountdown(delay = START_COUNTDOWN_MS) {
  timerRun.phase = 'prestart';
  timerRun.remainingMs = Math.max(0, delay);
  timerRun.endAt = Date.now() + timerRun.remainingMs;
  scheduleTimer();
}

function beginTimerWorkout() {
  if (!timerRun.active || timerRun.paused) return;
  clearTimerHandles();
  timerRun.phase = 'running';
  timerRun.remainingMs = 0;
  timerRun.endAt = Date.now() + timerRun.durations[timerRun.segmentIndex] * 1000;
  scheduleTimer();
}

function advanceTimer() {
  if (!timerRun.active || timerRun.paused) return;
  const isLastSegment = timerRun.segmentIndex === timerRun.durations.length - 1;
  const isLastRound = timerRun.roundIndex === timerRun.repeatCount - 1;

  if (isLastSegment && isLastRound) {
    clearTimerHandles();
    $('countdownDisplay').textContent = '0';
    $('countdownDisplay').dataset.digits = '1';
    $('timerNextInfo').textContent = '完了';
    playCue('finish');
    timerRun.active = false;
    releaseWakeLock();
    $('pauseTimerBtn').textContent = '一時停止';
    setTimeout(() => showToast('タイマー完了'), 250);
    return;
  }

  playCue('segment');
  if (isLastSegment) {
    timerRun.segmentIndex = 0;
    timerRun.roundIndex += 1;
  } else {
    timerRun.segmentIndex += 1;
  }

  const priorDeadline = timerRun.endAt;
  timerRun.endAt = priorDeadline + timerRun.durations[timerRun.segmentIndex] * 1000;
  // ごく短い処理遅延は、前区間の予定終了時刻を基準にして補正する。
  if (timerRun.endAt <= Date.now()) timerRun.endAt = Date.now() + timerRun.durations[timerRun.segmentIndex] * 1000;
  scheduleTimer();
}

async function startTimer() {
  setError('timerSetupError');
  let settings;
  try {
    settings = getTimerFormValues();
    await unlockAudio();
  } catch (error) {
    setError('timerSetupError', error.message);
    return;
  }

  appData.lastTimer = clone(settings);
  saveData();
  stopTimerCue();
  timerRun.active = true;
  timerRun.paused = false;
  timerRun.phase = 'prestart';
  timerRun.durations = settings.durations;
  timerRun.repeatCount = settings.repeatCount;
  timerRun.roundIndex = 0;
  timerRun.segmentIndex = 0;
  timerRun.remainingMs = START_COUNTDOWN_MS;
  timerRun.endAt = 0;
  $('timerPausedOverlay').classList.add('hidden');
  $('pauseTimerBtn').textContent = '一時停止';
  showView('timerRunView');
  const locked = await requestWakeLock();
  if (!locked && !('wakeLock' in navigator)) showToast('画面が消える場合は自動ロックを一時的に解除してください。');
  beginTimerCountdown();
}

function pauseTimer(auto = false) {
  if (!timerRun.active || timerRun.paused) return;
  stopTimerCue();
  timerRun.remainingMs = Math.max(0, timerRun.endAt - Date.now());
  timerRun.paused = true;
  clearTimerHandles();
  updateTimerScreen();
  $('timerPausedOverlay').classList.remove('hidden');
  $('pauseTimerBtn').textContent = '再開';
  releaseWakeLock();
  if (auto) showToast('画面が非表示になったため一時停止しました。');
}

async function resumeTimer() {
  if (!timerRun.active || !timerRun.paused) return;
  try { await unlockAudio(); } catch (error) { showToast(error.message); return; }
  timerRun.paused = false;
  timerRun.endAt = Date.now() + timerRun.remainingMs;
  $('timerPausedOverlay').classList.add('hidden');
  $('pauseTimerBtn').textContent = '一時停止';
  await requestWakeLock();
  scheduleTimer();
}

function restartTimer() {
  if (!timerRun.durations.length) return;
  clearTimerHandles();
  stopTimerCue();
  timerRun.active = true;
  timerRun.paused = false;
  timerRun.phase = 'prestart';
  timerRun.roundIndex = 0;
  timerRun.segmentIndex = 0;
  timerRun.remainingMs = START_COUNTDOWN_MS;
  timerRun.endAt = 0;
  $('timerPausedOverlay').classList.add('hidden');
  $('pauseTimerBtn').textContent = '一時停止';
  requestWakeLock();
  beginTimerCountdown();
}

function stopTimer() {
  clearTimerHandles();
  stopTimerCue();
  timerRun.active = false;
  timerRun.paused = false;
  timerRun.phase = 'idle';
  releaseWakeLock();
  showView('timerSetupView');
}

function directionIntervalMs() {
  if (directionRun.mode === 'fixed') return directionRun.fixed * 1000;
  const seconds = directionRun.min + Math.floor(Math.random() * (directionRun.max - directionRun.min + 1));
  return seconds * 1000;
}

function setArrow(direction, colorClass) {
  const arrow = $('directionArrow');
  arrow.style.transform = `rotate(${direction.angle}deg)`;
  arrow.classList.remove('arrow-green', 'arrow-orange');
  arrow.classList.add(colorClass);
  $('directionLabel').textContent = direction.label;
}

function clearDirectionSwitchHandles() {
  clearTimeout(directionRun.transitionTimer);
  clearTimeout(directionRun.blankTimer);
  clearTimeout(directionRun.countdownTimer);
  clearInterval(directionRun.countdownDisplayTimer);
  directionRun.transitionTimer = null;
  directionRun.blankTimer = null;
  directionRun.countdownTimer = null;
  directionRun.countdownDisplayTimer = null;
}

function clearDirectionExecutionHandles() {
  clearTimeout(directionRun.endTimer);
  clearInterval(directionRun.progressTimer);
  directionRun.endTimer = null;
  directionRun.progressTimer = null;
}

function clearDirectionHandles() {
  clearDirectionSwitchHandles();
  clearDirectionExecutionHandles();
}

function directionRemainingMs() {
  if (!directionRun.runSeconds) return null;
  if (!directionRun.executionStarted) return directionRun.executionRemainingMs;
  if (directionRun.paused) return directionRun.executionRemainingMs;
  return Math.max(0, directionRun.executionEndAt - Date.now());
}

function updateDirectionCounter() {
  const remaining = directionRemainingMs();
  $('directionCounter').textContent = remaining == null
    ? `${directionRun.count}回`
    : `${directionRun.count}回・残り ${Math.ceil(remaining / 1000)}秒`;
}

function scheduleDirectionExecution(delay) {
  if (!directionRun.runSeconds) return;
  clearDirectionExecutionHandles();
  directionRun.executionStarted = true;
  directionRun.executionRemainingMs = Math.max(0, delay);
  directionRun.executionEndAt = Date.now() + directionRun.executionRemainingMs;
  directionRun.endTimer = setTimeout(finishDirection, directionRun.executionRemainingMs);
  directionRun.progressTimer = setInterval(updateDirectionCounter, 100);
  updateDirectionCounter();
}

function scheduleDirectionTransition(delay = directionIntervalMs()) {
  clearTimeout(directionRun.transitionTimer);
  let actualDelay = delay;
  const runRemaining = directionRemainingMs();
  if (runRemaining != null) actualDelay = Math.min(actualDelay, runRemaining);
  directionRun.nextTransitionAt = Date.now() + actualDelay;
  directionRun.transitionTimer = setTimeout(beginDirectionTransition, actualDelay);
}

function updateDirectionCountdown() {
  if (!directionRun.active || directionRun.phase !== 'prestart') return;
  const remaining = directionRun.paused
    ? directionRun.countdownRemainingMs
    : Math.max(0, directionRun.countdownEndAt - Date.now());
  $('directionReady').textContent = String(Math.max(0, Math.ceil(remaining / 1000)));
  $('directionCounter').textContent = '開始まで';
}

function beginDirectionCountdown(delay = START_COUNTDOWN_MS) {
  clearDirectionSwitchHandles();
  directionRun.phase = 'prestart';
  directionRun.countdownRemainingMs = Math.max(0, delay);
  directionRun.countdownEndAt = Date.now() + directionRun.countdownRemainingMs;
  $('arrowWrap').classList.add('hidden');
  $('directionReady').classList.remove('hidden');
  updateDirectionCountdown();
  directionRun.countdownTimer = setTimeout(beginDirectionWorkout, directionRun.countdownRemainingMs);
  directionRun.countdownDisplayTimer = setInterval(updateDirectionCountdown, 100);
}

function beginDirectionWorkout() {
  if (!directionRun.active || directionRun.paused) return;
  clearDirectionSwitchHandles();
  directionRun.countdownRemainingMs = 0;
  directionRun.phase = 'blank';
  emitDirection();
}

function emitDirection() {
  if (!directionRun.active || directionRun.paused) return;
  if (directionRun.runSeconds && !directionRun.executionStarted) {
    scheduleDirectionExecution(directionRun.executionRemainingMs);
  }
  if (directionRun.runSeconds && directionRemainingMs() <= 0) {
    finishDirection();
    return;
  }
  const direction = DIRECTIONS[Math.floor(Math.random() * DIRECTIONS.length)];
  const colorClass = directionRun.count % 2 === 0 ? 'arrow-green' : 'arrow-orange';
  setArrow(direction, colorClass);
  $('directionReady').classList.add('hidden');
  $('arrowWrap').classList.remove('hidden');
  directionRun.phase = 'shown';
  directionRun.count += 1;
  updateDirectionCounter();
  playCue('direction');
  scheduleDirectionTransition();
}

function beginDirectionTransition() {
  if (!directionRun.active || directionRun.paused) return;
  if (directionRun.runSeconds && directionRemainingMs() <= 0) {
    finishDirection();
    return;
  }
  $('arrowWrap').classList.add('hidden');
  directionRun.phase = 'blank';
  clearTimeout(directionRun.blankTimer);
  directionRun.blankTimer = setTimeout(emitDirection, BLANK_MS);
}

async function startDirection() {
  setError('directionSetupError');
  let settings;
  try {
    settings = getDirectionFormValues();
    await unlockAudio();
  } catch (error) {
    setError('directionSetupError', error.message);
    return;
  }

  appData.lastDirection = clone(settings);
  saveData();
  Object.assign(directionRun, settings, {
    active: true,
    paused: false,
    count: 0,
    phase: 'prestart',
    remainingMs: 0,
    countdownEndAt: 0,
    countdownRemainingMs: START_COUNTDOWN_MS,
    executionStarted: false,
    executionEndAt: 0,
    executionRemainingMs: settings.runSeconds ? settings.runSeconds * 1000 : 0
  });
  updateDirectionCounter();
  $('arrowWrap').classList.add('hidden');
  $('directionReady').classList.remove('hidden');
  $('directionReady').textContent = '3';
  $('directionPausedOverlay').classList.add('hidden');
  $('pauseDirectionBtn').textContent = '一時停止';
  showView('directionRunView');
  const locked = await requestWakeLock();
  if (!locked && !('wakeLock' in navigator)) showToast('画面が消える場合は自動ロックを一時的に解除してください。');
  beginDirectionCountdown();
}

function pauseDirection(auto = false) {
  if (!directionRun.active || directionRun.paused) return;
  if (directionRun.phase === 'prestart') {
    directionRun.countdownRemainingMs = Math.max(0, directionRun.countdownEndAt - Date.now());
  } else if (directionRun.phase === 'shown') {
    directionRun.remainingMs = Math.max(0, directionRun.nextTransitionAt - Date.now());
  } else {
    directionRun.remainingMs = 0;
  }
  if (directionRun.runSeconds) {
    directionRun.executionRemainingMs = directionRun.executionStarted
      ? Math.max(0, directionRun.executionEndAt - Date.now())
      : directionRun.executionRemainingMs;
  }
  directionRun.paused = true;
  clearDirectionHandles();
  if (directionRun.phase === 'prestart') updateDirectionCountdown();
  else updateDirectionCounter();
  $('directionPausedOverlay').classList.remove('hidden');
  $('pauseDirectionBtn').textContent = '再開';
  releaseWakeLock();
  if (auto) showToast('画面が非表示になったため一時停止しました。');
}

async function resumeDirection() {
  if (!directionRun.active || !directionRun.paused) return;
  try { await unlockAudio(); } catch (error) { showToast(error.message); return; }
  if (directionRun.runSeconds && directionRun.executionStarted && directionRun.executionRemainingMs <= 0) {
    finishDirection();
    return;
  }
  directionRun.paused = false;
  $('directionPausedOverlay').classList.add('hidden');
  $('pauseDirectionBtn').textContent = '一時停止';
  await requestWakeLock();
  if (directionRun.phase === 'prestart') {
    beginDirectionCountdown(directionRun.countdownRemainingMs);
    return;
  }
  if (directionRun.runSeconds && directionRun.executionStarted) {
    scheduleDirectionExecution(directionRun.executionRemainingMs);
  }
  if (directionRun.phase === 'shown' && directionRun.remainingMs > 0) {
    scheduleDirectionTransition(directionRun.remainingMs);
  } else {
    $('arrowWrap').classList.add('hidden');
    directionRun.phase = 'blank';
    directionRun.blankTimer = setTimeout(emitDirection, BLANK_MS);
  }
}

async function restartDirection() {
  try {
    await unlockAudio();
  } catch (error) {
    showToast(error.message);
    return;
  }

  clearDirectionHandles();
  Object.assign(directionRun, {
    active: true,
    paused: false,
    count: 0,
    phase: 'prestart',
    remainingMs: 0,
    countdownEndAt: 0,
    countdownRemainingMs: START_COUNTDOWN_MS,
    executionStarted: false,
    executionEndAt: 0,
    executionRemainingMs: directionRun.runSeconds ? directionRun.runSeconds * 1000 : 0
  });
  updateDirectionCounter();
  $('arrowWrap').classList.add('hidden');
  $('directionReady').classList.remove('hidden');
  $('directionReady').textContent = '3';
  $('directionPausedOverlay').classList.add('hidden');
  $('pauseDirectionBtn').textContent = '一時停止';
  await requestWakeLock();
  beginDirectionCountdown();
}

function finishDirection() {
  if (!directionRun.active) return;
  clearDirectionHandles();
  directionRun.active = false;
  directionRun.paused = false;
  directionRun.phase = 'idle';
  directionRun.executionRemainingMs = 0;
  $('arrowWrap').classList.add('hidden');
  $('directionReady').classList.remove('hidden');
  $('directionReady').textContent = '終了';
  $('directionCounter').textContent = `${directionRun.count}回・終了`;
  $('directionPausedOverlay').classList.add('hidden');
  $('pauseDirectionBtn').textContent = '一時停止';
  playCue('directionFinish');
  releaseWakeLock();
  setTimeout(() => showToast('方向指示を終了しました。'), 250);
}

function stopDirection() {
  clearDirectionHandles();
  directionRun.active = false;
  directionRun.paused = false;
  directionRun.phase = 'idle';
  releaseWakeLock();
  showView('directionSetupView');
}

function saveTimerPreset() {
  setError('timerSetupError');
  let settings;
  try { settings = getTimerFormValues(); } catch (error) {
    setError('timerSetupError', error.message);
    return;
  }
  const defaultName = `${settings.durations.join('-')} × ${settings.repeatCount}`;
  const name = $('timerPresetName').value.trim() || defaultName;
  const existing = appData.timerPresets.find((preset) => preset.name === name);
  let id;
  if (existing) {
    Object.assign(existing, settings);
    id = existing.id;
  } else {
    id = makeId('timer');
    appData.timerPresets.push({ id, name, ...settings });
  }
  appData.lastTimer = clone(settings);
  saveData();
  renderTimerPresets(id);
  $('timerPresetName').value = '';
  showToast(existing ? '保存設定を更新しました。' : '設定を保存しました。');
}

function loadTimerPreset() {
  const preset = appData.timerPresets.find((item) => item.id === $('timerPresetSelect').value);
  if (!preset) { showToast('保存設定を選択してください。'); return; }
  applyTimerSettings(preset);
  setError('timerSetupError');
  showToast('設定を読み込みました。');
}

function deleteTimerPreset() {
  const id = $('timerPresetSelect').value;
  if (!id) return;
  appData.timerPresets = appData.timerPresets.filter((preset) => preset.id !== id);
  saveData();
  renderTimerPresets();
  showToast('保存設定を削除しました。');
}

function saveDirectionPreset() {
  setError('directionSetupError');
  let settings;
  try { settings = getDirectionFormValues(); } catch (error) {
    setError('directionSetupError', error.message);
    return;
  }
  const intervalName = settings.mode === 'fixed'
    ? `指定 ${settings.fixed}秒`
    : `ランダム ${settings.min}〜${settings.max}秒`;
  const defaultName = settings.runSeconds
    ? `${intervalName}・${settings.runSeconds}秒間`
    : intervalName;
  const name = $('directionPresetName').value.trim() || defaultName;
  const existing = appData.directionPresets.find((preset) => preset.name === name);
  let id;
  if (existing) {
    Object.assign(existing, settings);
    id = existing.id;
  } else {
    id = makeId('direction');
    appData.directionPresets.push({ id, name, ...settings });
  }
  appData.lastDirection = clone(settings);
  saveData();
  renderDirectionPresets(id);
  $('directionPresetName').value = '';
  showToast(existing ? '保存設定を更新しました。' : '設定を保存しました。');
}

function loadDirectionPreset() {
  const preset = appData.directionPresets.find((item) => item.id === $('directionPresetSelect').value);
  if (!preset) { showToast('保存設定を選択してください。'); return; }
  applyDirectionSettings(preset);
  setError('directionSetupError');
  showToast('設定を読み込みました。');
}

function deleteDirectionPreset() {
  const id = $('directionPresetSelect').value;
  if (!id) return;
  appData.directionPresets = appData.directionPresets.filter((preset) => preset.id !== id);
  saveData();
  renderDirectionPresets();
  showToast('保存設定を削除しました。');
}

function updateOfflineBadge() {
  const badge = $('offlineBadge');
  const secure = window.isSecureContext || location.hostname === 'localhost';
  if (!secure) {
    badge.textContent = 'HTTPSが必要';
    badge.classList.remove('ready');
    return;
  }
  if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
    badge.textContent = navigator.onLine ? 'オフライン対応' : 'オフライン中';
    badge.classList.add('ready');
  } else {
    badge.textContent = navigator.onLine ? '初回準備中' : '未準備';
    badge.classList.remove('ready');
  }
}

async function registerServiceWorker() {
  updateOfflineBadge();
  if (!('serviceWorker' in navigator) || !(window.isSecureContext || location.hostname === 'localhost')) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    await registration.update();
    await navigator.serviceWorker.ready;
    updateOfflineBadge();
    navigator.serviceWorker.addEventListener('controllerchange', updateOfflineBadge);
  } catch (error) {
    console.warn('オフライン機能を準備できませんでした。', error);
    $('offlineBadge').textContent = '準備失敗';
  }
}

function bindEvents() {
  $('openTimerBtn').addEventListener('click', () => showView('timerSetupView'));
  $('openDirectionBtn').addEventListener('click', () => showView('directionSetupView'));
  document.querySelectorAll('[data-back-home]').forEach((button) => button.addEventListener('click', () => showView('homeView')));

  document.querySelectorAll('input[name="repeatMode"]').forEach((input) => input.addEventListener('change', updateRepeatVisibility));
  document.querySelectorAll('input[name="intervalMode"]').forEach((input) => input.addEventListener('change', updateIntervalVisibility));
  document.querySelectorAll('[data-step-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = $(button.dataset.stepTarget);
      const next = clampInteger(Number(input.value) + Number(button.dataset.step), Number(input.min), Number(input.max), Number(input.min));
      input.value = String(next);
    });
  });

  $('timerPresetSelect').addEventListener('change', () => { $('deleteTimerPresetBtn').disabled = !$('timerPresetSelect').value; });
  $('directionPresetSelect').addEventListener('change', () => { $('deleteDirectionPresetBtn').disabled = !$('directionPresetSelect').value; });
  $('loadTimerPresetBtn').addEventListener('click', loadTimerPreset);
  $('saveTimerPresetBtn').addEventListener('click', saveTimerPreset);
  $('deleteTimerPresetBtn').addEventListener('click', deleteTimerPreset);
  $('loadDirectionPresetBtn').addEventListener('click', loadDirectionPreset);
  $('saveDirectionPresetBtn').addEventListener('click', saveDirectionPreset);
  $('deleteDirectionPresetBtn').addEventListener('click', deleteDirectionPreset);

  $('testSoundTimerBtn').addEventListener('click', () => testSound('segment'));
  $('testSoundDirectionBtn').addEventListener('click', () => testSound('direction'));
  $('startTimerBtn').addEventListener('click', startTimer);
  $('startDirectionBtn').addEventListener('click', startDirection);

  $('pauseTimerBtn').addEventListener('click', () => timerRun.paused ? resumeTimer() : pauseTimer());
  $('restartTimerBtn').addEventListener('click', restartTimer);
  $('exitTimerBtn').addEventListener('click', stopTimer);
  $('pauseDirectionBtn').addEventListener('click', () => directionRun.paused ? resumeDirection() : pauseDirection());
  $('restartDirectionBtn').addEventListener('click', restartDirection);
  $('exitDirectionBtn').addEventListener('click', stopDirection);

  $('fullscreenTimerBtn').addEventListener('click', enterFullscreen);
  $('fullscreenDirectionBtn').addEventListener('click', enterFullscreen);

  const dialog = $('installDialog');
  $('showInstallHelpBtn').addEventListener('click', () => dialog.showModal());
  $('closeInstallDialogBtn').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  window.addEventListener('online', updateOfflineBadge);
  window.addEventListener('offline', updateOfflineBadge);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (timerRun.active && !timerRun.paused) pauseTimer(true);
      if (directionRun.active && !directionRun.paused) pauseDirection(true);
    }
  });
}

function initialize() {
  document.querySelectorAll('[data-app-version]').forEach((node) => { node.textContent = `v${APP_VERSION}`; });
  document.getElementById('nextDirectionBtn')?.remove();
  fillSecondSelect($('fixedIntervalSelect'), 3);
  fillSecondSelect($('randomMinSelect'), 2);
  fillSecondSelect($('randomMaxSelect'), 5);
  renderTimerPresets();
  renderDirectionPresets();
  applyTimerSettings(appData.lastTimer);
  applyDirectionSettings(appData.lastDirection);
  bindEvents();
  registerServiceWorker();
}

initialize();
