/* Audio helpers: microphone recording, waveform drawing, players, joining segments, WAV encoding */

const AudioKit = (() => {
  let context = null;
  const mounted = new Set(); // players and idle waves that need cleanup / redraw

  function getContext() {
    if (!context) context = new (window.AudioContext || window.webkitAudioContext)();
    return context;
  }

  // Read a color token from the element itself, so speaker-scoped colors (.sp) apply
  function cssVar(name, el = document.documentElement) {
    return getComputedStyle(el).getPropertyValue(name).trim();
  }

  // Match the canvas pixel size to its CSS size (sharp on retina screens)
  function fitCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, rect.width, rect.height);
    return { g, width: rect.width, height: rect.height };
  }

  function bar(g, x, y, w, h) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, w / 2);
    else g.rect(x, y, w, h);
    g.fill();
  }

  /* Static waveform. progress: 0..1 (bars before it use the strong color).
     markers: 0..1 positions where a new segment (段) starts. */
  function drawPeaks(canvas, peaks, progress = 0, markers = []) {
    const area = fitCanvas(canvas);
    if (!area) return;
    const { g, width, height } = area;
    const barW = 2.5;
    const gap = 2;
    const count = Math.max(1, Math.floor(width / (barW + gap)));
    const strong = cssVar("--wave", canvas);
    const dim = cssVar("--wave-dim", canvas);
    // Step 1: segment boundaries as faint full-height hairlines
    if (markers.length) {
      g.fillStyle = cssVar("--marker", canvas);
      markers.forEach((m) => {
        if (m <= 0 || m >= 1) return;
        g.fillRect(Math.round(m * width), 0, 1, height);
      });
    }
    // Step 2: the bars
    for (let i = 0; i < count; i++) {
      const v = peaks.length ? peaks[Math.floor((i * peaks.length) / count)] : 0;
      const h = Math.max(2, v * (height - 6));
      g.fillStyle = progress > 0 && i / count < progress ? strong : dim;
      bar(g, i * (barW + gap), (height - h) / 2, barW, h);
    }
  }

  // Live waveform while recording: newest level on the right, drawn in vermilion
  function drawLive(canvas, levels) {
    const area = fitCanvas(canvas);
    if (!area) return;
    const { g, width, height } = area;
    const barW = 2.5;
    const gap = 2;
    const count = Math.max(1, Math.floor(width / (barW + gap)));
    const recent = levels.slice(-count);
    const offset = count - recent.length;
    g.fillStyle = cssVar("--wave-dim", canvas);
    for (let i = 0; i < offset; i++) bar(g, i * (barW + gap), height / 2 - 1, barW, 2);
    g.fillStyle = cssVar("--rec", canvas);
    recent.forEach((level, i) => {
      const h = Math.max(2, Math.min(1, level / 0.5) * (height - 4));
      bar(g, (offset + i) * (barW + gap), (height - h) / 2, barW, h);
    });
  }

  // Scale peaks for display; quiet audio stays visibly quiet
  function normalizePeaks(peaks) {
    const max = Math.max(0.25, ...peaks);
    return peaks.map((p) => Math.min(1, p / max));
  }

  function computePeaks(samples, count = 240) {
    const size = Math.max(1, Math.floor(samples.length / count));
    const peaks = [];
    for (let i = 0; i < count; i++) {
      let max = 0;
      const end = Math.min(samples.length, (i + 1) * size);
      for (let j = i * size; j < end; j++) {
        const v = Math.abs(samples[j]);
        if (v > max) max = v;
      }
      peaks.push(max);
    }
    return peaks;
  }

  async function decodeBlob(blob) {
    const buffer = await blob.arrayBuffer();
    return getContext().decodeAudioData(buffer);
  }

  // Decode any audio Blob -> { duration, peak, peaks }
  async function analyzeBlob(blob) {
    const audio = await decodeBlob(blob);
    const samples = audio.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    return { duration: audio.duration, peak, peaks: normalizePeaks(computePeaks(samples)) };
  }

  /* Join several audio Blobs into one WAV with a short pause between them.
     Returns { blob, duration, starts: [sec], durations: [sec], peaks } */
  async function joinBlobs(blobs, gapSeconds = 0.25) {
    // Step 1: decode every segment (decodeAudioData resamples to one rate)
    const buffers = [];
    for (const b of blobs) buffers.push(await decodeBlob(b));
    const rate = getContext().sampleRate;
    const gap = Math.round(gapSeconds * rate);
    const total = buffers.reduce((sum, buf) => sum + buf.length, 0) + gap * Math.max(0, buffers.length - 1);
    // Step 2: copy them one after another into a single mono track
    const out = new Float32Array(total);
    const starts = [];
    const durations = [];
    let pos = 0;
    buffers.forEach((buf, i) => {
      starts.push(pos / rate);
      durations.push(buf.length / rate);
      out.set(buf.getChannelData(0), pos);
      pos += buf.length + (i < buffers.length - 1 ? gap : 0);
    });
    // Step 3: encode as 16-bit WAV
    const pcm = new Int16Array(total);
    for (let i = 0; i < total; i++) pcm[i] = Math.max(-1, Math.min(1, out[i])) * 32767;
    return {
      blob: encodeWav(pcm, rate),
      duration: total / rate,
      starts,
      durations,
      peaks: normalizePeaks(computePeaks(out, 360)),
    };
  }

  // Start recording from the microphone; returns a controller with stop() / cancel()
  async function startRecording(canvas) {
    // Step 1: check browser support (microphone needs HTTPS or localhost)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      const err = new Error("unsupported");
      err.name = "NotSupportedError";
      throw err;
    }
    // Step 2: ask for microphone permission; keep the raw sound for voice training
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    // Step 3: connect an analyser to read the input level for the live waveform
    const ac = getContext();
    if (ac.state === "suspended") await ac.resume();
    const source = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    // Step 4: record with MediaRecorder (Chrome: webm, Safari: mp4)
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    const levels = [];
    const samples = new Float32Array(analyser.fftSize);
    const startedAt = performance.now();
    let peak = 0;
    let lastPush = 0;
    let raf = 0;

    function frame(now) {
      analyser.getFloatTimeDomainData(samples);
      let level = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = Math.abs(samples[i]);
        if (v > level) level = v;
      }
      peak = Math.max(peak, level);
      if (now - lastPush > 45) {
        levels.push(level);
        lastPush = now;
      }
      drawLive(canvas, levels);
      raf = requestAnimationFrame(frame);
    }

    function cleanup() {
      cancelAnimationFrame(raf);
      try { source.disconnect(); } catch { /* already disconnected */ }
      stream.getTracks().forEach((t) => t.stop());
    }

    recorder.start();
    raf = requestAnimationFrame(frame);

    return {
      elapsed: () => (performance.now() - startedAt) / 1000,
      stop: () => new Promise((resolve) => {
        recorder.onstop = () => {
          cleanup();
          resolve({
            blob: new Blob(chunks, { type: recorder.mimeType || "audio/webm" }),
            duration: (performance.now() - startedAt) / 1000,
            peak,
            peaks: normalizePeaks(levels),
          });
        };
        recorder.stop();
      }),
      cancel: () => {
        recorder.onstop = null;
        try { recorder.stop(); } catch { /* not recording */ }
        cleanup();
      },
    };
  }

  // Flat placeholder waveform shown before anything is recorded
  function mountIdleWave(box) {
    const canvas = document.createElement("canvas");
    canvas.className = "wave-canvas";
    canvas.setAttribute("aria-hidden", "true");
    box.appendChild(canvas);
    const redraw = () => drawPeaks(canvas, [], 0);
    const ro = new ResizeObserver(redraw);
    ro.observe(canvas);
    const entry = { root: canvas, audio: null, redraw, destroy() { ro.disconnect(); mounted.delete(entry); } };
    mounted.add(entry);
    return canvas;
  }

  /* Player.
     options.variant: "default" | "compact" | "bar" (music-player style with loop button)
     options.peaks / options.duration: precomputed values (skip decoding)
     options.markers: segment start times in seconds
     options.onTime(seconds): called while playing / seeking */
  function createPlayer(blob, options = {}) {
    const variant = options.variant || "default";
    const root = document.createElement("div");
    root.className = `player${variant === "default" ? "" : ` player-${variant}`}`;
    const isBar = variant === "bar";
    root.innerHTML = isBar
      ? `<button type="button" class="player-btn" aria-label="再生">${UI.ICONS.play}</button>
         <span class="player-time is-current">0:00.0</span>
         <canvas class="player-wave" tabindex="0" role="slider" aria-label="再生位置" aria-valuemin="0"></canvas>
         <span class="player-time is-total">0:00.0</span>
         <button type="button" class="player-loop" aria-pressed="false" aria-label="リピート再生">${UI.ICONS.loop}</button>`
      : `<button type="button" class="player-btn" aria-label="再生">${UI.ICONS.play}</button>
         <canvas class="player-wave" tabindex="0" role="slider" aria-label="再生位置" aria-valuemin="0"></canvas>
         <span class="player-time">0:00.0</span>`;
    const btn = root.querySelector(".player-btn");
    const canvas = root.querySelector(".player-wave");
    const curEl = root.querySelector(isBar ? ".is-current" : ".player-time");
    const totalEl = isBar ? root.querySelector(".is-total") : null;
    const loopBtn = root.querySelector(".player-loop");
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    let peaks = options.peaks || null;
    let knownDuration = options.duration || 0;
    let raf = 0;

    // MediaRecorder files often report Infinity, so fall back to the analysed length
    const duration = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : knownDuration);

    function draw() {
      const d = duration();
      const markers = d && options.markers ? options.markers.map((t) => t / d) : [];
      drawPeaks(canvas, peaks || [], d ? audio.currentTime / d : 0, markers);
      canvas.setAttribute("aria-valuemax", String(Math.round(d * 10) / 10));
      canvas.setAttribute("aria-valuenow", String(Math.round(audio.currentTime * 10) / 10));
      if (isBar) {
        curEl.textContent = UI.formatSeconds(audio.currentTime);
        totalEl.textContent = UI.formatSeconds(d);
      } else {
        curEl.textContent = audio.currentTime > 0
          ? `${UI.formatSeconds(audio.currentTime)} / ${UI.formatSeconds(d)}`
          : UI.formatSeconds(d);
      }
      if (options.onTime) options.onTime(audio.currentTime);
    }

    function loop() {
      draw();
      if (!audio.paused) raf = requestAnimationFrame(loop);
    }

    function seek(seconds) {
      const d = duration();
      if (!d) return;
      audio.currentTime = Math.max(0, Math.min(d - 0.01, seconds));
      draw();
    }

    function play() {
      stopAll();
      audio.play().catch(() => UI.toast("音声を再生できませんでした。", "error"));
    }

    btn.addEventListener("click", () => (audio.paused ? play() : audio.pause()));
    audio.addEventListener("play", () => {
      btn.innerHTML = UI.ICONS.pause;
      btn.setAttribute("aria-label", "一時停止");
      loop();
    });
    audio.addEventListener("pause", () => {
      btn.innerHTML = UI.ICONS.play;
      btn.setAttribute("aria-label", "再生");
      cancelAnimationFrame(raf);
      draw();
    });
    audio.addEventListener("ended", () => {
      audio.currentTime = 0;
      draw();
    });
    if (loopBtn) {
      loopBtn.addEventListener("click", () => {
        audio.loop = !audio.loop;
        loopBtn.setAttribute("aria-pressed", String(audio.loop));
      });
    }
    canvas.addEventListener("click", (e) => {
      const rect = canvas.getBoundingClientRect();
      seek(((e.clientX - rect.left) / rect.width) * duration());
    });
    canvas.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { seek(audio.currentTime + 2); e.preventDefault(); }
      if (e.key === "ArrowLeft") { seek(audio.currentTime - 2); e.preventDefault(); }
      if (e.key === " " || e.key === "Enter") { audio.paused ? play() : audio.pause(); e.preventDefault(); }
    });

    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);

    if (!peaks) {
      analyzeBlob(blob)
        .then((info) => { peaks = info.peaks; knownDuration = info.duration; draw(); })
        .catch(() => { peaks = []; draw(); });
    }

    const entry = {
      root,
      audio,
      redraw: draw,
      destroy() {
        audio.pause();
        cancelAnimationFrame(raf);
        ro.disconnect();
        URL.revokeObjectURL(url);
        mounted.delete(entry);
      },
    };
    mounted.add(entry);
    root.player = { audio, seek, play };
    return root;
  }

  // Repaint every waveform (colors come from CSS variables, e.g. after a theme change)
  function redrawAll() {
    mounted.forEach((m) => { if (m.redraw) m.redraw(); });
  }

  function stopAll() {
    mounted.forEach((m) => { if (m.audio) m.audio.pause(); });
  }

  // Destroy every player / idle wave inside an element before it is replaced
  function destroyIn(element) {
    if (!element) return;
    mounted.forEach((m) => { if (element.contains(m.root)) m.destroy(); });
  }

  // Generate a speech-like test WAV (used by the mock server and dev buttons)
  function makeDemoWav(seconds = 2, seed = 1) {
    const rate = 22050;
    const n = Math.floor(seconds * rate);
    const pcm = new Int16Array(n);
    let state = (seed * 9301 + 49297) % 233280;
    const rand = () => (state = (state * 9301 + 49297) % 233280) / 233280;
    const base = 140 + rand() * 70;
    const syllableLen = 0.16 + rand() * 0.06;
    let phase = 0;
    let amp = 0.6;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const syllable = (t % syllableLen) / syllableLen;
      if (i % Math.floor(syllableLen * rate) === 0) amp = 0.35 + rand() * 0.65;
      const envelope = Math.sin(Math.PI * syllable) ** 2 * amp * Math.min(1, t * 8, (seconds - t) * 8);
      const freq = base * (1 + 0.1 * Math.sin(2 * Math.PI * 1.1 * t));
      phase += (2 * Math.PI * freq) / rate;
      const s = 0.55 * Math.sin(phase) + 0.25 * Math.sin(2 * phase) + 0.12 * Math.sin(3 * phase);
      pcm[i] = Math.max(-1, Math.min(1, s * envelope * 0.7)) * 32767;
    }
    return encodeWav(pcm, rate);
  }

  // 16-bit mono PCM -> WAV Blob
  function encodeWav(pcm, rate) {
    const buffer = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buffer);
    const text = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
    text(0, "RIFF");
    view.setUint32(4, 36 + pcm.length * 2, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);   // PCM
    view.setUint16(22, 1, true);   // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, pcm.length * 2, true);
    for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, pcm[i], true);
    return new Blob([buffer], { type: "audio/wav" });
  }

  return {
    analyzeBlob, joinBlobs, normalizePeaks, startRecording, drawPeaks, cssVar, fitCanvas,
    mountIdleWave, createPlayer, stopAll, destroyIn, redrawAll, makeDemoWav,
  };
})();
