/* App entry: the landing page, and one workbench with two panes that push each other:
   left = 声の登録 (record), right = 音声生成 (clone).
   States: split (50/50) · rec (left open, right is an edge) · syn (right open, left is an edge).
   Both panes stay mounted, so names, samples, drafts and results survive every switch. */

const App = (() => {
  const ROUTE_STATE = { studio: "split", record: "rec", synthesize: "syn", speakers: "syn" };
  const THEME_KEY = "voicebox.theme";
  const SELECTED_KEY = "voicebox.lastSpeaker";

  const state = {
    selectedSpeaker: UI.storage.get(SELECTED_KEY, null),
  };
  let world = null;

  function route() {
    const name = location.hash.replace(/^#/, "");
    return ROUTE_STATE[name] ? name : "home";
  }

  function go(name) {
    if (route() === name && location.hash) render();
    else location.hash = name;
  }

  /* ---------- Workbench ---------- */
  const Bench = (() => {
    let bench = null;
    let mounted = false;
    let current = null;
    let hoverTimer = 0;
    const panes = {};
    const narrow = () => window.matchMedia("(max-width: 767px)").matches;
    const motionMs = () => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 680);

    function mount() {
      if (mounted) return;
      mounted = true;
      bench = document.getElementById("bench");
      panes.rec = { el: document.getElementById("pane-rec"), body: document.getElementById("rec-body") };
      panes.syn = { el: document.getElementById("pane-syn"), body: document.getElementById("syn-body") };

      // Step 1: mount both sides once
      SpeakerList.mount(document.getElementById("list-pane"));
      Views.record.render(document.getElementById("rec-view"));
      Views.synthesize.render(document.getElementById("view"));

      // Step 2: edges (with the brand mark) and expand buttons
      bench.querySelectorAll(".edge-arrow").forEach((a) => a.insertAdjacentHTML("afterend", UI.mark("edge-mark")));
      bench.querySelectorAll("[data-go]").forEach((btn) => btn.addEventListener("click", (e) => {
        e.stopPropagation();
        go(btn.dataset.go);
      }));

      // Step 3: in side-by-side, a click on an empty part of a pane opens it.
      // Controls keep their own job; "click" fires after release, so nothing moves under a press.
      ["rec", "syn"].forEach((side) => {
        panes[side].body.addEventListener("click", (e) => {
          if (current !== "split") return;
          if (e.target.closest("button, a, input, textarea, select, label, canvas, [role=slider], .popover, .seg, .row, .bubble-me, .bubble-vb")) return;
          if (String(window.getSelection())) return;
          go(side === "rec" ? "record" : "synthesize");
        });
        // Hover / keyboard focus brings a side forward (desktop, side-by-side only)
        panes[side].el.addEventListener("mouseenter", () => setHover(side));
        panes[side].el.addEventListener("focusin", () => setHover(side, 0));
      });
      bench.addEventListener("mouseleave", () => setHover(null));
      bench.addEventListener("focusout", (e) => { if (!bench.contains(e.relatedTarget)) setHover(null); });
      window.addEventListener("resize", () => apply(current, true));
    }

    function setHover(side, delay = 120) {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (side && current === "split") bench.dataset.hover = side;
        else delete bench.dataset.hover;
      }, side ? delay : 60);
    }

    function isCollapsed(side, st) {
      return (st === "rec" && side === "syn") || (st === "syn" && side === "rec");
    }

    // Apply a state. A pane that collapses keeps its current width and slides out;
    // a pane that opens from an edge is laid out at its final width and slides in.
    function apply(next, instant = false) {
      if (narrow() && next === "split") next = "rec";
      const prev = current;
      if (prev === next && !instant) return;
      const W = bench.clientWidth;
      const edge = narrow() ? 44 : 64;
      ["rec", "syn"].forEach((side) => {
        const { el, body } = panes[side];
        const was = prev ? isCollapsed(side, prev) : false;
        const will = isCollapsed(side, next);
        if (will && (!prev || instant)) {
          // Collapsed from the start (or after a resize): lay its content out at the width it opens to
          body.style.width = `${W - edge}px`;
        } else if (will && !was) {
          body.style.width = `${body.offsetWidth}px`;
        } else if (!will && was && !instant) {
          body.style.width = `${next === "split" ? W / 2 : W - edge}px`;
          setTimeout(() => { if (!isCollapsed(side, current)) body.style.width = ""; }, motionMs() + 40);
        } else if (!will) {
          body.style.width = "";
        }
        el.classList.toggle("is-collapsed", will);
        // Hidden side: not focusable, not clickable
        body.inert = will;
        el.querySelector(".edge").tabIndex = will ? 0 : -1;
      });
      current = next;
      bench.dataset.state = next;
      delete bench.dataset.hover;
      document.getElementById("split-btn").setAttribute("aria-pressed", String(next === "split"));
    }

    async function show(next) {
      mount();
      // Leaving the record side: finish the take that is being recorded
      if (isCollapsed("rec", next) && current !== null && !isCollapsed("rec", current)) {
        await Views.record.suspend();
      }
      // Opening the record side: stop sound so it is clear where audio comes from
      if (next === "rec") AudioKit.stopAll();
      apply(next);
    }

    return { mount, show, state: () => current };
  })();

  /* ---------- Routing ---------- */
  function setWorld(next) {
    if (world === next) return;
    world = next;
    document.body.dataset.world = next;
    document.getElementById("landing").hidden = next !== "landing";
    document.getElementById("app").hidden = next !== "app";
    window.scrollTo(0, 0);
    if (next === "landing") Landing.start();
    else Landing.stop();
  }

  async function render() {
    const name = route();
    if (name === "home") {
      if (Bench.state()) {
        await Views.record.suspend();
        AudioKit.stopAll();
      }
      setWorld("landing");
      document.title = "voicebox";
      return;
    }
    setWorld("app");
    const st = ROUTE_STATE[name];
    await Bench.show(st);
    document.title = { split: "voicebox", rec: "声の登録 · voicebox", syn: "音声生成 · voicebox" }[Bench.state()];
  }

  // Open a speaker's conversation (keeps the current layout unless asked to open the clone side)
  function selectSpeaker(id, { expand = false } = {}) {
    state.selectedSpeaker = id;
    UI.storage.set(SELECTED_KEY, id);
    SpeakerList.highlight();
    Views.synthesize.render(document.getElementById("view"));
    if (expand) go("synthesize");
  }

  function forgetSpeaker(id) {
    if (state.selectedSpeaker === id) {
      state.selectedSpeaker = null;
      UI.storage.remove(SELECTED_KEY);
    }
  }

  function reloadClone() {
    Views.synthesize.render(document.getElementById("view"));
  }

  /* ---------- Theme: follows the system until the user picks one ---------- */
  function effectiveTheme() {
    const set = document.documentElement.getAttribute("data-theme");
    if (set === "dark" || set === "light") return set;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function syncThemeIcon() {
    const dark = effectiveTheme() === "dark";
    const btn = document.getElementById("theme-btn");
    btn.innerHTML = dark ? UI.ICONS.sun : UI.ICONS.moon;
    btn.setAttribute("aria-label", dark ? "ライトモードに切り替える" : "ダークモードに切り替える");
  }

  function toggleTheme() {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    UI.storage.set(THEME_KEY, next);
    onThemeChanged();
  }

  function onThemeChanged() {
    syncThemeIcon();
    AudioKit.redrawAll(); // canvas waveforms read colors at draw time
    window.dispatchEvent(new Event("theme:changed"));
  }

  // Phones: keep the app exactly as tall as the visible area, so the composer and the
  // submit button stay above the on-screen keyboard
  function fitToViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    const fit = () => {
      if (Math.abs(vv.scale - 1) > 0.01) return; // pinch-zoom: leave the layout alone
      document.documentElement.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
      if (world === "app" && window.scrollY) window.scrollTo(0, 0);
    };
    vv.addEventListener("resize", fit);
    fit();
  }

  function init() {
    fitToViewport();
    const saved = UI.storage.get(THEME_KEY, null);
    if (saved === "dark" || saved === "light") document.documentElement.setAttribute("data-theme", saved);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onThemeChanged);
    document.getElementById("theme-btn").addEventListener("click", toggleTheme);
    document.getElementById("split-btn").addEventListener("click", () => go("studio"));
    document.getElementById("mock-pill").hidden = !API_CONFIG.USE_MOCK;
    syncThemeIcon();
    window.addEventListener("hashchange", render);
    render();
    // Mock only: give the sample speaker a finished demo conversation (no autoplay)
    Demo.seed().then((added) => {
      const intro = document.querySelector("#view .chat-intro");
      if (added && intro && state.selectedSpeaker === Demo.SPEAKER) reloadClone();
    });
  }

  return { state, go, selectSpeaker, forgetSpeaker, reloadClone, toggleTheme, effectiveTheme, init };
})();

App.init();
