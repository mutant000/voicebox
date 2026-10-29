/* View: 音声生成 as a conversation with one speaker.
   Your text is a bubble on the right; voicebox answers on the left with the audio:
   status line, music-player bar, the sentences (段) and downloads.
   The send button generates; the button beside it stops (while generating) or deletes the latest audio. */

// Conversation history per speaker (kept for the session; generated audio is lost on reload)
const ChatStore = (() => {
  const threads = {};
  let seq = 0;
  const emit = () => window.dispatchEvent(new Event("chat:changed"));
  const list = (id) => (threads[id] = threads[id] || []);

  function add(id, msg) {
    msg.id = ++seq;
    msg.at = msg.at || new Date();
    list(id).push(msg);
    emit();
    return msg;
  }
  function remove(id, mid) {
    const thread = list(id);
    const index = thread.findIndex((m) => m.id === mid);
    if (index >= 0) thread.splice(index, 1);
    emit();
  }
  // Last thing the user wrote (shown in the speaker list)
  function last(id) {
    const thread = threads[id] || [];
    for (let i = thread.length - 1; i >= 0; i--) if (thread[i].type === "me") return thread[i];
    return null;
  }
  function latestResult(id) {
    const thread = threads[id] || [];
    for (let i = thread.length - 1; i >= 0; i--) if (thread[i].type === "vb" && thread[i].entry) return thread[i];
    return null;
  }
  function drop(id) { delete threads[id]; emit(); }
  function clear() { Object.keys(threads).forEach((k) => delete threads[k]); emit(); }
  return { list, add, remove, last, latestResult, drop, clear, emit };
})();

Views.synthesize = (() => {
  const MAX_CHARS = 200;
  const SEGMENT_MAX = 60;
  const JOIN_GAP = 0.25;
  const JAPANESE = /[぀-ヿ㐀-鿿]/;
  const EXAMPLES = [
    { label: "あいさつ", text: "本日はお忙しいところお集まりいただき、誠にありがとうございます。最後までどうぞよろしくお願いいたします。" },
    { label: "駅の案内", text: "まもなく三番線に、東京行きの電車がまいります。危ないですから、黄色い線の内側までお下がりください。" },
    { label: "天気予報", text: "明日は全国的に晴れるでしょう。ただし、夕方からは北の地域で雨が降る見込みです。お出かけの際は傘をお持ちください。" },
    { label: "日常会話", text: "今日の晩ごはんは、駅前のお店でカレーを食べようと思っています。" },
  ];

  const drafts = {}; // unsent text per speaker
  let root = null;
  let token = 0;
  let speaker = null;
  let busy = false;
  let controller = null;
  let elapsedId = null;
  let jobPollId = null;

  const q = (sel) => (root ? root.querySelector(sel) : null);
  const charCount = (text) => [...text].length;

  /* ================= Mount ================= */

  async function render(container) {
    root = container;
    const myToken = ++token;
    root.innerHTML = `<div class="placeholder">${UI.spinner()}</div>`;
    let speakers;
    try {
      speakers = await Api.listSpeakers();
    } catch (err) {
      if (myToken !== token) return;
      root.innerHTML = `
        <div class="placeholder">
          <p>${UI.escapeHtml(UI.errorMessage(err))}</p>
          <button type="button" class="btn btn-outline btn-pill" id="reload">再読み込み</button>
        </div>`;
      q("#reload").addEventListener("click", () => render(root));
      return;
    }
    if (myToken !== token) return;
    const chosen = speakers.find((s) => s.id === App.state.selectedSpeaker)
      || speakers.find((s) => s.status === "ready") || speakers[0];
    if (!chosen) {
      root.innerHTML = `
        <div class="placeholder">
          ${UI.mark("mark")}
          <p>まだ声が登録されていません</p>
          <a class="btn btn-primary btn-pill" href="#record">声を登録する</a>
        </div>`;
      return;
    }
    if (App.state.selectedSpeaker !== chosen.id) {
      App.state.selectedSpeaker = chosen.id;
      UI.storage.set("voicebox.lastSpeaker", chosen.id);
      SpeakerList.highlight();
    }
    window.addEventListener("speakers:loaded", onSpeakersLoaded);
    openChat(chosen);
  }

  function leave() {
    if (controller) controller.abort();
    clearInterval(elapsedId);
    clearInterval(jobPollId);
    window.removeEventListener("speakers:loaded", onSpeakersLoaded);
    document.removeEventListener("click", onOutsideClick);
    token++;
    root = null;
    busy = false;
  }

  // When the list refreshes and this speaker's status changed (e.g. training finished), redraw
  function onSpeakersLoaded(e) {
    if (!speaker || busy) return;
    const fresh = e.detail.find((s) => s.id === speaker.id);
    if (!fresh) return;
    const changed = fresh.status !== speaker.status || fresh.name !== speaker.name;
    speaker = fresh;
    if (changed) openChat(fresh);
  }

  /* ================= Chat layout ================= */

  function openChat(s) {
    speaker = s;
    clearInterval(jobPollId);
    AudioKit.destroyIn(root);
    const ready = s.status === "ready";
    const sub = ready
      ? `素材 ${s.sampleCount} 件${s.totalSeconds ? ` · ${UI.formatClock(s.totalSeconds)}` : ""}`
      : ({ pending: "準備中", training: "学習中", failed: "学習失敗" }[s.status] || "");
    root.innerHTML = `
      <div class="sp" style="--h:${UI.speakerHue(s.id)}; display: contents">
        <header class="c-head">
          <div class="c-ident">
            ${UI.voiceprint(s.id, "36")}
            <div class="c-title-wrap">
              <h1 class="c-title">${UI.escapeHtml(s.name)}</h1>
              <span class="c-sub">${sub}</span>
            </div>
          </div>
          <div class="spk-strip" data-strip role="group" aria-label="話者を切り替える"></div>
          <div class="menu-wrap">
            <button type="button" class="icon-btn" id="menu-btn" aria-label="話者の操作" aria-haspopup="true" aria-expanded="false">${UI.ICONS.more}</button>
            <div class="popover" id="menu" hidden></div>
          </div>
        </header>

        <div class="chat" id="chat"><div class="chat-inner" id="chat-inner"></div></div>

        <footer class="c-foot">
          <div class="composer">
            <div class="ex-row" aria-label="例文">
              ${EXAMPLES.map((ex, i) => `<button type="button" class="ex-chip" data-example="${i}">${ex.label}</button>`).join("")}
            </div>
            <div class="input-row">
              <div class="input-wrap" id="input-wrap">
                <label class="visually-hidden" for="text-input">読み上げる日本語の文章</label>
                <textarea class="composer-text" id="text-input" rows="1" lang="ja" placeholder="${ready ? "日本語の文章を入力" : "学習が終わると生成できます"}"></textarea>
                <span class="counter" id="counter">0 / ${MAX_CHARS}</span>
              </div>
              <button type="button" class="round round-stop" id="stop-btn" title="停止・削除" aria-label="停止・削除" disabled>${UI.ICONS.stop}</button>
              <button type="button" class="round round-send" id="gen-btn" title="生成" aria-label="生成" disabled>${UI.ICONS.send}</button>
            </div>
            <p class="composer-hint" id="text-hint" hidden></p>
          </div>
        </footer>
      </div>`;

    // Step 1: speaker switcher (shown instead of the list when the pane is narrow)
    SpeakerList.fillStrip(q("[data-strip]"));

    // Step 2: composer (re-fit the text box whenever the pane width changes)
    const input = q("#text-input");
    if (window.ResizeObserver) {
      let lastWidth = 0;
      new ResizeObserver(([entry]) => {
        const w = Math.round(entry.contentRect.width);
        if (w === lastWidth) return;
        lastWidth = w;
        requestAnimationFrame(autosize);
      }).observe(q(".input-row"));
    }
    input.value = drafts[s.id] || "";
    input.disabled = !ready;
    input.addEventListener("input", () => { drafts[s.id] = input.value; autosize(); updateComposer(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); generate(); }
    });
    root.querySelectorAll("[data-example]").forEach((btn) => {
      btn.disabled = !ready;
      btn.addEventListener("click", () => {
        input.value = EXAMPLES[Number(btn.dataset.example)].text;
        drafts[s.id] = input.value;
        autosize();
        updateComposer();
        input.focus();
      });
    });
    q("#gen-btn").addEventListener("click", () => generate());
    // Keep the keyboard open on phones: these buttons must not take focus from the text box
    root.querySelectorAll("#gen-btn, #stop-btn, [data-example]").forEach((btn) => {
      btn.addEventListener("pointerdown", (e) => e.preventDefault());
    });
    q("#stop-btn").addEventListener("click", stopOrDelete);

    // Step 3: header menu (rename / delete)
    q("#menu-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu();
    });
    document.addEventListener("click", onOutsideClick);

    // Step 4: messages (or the training state)
    renderThread();
    autosize();
    updateComposer();
    if (!ready) watchTraining(s);
  }

  function autosize() {
    const input = q("#text-input");
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(140, Math.max(26, input.scrollHeight))}px`;
  }

  /* ---------- Thread ---------- */

  function renderThread() {
    const inner = q("#chat-inner");
    AudioKit.destroyIn(inner);
    const thread = ChatStore.list(speaker.id);
    if (speaker.status !== "ready") {
      inner.innerHTML = trainingCard(speaker);
      return;
    }
    if (!thread.length) {
      inner.innerHTML = `
        <div class="chat-intro">
          ${UI.voiceprint(speaker.id, "72")}
          <div class="speaker-name">${UI.escapeHtml(speaker.name)}</div>
          <p>文章を入力すると、この声で読み上げます。</p>
        </div>`;
      return;
    }
    const head = thread[0] && thread[0].cover ? "" : '<div class="sys-pill">今日</div>';
    inner.innerHTML = `${head}${thread.map(msgHtml).join("")}`;
    thread.forEach(mountPlayer);
    scrollToBottom();
  }

  function msgHtml(m) {
    if (m.type === "me") {
      return `
        <div class="msg msg-me" data-mid="${m.id}">
          <span class="msg-time">${UI.formatTime(m.at)}</span>
          <div class="bubble-me" lang="ja">${UI.escapeHtml(m.text)}</div>
        </div>`;
    }
    if (m.type === "sys" && m.cover) {
      return `
        <div class="demo-cover" data-mid="${m.id}">
          ${UI.mark("demo-mark")}
          <div class="demo-cover-text"><b>操作デモ</b><span>モック動作中のため、音声はデモ用の合成音です</span></div>
        </div>`;
    }
    if (m.type === "sys") {
      const retry = m.retryText ? ` <button type="button" data-retry="${m.id}">もう一度</button>` : "";
      return `<div class="sys-pill ${m.tone === "error" ? "is-error" : ""}" data-mid="${m.id}">${UI.escapeHtml(m.text)}${retry}</div>`;
    }
    return `
      <div class="msg msg-vb" data-mid="${m.id}">
        ${UI.voiceprint(speaker.id, "36")}
        <div class="msg-col">
          <span class="msg-name">${UI.escapeHtml(speaker.name)}</span>
          <div class="msg-row">
            <div class="bubble-vb">${m.entry ? resultBody(m) : progressBody(m)}</div>
            ${m.entry ? `<span class="msg-time">${UI.formatTime(m.at)}</span>` : ""}
          </div>
        </div>
      </div>`;
  }

  function progressBody(m) {
    const n = m.segments.length;
    const label = m.joining ? "音声をつなげています…" : `${m.done + 1} / ${n} 段目を生成しています…`;
    const pips = m.segments.map((_, i) => `<i class="${i < m.done || m.joining ? "is-done" : i === m.done ? "is-now" : ""}"></i>`).join("");
    return `
      <div class="rp-status is-busy">
        ${UI.spinner()}<span>${label}</span><span class="sep">·</span><span class="num" data-elapsed>0.0 秒</span>
        <span class="pips" aria-hidden="true">${pips}</span>
      </div>
      <ol class="segs">
        ${m.segments.map((seg, i) => `
          <li><div class="seg ${i > m.done && !m.joining ? "is-pending" : ""}">
            <span class="seg-text" lang="ja">${UI.escapeHtml(seg)}</span>
            <span class="seg-meta">${String(i + 1).padStart(2, "0")}${i < m.done || m.joining ? " · ✓" : ""}</span>
          </div></li>`).join("")}
      </ol>`;
  }

  function resultBody(m) {
    const e = m.entry;
    const n = e.segments.length;
    return `
      <div class="rp-status">
        ${m.demo ? '<span class="chip chip-neutral">デモ音声</span>' : '<span class="dot" aria-hidden="true"></span>'}
        <span class="num">${n} / ${n}</span><span>段を生成しました</span>
        <span class="sep">·</span><span>すべて完了</span>
        <span class="rp-hint">連続再生・リピート再生ができます</span>
      </div>
      <div data-player></div>
      <ol class="segs">
        ${e.segments.map((seg, i) => `
          <li><button type="button" class="seg" data-seek="${seg.start}">
            <span class="seg-text" lang="ja">${UI.escapeHtml(seg.text)}</span>
            <span class="seg-meta">${String(i + 1).padStart(2, "0")} · ${UI.formatSeconds(seg.start)}</span>
          </button></li>`).join("")}
      </ol>
      <div class="rp-actions">
        <button type="button" class="btn btn-soft" data-zip>${UI.ICONS.download}<span>音声パック（.zip）</span></button>
        <button type="button" class="btn btn-ghost" data-wav>WAV</button>
        <button type="button" class="btn btn-ghost btn-del" data-del>削除</button>
      </div>`;
  }

  // Attach the player and the buttons of one finished message
  function mountPlayer(m) {
    if (m.type === "sys" && m.retryText) {
      const btn = root.querySelector(`[data-retry="${m.id}"]`);
      if (btn) btn.addEventListener("click", () => {
        const input = q("#text-input");
        input.value = m.retryText;
        drafts[speaker.id] = m.retryText;
        autosize();
        updateComposer();
        generate();
      });
      return;
    }
    if (m.type !== "vb" || !m.entry) return;
    const el = root.querySelector(`[data-mid="${m.id}"]`);
    if (!el) return;
    const e = m.entry;
    const segButtons = [...el.querySelectorAll(".seg")];
    let playing = -1;
    const highlight = (t) => {
      const idx = t > 0.001 ? e.segments.findIndex((s) => t >= s.start && t < s.start + s.duration + JOIN_GAP) : -1;
      if (idx === playing) return;
      playing = idx;
      segButtons.forEach((b, i) => b.classList.toggle("is-playing", i === idx));
    };
    const player = AudioKit.createPlayer(e.blob, {
      variant: "bar",
      peaks: e.peaks,
      duration: e.duration,
      markers: e.segments.map((s) => s.start),
      onTime: highlight,
    });
    el.querySelector("[data-player]").appendChild(player);
    segButtons.forEach((b) => b.addEventListener("click", () => {
      player.player.seek(Number(b.dataset.seek));
      player.player.play();
    }));
    el.querySelector("[data-zip]").addEventListener("click", (ev) => downloadPack(e, ev.currentTarget));
    el.querySelector("[data-wav]").addEventListener("click", () => {
      UI.downloadBlob(e.blob, `${UI.safeFileName(speaker.name)}_${UI.timeStamp(e.createdAt)}.wav`);
    });
    el.querySelector("[data-del]").addEventListener("click", () => deleteResult(m));
  }

  function appendMsg(m) {
    const inner = q("#chat-inner");
    if (!inner) return;
    if (inner.querySelector(".chat-intro")) inner.innerHTML = '<div class="sys-pill">今日</div>';
    inner.insertAdjacentHTML("beforeend", msgHtml(m));
    mountPlayer(m);
    scrollToBottom();
  }

  function replaceMsg(m) {
    const el = root ? root.querySelector(`[data-mid="${m.id}"]`) : null;
    if (!el) return;
    AudioKit.destroyIn(el);
    el.outerHTML = msgHtml(m);
    mountPlayer(m);
  }

  function removeMsg(m) {
    const el = root ? root.querySelector(`[data-mid="${m.id}"]`) : null;
    if (!el) return;
    AudioKit.destroyIn(el);
    el.remove();
  }

  function scrollToBottom() {
    const chat = q("#chat");
    if (chat) chat.scrollTop = chat.scrollHeight;
  }

  /* ---------- Training state for a speaker that is not ready ---------- */

  function trainingCard(s) {
    if (s.status === "failed") {
      return `
        <div class="chat-intro">
          ${UI.voiceprint(s.id, "72")}
          <div class="speaker-name">${UI.escapeHtml(s.name)}</div>
          ${UI.statusChip("failed")}
          <p>${UI.escapeHtml(s.failReason || "学習に失敗しました。")}</p>
          <a class="btn btn-outline btn-pill btn-sm" href="#record">素材を見直す</a>
        </div>`;
    }
    return `
      <div class="chat-intro">
        ${UI.voiceprint(s.id, "72")}
        <div class="speaker-name">${UI.escapeHtml(s.name)}</div>
        ${UI.statusChip(s.status)}
        <div class="progress" style="width: min(280px, 80%); margin-top: 6px"><div class="progress-bar" id="job-bar"></div></div>
        <p id="job-msg">学習が終わると、ここで音声を生成できます。</p>
      </div>`;
  }

  function watchTraining(s) {
    if (!s.jobId || s.status === "failed") return;
    const myToken = token;
    const poll = async () => {
      try {
        const job = await Api.getJob(s.jobId);
        if (myToken !== token || !root) return;
        const bar = q("#job-bar");
        if (bar && job.progress != null) bar.style.width = `${Math.round(job.progress * 100)}%`;
        if (job.status !== "running") {
          clearInterval(jobPollId);
          SpeakerList.refresh(); // fires speakers:loaded -> onSpeakersLoaded redraws
        }
      } catch { /* keep trying */ }
    };
    poll();
    jobPollId = setInterval(poll, 2000);
  }

  /* ---------- Composer rules ---------- */

  // Split into sentences (段); very short ones join the previous, very long ones break at 、
  function splitSegments(text) {
    const sentences = (text.replace(/\s+/g, " ").match(/[^。！？!?]+[。！？!?」』）]*/g) || [text])
      .map((s) => s.trim()).filter(Boolean);
    const merged = [];
    sentences.forEach((s) => {
      if (merged.length && charCount(s) < 6) merged[merged.length - 1] += s;
      else merged.push(s);
    });
    return merged.flatMap((s) => {
      if (charCount(s) <= SEGMENT_MAX) return [s];
      const parts = [];
      let buf = "";
      s.split(/(?<=、)/).forEach((piece) => {
        if (buf && charCount(buf + piece) > SEGMENT_MAX) { parts.push(buf); buf = ""; }
        buf += piece;
      });
      if (buf) parts.push(buf);
      return parts.flatMap((p) => (charCount(p) <= SEGMENT_MAX ? [p] : p.match(new RegExp(`.{1,${SEGMENT_MAX}}`, "gu"))));
    });
  }

  function validate(text) {
    const trimmed = text.trim();
    const count = charCount(trimmed);
    if (!trimmed) return { ok: false, message: "" };
    if (count > MAX_CHARS) return { ok: false, message: `${MAX_CHARS} 文字以内にしてください（現在 ${count} 文字）` };
    if (!JAPANESE.test(trimmed)) return { ok: false, message: "日本語の文章を入力してください" };
    return { ok: true, message: "" };
  }

  function updateComposer() {
    if (!root || !q("#text-input")) return;
    const text = q("#text-input").value;
    const result = validate(text);
    const count = charCount(text.trim());
    const counter = q("#counter");
    counter.textContent = `${count} / ${MAX_CHARS}`;
    counter.classList.toggle("is-over", count > MAX_CHARS);
    counter.classList.toggle("is-empty", count === 0);
    const hint = q("#text-hint");
    hint.textContent = result.message;
    hint.hidden = !result.message;
    q("#input-wrap").classList.toggle("is-invalid", Boolean(result.message));
    q("#gen-btn").disabled = busy || !result.ok || speaker.status !== "ready";
    updateStopButton();
  }

  function updateStopButton() {
    const btn = q("#stop-btn");
    if (!btn || !speaker) return;
    const latest = ChatStore.latestResult(speaker.id);
    btn.disabled = !busy && !latest;
    const label = busy ? "生成を停止して、途中の音声を削除" : "最新の音声を削除";
    btn.setAttribute("aria-label", label);
    btn.title = busy ? "停止・削除" : "最新の音声を削除";
    // Shape tells the job: a filled square stops, a bin deletes
    const mode = busy ? "stop" : "trash";
    if (btn.dataset.mode !== mode) {
      btn.dataset.mode = mode;
      btn.innerHTML = UI.ICONS[mode];
      btn.classList.toggle("is-busy", busy);
    }
  }

  function setBusy(isBusy) {
    busy = isBusy;
    if (!root) return;
    q("#text-input").readOnly = isBusy;
    root.querySelectorAll("[data-example]").forEach((b) => { b.disabled = isBusy; });
    updateComposer();
  }

  /* ---------- Generate / stop / delete ---------- */

  async function generate() {
    if (!root || busy || !speaker || speaker.status !== "ready") return;
    const input = q("#text-input");
    const text = input.value.trim();
    if (!validate(text).ok) return;

    const sid = speaker.id;
    const myToken = token;
    const segments = splitSegments(text);
    const startedAt = performance.now();

    // Step 1: your message, then voicebox's reply in progress
    input.value = "";
    drafts[sid] = "";
    autosize();
    appendMsg(ChatStore.add(sid, { type: "me", text }));
    const reply = ChatStore.add(sid, { type: "vb", segments, done: 0, joining: false, entry: null });
    appendMsg(reply);

    controller = new AbortController();
    setBusy(true);
    elapsedId = setInterval(() => {
      const el = root && root.querySelector(`[data-mid="${reply.id}"] [data-elapsed]`);
      if (el) el.textContent = `${((performance.now() - startedAt) / 1000).toFixed(1)} 秒`;
    }, 100);

    try {
      // Step 2: one request per sentence, so progress and 停止 work per 段
      const blobs = [];
      for (let i = 0; i < segments.length; i++) {
        reply.done = i;
        if (myToken === token) replaceMsg(reply);
        blobs.push(await Api.synthesize(sid, segments[i], controller.signal));
      }
      // Step 3: join every 段 into one track for continuous playback
      reply.joining = true;
      if (myToken === token) replaceMsg(reply);
      const joined = await AudioKit.joinBlobs(blobs, JOIN_GAP);
      reply.entry = {
        text,
        segments: segments.map((seg, i) => ({ text: seg, blob: blobs[i], start: joined.starts[i], duration: joined.durations[i] })),
        blob: joined.blob,
        duration: joined.duration,
        peaks: joined.peaks,
        seconds: (performance.now() - startedAt) / 1000,
        createdAt: new Date(),
      };
      reply.at = new Date();
      ChatStore.emit();
      if (myToken === token) replaceMsg(reply);
    } catch (err) {
      ChatStore.remove(sid, reply.id);
      const stopped = err && err.name === "AbortError";
      const note = stopped
        ? ChatStore.add(sid, { type: "sys", text: "生成を停止し、途中の音声を削除しました" })
        : ChatStore.add(sid, { type: "sys", tone: "error", text: UI.errorMessage(err), retryText: text });
      if (myToken === token) {
        removeMsg(reply);
        appendMsg(note);
      }
    } finally {
      clearInterval(elapsedId);
      controller = null;
      if (myToken === token) setBusy(false);
      else busy = false;
    }
  }

  function stopOrDelete() {
    if (busy && controller) {
      controller.abort();
      return;
    }
    const latest = ChatStore.latestResult(speaker.id);
    if (latest) deleteResult(latest);
  }

  function deleteResult(m) {
    ChatStore.remove(speaker.id, m.id);
    removeMsg(m);
    appendMsg(ChatStore.add(speaker.id, { type: "sys", text: "音声を削除しました" }));
    updateStopButton();
  }

  // 音声パック: the joined track + every 段 as its own WAV + the text
  async function downloadPack(entry, btn) {
    if (btn) btn.disabled = true;
    try {
      const lines = entry.segments.map((s, i) => `${String(i + 1).padStart(2, "0")}\t${UI.formatSeconds(s.start)}\t${s.text}`);
      const readme = [
        `話者: ${speaker.name}`,
        `生成日時: ${UI.formatDate(entry.createdAt)}`,
        `長さ: ${UI.formatSeconds(entry.duration)}（${entry.segments.length} 段）`,
        "",
        "段\t開始\t文章",
        ...lines,
        "",
      ].join("\r\n");
      const files = [
        { name: "all.wav", data: entry.blob },
        ...entry.segments.map((s, i) => ({ name: `segment_${String(i + 1).padStart(2, "0")}.wav`, data: s.blob })),
        { name: "text.txt", data: "﻿" + readme },
      ];
      const zip = await Zip.build(files);
      UI.downloadBlob(zip, `${UI.safeFileName(speaker.name)}_${UI.timeStamp(entry.createdAt)}.zip`);
    } catch {
      UI.toast("音声パックを作成できませんでした。", "error");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /* ---------- Header menu: rename / delete ---------- */

  // Close the menu when the user clicks anywhere else.
  // Check the path the click travelled, not e.target: choosing a menu item replaces the menu's content,
  // so by the time the click reaches the document the clicked button is no longer in the page.
  function onOutsideClick(e) {
    const menu = q("#menu");
    if (menu && !menu.hidden && !e.composedPath().includes(q(".menu-wrap"))) closeMenu();
  }

  function closeMenu() {
    const menu = q("#menu");
    if (!menu) return;
    menu.hidden = true;
    q("#menu-btn").setAttribute("aria-expanded", "false");
  }

  function toggleMenu() {
    const menu = q("#menu");
    if (!menu.hidden) { closeMenu(); return; }
    menu.hidden = false;
    q("#menu-btn").setAttribute("aria-expanded", "true");
    menu.innerHTML = `
      <button type="button" class="pop-item" data-act="rename">${UI.ICONS.pen}<span>名前を変更</span></button>
      <button type="button" class="pop-item is-danger" data-act="delete">${UI.ICONS.trash}<span>この声を削除</span></button>`;
    menu.querySelector('[data-act="rename"]').addEventListener("click", showRename);
    menu.querySelector('[data-act="delete"]').addEventListener("click", showDelete);
    menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); q("#menu-btn").focus(); } });
    menu.querySelector(".pop-item").focus();
  }

  function showRename() {
    const menu = q("#menu");
    menu.innerHTML = `
      <form class="pop-form" id="rename-form">
        <label class="visually-hidden" for="rename-input">新しい話者名</label>
        <input class="input" id="rename-input" maxlength="30" value="${UI.escapeHtml(speaker.name)}">
        <div class="pop-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-cancel>キャンセル</button>
          <button type="submit" class="btn btn-primary btn-sm">保存</button>
        </div>
      </form>`;
    const input = menu.querySelector("#rename-input");
    input.focus();
    input.select();
    menu.querySelector("[data-cancel]").addEventListener("click", closeMenu);
    menu.querySelector("#rename-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) { UI.toast("話者名を入力してください。", "error"); return; }
      try {
        await Api.renameSpeaker(speaker.id, name);
        closeMenu();
        UI.toast("話者名を変更しました。", "success");
        SpeakerList.refresh(); // redraws this header through speakers:loaded
      } catch (err) {
        UI.toast(UI.errorMessage(err), "error");
      }
    });
  }

  function showDelete() {
    const menu = q("#menu");
    const training = speaker.status === "training" || speaker.status === "pending";
    menu.innerHTML = `
      <div class="pop-form">
        <p>「${UI.escapeHtml(speaker.name)}」を削除しますか？ ${training ? "学習は中止されます。" : "学習した声も削除され、元に戻せません。"}</p>
        <div class="pop-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-cancel>キャンセル</button>
          <button type="button" class="btn btn-danger btn-sm" data-confirm>削除する</button>
        </div>
      </div>`;
    menu.querySelector("[data-cancel]").addEventListener("click", closeMenu);
    const confirmBtn = menu.querySelector("[data-confirm]");
    confirmBtn.focus();
    confirmBtn.addEventListener("click", async () => {
      confirmBtn.disabled = true;
      const target = speaker;
      try {
        await Api.deleteSpeaker(target.id);
        const job = UI.storage.get(ACTIVE_JOB_KEY, null);
        if (job && job.speakerId === target.id) UI.storage.remove(ACTIVE_JOB_KEY);
        ChatStore.drop(target.id);
        App.forgetSpeaker(target.id);
        UI.toast(`「${target.name}」を削除しました。`, "success");
        SpeakerList.refresh();
        App.reloadClone();
      } catch (err) {
        confirmBtn.disabled = false;
        UI.toast(UI.errorMessage(err), "error");
      }
    });
  }

  return { render, leave };
})();
