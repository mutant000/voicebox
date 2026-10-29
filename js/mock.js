/* Fake backend used while the real server is not ready.
   It follows the same API contract and keeps data in localStorage,
   so training progress survives a page reload.

   Test hooks:
   - a speaker name containing 「失敗」 makes training fail at 60%
   - synthesis text containing 「エラー」 returns HTTP 500 */

const MockServer = (() => {
  const KEY = "koeutsushi.mock.v2";
  const TRAIN_SECONDS = 12;

  // setTimeout that can be cancelled by an AbortSignal (used for "停止")
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const id = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(id);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }
  });
  const uid = (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 8)}`;

  function seed() {
    return {
      speakers: [{
        id: "spk_sample",
        name: "サンプル話者",
        status: "ready",
        sample_count: 15,
        total_seconds: 74,
        created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
        job_id: null,
        fail_reason: null,
      }],
      jobs: {},
    };
  }

  function load() {
    let db = UI.storage.get(KEY, null);
    if (!db || !Array.isArray(db.speakers)) {
      db = seed();
      UI.storage.set(KEY, db);
    }
    return db;
  }

  function save(db) {
    UI.storage.set(KEY, db);
  }

  // Advance every job based on elapsed time, and copy the result to its speaker
  function advanceJobs(db) {
    Object.values(db.jobs).forEach((job) => {
      if (job.status !== "running") return;
      const progress = Math.min(1, (Date.now() - job.started_at) / (TRAIN_SECONDS * 1000));
      job.progress = progress;
      const speaker = db.speakers.find((s) => s.id === job.speaker_id);
      if (job.will_fail && progress >= 0.6) {
        job.status = "failed";
        job.message = "音声に雑音が多く、声の特徴を十分に学習できませんでした。静かな場所で録り直してください。";
        if (speaker) { speaker.status = "failed"; speaker.fail_reason = job.message; }
      } else if (progress >= 1) {
        job.status = "done";
        if (speaker) speaker.status = "ready";
      }
    });
  }

  function findSpeaker(db, id) {
    const speaker = db.speakers.find((s) => s.id === id);
    if (!speaker) throw new ApiError(404);
    return speaker;
  }

  return {
    async listSpeakers() {
      await wait(250);
      const db = load();
      advanceJobs(db);
      save(db);
      return db.speakers.map((s) => ({ ...s }));
    },

    async createSpeaker(name, samples) {
      await wait(700);
      if (!name || !name.trim()) throw new ApiError(400, "話者名が空です");
      if (!samples.length) throw new ApiError(400, "音声ファイルがありません");
      const total = samples.reduce((sum, s) => sum + (s.duration || 0), 0);
      if (total > 300.5) throw new ApiError(400, "音声の合計が 5 分を超えています");
      const db = load();
      const speaker = {
        id: uid("spk"),
        name: name.trim(),
        status: "pending",
        sample_count: samples.length,
        total_seconds: Math.round(total),
        created_at: new Date().toISOString(),
        job_id: null,
        fail_reason: null,
      };
      db.speakers.push(speaker);
      save(db);
      return { speaker_id: speaker.id };
    },

    async startTraining(speakerId) {
      await wait(300);
      const db = load();
      const speaker = findSpeaker(db, speakerId);
      const jobId = uid("job");
      db.jobs[jobId] = {
        id: jobId,
        speaker_id: speakerId,
        started_at: Date.now(),
        status: "running",
        progress: 0,
        will_fail: speaker.name.includes("失敗"),
      };
      speaker.status = "training";
      speaker.job_id = jobId;
      speaker.fail_reason = null;
      save(db);
      return { job_id: jobId };
    },

    async getJob(jobId) {
      await wait(150);
      const db = load();
      advanceJobs(db);
      save(db);
      const job = db.jobs[jobId];
      if (!job) throw new ApiError(404);
      return { job_id: job.id, status: job.status, progress: job.progress, message: job.message || null, speaker_id: job.speaker_id };
    },

    async synthesize(speakerId, text, signal) {
      await wait(700 + [...text].length * 22, signal);
      const db = load();
      advanceJobs(db);
      const speaker = findSpeaker(db, speakerId);
      if (speaker.status !== "ready") throw new ApiError(409);
      if (text.includes("エラー")) throw new ApiError(500);
      const seconds = Math.min(14, 0.8 + [...text].length * 0.11);
      return AudioKit.makeDemoWav(seconds, [...text].length + speaker.name.length);
    },

    async renameSpeaker(speakerId, name) {
      await wait(250);
      if (!name || !name.trim()) throw new ApiError(400, "話者名が空です");
      const db = load();
      findSpeaker(db, speakerId).name = name.trim();
      save(db);
    },

    async deleteSpeaker(speakerId) {
      await wait(250);
      const db = load();
      findSpeaker(db, speakerId);
      db.speakers = db.speakers.filter((s) => s.id !== speakerId);
      Object.keys(db.jobs).forEach((id) => {
        if (db.jobs[id].speaker_id === speakerId) delete db.jobs[id];
      });
      save(db);
    },

    reset() {
      UI.storage.remove(KEY);
    },
  };
})();
