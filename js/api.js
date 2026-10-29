/* All communication with the backend lives here.
   Switch USE_MOCK to false once the backend server is running. */

const API_CONFIG = {
  USE_MOCK: true,
  BASE_URL: "http://localhost:8000",
};

class ApiError extends Error {
  constructor(status, detail = "") {
    super(detail || `HTTP ${status}`);
    this.status = status; // 0 means the server could not be reached
    this.detail = detail;
  }
}

// Send an HTTP request and turn non-2xx responses into ApiError
async function apiRequest(path, options = {}) {
  let res;
  // Step 1: network failure (server down, CORS, offline) -> status 0; a user abort is passed through
  try {
    res = await fetch(API_CONFIG.BASE_URL + path, options);
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new ApiError(0);
  }
  // Step 2: read the error detail from the JSON body if the server sent one
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : body.message || "";
    } catch { /* body was not JSON */ }
    throw new ApiError(res.status, detail);
  }
  return res;
}

// Convert the server's snake_case JSON into the shape the views use
function toSpeaker(raw) {
  return {
    id: raw.speaker_id ?? raw.id,
    name: raw.name,
    status: raw.status, // "pending" | "training" | "ready" | "failed"
    sampleCount: raw.sample_count ?? 0,
    totalSeconds: raw.total_seconds ?? null,
    createdAt: raw.created_at,
    jobId: raw.job_id ?? null,
    failReason: raw.fail_reason ?? null,
  };
}

function extensionFor(mimeType) {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

const Api = {
  /** GET /speakers -> list of speakers */
  async listSpeakers() {
    let list;
    if (API_CONFIG.USE_MOCK) {
      list = (await MockServer.listSpeakers()).map(toSpeaker);
    } else {
      const res = await apiRequest("/speakers");
      const body = await res.json();
      list = (body.speakers ?? body).map(toSpeaker);
    }
    // Let the sidebar update its speaker count
    window.dispatchEvent(new CustomEvent("speakers:loaded", { detail: list }));
    return list;
  },

  /** POST /speakers (multipart) -> speaker ID
   *  samples: [{ blob, text, duration }] — text is what is said in the audio (may be empty) */
  async createSpeaker(name, samples) {
    if (API_CONFIG.USE_MOCK) return (await MockServer.createSpeaker(name, samples)).speaker_id;
    // Step 1: pack the name, audio files and their transcripts into one form
    const form = new FormData();
    form.append("name", name);
    samples.forEach((sample, i) => {
      const no = String(i + 1).padStart(2, "0");
      form.append("files", sample.blob, `sample_${no}.${extensionFor(sample.blob.type || "")}`);
    });
    form.append("transcripts", JSON.stringify(samples.map((s) => s.text || "")));
    // Step 2: send with POST (the browser sets the multipart Content-Type itself)
    const res = await apiRequest("/speakers", { method: "POST", body: form });
    return (await res.json()).speaker_id;
  },

  /** POST /speakers/{id}/train -> job ID */
  async startTraining(speakerId) {
    if (API_CONFIG.USE_MOCK) return (await MockServer.startTraining(speakerId)).job_id;
    const res = await apiRequest(`/speakers/${encodeURIComponent(speakerId)}/train`, { method: "POST" });
    return (await res.json()).job_id;
  },

  /** GET /jobs/{id} -> { status: "running"|"done"|"failed", progress: 0..1, message } */
  async getJob(jobId) {
    const raw = API_CONFIG.USE_MOCK
      ? await MockServer.getJob(jobId)
      : await (await apiRequest(`/jobs/${encodeURIComponent(jobId)}`)).json();
    return {
      status: raw.status,
      progress: typeof raw.progress === "number" ? raw.progress : null,
      message: raw.message ?? null,
      speakerId: raw.speaker_id ?? null,
    };
  },

  /** POST /synthesize { speaker_id, text } -> audio Blob (audio/wav). `signal` lets the user stop it. */
  async synthesize(speakerId, text, signal) {
    if (API_CONFIG.USE_MOCK) return MockServer.synthesize(speakerId, text, signal);
    const res = await apiRequest("/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ speaker_id: speakerId, text }),
      signal,
    });
    return res.blob();
  },

  /** PATCH /speakers/{id} { name } */
  async renameSpeaker(speakerId, name) {
    if (API_CONFIG.USE_MOCK) return MockServer.renameSpeaker(speakerId, name);
    await apiRequest(`/speakers/${encodeURIComponent(speakerId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  },

  /** DELETE /speakers/{id} */
  async deleteSpeaker(speakerId) {
    if (API_CONFIG.USE_MOCK) return MockServer.deleteSpeaker(speakerId);
    await apiRequest(`/speakers/${encodeURIComponent(speakerId)}`, { method: "DELETE" });
  },
};
