/* Landing page: one voice line that changes its meaning scene by scene.
   0 序      a quiet white beam under the title
   1 録る    the beam becomes a voice — bursts and pauses — in the lower band, under the sentence being read
   2 覚える  the voice flows into the container (the brand mark, centre-left) and gathers into a voiceprint
   3 話す    the container moves down-left; the same voice leaves it to the right, as a copy (blue, slight colour split)
   4 はじまり the original ends on 「声を登録する」, the copy on 「登録済みの声を使う」
   Each scene is a keyframe; between scenes every value is eased from one keyframe to the next.
   Text stays in the DOM; the canvas only draws light. Without canvas, a CSS beam and a still mark remain. */

const Landing = (() => {
  const WHITE = [255, 255, 255];
  const COPY = [157, 177, 255];
  // The brand mark in a 36-unit box (same numbers as UI.mark)
  const BARS = [[8.8, 7], [12.8, 14], [16.8, 20], [20.8, 10], [24.8, 15]];
  // Text the light must not run through while scenes scroll past each other.
  // The two entry buttons are left out on purpose: the lines are meant to end on them.
  const TEXT = ".lp-title, .lp-sub, .lp-scroll, .lp-no, .lp-h, .lp-body, .lp-quote, .lp-bub-me, .lp-bub-vb, .lp-foot";

  let root = null;
  let canvas = null;
  let g = null;
  let rail = [];
  let scenes = [];
  let ctas = [];
  let texts = []; // { el, size }: the TEXT elements and their font size (read again on resize)
  let running = false;
  let raf = 0;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let clock = 0;
  let last = 0;
  let reduced = false;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  function init() {
    root = document.getElementById("landing");
    canvas = document.getElementById("lp-canvas");
    rail = [...root.querySelectorAll(".lp-rail button")];
    scenes = [...root.querySelectorAll(".lp-scene")];
    ctas = [document.getElementById("lp-cta"), document.getElementById("lp-cta-2")];
    texts = [...root.querySelectorAll(TEXT)].map((el) => ({ el, size: 16 }));
    rail.forEach((btn) => btn.addEventListener("click", () => {
      const scene = scenes[Number(btn.dataset.goto)];
      window.scrollTo({ top: scene.offsetTop, behavior: reduced ? "auto" : "smooth" });
    }));
    // DOM pieces that also work without canvas
    const still = root.querySelector(".lp-mark-still");
    if (still) still.innerHTML = UI.mark("lp-mark");
    const bars = root.querySelector(".lp-bars");
    if (bars) bars.innerHTML = Array.from({ length: 26 }, (_, i) => {
      const h = 0.25 + 0.75 * Math.abs(Math.sin(i * 0.9) * Math.sin(i * 0.37 + 0.6));
      return `<i style="height:${Math.round(h * 100)}%"></i>`;
    }).join("");
    try { g = canvas.getContext("2d"); } catch { g = null; }
  }

  // Scroll position in scenes: 0 = first scene, 4 = last scene
  function progress() {
    const unit = scenes[1] ? scenes[1].offsetTop : window.innerHeight;
    return clamp(window.scrollY / unit, 0, scenes.length - 1);
  }

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    texts.forEach((t) => { t.size = parseFloat(getComputedStyle(t.el).fontSize) || 16; });
  }

  function updateRail(p) {
    const idx = Math.round(p);
    rail.forEach((btn, i) => {
      btn.classList.toggle("is-on", i === idx);
      if (i === idx) btn.setAttribute("aria-current", "step");
      else btn.removeAttribute("aria-current");
    });
  }

  /* ---------- Keyframes ---------- */

  // Centre of a button plus its left / right edges (lines stop at the edge, never cross the label)
  function anchorOf(el, fallback) {
    if (!el) return { ...fallback, l: fallback.x, r: fallback.x };
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left + 10, r: r.right - 10 };
  }

  // Layout of every scene for the current screen. Values: [序, 録る, 覚える, 話す, はじまり]
  function keyframes() {
    const portrait = H > W * 1.1;
    const lpLeft = W <= 639 ? 54 : 72 + W * 0.06;
    const A = portrait ? Math.min(H * 0.06, 50) : Math.min(H * 0.1, 92);
    const P1 = anchorOf(ctas[0], { x: W * 0.42, y: H * 0.55 });
    const P2 = anchorOf(ctas[1], { x: W * 0.58, y: H * 0.55 });

    // 覚える: big container, centre-left (top-centre on portrait)
    const s2 = portrait ? Math.min(W * 0.5, H * 0.24, 220) : Math.min(H * 0.36, W * 0.24, 320);
    const b2 = portrait ? { x: (36 + W) / 2, y: H * 0.34, s: s2 } : { x: Math.max(W * 0.33, lpLeft + s2 / 2), y: H * 0.5, s: s2 };
    // 話す: smaller container, lower-left
    const s3 = portrait ? Math.min(W * 0.2, 84) : Math.min(H * 0.17, 150);
    const b3 = portrait ? { x: lpLeft + s3 / 2, y: H * 0.85, s: s3 } : { x: lpLeft + s3 / 2 + W * 0.03, y: H * 0.76, s: s3 };

    const heroY = portrait ? H * 0.72 : H * 0.8;
    const bandY = portrait ? H * 0.84 : H * 0.8;
    const edge = (b) => b.x - b.s * 0.36;   // where a line meets the frame (left)
    const exit = (b) => b.x + b.s * 0.36;   // where the copy leaves it (right)

    return {
      // original voice (white)
      oy: [heroY, bandY, b2.y, b3.y, P1.y],
      oEnd: [portrait ? W * 0.7 : W * 0.43, W + 20, edge(b2), edge(b3), P1.l],
      oAmp: [0, A, A * 0.8, A * 0.55, 0],
      rhythm: [0, 1, 0.7, 0.5, 0],
      // container
      bx: [b2.x, b2.x, b2.x, b3.x, P1.x],
      by: [b2.y, b2.y, b2.y, b3.y, P1.y],
      bs: [b2.s * 0.8, b2.s * 0.8, b2.s, b3.s, b3.s * 0.6],
      bAlpha: [0, 0, 1, 1, 0],
      // copy (blue)
      cStart: [exit(b2), exit(b2), exit(b2), exit(b3), P2.r],
      cStop: [exit(b2), exit(b2), exit(b2), W + 20, W + 20],
      cy: [b2.y, b2.y, b2.y, b3.y, P2.y],
      cAmp: [0, 0, 0, A * 0.75, 0],
      cAlpha: [0, 0, 0, 1, 1],
      P1, P2,
    };
  }

  // Value of one keyframe track at scroll position p (holds near each scene, eases in between)
  function at(track, p) {
    const k = Math.min(track.length - 2, Math.floor(p));
    const t = smooth(k + 0.22, k + 1, p);
    return lerp(track[k], track[k + 1], t);
  }

  /* ---------- Shapes ---------- */

  // Steady phrases (beam / copy)
  function envelope(w) {
    const phrase = Math.sin(w * 0.0042) ** 2;
    const syllable = 0.55 + 0.45 * Math.sin(w * 0.021 + 1.3);
    return 0.16 + 0.84 * phrase * syllable;
  }
  // Speech: bursts separated by real pauses
  function speech(w) {
    const gate = clamp((Math.sin(w * 0.0068 + 0.5) + 0.12) / 0.42, 0, 1);
    const syllable = 0.45 + 0.55 * Math.abs(Math.sin(w * 0.024 + 0.8));
    return gate * syllable;
  }
  const carrier = (w) => Math.sin(w * 0.085) * 0.7 + Math.sin(w * 0.23 + 0.6) * 0.3;

  function linePoints(x0, x1, cy, amp, flow, rhythm, taperIn, taperOut) {
    const pts = [];
    if (x1 - x0 < 2) return pts;
    const zoom = clamp(1100 / W, 1, 2.4); // narrow screens still show phrases and pauses
    for (let x = x0; x <= x1; x += 3) {
      const w = x - flow; // the voice travels to the right
      const tin = taperIn ? clamp((x - x0) / taperIn, 0, 1) : 1;
      const tout = taperOut ? clamp((x1 - x) / taperOut, 0, 1) : 1;
      const env = lerp(envelope(w * zoom), speech(w * zoom), rhythm);
      pts.push(x, cy + amp * env * Math.min(tin, tout) * carrier(w));
    }
    return pts;
  }

  function rgba(rgb, a) {
    return `rgba(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])},${a})`;
  }

  // A line of light: a soft halo, then a bright core
  function glowStroke(path, rgb, alpha, width) {
    g.shadowColor = rgba(rgb, alpha);
    g.shadowBlur = 22 * dpr;
    g.strokeStyle = rgba(rgb, alpha * 0.28);
    g.lineWidth = width * 5;
    g.stroke(path);
    g.shadowBlur = 8 * dpr;
    g.strokeStyle = rgba(rgb, alpha);
    g.lineWidth = width;
    g.stroke(path);
    g.shadowBlur = 0;
  }

  function polyline(pts) {
    const path = new Path2D();
    if (pts.length < 4) return path;
    path.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) path.lineTo(pts[i], pts[i + 1]);
    return path;
  }

  function halo(x, y, r, rgb, alpha) {
    if (alpha <= 0.001 || r <= 0) return;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, rgba(rgb, alpha));
    grad.addColorStop(1, rgba(rgb, 0));
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // The container: two brackets (the brand mark) with the voiceprint gathering inside
  function drawContainer(cx, cy, size, alpha, gather, tint) {
    const u = size / 36;
    const X = (v) => cx + (v - 18) * u;
    const Y = (v) => cy + (v - 18) * u;
    const r = 2.5 * u;
    const col = [lerp(255, COPY[0], tint), lerp(255, COPY[1], tint), 255];

    halo(cx, cy, size * 0.95, col, (0.07 + (reduced ? 0 : 0.03 * Math.sin(clock * 2))) * alpha);
    const frame = new Path2D();
    frame.moveTo(X(8.5), Y(6)); frame.lineTo(X(6.5), Y(6));
    frame.arcTo(X(4), Y(6), X(4), Y(8.5), r); frame.lineTo(X(4), Y(27.5));
    frame.arcTo(X(4), Y(30), X(6.5), Y(30), r); frame.lineTo(X(8.5), Y(30));
    frame.moveTo(X(27.5), Y(6)); frame.lineTo(X(29.5), Y(6));
    frame.arcTo(X(32), Y(6), X(32), Y(8.5), r); frame.lineTo(X(32), Y(27.5));
    frame.arcTo(X(32), Y(30), X(29.5), Y(30), r); frame.lineTo(X(27.5), Y(30));
    glowStroke(frame, col, 0.92 * alpha, Math.max(1.4, size / 120));

    // Bars grow as the voice is learned, and breathe a little
    g.shadowColor = rgba(col, 0.9 * alpha);
    g.shadowBlur = 12 * dpr;
    g.fillStyle = rgba(col, 0.92 * alpha);
    BARS.forEach(([x, h], i) => {
      const breathe = reduced ? 1 : 1 + 0.07 * Math.sin(clock * 2.6 + i * 1.3);
      const hh = Math.max(2.4, h * (0.18 + 0.82 * gather) * breathe) * u;
      const bar = new Path2D();
      bar.roundRect(X(x), cy - hh / 2, 2.4 * u, hh, 1.2 * u);
      g.fill(bar);
    });
    g.shadowBlur = 0;
  }

  /* ---------- One frame ---------- */

  function draw(p) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, W, H);
    g.globalCompositeOperation = "lighter";
    g.lineJoin = "round";
    g.lineCap = "round";

    const K = keyframes();
    const v = (name) => at(K[name], p);
    const flow = clock * 70 + p * 240;
    const final = smooth(3.22, 4, p);
    const into = smooth(1.22, 2, p);     // the voice reaches the container

    // Step 1: the original voice (white)
    const oy = v("oy");
    const oEnd = v("oEnd");
    const oAmp = v("oAmp") * smooth(0.25, 0.9, p);
    const original = polyline(linePoints(-10, oEnd, oy, oAmp, flow, v("rhythm"), 80, 90 * into * (1 - final)));
    glowStroke(original, WHITE, 0.95, 1.6);
    if (p < 1) halo(oEnd, oy, 90, WHITE, 0.45 * (1 - smooth(0.3, 1, p)) + 0.1);
    halo(oEnd, oy, Math.min(W, H) * 0.3, WHITE, 0.05 * (1 - into));

    // Step 2: the container
    const bAlpha = v("bAlpha");
    if (bAlpha > 0.01) {
      const gather = smooth(1.45, 2.05, p);
      const tint = smooth(2.2, 3, p);
      drawContainer(v("bx"), v("by"), v("bs"), bAlpha, gather, tint);
    }

    // Step 3: the copy — same shape, blue light, a slight colour split
    const cAlpha = v("cAlpha");
    const cStart = v("cStart");
    const cStop = v("cStop");
    if (cAlpha > 0.01 && cStop - cStart > 4) {
      const pts = linePoints(cStart, cStop, v("cy"), v("cAmp"), flow, v("rhythm"), 70, 0);
      const copy = polyline(pts);
      const split = 1.8 * (1 - final);
      if (split > 0.1) {
        g.save(); g.translate(-split, -split * 0.6);
        glowStroke(copy, [255, 120, 176], 0.3 * cAlpha, 1);
        g.translate(split * 2, split * 1.2);
        glowStroke(copy, [110, 232, 255], 0.3 * cAlpha, 1);
        g.restore();
      }
      glowStroke(copy, COPY, 0.95 * cAlpha, 1.6);
    }

    // Step 4: light gathers on the two ways in
    if (final > 0) {
      halo(K.P1.x, K.P1.y, 40 + 160 * final, WHITE, 0.3 * final);
      halo(K.P2.x, K.P2.y, 40 + 140 * final, COPY, 0.24 * final);
    }

    // Step 5: keep the words readable
    clearBehindText();
  }

  // While one scene scrolls in, its words would cross the line or the container.
  // So, as the last step of every frame, softly erase the light behind each piece of text on screen.
  // At rest this hardly touches anything: each scene keeps its text away from its own light.
  function clearBehindText() {
    const FAR = 10000; // each rectangle is drawn this far off to the left; only its blurred shadow lands on the text
    const range = document.createRange();
    g.globalCompositeOperation = "destination-out"; // drawing now removes light instead of adding it
    g.fillStyle = "#000";
    g.shadowColor = "#000";
    g.shadowBlur = 24 * dpr; // the shadow alone gives soft edges, without the hard border of a filled rectangle
    g.shadowOffsetX = FAR * dpr;
    texts.forEach(({ el, size }) => {
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect(); // the text itself, not the whole block
      if (!r.width || r.bottom < 0 || r.top > H) return;
      const pad = 12 + size * 0.2; // wide enough that the soft edge stays outside the letters
      const hang = el.classList.contains("lp-quote") ? size : 0; // the 「 hangs one character to the left
      g.fillRect(r.left - pad - hang - FAR, r.top - pad, r.width + pad * 2 + hang, r.height + pad * 2);
    });
    g.shadowBlur = 0;
    g.shadowOffsetX = 0;
  }

  /* ---------- Loop ---------- */

  function frame(now) {
    if (!running) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    clock += dt;
    draw(progress());
    raf = requestAnimationFrame(frame);
  }

  function onScroll() {
    const p = progress();
    updateRail(p);
    if (reduced && g) draw(p);
  }

  function onResize() {
    if (!g) return;
    resize();
    draw(progress());
  }

  function start() {
    if (!root) init();
    running = true;
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    updateRail(progress());
    if (!g) return; // CSS beam and the still mark stay as the static version
    resize();
    draw(progress());
    requestAnimationFrame(() => root.classList.add("is-live"));
    if (!reduced) {
      last = 0;
      raf = requestAnimationFrame(frame);
    }
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
  }

  return { start, stop };
})();
