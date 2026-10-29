/* View: voice registration
   record on the spot and/or upload files -> describe what is said -> keep the total within 5 min
   -> submit -> follow training progress */

const SCRIPT_LINES = [
  "今日はよく晴れていて、散歩にちょうどいい天気です。",
  "駅前の新しいパン屋さんは、朝七時から開いています。",
  "来週の会議の資料を、金曜日までに送ってください。",
  "冷たい麦茶を一杯いただけますか。",
  "図書館で借りた本を、まだ半分しか読んでいません。",
  "電車が遅れているので、少し遅れて到着します。",
  "雨の日は、家でゆっくり映画を見るのが好きです。",
  "このボタンを押すと、録音が始まります。",
  "夏休みには、友達と京都へ旅行に行く予定です。",
  "先生の説明は、とても分かりやすかったです。",
  "机の上の書類を、右側の棚に片付けてください。",
  "秋になると、山の木々が赤や黄色に色づきます。",
  "新しいスマートフォンの使い方を教えてもらえますか。",
  "夜遅くまで勉強したので、少し眠いです。",
  "最後まで聞いていただき、ありがとうございました。",
];
const MIN_TOTAL_SECONDS = 30;
const MAX_TOTAL_SECONDS = 300;
const MAX_RECORD_SECONDS = 20;
const MAX_FILE_MB = 20;
const AUDIO_EXT = /\.(wav|mp3|m4a|aac|ogg|oga|flac|webm)$/i;
const ACTIVE_JOB_KEY = "koeutsushi.activeJob";
const SOURCE_KEY = "voicebox.recSource";

// Lives outside the view so samples survive switching pages (lost on reload)
const recordDraft = {
  name: "",
  consent: false,
  lineIndex: 0,
  source: UI.storage.get(SOURCE_KEY, "mic") === "file" ? "file" : "mic", // which way of adding is open
  samples: [],     // { id, source: "mic"|"file", name, blob, duration, peak, peaks, issues, text, lineIndex }
  uploadLog: [],   // results of the last upload: { name, ok, message }
  createdSpeakerId: null, // set once the speaker exists, so a retry does not create a duplicate
};
let sampleSeq = 0;

function resetRecordDraft() {
  recordDraft.name = "";
  recordDraft.consent = false;
  recordDraft.lineIndex = 0;
  recordDraft.samples = [];
  recordDraft.uploadLog = [];
  recordDraft.createdSpeakerId = null;
}

function checkSampleQuality(info, source) {
  const issues = [];
  if (info.duration < 1.0) {
    issues.push({ level: "error", text: "短すぎます（1 秒未満）。文の最後まで読み上げてください。" });
  }
  if (info.peak < 0.02) {
    issues.push({ level: "error", text: "音がほとんど入っていません。マイクやファイルを確認してください。" });
  } else if (info.peak < 0.08) {
    issues.push({ level: "warn", text: "音量が小さめです。もう少しマイクに近づくと、学習の精度が上がります。" });
  }
  if (info.peak > 0.98) {
    issues.push({ level: "warn", text: "音が割れている可能性があります。" });
  }
  if (source === "mic" && info.duration > 15) {
    issues.push({ level: "warn", text: "録音が長めです。読み終わったらすぐに停止してください。" });
  }
  return issues;
}

// "done" | "warn" | "error"
function sampleLevel(sample) {
  if (sample.issues.some((i) => i.level === "error")) return "error";
  return sample.issues.length ? "warn" : "done";
}

// Samples that will be sent: everything without a blocking problem
function usableSamples() {
  return recordDraft.samples.filter((s) => sampleLevel(s) !== "error");
}

function usableSeconds() {
  return usableSamples().reduce((sum, s) => sum + s.duration, 0);
}

Views.record = (() => {
  const LEVEL_CHIP = {
    done: '<span class="chip chip-ok">OK</span>',
    warn: '<span class="chip chip-warn">要確認</span>',
    error: '<span class="chip chip-err">送信されません</span>',
  };

  let root = null;
  let token = 0;
  let recorder = null;
  let timerId = null;
  let autoStopId = null;
  let pollId = null;
  let submitting = false;
  let feedback = null; // { type, html } shown under the record button

  const q = (selector) => (root ? root.querySelector(selector) : null);

  function render(container) {
    root = container;
    token++;
    const job = UI.storage.get(ACTIVE_JOB_KEY, null);
    if (job && job.jobId) renderTraining(job);
    else renderForm();
  }

  // Called when this pane is collapsed or the app is left: finish and keep the current take
  function suspend() {
    if (recorder) return stopRecording();
    return Promise.resolve();
  }

  function leave() {
    if (recorder) { recorder.cancel(); recorder = null; }
    clearInterval(timerId);
    clearTimeout(autoStopId);
    clearInterval(pollId);
    token++;
    root = null;
  }

  /* ================= Form ================= */

  function renderForm() {
    clearInterval(pollId);
    AudioKit.destroyIn(root);
    feedback = null;
    const devPanel = API_CONFIG.USE_MOCK ? `
      <details class="dev-panel">
        <summary>開発用ツール<span>モック動作中のみ</span></summary>
        <div class="dev-actions">
          <button type="button" class="btn btn-soft btn-sm" id="dev-one">この例文にテスト音声</button>
          <button type="button" class="btn btn-soft btn-sm" id="dev-fill">テスト音声で 1 分ぶん追加</button>
          <button type="button" class="btn btn-soft btn-sm" id="dev-file">テストファイルを追加</button>
          <button type="button" class="btn btn-soft btn-sm" id="dev-reset">モックデータを初期化</button>
        </div>
      </details>` : "";

    root.innerHTML = `
      <div class="c-body rec-scroll">
        <div class="rec-inner">
          <section class="rf-group">
            <label class="rf-label" for="speaker-name">話者名</label>
            <input class="input input-name" id="speaker-name" maxlength="30" autocomplete="off" placeholder="例：山田 花子">
          </section>

          <section class="rf-group" aria-labelledby="add-title">
            <h2 class="rf-label" id="add-title">素材を追加</h2>
            <div class="src-switch" role="tablist" aria-label="素材の追加方法">
              <button type="button" class="src-opt" role="tab" id="tab-mic" data-src="mic" aria-controls="panel-mic">${UI.ICONS.mic}<span>マイクで録音</span></button>
              <button type="button" class="src-opt" role="tab" id="tab-file" data-src="file" aria-controls="panel-file">${UI.ICONS.upload}<span>ファイルを追加</span></button>
            </div>

            <div class="src-stage">
              <div class="src-panel" id="panel-mic" role="tabpanel" aria-labelledby="tab-mic">
                <div class="script-meta">
                  <span class="script-no">例文 <b id="line-no">01</b> / ${SCRIPT_LINES.length}</span>
                  <span id="line-state"></span>
                  <span class="script-nav">
                    <button type="button" class="icon-btn" id="prev-line" aria-label="前の例文">${UI.ICONS.chevronLeft}</button>
                    <button type="button" class="icon-btn" id="next-line" aria-label="次の例文">${UI.ICONS.chevronRight}</button>
                  </span>
                </div>
                <p class="script-text" id="script-text" lang="ja"></p>
                <div class="wave-box" id="wave-box"></div>
                <div class="rec-row">
                  <button type="button" class="btn-record" id="rec-btn"></button>
                  <span class="rec-clock"><span class="rec-time" id="rec-time">0:00.0</span><span class="rec-limit">/ ${UI.formatClock(MAX_RECORD_SECONDS)}</span></span>
                </div>
                <div id="rec-feedback" hidden></div>
              </div>

              <div class="src-panel" id="panel-file" role="tabpanel" aria-labelledby="tab-file">
                <input type="file" id="file-input" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg,.flac" multiple class="visually-hidden">
                <label class="dropzone" id="dropzone" for="file-input">
                  <span class="dz-icon">${UI.ICONS.upload}</span>
                  <span class="dropzone-title">音声ファイルを選ぶ</span>
                  <span class="dropzone-sub">ここにドロップしても追加できます · ${MAX_FILE_MB}MB まで</span>
                </label>
                <ul class="upload-log" id="upload-log" aria-live="polite"></ul>
              </div>
            </div>
          </section>

          <section class="rf-group" aria-labelledby="samples-title">
            <h2 class="rf-label" id="samples-title">音声素材 <span class="num" id="sample-count"></span></h2>
            <div class="meter">
              <div class="meter-top">
                <span class="meter-total"><b id="total-time">0:00</b>/ 5:00</span>
                <span class="meter-note" id="meter-note"></span>
              </div>
              <div class="meter-track">
                <div class="meter-fill" id="meter-fill"></div>
                <span class="meter-min" style="left: ${(MIN_TOTAL_SECONDS / MAX_TOTAL_SECONDS) * 100}%"></span>
              </div>
              <div class="meter-scale" aria-hidden="true">
                ${[0, 1, 2, 3, 4, 5].map((m) => `<span style="left: ${m * 20}%">${m === 5 ? "5 分" : m}</span>`).join("")}
              </div>
            </div>
            <div id="sample-area"></div>
          </section>
        </div>
        <div class="rec-dev">${devPanel}</div>

        <footer class="rec-foot">
          <div class="submit-row">
            <label class="check">
              <input type="checkbox" id="consent">
              <span>本人から、録音と音声生成への利用について同意を得ています。</span>
            </label>
            <div class="submit-act">
              <p class="submit-hint" id="submit-hint"></p>
              <button type="button" class="btn btn-primary btn-lg btn-pill" id="submit-btn">送信して学習を始める</button>
            </div>
          </div>
        </footer>
      </div>`;

    // Step 1: restore the draft into the form
    q("#speaker-name").value = recordDraft.name;
    q("#consent").checked = recordDraft.consent;
    AudioKit.mountIdleWave(q("#wave-box"));

    // Step 2: wire up events
    q("#speaker-name").addEventListener("input", (e) => { recordDraft.name = e.target.value; updateSubmit(); });
    q("#consent").addEventListener("change", (e) => { recordDraft.consent = e.target.checked; updateSubmit(); });
    root.querySelectorAll(".src-opt").forEach((tab) => tab.addEventListener("click", () => setSource(tab.dataset.src, true)));
    q(".src-switch").addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setSource(recordDraft.source === "mic" ? "file" : "mic", true);
    });
    q("#rec-btn").addEventListener("click", () => (recorder ? stopRecording() : startRecording()));
    q("#prev-line").addEventListener("click", () => showLine(recordDraft.lineIndex - 1));
    q("#next-line").addEventListener("click", () => showLine(recordDraft.lineIndex + 1));
    q("#file-input").addEventListener("change", (e) => {
      const files = [...(e.target.files || [])];
      e.target.value = "";
      if (files.length) handleFiles(files);
    });
    bindDropzone();
    bindSampleList();
    q("#submit-btn").addEventListener("click", submit);
    if (API_CONFIG.USE_MOCK) bindDev();

    // Step 3: draw every part
    setSource(recordDraft.source);
    showLine(recordDraft.lineIndex);
    renderSamples();
    renderUploadLog();
  }

  /* ---------- Source switch: one area, two ways of adding ---------- */

  function setSource(src, focus = false) {
    if (!root || recorder) return;
    recordDraft.source = src === "file" ? "file" : "mic";
    UI.storage.set(SOURCE_KEY, recordDraft.source);
    ["mic", "file"].forEach((key) => {
      const on = key === recordDraft.source;
      const tab = q(`#tab-${key}`);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      q(`#panel-${key}`).hidden = !on;
      if (on && focus) tab.focus();
    });
    if (recordDraft.source === "mic") AudioKit.redrawAll();
  }

  /* ---------- Record button: dark pill → red "stop" while recording ---------- */

  function paintRecButton(mode) {
    const btn = q("#rec-btn");
    if (!btn) return;
    const look = {
      idle: { icon: UI.ICONS.mic, label: "録音をはじめる", aria: "録音をはじめる" },
      redo: { icon: UI.ICONS.mic, label: "録り直す", aria: "この例文を録り直す" },
      recording: { icon: UI.ICONS.stop, label: "録音を停止", aria: "録音を停止" },
      checking: { icon: UI.spinner(), label: "確認中…", aria: "確認中" },
    }[mode];
    btn.className = `btn-record is-${mode}`;
    btn.innerHTML = `${look.icon}<span>${look.label}</span>`;
    btn.setAttribute("aria-label", look.aria);
    btn.setAttribute("aria-pressed", String(mode === "recording"));
    btn.disabled = mode === "checking";
  }

  /* ---------- Script (例文) ---------- */

  function lineRecorded(index) {
    return recordDraft.samples.some((s) => s.lineIndex === index);
  }

  function showLine(i) {
    if (!root || recorder) return;
    recordDraft.lineIndex = Math.max(0, Math.min(SCRIPT_LINES.length - 1, i));
    const idx = recordDraft.lineIndex;
    q("#line-no").textContent = String(idx + 1).padStart(2, "0");
    q("#script-text").textContent = SCRIPT_LINES[idx];
    q("#prev-line").disabled = idx === 0;
    q("#next-line").disabled = idx === SCRIPT_LINES.length - 1;
    const done = lineRecorded(idx);
    q("#line-state").innerHTML = done ? '<span class="chip chip-ok">録音済み</span>' : "";
    paintRecButton(done ? "redo" : "idle");
    q("#rec-time").textContent = "0:00.0";
    q("#rec-time").parentElement.classList.remove("is-live");
    renderFeedback();
  }

  // After a good take, move to the next sentence that has not been recorded yet
  function advanceLine() {
    for (let step = 1; step <= SCRIPT_LINES.length; step++) {
      const next = (recordDraft.lineIndex + step) % SCRIPT_LINES.length;
      if (!lineRecorded(next)) { showLine(next); return; }
    }
    showLine(recordDraft.lineIndex);
  }

  function renderFeedback() {
    const box = q("#rec-feedback");
    if (!box) return;
    if (!feedback) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = UI.notice(feedback.type, feedback.html);
  }

  /* ---------- Recording ---------- */

  function setRecordingUi(isRecording) {
    ["#prev-line", "#next-line", "#submit-btn", "#file-input", "#tab-mic", "#tab-file"].forEach((s) => { q(s).disabled = isRecording; });
    q("#rec-time").parentElement.classList.toggle("is-live", isRecording);
    q("#dropzone").style.pointerEvents = isRecording ? "none" : "";
    q("#dropzone").style.opacity = isRecording ? "0.5" : "";
    root.querySelectorAll("[data-remove]").forEach((b) => { b.disabled = isRecording; });
    if (isRecording) {
      paintRecButton("recording");
      q("#line-state").innerHTML = '<span class="chip chip-rec is-live">録音中</span>';
      feedback = null;
      renderFeedback();
    } else {
      updateSubmit();
    }
  }

  async function startRecording() {
    const box = q("#wave-box");
    AudioKit.destroyIn(box);
    box.innerHTML = '<canvas class="wave-canvas" id="rec-wave" aria-hidden="true"></canvas>';
    try {
      recorder = await AudioKit.startRecording(q("#rec-wave"));
    } catch (err) {
      recorder = null;
      box.innerHTML = "";
      AudioKit.mountIdleWave(box);
      feedback = { type: "error", html: UI.escapeHtml(micErrorMessage(err)) };
      renderFeedback();
      return;
    }
    if (!root) { recorder.cancel(); recorder = null; return; }
    setRecordingUi(true);
    timerId = setInterval(() => {
      if (recorder && root) q("#rec-time").textContent = UI.formatSeconds(recorder.elapsed());
    }, 100);
    autoStopId = setTimeout(() => {
      if (!recorder) return;
      UI.toast(`${MAX_RECORD_SECONDS} 秒を超えたため、録音を自動で停止しました。`);
      stopRecording();
    }, MAX_RECORD_SECONDS * 1000);
  }

  async function stopRecording() {
    const active = recorder;
    if (!active) return;
    recorder = null;
    clearInterval(timerId);
    clearTimeout(autoStopId);
    const index = recordDraft.lineIndex;
    paintRecButton("checking");
    q("#rec-time").parentElement.classList.remove("is-live");
    const result = await active.stop();
    let info;
    try {
      info = await AudioKit.analyzeBlob(result.blob);
    } catch {
      info = { duration: result.duration, peak: result.peak, peaks: result.peaks };
    }
    if (!root) return;
    setRecordingUi(false);
    const box = q("#wave-box");
    box.innerHTML = "";
    AudioKit.mountIdleWave(box);
    addRecordedSample(index, result.blob, info);
  }

  function addRecordedSample(index, blob, info) {
    const sample = {
      id: ++sampleSeq,
      source: "mic",
      name: `例文 ${String(index + 1).padStart(2, "0")}`,
      blob,
      duration: info.duration,
      peak: info.peak,
      peaks: info.peaks,
      issues: checkSampleQuality(info, "mic"),
      text: SCRIPT_LINES[index],
      lineIndex: index,
    };
    const level = sampleLevel(sample);
    const existing = recordDraft.samples.findIndex((s) => s.lineIndex === index);
    // Step 1: the 5-minute limit counts only samples that will be sent
    const old = existing >= 0 ? recordDraft.samples[existing] : null;
    const base = usableSeconds() - (old && sampleLevel(old) !== "error" ? old.duration : 0);
    if (level !== "error" && base + sample.duration > MAX_TOTAL_SECONDS) {
      feedback = { type: "error", html: `合計が 5 分を超えるため追加できませんでした（残り ${UI.formatClock(MAX_TOTAL_SECONDS - base)}）。不要な素材を削除してください。` };
      showLine(index);
      return;
    }
    // Step 2: replace the earlier take of the same sentence, or append
    if (existing >= 0) recordDraft.samples.splice(existing, 1, sample);
    else recordDraft.samples.push(sample);
    // Step 3: tell the user how it went, then move on
    const items = sample.issues.map((i) => `<li>${UI.escapeHtml(i.text)}</li>`).join("");
    if (level === "error") {
      feedback = { type: "error", html: `<span>${sample.name} は送信されません。録り直してください。</span><ul>${items}</ul>` };
      renderSamples();
      showLine(index);
    } else {
      feedback = level === "warn"
        ? { type: "warn", html: `<span>${sample.name} を追加しました。録り直すと精度が上がります。</span><ul>${items}</ul>` }
        : { type: "ok", html: `<span>${sample.name} を追加しました（${UI.formatSeconds(sample.duration)}）。</span>` };
      renderSamples();
      advanceLine();
    }
  }

  function micErrorMessage(err) {
    const name = err && err.name;
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "マイクの使用が許可されていません。ブラウザの設定でマイクを許可するか、「ファイルを追加」から音声ファイルを追加してください。";
    }
    if (name === "NotFoundError") {
      return "マイクが見つかりません。マイクを接続するか、「ファイルを追加」から音声ファイルを追加してください。";
    }
    return "この環境ではマイクを使えません（HTTPS または localhost で開く必要があります）。「ファイルを追加」から音声ファイルを追加してください。";
  }

  /* ---------- Upload ---------- */

  function bindDropzone() {
    const zone = q("#dropzone");
    ["dragenter", "dragover"].forEach((type) => zone.addEventListener(type, (e) => {
      e.preventDefault();
      zone.classList.add("is-over");
    }));
    ["dragleave", "drop"].forEach((type) => zone.addEventListener(type, () => zone.classList.remove("is-over")));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      if (recorder) return;
      const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
      if (files.length) handleFiles(files);
    });
  }

  // Check each file and report success / failure per file
  async function handleFiles(files) {
    const log = [];
    const myToken = token;
    q("#upload-log").innerHTML = `<li>${UI.spinner()}<span>${files.length} 件を確認しています…</span></li>`;
    for (const file of files) {
      log.push(await addFile(file));
      if (myToken !== token) return;
    }
    recordDraft.uploadLog = log;
    renderUploadLog();
    renderSamples();
    const ok = log.filter((r) => r.ok).length;
    const ng = log.length - ok;
    if (ng === 0) UI.toast(`${ok} 件のファイルを追加しました。`, "success");
    else if (ok === 0) UI.toast(`${ng} 件のファイルを追加できませんでした。理由を確認してください。`, "error");
    else UI.toast(`${ok} 件を追加、${ng} 件は追加できませんでした。`);
  }

  async function addFile(file) {
    const fail = (message) => ({ name: file.name, ok: false, message });
    // Step 1: format and size
    if (!(file.type && file.type.startsWith("audio/")) && !AUDIO_EXT.test(file.name)) {
      return fail("音声ファイルではありません");
    }
    if (file.size > MAX_FILE_MB * 1024 * 1024) return fail(`${MAX_FILE_MB}MB を超えています`);
    // Step 2: decode (also proves the file is not broken)
    let info;
    try {
      info = await AudioKit.analyzeBlob(file);
    } catch {
      return fail("読み込めませんでした（壊れているか、対応していない形式です）");
    }
    const issues = checkSampleQuality(info, "file");
    const blocking = issues.find((i) => i.level === "error");
    if (blocking) return fail(blocking.text);
    // Step 3: the 5-minute total
    const remaining = MAX_TOTAL_SECONDS - usableSeconds();
    if (info.duration > remaining) {
      return fail(`合計 5 分を超えます（この音声 ${UI.formatClock(info.duration)}、残り ${UI.formatClock(Math.max(0, remaining))}）`);
    }
    recordDraft.samples.push({
      id: ++sampleSeq,
      source: "file",
      name: file.name,
      blob: file,
      duration: info.duration,
      peak: info.peak,
      peaks: info.peaks,
      issues,
      text: "",
      lineIndex: null,
    });
    const note = issues.length ? "・要確認" : "";
    return { name: file.name, ok: true, message: `追加しました（${UI.formatSeconds(info.duration)}${note}）` };
  }

  function renderUploadLog() {
    const box = q("#upload-log");
    if (!box) return;
    box.innerHTML = recordDraft.uploadLog.map((r) => `
      <li><span class="${r.ok ? "ok" : "ng"}">${r.ok ? "✓" : "✕"}</span>
        <span><b>${UI.escapeHtml(r.name)}</b>：${UI.escapeHtml(r.message)}</span></li>`).join("");
  }

  /* ---------- Sample list + meter ---------- */

  function bindSampleList() {
    const area = q("#sample-area");
    area.addEventListener("input", (e) => {
      const input = e.target.closest("[data-text]");
      if (!input) return;
      const sample = recordDraft.samples.find((s) => s.id === Number(input.dataset.text));
      if (sample) sample.text = input.value;
      updateSubmit();
    });
    area.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-remove]");
      if (!btn || recorder) return;
      const id = Number(btn.dataset.remove);
      const sample = recordDraft.samples.find((s) => s.id === id);
      recordDraft.samples = recordDraft.samples.filter((s) => s.id !== id);
      renderSamples();
      showLine(recordDraft.lineIndex);
      if (sample) UI.toast(`${sample.name} を削除しました。`);
    });
  }

  function renderSamples() {
    if (!root) return;
    const area = q("#sample-area");
    AudioKit.destroyIn(area);
    const list = recordDraft.samples;
    q("#sample-count").textContent = list.length ? `${list.length} 件` : "";
    if (!list.length) {
      area.innerHTML = '<p class="sample-empty">まだ素材がありません</p>';
    } else {
      area.innerHTML = `<ol class="sample-list">${list.map(sampleRow).join("")}</ol>`;
      list.forEach((s) => {
        const holder = area.querySelector(`[data-player="${s.id}"]`);
        holder.appendChild(AudioKit.createPlayer(s.blob, { variant: "compact", peaks: s.peaks, duration: s.duration }));
      });
    }
    renderMeter();
    updateSubmit();
  }

  function sampleRow(s) {
    const level = sampleLevel(s);
    const issues = s.issues.length
      ? `<ul class="sample-issues">${s.issues.map((i) => `<li>${UI.escapeHtml(i.text)}</li>`).join("")}</ul>` : "";
    const placeholder = s.source === "mic" ? "読み上げた内容" : "話している内容（任意）";
    return `
      <li class="sample is-${level}">
        <span class="sample-src ${s.source === "mic" ? "is-mic" : ""}" title="${s.source === "mic" ? "録音" : "ファイル"}">
          ${s.source === "mic" ? UI.ICONS.mic : UI.ICONS.file}
        </span>
        <div class="sample-main">
          <div class="sample-top">
            <span class="sample-name">${UI.escapeHtml(s.name)}</span>
            ${LEVEL_CHIP[level]}
          </div>
          <div class="sample-player" data-player="${s.id}"></div>
          <label class="visually-hidden" for="text-${s.id}">${UI.escapeHtml(s.name)} で話している内容</label>
          <input class="sample-text" id="text-${s.id}" data-text="${s.id}" value="${UI.escapeHtml(s.text)}" placeholder="${placeholder}" maxlength="200">
          ${issues}
        </div>
        <button type="button" class="icon-btn" data-remove="${s.id}" aria-label="${UI.escapeHtml(s.name)} を削除">${UI.ICONS.trash}</button>
      </li>`;
  }

  function renderMeter() {
    const total = usableSeconds();
    const fill = q("#meter-fill");
    fill.style.width = `${Math.min(100, (total / MAX_TOTAL_SECONDS) * 100)}%`;
    fill.classList.toggle("is-low", total < MIN_TOTAL_SECONDS);
    q("#total-time").textContent = UI.formatClock(total);
    const note = q("#meter-note");
    const remaining = MAX_TOTAL_SECONDS - total;
    note.className = "meter-note";
    if (total < MIN_TOTAL_SECONDS) {
      note.textContent = `最低 ${UI.formatClock(MIN_TOTAL_SECONDS)}`;
    } else if (remaining < 15) {
      note.textContent = `残り ${UI.formatClock(remaining)}`;
      note.classList.add("is-err");
    } else {
      note.textContent = "✓ 送信できます";
      note.classList.add("is-ok");
    }
  }

  function updateSubmit() {
    if (!root) return;
    const total = usableSeconds();
    let hint = "";
    if (total < MIN_TOTAL_SECONDS) hint = `素材をあと ${UI.formatClock(Math.ceil(MIN_TOTAL_SECONDS - total))} 追加してください`;
    else if (!recordDraft.name.trim()) hint = "話者名を入力してください";
    else if (!recordDraft.consent) hint = "同意にチェックしてください";
    const hintEl = q("#submit-hint");
    hintEl.textContent = hint;
    hintEl.hidden = !hint;
    q("#submit-btn").disabled = Boolean(hint) || submitting || Boolean(recorder);
  }

  /* ---------- Dev helpers (mock mode) ---------- */

  function bindDev() {
    const demoInfo = async (blob) => AudioKit.analyzeBlob(blob);
    q("#dev-one").addEventListener("click", async () => {
      const i = recordDraft.lineIndex;
      const blob = AudioKit.makeDemoWav(1.6 + SCRIPT_LINES[i].length * 0.1, i + 3);
      addRecordedSample(i, blob, await demoInfo(blob));
    });
    q("#dev-fill").addEventListener("click", async () => {
      const target = Math.min(MAX_TOTAL_SECONDS, usableSeconds() + 60);
      for (let i = 0; i < SCRIPT_LINES.length && usableSeconds() < target; i++) {
        if (lineRecorded(i)) continue;
        const blob = AudioKit.makeDemoWav(1.6 + SCRIPT_LINES[i].length * 0.1, i + 3);
        const info = await demoInfo(blob);
        if (usableSeconds() + info.duration > MAX_TOTAL_SECONDS) break;
        recordDraft.samples.push({
          id: ++sampleSeq, source: "mic", name: `例文 ${String(i + 1).padStart(2, "0")}`, blob,
          duration: info.duration, peak: info.peak, peaks: info.peaks, issues: [], text: SCRIPT_LINES[i], lineIndex: i,
        });
      }
      if (!root) return;
      feedback = null;
      renderSamples();
      advanceLine();
      UI.toast("テスト音声を追加しました。");
    });
    q("#dev-reset").addEventListener("click", () => {
      MockServer.reset();
      UI.storage.remove(ACTIVE_JOB_KEY);
      ChatStore.clear();
      SpeakerList.refresh();
      Demo.seed().then(() => App.reloadClone());
      UI.toast("モックデータを初期化しました。");
    });
    q("#dev-file").addEventListener("click", () => {
      const blob = AudioKit.makeDemoWav(12, Date.now() % 97);
      const file = new File([blob], `interview_${String(sampleSeq + 1).padStart(2, "0")}.wav`, { type: "audio/wav" });
      handleFiles([file]);
    });
  }

  /* ---------- Submit ---------- */

  async function submit() {
    if (submitting) return;
    const myToken = token;
    submitting = true;
    const btn = q("#submit-btn");
    btn.disabled = true;
    btn.innerHTML = `${UI.spinner()}<span>送信しています…</span>`;
    try {
      // Step 1: create the speaker once (skipped on retry)
      if (!recordDraft.createdSpeakerId) {
        const payload = usableSamples().map((s) => ({ blob: s.blob, text: s.text.trim(), duration: s.duration }));
        recordDraft.createdSpeakerId = await Api.createSpeaker(recordDraft.name.trim(), payload);
      }
      // Step 2: start training and remember the job so a reload can resume it
      const jobId = await Api.startTraining(recordDraft.createdSpeakerId);
      const job = { jobId, speakerId: recordDraft.createdSpeakerId, name: recordDraft.name.trim() };
      UI.storage.set(ACTIVE_JOB_KEY, job);
      submitting = false;
      UI.toast("送信しました。学習を始めます。", "success");
      SpeakerList.refresh();
      if (myToken === token) renderTraining(job);
    } catch (err) {
      submitting = false;
      UI.toast(UI.errorMessage(err), "error");
      if (myToken === token && root) {
        btn.textContent = "送信して学習を始める";
        updateSubmit();
      }
    }
  }

  /* ================= Training ================= */

  function renderTraining(job) {
    AudioKit.destroyIn(root);
    root.innerHTML = `
      <div class="c-body sp" style="--h:${UI.speakerHue(job.speakerId)}">
        <section class="training" aria-live="polite">
          ${UI.voiceprint(job.speakerId, "72")}
          <div class="speaker-name">${UI.escapeHtml(job.name)}</div>
          <span id="train-chip">${UI.statusChip("training")}</span>
          <span class="training-pct" id="train-pct">0%</span>
          <div class="progress"><div class="progress-bar" id="train-bar"></div></div>
          <p class="training-msg" id="train-msg">音声データを準備しています…</p>
          <div id="train-conn" hidden></div>
          <div class="training-actions" id="train-actions">
            <span class="training-msg" style="font-size:12px">ページを閉じても学習は続きます</span>
          </div>
        </section>
      </div>`;
    const myToken = token;
    clearInterval(pollId);
    pollJob(job, myToken);
    pollId = setInterval(() => pollJob(job, myToken), 2000);
  }

  function stageMessage(progress) {
    if (progress < 0.15) return "音声データを準備しています…";
    if (progress < 0.5) return "声の特徴を分析しています…";
    if (progress < 0.9) return "モデルを学習しています…";
    return "仕上げをしています…";
  }

  async function pollJob(job, myToken) {
    let status;
    try {
      status = await Api.getJob(job.jobId);
    } catch (err) {
      if (myToken !== token || !root) return;
      if (err.status === 404) {
        clearInterval(pollId);
        UI.storage.remove(ACTIVE_JOB_KEY);
        showTrainingFailed(job, "学習の情報が見つかりませんでした。話者が削除された可能性があります。");
        return;
      }
      const conn = q("#train-conn");
      conn.hidden = false;
      conn.innerHTML = UI.notice("warn", `${UI.escapeHtml(UI.errorMessage(err))} 自動で再接続します。`);
      return;
    }
    if (myToken !== token || !root) return;
    q("#train-conn").hidden = true;

    if (status.status === "done") {
      clearInterval(pollId);
      UI.storage.remove(ACTIVE_JOB_KEY);
      showTrainingDone(job);
    } else if (status.status === "failed") {
      clearInterval(pollId);
      UI.storage.remove(ACTIVE_JOB_KEY);
      showTrainingFailed(job, status.message || "学習に失敗しました。");
    } else {
      const p = status.progress ?? 0;
      q("#train-bar").style.width = `${Math.round(p * 100)}%`;
      q("#train-pct").textContent = `${Math.round(p * 100)}%`;
      q("#train-msg").textContent = stageMessage(p);
    }
  }

  function showTrainingDone(job) {
    resetRecordDraft();
    q("#train-chip").innerHTML = UI.statusChip("ready");
    q("#train-bar").style.width = "100%";
    q("#train-bar").classList.add("is-ok");
    q("#train-pct").textContent = "100%";
    q("#train-msg").textContent = "学習が完了しました。この声で音声を生成できます。";
    q("#train-actions").innerHTML = `
      <button type="button" class="btn btn-primary btn-pill" id="go-synth">この声で生成する</button>
      <button type="button" class="btn btn-soft btn-pill" id="another">別の声を登録</button>`;
    q("#go-synth").addEventListener("click", () => App.selectSpeaker(job.speakerId, { expand: true }));
    SpeakerList.refresh();
    q("#another").addEventListener("click", renderForm);
    UI.toast(`「${job.name}」の学習が完了しました。`, "success");
  }

  function showTrainingFailed(job, reason) {
    const hasSamples = recordDraft.samples.length > 0;
    q("#train-chip").innerHTML = UI.statusChip("failed");
    q("#train-bar").classList.add("is-err");
    q("#train-msg").textContent = reason;
    q("#train-actions").innerHTML = `
      <button type="button" class="btn btn-primary btn-pill" id="back-record">素材を見直す</button>
      <p class="training-msg" style="width:100%; font-size:12px">${hasSamples
        ? "素材はこの画面に残っています。"
        : "ページを再読み込みしたため、素材は残っていません。"}</p>`;
    SpeakerList.refresh();
    q("#back-record").addEventListener("click", () => {
      // Remove the failed speaker so the next submission does not leave a duplicate
      Api.deleteSpeaker(job.speakerId).then(() => SpeakerList.refresh()).catch(() => {});
      recordDraft.createdSpeakerId = null;
      renderForm();
    });
  }

  return { render, leave, suspend };
})();
