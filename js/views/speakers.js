/* Speakers of the clone pane, drawn two ways from the same data:
   - the list beside the conversation (wide pane)
   - a horizontal strip of chips in the conversation header (side-by-side, tablets, phones) */

const SpeakerList = (() => {
  let root = null;
  let speakers = [];
  let loaded = false;
  let query = "";
  let pollId = null;

  const q = (sel) => root.querySelector(sel);

  function mount(el) {
    if (root) return;
    root = el;
    root.innerHTML = `
      <div class="list-head">
        <h2 class="list-title">話者</h2>
        <div class="list-tools">
          <a class="icon-btn" href="#record" aria-label="新しい声を登録">${UI.ICONS.plus}</a>
        </div>
      </div>
      <div class="search">
        ${UI.ICONS.search}
        <label class="visually-hidden" for="speaker-search">話者を検索</label>
        <input id="speaker-search" type="search" placeholder="名前で検索" autocomplete="off">
      </div>
      <ul class="rows" id="rows"><li class="list-empty">${UI.spinner()}</li></ul>
      <div class="list-foot">
        <span class="mock-pill" ${API_CONFIG.USE_MOCK ? "" : "hidden"} title="js/api.js の USE_MOCK で切り替えます">モック動作中</span>
        <a class="btn btn-soft btn-sm btn-pill" href="#record">${UI.ICONS.plus}<span>新しい声</span></a>
      </div>`;

    q("#speaker-search").addEventListener("input", (e) => { query = e.target.value.trim(); draw(); });
    q("#rows").addEventListener("click", (e) => {
      const row = e.target.closest("[data-id]");
      if (row) App.selectSpeaker(row.dataset.id);
    });
    window.addEventListener("speakers:loaded", (e) => {
      speakers = e.detail;
      loaded = true;
      draw();
      schedulePoll();
    });
    window.addEventListener("chat:changed", draw);
    refresh();
  }

  function refresh() {
    return Api.listSpeakers().catch((err) => {
      if (!loaded && root) q("#rows").innerHTML = `<li class="list-empty">${UI.escapeHtml(UI.errorMessage(err))}</li>`;
    });
  }

  // Keep polling while someone is still training, so the status changes by itself
  function schedulePoll() {
    const training = speakers.some((s) => s.status === "training" || s.status === "pending");
    if (training && !pollId) pollId = setInterval(refresh, 3000);
    if (!training && pollId) { clearInterval(pollId); pollId = null; }
  }

  function subline(s) {
    const last = ChatStore.last(s.id);
    if (s.status === "training" || s.status === "pending") return { text: "学習中…", cls: "is-live" };
    if (s.status === "failed") return { text: "学習に失敗しました", cls: "is-err" };
    if (last) return { text: last.text, cls: "" };
    return { text: "まだ生成していません", cls: "" };
  }

  function draw() {
    if (!root) return;
    const box = q("#rows");
    if (!loaded) return;
    const list = speakers
      .filter((s) => !query || s.name.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => activity(b) - activity(a));
    if (!speakers.length) {
      box.innerHTML = '<li class="list-empty">まだ声が登録されていません</li>';
      return;
    }
    if (!list.length) {
      box.innerHTML = '<li class="list-empty">見つかりません</li>';
      return;
    }
    drawStrips();
    box.innerHTML = list.map((s) => {
      const sub = subline(s);
      const last = ChatStore.last(s.id);
      return `
        <li>
          <button type="button" class="row sp" style="--h:${UI.speakerHue(s.id)}" data-id="${UI.escapeHtml(s.id)}">
            ${UI.voiceprint(s.id)}
            <span class="row-body">
              <span class="row-top">
                <span class="row-name">${UI.escapeHtml(s.name)}</span>
                <span class="row-time">${UI.formatTime(last ? last.at : s.createdAt)}</span>
              </span>
              <span class="row-sub ${sub.cls}">${UI.escapeHtml(sub.text)}</span>
            </span>
          </button>
        </li>`;
    }).join("");
    highlight();
  }

  function activity(s) {
    const last = ChatStore.last(s.id);
    return new Date(last ? last.at : s.createdAt).getTime() || 0;
  }

  function highlight() {
    if (!root) return;
    root.querySelectorAll("[data-id]").forEach((row) => {
      const on = row.dataset.id === App.state.selectedSpeaker;
      row.classList.toggle("is-on", on);
      if (on) row.setAttribute("aria-current", "true");
      else row.removeAttribute("aria-current");
    });
    document.querySelectorAll("[data-strip] [data-pick]").forEach((chip) => {
      chip.setAttribute("aria-pressed", String(chip.dataset.pick === App.state.selectedSpeaker));
    });
  }

  /* ---------- Strip: compact switcher for narrow panes ---------- */

  // Stable order (newest registration first), so chips never jump under the pointer
  function stripHtml() {
    const list = [...speakers].sort((a, b) => (new Date(b.createdAt).getTime() || 0) - (new Date(a.createdAt).getTime() || 0));
    return list.map((s) => {
      const busy = s.status === "training" || s.status === "pending";
      const flag = busy ? '<span class="spk-flag is-live" title="学習中"></span>'
        : s.status === "failed" ? '<span class="spk-flag is-err" title="学習失敗"></span>' : "";
      return `
        <button type="button" class="spk-chip sp" style="--h:${UI.speakerHue(s.id)}" data-pick="${UI.escapeHtml(s.id)}"
          aria-pressed="${s.id === App.state.selectedSpeaker}">
          ${UI.voiceprint(s.id, "28")}<span class="spk-name">${UI.escapeHtml(s.name)}</span>${flag}
        </button>`;
    }).join("") + `<a class="spk-add" href="#record" aria-label="新しい声を登録" title="新しい声を登録">${UI.ICONS.plus}</a>`;
  }

  function fillStrip(el) {
    if (!el) return;
    el.innerHTML = loaded ? stripHtml() : "";
    el.onclick = (e) => {
      const chip = e.target.closest("[data-pick]");
      if (chip && chip.dataset.pick !== App.state.selectedSpeaker) App.selectSpeaker(chip.dataset.pick);
    };
    const on = el.querySelector('[aria-pressed="true"]');
    // Bring the current chip into view by scrolling the strip only (never its overflow-hidden parents)
    if (on) requestAnimationFrame(() => {
      const left = on.offsetLeft - el.offsetLeft;
      if (left < el.scrollLeft || left + on.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, left - 8);
    });
  }

  function drawStrips() {
    document.querySelectorAll("[data-strip]").forEach((el) => {
      const keep = el.scrollLeft;
      el.innerHTML = stripHtml();
      el.scrollLeft = keep;
    });
  }

  const data = () => speakers;

  return { mount, refresh, highlight, fillStrip, data };
})();

/* Content shown on #speakers (desktop) before a speaker is chosen */
Views.speakers = (() => {
  function render(root) {
    root.innerHTML = `
      <div class="placeholder">
        ${UI.mark("mark")}
        <p>話者を選ぶと、ここで音声を生成できます。</p>
        <a class="btn btn-outline btn-pill" href="#record">${UI.ICONS.mic}<span>新しい声を登録</span></a>
      </div>`;
  }
  return { render };
})();
