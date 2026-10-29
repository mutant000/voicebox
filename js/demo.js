/* 操作デモ: in mock mode only, the sample speaker starts with one finished conversation
   (your text → a reply with 3 段, player, seeking and downloads), so every control can be tried at once.
   The sound is the mock's synthetic tone and is labelled デモ音声 — never presented as a trained voice.
   With a real backend nothing is inserted. The record side always starts empty. */

const Demo = (() => {
  const SPEAKER = "spk_sample";
  const SEGMENTS = [
    "おはようございます。",
    "今日は駅前の新しいパン屋さんで、焼きたてのクロワッサンを買いました。",
    "来週の金曜日に、みんなで行ってみませんか。",
  ];
  let seeding = null;

  // Returns true when a demo conversation was added
  function seed() {
    if (!API_CONFIG.USE_MOCK) return Promise.resolve(false);
    if (seeding) return seeding;
    seeding = (async () => {
      try {
        if (ChatStore.list(SPEAKER).length) return false;
        const speakers = await Api.listSpeakers();
        if (!speakers.some((s) => s.id === SPEAKER && s.status === "ready")) return false;
        // Step 1: one demo tone per 段, joined like a real result
        const blobs = SEGMENTS.map((text, i) => AudioKit.makeDemoWav(Math.min(14, 0.8 + [...text].length * 0.11), 40 + i * 7));
        const joined = await AudioKit.joinBlobs(blobs, 0.25);
        if (ChatStore.list(SPEAKER).length) return false; // the user got there first
        const text = SEGMENTS.join("");
        const at = new Date(Date.now() - 4 * 60000);
        // Step 2: the cover, your message, and the finished reply
        ChatStore.add(SPEAKER, { type: "sys", cover: true, demo: true, at });
        ChatStore.add(SPEAKER, { type: "me", text, demo: true, at });
        ChatStore.add(SPEAKER, {
          type: "vb",
          demo: true,
          at,
          segments: SEGMENTS,
          done: SEGMENTS.length,
          joining: false,
          entry: {
            text,
            segments: SEGMENTS.map((seg, i) => ({ text: seg, blob: blobs[i], start: joined.starts[i], duration: joined.durations[i] })),
            blob: joined.blob,
            duration: joined.duration,
            peaks: joined.peaks,
            seconds: 2.4,
            createdAt: at,
          },
        });
        return true;
      } catch {
        return false;
      } finally {
        seeding = null;
      }
    })();
    return seeding;
  }

  return { seed, SPEAKER };
})();
