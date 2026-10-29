/* Shared UI helpers: icons, voiceprints, formatting, toasts, error messages, storage */

const UI = (() => {
  const STATUS = {
    pending: { label: "準備中", cls: "chip-warn is-live" },
    training: { label: "学習中", cls: "chip-sp is-live" },
    ready: { label: "使用可能", cls: "chip-ok" },
    failed: { label: "学習失敗", cls: "chip-err" },
  };

  const line = (d) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;

  const ICONS = {
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4.5 2.6v10.8a.6.6 0 0 0 .9.5l8.6-5.4a.6.6 0 0 0 0-1L5.4 2.1a.6.6 0 0 0-.9.5z"/></svg>',
    pause: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect fill="currentColor" x="3.5" y="2.5" width="3" height="11" rx="1"/><rect fill="currentColor" x="9.5" y="2.5" width="3" height="11" rx="1"/></svg>',
    info: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm.75 9.75h-1.5V7.25h1.5v4zM8 6.25a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8z"/></svg>',
    download: line('<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14"/>'),
    upload: line('<path d="M12 15.5v-11m0 0L7.5 9M12 4.5 16.5 9M5 19.5h14"/>'),
    sparkle: line('<path d="M12 3.5 13.9 9l5.6 1.9-5.6 2L12 18.5l-1.9-5.6-5.6-2L10.1 9z"/>'),
    stop: line('<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>'),
    trash: line('<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2h9.2l.9-12.2M10.3 10.5v5.5M13.7 10.5v5.5"/>'),
    mic: line('<rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5"/>'),
    file: line('<path d="M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8z"/><path d="M14 3.5V8h4.5M9.5 16v-3M12 16v-5M14.5 16v-2"/>'),
    chevronLeft: line('<path d="m14.5 6-6 6 6 6"/>'),
    chevronRight: line('<path d="m9.5 6 6 6-6 6"/>'),
    back: line('<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>'),
    more: line('<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>'),
    plus: line('<path d="M12 5v14M5 12h14"/>'),
    search: line('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>'),
    send: line('<path d="M12 19V5m0 0-6 6m6-6 6 6"/>'),
    pen: line('<path d="M4.5 19.5h4l10-10-4-4-10 10zM13.5 6.5l4 4"/>'),
    sun: line('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>'),
    moon: line('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
    loop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3.5 20 6.5 17 9.5"/><path d="M4 11.5v-1a4 4 0 0 1 4-4h12M7 20.5 4 17.5l3-3"/><path d="M20 12.5v1a4 4 0 0 1-4 4H4"/></svg>',
  };

  // Escape user-provided text before putting it into innerHTML
  function escapeHtml(text) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(text ?? "").replace(/[&<>"']/g, (c) => map[c]);
  }

  function hashOf(key) {
    let hash = 2166136261;
    for (const ch of String(key)) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619) >>> 0;
    return hash;
  }

  // 声紋 (voiceprint): bars generated from the speaker ID, so each speaker keeps one recognisable mark
  function voiceprint(key, size = "") {
    let state = hashOf(key) || 1;
    const rand = () => {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      return (state % 10000) / 10000;
    };
    const count = 5 + Math.floor(rand() * 3);          // 5–7 bars
    const barW = 2.4;
    const gap = count === 7 ? 1.3 : 1.8;
    const start = (24 - (count * barW + (count - 1) * gap)) / 2;
    const peakAt = 1 + rand() * (count - 3);           // where the voice is loudest
    let rects = "";
    for (let i = 0; i < count; i++) {
      const near = Math.max(0, 1 - Math.abs(i - peakAt) / 2.6);
      const shape = 0.62 * near ** 1.4 + 0.38 * rand();
      const h = 3.5 + 16 * (0.12 + 0.88 * shape);
      rects += `<rect x="${(start + i * (barW + gap)).toFixed(2)}" y="${((24 - h) / 2).toFixed(2)}" width="${barW}" height="${h.toFixed(2)}" rx="1.2"/>`;
    }
    return `<span class="vp${size ? ` vp-${size}` : ""} sp" style="--h:${speakerHue(key)}" aria-hidden="true"><svg viewBox="0 0 24 24">${rects}</svg></span>`;
  }

  // Each speaker gets one hue from a muted, harmonious set; it is only used inside .sp
  const HUES = [352, 214, 36, 158, 266, 18, 192, 312];
  function speakerHue(key) {
    return HUES[hashOf(String(key) + "#hue") % HUES.length];
  }

  // 3.25 -> "0:03.2"
  function formatSeconds(seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(s / 60);
    const rest = (s - minutes * 60).toFixed(1).padStart(4, "0");
    return `${minutes}:${rest}`;
  }

  // 83 -> "1:23"
  function formatClock(seconds) {
    const s = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function formatDate(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Today -> "16:29", other days -> "10月11日"
  function formatTime(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  // Brand mark: a voiceprint held inside a container — the voice is taken in, then given back out
  const MARK_BODY = '<g class="mk-frame"><path d="M8.5 6H6.5A2.5 2.5 0 0 0 4 8.5v19A2.5 2.5 0 0 0 6.5 30h2"/><path d="M27.5 6h2A2.5 2.5 0 0 1 32 8.5v19a2.5 2.5 0 0 1-2.5 2.5h-2"/></g><g class="mk-bars"><rect x="8.8" y="14.5" width="2.4" height="7" rx="1.2"/><rect x="12.8" y="11.0" width="2.4" height="14" rx="1.2"/><rect x="16.8" y="8.0" width="2.4" height="20" rx="1.2"/><rect x="20.8" y="13.0" width="2.4" height="10" rx="1.2"/><rect x="24.8" y="10.5" width="2.4" height="15" rx="1.2"/></g>';
  function mark(cls = "mark") {
    return `<svg class="mk ${cls}" viewBox="0 0 36 36" aria-hidden="true">${MARK_BODY}</svg>`;
  }

  function timeStamp(date = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  function toast(message, type = "info") {
    const box = document.getElementById("toasts");
    if (!box) return;
    // Step 1: build the toast element
    const item = document.createElement("div");
    item.className = `toast toast-${type}`;
    item.setAttribute("role", type === "error" ? "alert" : "status");
    item.textContent = message;
    box.appendChild(item);
    // Step 2: fade out after a while (errors stay longer)
    const life = type === "error" ? 6000 : 3200;
    setTimeout(() => {
      item.classList.add("is-leaving");
      setTimeout(() => item.remove(), 260);
    }, life);
  }

  // Turn an ApiError (or any error) into a message the user can act on
  function errorMessage(err) {
    const status = err && typeof err.status === "number" ? err.status : -1;
    const messages = {
      0: "サーバーに接続できません。ネットワークとサーバーの状態を確認してください。",
      400: "入力内容に問題があります。内容を確認してください。",
      404: "対象のデータが見つかりません。画面を再読み込みしてください。",
      409: "この話者はまだ学習が完了していません。",
      413: "ファイルサイズが大きすぎます。",
    };
    let base = messages[status];
    if (!base && status >= 500) base = "サーバーで処理に失敗しました。時間をおいてもう一度お試しください。";
    if (!base) base = "予期しないエラーが発生しました。";
    const detail = err && err.detail ? String(err.detail) : "";
    return detail && detail !== base ? `${base}（${detail}）` : base;
  }

  function notice(type, html) {
    return `<div class="notice notice-${type}">${ICONS.info}<div class="notice-body">${html}</div></div>`;
  }

  // localStorage wrapper that never throws (private mode etc.)
  const storage = {
    get(key, fallback = null) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
    },
  };

  function statusChip(status) {
    const s = STATUS[status] || { label: status, cls: "chip-neutral" };
    return `<span class="chip ${s.cls}">${escapeHtml(s.label)}</span>`;
  }

  function spinner() {
    return '<span class="spinner" aria-hidden="true"></span>';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function safeFileName(text) {
    return String(text).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) || "voice";
  }

  return {
    ICONS, escapeHtml, voiceprint, speakerHue, formatSeconds, formatClock, formatDate, formatTime, timeStamp, toast,
    errorMessage, notice, storage, statusChip, spinner, downloadBlob, safeFileName, mark,
  };
})();

// Registry the view files add themselves to (see js/views/)
const Views = {};
