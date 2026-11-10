const $ = (id) => document.getElementById(id);
const fileInput = $('file-input');
const importButton = $('import-button');
const playButton = $('play-button');
const seek = $('seek');
const barsHost = $('viz-bars');
let song = null;
let audio = null;
let master = null;
let playing = false;
let playStartedAt = 0;
let offsetAtStart = 0;
let currentPosition = 0;
let raf = 0;
let voices = [];
let toastTimer;

// A small seeded pattern makes the empty player feel alive without audio.
let seed = 17;
for (let i = 0; i < 76; i++) {
  seed = (seed * 9301 + 49297) % 233280;
  const bar = document.createElement('span');
  bar.className = 'viz-bar';
  bar.style.height = `${8 + (seed / 233280) * 31}%`;
  barsHost.appendChild(bar);
}
const bars = [...barsHost.children];

function notify(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

function formatTime(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function readMidi(buffer) {
  const data = new DataView(buffer);
  const ascii = (start, length) => Array.from({ length }, (_, i) => String.fromCharCode(data.getUint8(start + i))).join('');
  if (buffer.byteLength < 14 || ascii(0, 4) !== 'MThd') throw new Error('This file does not look like a standard MIDI file.');
  const headerLength = data.getUint32(4);
  const format = data.getUint16(8);
  const trackCount = data.getUint16(10);
  const division = data.getUint16(12);
  if (format === 2) throw new Error('Type 2 MIDI files contain separate sequences. Please try a Type 0 or Type 1 file.');
  if (division & 0x8000) throw new Error('This MIDI file uses SMPTE timing, which this player does not support yet.');
  if (!division) throw new Error('This MIDI file has an invalid timing division.');

  let cursor = 8 + headerLength;
  const tempos = [{ tick: 0, micros: 500000 }];
  const rawNotes = [];
  const trackNames = [];
  let lastTick = 0;

  const readVLQ = (state) => {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      if (state.pos >= state.end) throw new Error('Unexpected end of MIDI data.');
      const byte = data.getUint8(state.pos++);
      value = (value << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) return value;
    }
    throw new Error('Invalid MIDI variable-length value.');
  };

  for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
    if (cursor + 8 > buffer.byteLength || ascii(cursor, 4) !== 'MTrk') throw new Error('A MIDI track is missing or damaged.');
    const length = data.getUint32(cursor + 4);
    const state = { pos: cursor + 8, end: cursor + 8 + length };
    if (state.end > buffer.byteLength) throw new Error('A MIDI track is incomplete.');
    cursor = state.end;
    let tick = 0;
    let runningStatus = 0;
    const active = new Map();

    while (state.pos < state.end) {
      tick += readVLQ(state);
      lastTick = Math.max(lastTick, tick);
      let status = data.getUint8(state.pos++);
      if (status < 0x80) {
        if (!runningStatus) throw new Error('Invalid MIDI running status.');
        state.pos--;
        status = runningStatus;
      } else if (status < 0xf0) runningStatus = status;

      if (status === 0xff) {
        runningStatus = 0;
        if (state.pos >= state.end) break;
        const type = data.getUint8(state.pos++);
        const size = readVLQ(state);
        const at = state.pos;
        if (type === 0x51 && size === 3) {
          const micros = (data.getUint8(at) << 16) | (data.getUint8(at + 1) << 8) | data.getUint8(at + 2);
          if (micros > 0) tempos.push({ tick, micros });
        } else if (type === 0x03 && size) {
          const name = new TextDecoder().decode(new Uint8Array(buffer, at, size)).replace(/\0/g, '').trim();
          if (name) trackNames[trackIndex] = name;
        }
        state.pos += size;
        continue;
      }
      if (status === 0xf0 || status === 0xf7) {
        runningStatus = 0;
        state.pos += readVLQ(state);
        continue;
      }
      if (status >= 0xf0) {
        runningStatus = 0;
        const skip = status === 0xf1 || status === 0xf3 ? 1 : status === 0xf2 ? 2 : 0;
        state.pos += skip;
        continue;
      }

      const kind = status & 0xf0;
      const channel = status & 0x0f;
      if (state.pos >= state.end) throw new Error('Incomplete MIDI event.');
      const a = data.getUint8(state.pos++);
      const oneByte = kind === 0xc0 || kind === 0xd0;
      const b = oneByte ? 0 : (state.pos < state.end ? data.getUint8(state.pos++) : 0);
      if (kind === 0x90 && b > 0) {
        const key = `${channel}:${a}`;
        if (!active.has(key)) active.set(key, []);
        active.get(key).push({ tick, pitch: a, velocity: b / 127, channel, trackIndex });
      } else if (kind === 0x80 || (kind === 0x90 && b === 0)) {
        const key = `${channel}:${a}`;
        const stack = active.get(key);
        const note = stack?.shift();
        if (note) rawNotes.push({ ...note, endTick: Math.max(tick, note.tick + 1) });
      }
    }
    for (const stack of active.values()) for (const note of stack) rawNotes.push({ ...note, endTick: Math.max(lastTick, note.tick + division / 2) });
  }

  tempos.sort((a, b) => a.tick - b.tick);
  const compact = [];
  for (const tempo of tempos) {
    if (compact.length && compact[compact.length - 1].tick === tempo.tick) compact[compact.length - 1] = tempo;
    else compact.push(tempo);
  }
  if (compact[0].tick !== 0) compact.unshift({ tick: 0, micros: 500000 });
  const timeAtTick = (target) => {
    let seconds = 0, previousTick = 0, micros = 500000;
    for (const tempo of compact) {
      if (tempo.tick > target) break;
      seconds += (tempo.tick - previousTick) * micros / division / 1e6;
      previousTick = tempo.tick;
      micros = tempo.micros;
    }
    return seconds + (target - previousTick) * micros / division / 1e6;
  };
  const notes = rawNotes.map((n) => ({ ...n, start: timeAtTick(n.tick), end: timeAtTick(n.endTick) })).filter((n) => Number.isFinite(n.start) && Number.isFinite(n.end));
  if (!notes.length) throw new Error('I could not find any playable notes in this MIDI file.');
  const duration = Math.max(...notes.map((n) => n.end), timeAtTick(lastTick));
  return { notes, duration, trackNames, trackCount, title: trackNames.find(Boolean) || '' };
}

function clearVoices() {
  for (const voice of voices) {
    try { voice.osc.stop(); } catch {}
    try { voice.osc.disconnect(); voice.gain.disconnect(); } catch {}
  }
  voices = [];
}

function getAudio() {
  if (!audio) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) throw new Error('Web Audio is not available in this browser.');
    audio = new AudioCtx();
    master = audio.createGain();
    master.gain.value = Number($('volume').value) / 100;
    master.connect(audio.destination);
  }
  return audio;
}

function voice(note, startAt, endAt) {
  if (endAt <= startAt) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  // A gentle, slightly bell-like triangle tone makes chords clear without samples.
  osc.type = 'triangle';
  osc.frequency.value = 440 * Math.pow(2, (note.pitch - 69) / 12);
  const peak = Math.max(0.012, note.velocity * 0.12);
  gain.gain.setValueAtTime(0, startAt);
  if (endAt - startAt < 0.07) {
    gain.gain.linearRampToValueAtTime(peak, startAt + (endAt - startAt) * 0.22);
    gain.gain.linearRampToValueAtTime(0, endAt);
  } else {
    gain.gain.linearRampToValueAtTime(peak, startAt + 0.018);
    gain.gain.setValueAtTime(peak * 0.72, endAt - 0.055);
    gain.gain.linearRampToValueAtTime(0, endAt);
  }
  osc.connect(gain);
  gain.connect(master);
  osc.start(startAt);
  osc.stop(endAt + 0.01);
  voices.push({ osc, gain });
  osc.onended = () => {
    try { osc.disconnect(); gain.disconnect(); } catch {}
    voices = voices.filter((v) => v.osc !== osc);
  };
}

function setPlayIcon(isPlaying) {
  playButton.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  playButton.title = isPlaying ? 'Pause' : 'Play';
  playButton.innerHTML = isPlaying
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5.8c0-.4.3-.8.8-.8h2.1c.4 0 .8.4.8.8v12.4c0 .4-.4.8-.8.8H7.8c-.5 0-.8-.4-.8-.8V5.8Zm7.3 0c0-.4.3-.8.8-.8h2.1c.5 0 .8.4.8.8v12.4c0 .4-.3.8-.8.8h-2.1c-.5 0-.8-.4-.8-.8V5.8Z"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.8c0-.8.9-1.3 1.6-.9l9.1 5.5a1.8 1.8 0 0 1 0 3.1l-9.1 5.5c-.7.4-1.6-.1-1.6-.9V5.8Z"/></svg>';
}

function updateUI(position) {
  currentPosition = Math.min(song.duration, Math.max(0, position));
  $('elapsed').textContent = formatTime(currentPosition);
  seek.value = String(Math.round(currentPosition / song.duration * 1000));
  const phase = currentPosition * 0.9;
  for (let i = 0; i < bars.length; i++) {
    const wave = Math.sin(i * 0.39 + phase) * Math.cos(i * 0.13 - phase * 0.43);
    const activity = playing ? Math.abs(wave) : 0.08;
    bars[i].style.height = `${Math.max(5, 9 + (playing ? 54 : 17) * activity)}%`;
  }
}

function finishPlayback() {
  playing = false;
  clearVoices();
  $('visualizer').classList.remove('playing');
  $('live-text').textContent = 'PAUSED';
  setPlayIcon(false);
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

function frame() {
  if (!playing || !song) return;
  const position = offsetAtStart + (performance.now() - playStartedAt) / 1000;
  if (position >= song.duration) {
    updateUI(song.duration);
    finishPlayback();
    $('live-text').textContent = 'FINISHED';
    $('viz-caption').textContent = 'THAT WAS LOVELY';
    return;
  }
  updateUI(position);
  raf = requestAnimationFrame(frame);
}

async function startPlayback(position = currentPosition) {
  if (!song) { notify('Import a MIDI file to start listening.'); return; }
  try {
    getAudio();
    await audio.resume();
    clearVoices();
    const now = audio.currentTime + 0.055;
    for (const note of song.notes) {
      if (note.end <= position) continue;
      const startAt = now + Math.max(0, note.start - position);
      const endAt = now + (note.end - position);
      voice(note, startAt, endAt);
    }
    offsetAtStart = position;
    currentPosition = position;
    playStartedAt = performance.now();
    playing = true;
    $('visualizer').classList.add('playing');
    $('live-text').textContent = 'PLAYING';
    $('viz-caption').textContent = 'NOW IN THE MOMENT';
    setPlayIcon(true);
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  } catch (error) { notify(error.message || 'Audio could not start.'); }
}

function pausePlayback() {
  if (!playing) return;
  currentPosition = Math.min(song.duration, offsetAtStart + (performance.now() - playStartedAt) / 1000);
  finishPlayback();
  updateUI(currentPosition);
}

async function loadFile(file) {
  if (!file) return;
  try {
    const parsed = readMidi(await file.arrayBuffer());
    if (playing) pausePlayback();
    clearVoices();
    song = parsed;
    currentPosition = 0;
    $('track-title').textContent = parsed.title || file.name.replace(/\.(midi?)$/i, '') || 'Untitled MIDI';
    $('track-subtitle').textContent = `${formatTime(parsed.duration)} · ${file.name}`;
    $('duration').textContent = formatTime(parsed.duration);
    $('track-count').textContent = `${parsed.trackCount} ${parsed.trackCount === 1 ? 'TRACK' : 'TRACKS'}`;
    $('viz-caption').textContent = 'READY TO PLAY';
    $('live-text').textContent = 'LOADED';
    $('visualizer').classList.add('has-song');
    updateUI(0);
  } catch (error) { notify(error.message || 'That MIDI file could not be loaded.'); }
}

importButton.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { loadFile(fileInput.files[0]); fileInput.value = ''; });
playButton.addEventListener('click', () => playing ? pausePlayback() : startPlayback(currentPosition >= (song?.duration || Infinity) ? 0 : currentPosition));
$('restart-button').addEventListener('click', () => {
  if (!song) { notify('Import a MIDI file first.'); return; }
  if (playing) { pausePlayback(); startPlayback(0); }
  else { currentPosition = 0; updateUI(0); $('live-text').textContent = 'LOADED'; }
});
$('stop-button').addEventListener('click', () => {
  if (!song) return;
  if (playing) pausePlayback();
  currentPosition = 0;
  updateUI(0);
  $('live-text').textContent = 'STOPPED';
  $('viz-caption').textContent = 'READY TO PLAY';
});
seek.addEventListener('input', () => {
  if (!song) return;
  const target = Number(seek.value) / 1000 * song.duration;
  if (playing) startPlayback(target);
  else { currentPosition = target; updateUI(target); }
});
$('volume').addEventListener('input', (event) => {
  const value = Number(event.target.value);
  $('volume-value').textContent = `${value}%`;
  if (master && audio) master.gain.setTargetAtTime(value / 100, audio.currentTime, 0.025);
});

for (const event of ['dragenter', 'dragover']) document.addEventListener(event, (e) => { e.preventDefault(); $('visualizer').style.outline = '2px dashed #c4d0bd'; });
for (const event of ['dragleave', 'drop']) document.addEventListener(event, (e) => { e.preventDefault(); $('visualizer').style.outline = ''; });
document.addEventListener('drop', (e) => { const file = [...(e.dataTransfer?.files || [])].find((f) => /\.(mid|midi)$/i.test(f.name)); if (file) loadFile(file); else notify('Drop a .mid or .midi file to import it.'); });

let conversionBusy = false;
let activeJobId = null;
const audioInput = $('audio-input');
const jobStatus = $('job-status');
const jobProgress = $('job-progress');
const cancelJob = $('cancel-job');
const resultPanel = $('conversion-result');
const converterControls = [$('audio-import-button'), $('fast-mode'), $('preview-mode'), ...$('youtube-form').querySelectorAll('button')];

$('audio-import-button').addEventListener('click', () => audioInput.click());
audioInput.addEventListener('change', async () => {
  const file = audioInput.files[0];
  if (!file) return;
  $('source-filename').textContent = file.name;
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('fast', String($('fast-mode').checked));
  form.append('preview', String($('preview-mode').checked));
  audioInput.value = '';
  await beginConversion(() => fetch('/api/jobs/upload', { method: 'POST', body: form }));
});

$('youtube-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = $('youtube-url').value.trim();
  if (!url) { notify('Paste a YouTube link first.'); return; }
  await beginConversion(() => fetch('/api/jobs/youtube', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, fast: $('fast-mode').checked, preview: $('preview-mode').checked }),
  }));
});

cancelJob.addEventListener('click', async () => {
  if (!activeJobId) return;
  const id = activeJobId;
  cancelJob.disabled = true;
  try {
    const response = await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' });
    if (!response.ok) throw new Error();
  } catch {
    if (activeJobId === id) cancelJob.disabled = false;
    notify('Could not stop the conversion. Try again.');
  }
});

async function beginConversion(sendRequest, existingId = null) {
  if (conversionBusy) return;
  conversionBusy = true;
  converterControls.forEach((control) => { control.disabled = true; });
  jobStatus.hidden = false;
  resultPanel.hidden = true;
  $('job-message').textContent = existingId ? 'Reconnecting to your conversion…' : 'Starting conversion…';
  jobProgress.hidden = false;
  jobProgress.removeAttribute('value');
  $('job-detail').textContent = '';
  $('job-log').textContent = '';
  try {
    let id = existingId;
    if (!id) {
      const response = await sendRequest();
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not start the conversion.');
      id = data.id;
    }
    activeJobId = id;
    cancelJob.hidden = false;
    cancelJob.disabled = false;
    let state = 'queued';
    let status;
    while (['queued', 'running', 'cancelling'].includes(state)) {
      const statusResponse = await fetch(`/api/jobs/${id}`);
      status = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(status.error || 'Could not read conversion status.');
      state = status.state;
      if ($('job-message').textContent !== status.message) $('job-message').textContent = status.message;
      const active = ['queued', 'running', 'cancelling'].includes(state);
      jobProgress.hidden = !active;
      if (active && typeof status.progress === 'number') {
        jobProgress.max = 100;
        jobProgress.value = status.progress;
      } else {
        jobProgress.removeAttribute('value');
      }
      const detail = [];
      if (active && typeof status.progress === 'number') detail.push(`${status.progress}% of this step`);
      if (typeof status.elapsed === 'number') detail.push(`${formatTime(status.elapsed)} elapsed`);
      $('job-detail').textContent = detail.join(' · ');
      $('job-log').textContent = (status.logs || []).slice(-12).join('\n');
      $('job-log').scrollTop = $('job-log').scrollHeight;
      if (active) await new Promise((resolve) => setTimeout(resolve, 1800));
    }
    cancelJob.hidden = true;
    if (state === 'cancelled') return;
    if (state !== 'done') throw new Error($('job-message').textContent || 'Conversion failed.');
    resultPanel.hidden = false;
    const midiUrl = `/api/jobs/${id}/midi`;
    const midiName = status.preview ? 'Piano preview.mid' : 'Piano accompaniment.mid';
    $('download-midi').href = midiUrl;
    $('download-midi').download = midiName;
    $('result-message').textContent = status.preview ? '30-second piano preview is ready.' : 'Piano MIDI is ready.';
    const midiResponse = await fetch(midiUrl);
    if (midiResponse.ok) {
      const blob = await midiResponse.blob();
      await loadFile(new File([blob], midiName, { type: 'audio/midi' }));
    }
    $('youtube-url').value = '';
  } catch (error) {
    $('job-message').textContent = error.message || 'Conversion failed.';
    notify(error.message || 'Conversion failed.');
  } finally {
    activeJobId = null;
    cancelJob.hidden = true;
    jobProgress.hidden = true;
    conversionBusy = false;
    converterControls.forEach((control) => { control.disabled = false; });
  }
}

fetch('/api/jobs/active')
  .then((response) => response.ok ? response.json() : null)
  .then((job) => { if (job?.id) return beginConversion(null, job.id); })
  .catch(() => {});
