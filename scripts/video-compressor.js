// CompressPixel video compressor
// Runs fully in the browser. Primary engine: WebCodecs via Mediabunny (hardware accelerated).
// Fallback engine: ffmpeg.wasm (single-threaded, works on GitHub Pages without special headers).

const MEDIABUNNY_URL = "https://cdn.jsdelivr.net/npm/mediabunny@1.61.1/dist/bundles/mediabunny.min.mjs";
const FFMPEG_CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";
const AUDIO_BITRATE = 96_000;
const MB = 1000 * 1000; // decimal MB, matches how email and chat apps count limits

const PRESETS = {
  whatsapp: { label: "WhatsApp", targetMb: 16, note: "Keeps the video under 16 MB so it sends on WhatsApp chats and Status without WhatsApp crushing it further." },
  gmail: { label: "Gmail", targetMb: 22, note: "Gmail attachments max out at 25 MB per email. We aim for 22 MB to leave room for the email itself, so the video attaches instead of becoming a Drive link." },
  outlook: { label: "Outlook", targetMb: 18, note: "Outlook and most work mailboxes cap emails at 20 MB. We aim for 18 MB to leave headroom so it does not bounce." },
  discord: { label: "Discord", targetMb: 20, note: "Free Discord accounts can upload files up to 20 MB (raised from 10 MB in August 2026). Nitro users can pick Custom size." },
  quality: { label: "Smaller, same look", targetMb: null, note: "No size limit. Re-encodes efficiently and usually cuts phone videos by 50-80% with little visible difference." },
  custom: { label: "Custom size", targetMb: 50, note: "Pick any size in MB. We will fit the video under it, lowering resolution only when needed." }
};

const state = { files: [], results: [], running: false, cancel: null, mediabunny: null, ffmpeg: null };

const $ = (sel) => document.querySelector(sel);
const el = {
  input: $("#videoInput"),
  select: $("#selectVideos"),
  drop: $("#videoDrop"),
  preset: $("#videoPreset"),
  customWrap: $("#customSizeWrap"),
  customMb: $("#customMb"),
  resolution: $("#videoResolution"),
  audio: $("#videoAudio"),
  note: $("#videoNote"),
  start: $("#startCompress"),
  cancel: $("#cancelCompress"),
  queue: $("#videoQueue"),
  empty: $("#videoEmpty"),
  engine: $("#engineInfo")
};

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i < 2 ? 0 : 1)} ${units[i]}`;
}

function formatTime(sec) {
  if (!isFinite(sec) || sec < 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m ? `${m}m ${s}s` : `${s}s`;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function outputName(file) {
  return `${file.name.replace(/\.[^.]+$/, "")}-compressed.mp4`;
}

function currentSettings() {
  const presetKey = el.preset.value;
  const preset = PRESETS[presetKey];
  let targetMb = preset.targetMb;
  if (presetKey === "custom") targetMb = Math.max(1, Number(el.customMb.value) || 50);
  return {
    presetKey,
    targetBytes: targetMb ? targetMb * MB : null,
    resolution: el.resolution.value,
    keepAudio: el.audio.value === "keep"
  };
}

function updateNote() {
  const key = el.preset.value;
  el.customWrap.hidden = key !== "custom";
  el.note.textContent = PRESETS[key].note;
  try { localStorage.setItem("cp-video-preset", key); } catch (e) { /* storage unavailable */ }
}

// Pick output height and video bitrate.
function plan(meta, settings) {
  const { duration, width, height, fps } = meta;
  const shortSide = Math.min(width, height);
  const audioBits = settings.keepAudio && meta.hasAudio ? AUDIO_BITRATE : 0;
  let videoBitrate;

  if (settings.targetBytes) {
    // 6% container overhead and safety margin
    const totalBits = settings.targetBytes * 8 * 0.94;
    videoBitrate = Math.floor(totalBits / Math.max(duration, 0.5) - audioBits);
  } else {
    videoBitrate = null; // quality mode
  }

  let targetShort = shortSide;
  if (settings.resolution !== "auto" && settings.resolution !== "original") {
    targetShort = Math.min(shortSide, Number(settings.resolution));
  } else if (settings.resolution === "auto") {
    targetShort = Math.min(shortSide, 1080);
    if (videoBitrate) {
      // Drop resolution until there are enough bits per pixel for a clean picture.
      const ladder = [1080, 720, 540, 480, 360, 240];
      for (const step of ladder) {
        if (step > shortSide) continue;
        targetShort = step;
        const longSide = step * (Math.max(width, height) / shortSide);
        const bpp = videoBitrate / (step * longSide * Math.min(fps || 30, 30));
        if (bpp >= 0.06) break;
      }
    }
  }

  const scale = targetShort / shortSide;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return {
    width: even(width * scale),
    height: even(height * scale),
    videoBitrate,
    audioBitrate: audioBits || null,
    tooSmall: videoBitrate !== null && videoBitrate < 80_000
  };
}

async function loadMediabunny() {
  if (!state.mediabunny) state.mediabunny = await import(MEDIABUNNY_URL);
  return state.mediabunny;
}

async function probe(file) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error("No video track found in this file.");
  const audio = await input.getPrimaryAudioTrack();
  const duration = await input.computeDuration();
  let fps = 30;
  try {
    const stats = await video.computePacketStats(120);
    if (stats && stats.averagePacketRate) fps = stats.averagePacketRate;
  } catch (e) { /* keep default */ }
  return { duration, width: video.displayWidth, height: video.displayHeight, fps, hasAudio: !!audio };
}

function supportsWebCodecs() {
  return typeof window.VideoEncoder === "function" && typeof window.VideoDecoder === "function";
}

async function encodeWithMediabunny(file, p, settings, onProgress, registerCancel) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target: new mb.BufferTarget() });

  const video = {
    codec: "avc",
    width: p.width,
    height: p.height,
    fit: "contain",
    forceTranscode: true,
    quality: p.videoBitrate
      ? new mb.Quality({ bitrate: p.videoBitrate, bitrateMode: "variable" })
      : new mb.Quality({ quality: "medium" })
  };
  const audio = settings.keepAudio
    ? { codec: "aac", quality: new mb.Quality({ bitrate: AUDIO_BITRATE }), forceTranscode: true }
    : { discard: true };

  const conversion = await mb.Conversion.init({ input, output, video, audio, showWarnings: false });
  if (!conversion.isValid) {
    const reasons = conversion.discardedTracks.map((t) => t.reason).join(", ");
    throw new Error(`Browser encoder unavailable (${reasons || "unknown"})`);
  }
  // Never silently drop the sound: if this browser can't encode the audio, let the fallback engine handle it.
  const lostAudio = conversion.discardedTracks.some((d) => d.track.type === "audio" && d.reason !== "discarded_by_user");
  if (settings.keepAudio && lostAudio) throw new Error("Browser audio encoder unavailable");
  conversion.onProgress = (progress) => onProgress(progress);
  registerCancel(() => conversion.cancel());
  await conversion.execute();
  return new Blob([output.target.buffer], { type: "video/mp4" });
}

async function loadFfmpeg() {
  if (state.ffmpeg) return state.ffmpeg;
  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
  const base = new URL("../vendor/ffmpeg/", import.meta.url);
  await loadScript(new URL("ffmpeg.js", base).href);
  const { FFmpeg } = window.FFmpegWASM;
  const toBlobURL = async (url, type) => URL.createObjectURL(new Blob([await (await fetch(url)).arrayBuffer()], { type }));
  const ffmpeg = new FFmpeg();
  await ffmpeg.load({
    coreURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, "application/wasm")
  });
  state.ffmpeg = ffmpeg;
  return ffmpeg;
}

async function encodeWithFfmpeg(file, p, settings, onProgress, registerCancel) {
  const ffmpeg = await loadFfmpeg();
  const ext = (file.name.split(".").pop() || "mp4").toLowerCase();
  const inName = `input.${ext}`;
  await ffmpeg.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
  const handler = ({ progress }) => onProgress(Math.min(1, Math.max(0, progress)));
  ffmpeg.on("progress", handler);
  registerCancel(() => { ffmpeg.terminate(); state.ffmpeg = null; });
  const args = ["-i", inName, "-vf", `scale=${p.width}:${p.height}`, "-c:v", "libx264", "-preset", "veryfast"];
  if (p.videoBitrate) {
    const k = Math.floor(p.videoBitrate / 1000);
    args.push("-b:v", `${k}k`, "-maxrate", `${Math.floor(k * 1.3)}k`, "-bufsize", `${k * 2}k`);
  } else {
    args.push("-crf", "26");
  }
  args.push("-pix_fmt", "yuv420p");
  if (settings.keepAudio) args.push("-c:a", "aac", "-b:a", "96k"); else args.push("-an");
  args.push("-movflags", "+faststart", "out.mp4");
  try {
    await ffmpeg.exec(args);
    const data = await ffmpeg.readFile("out.mp4");
    return new Blob([data.buffer], { type: "video/mp4" });
  } finally {
    ffmpeg.off("progress", handler);
    try { await ffmpeg.deleteFile(inName); await ffmpeg.deleteFile("out.mp4"); } catch (e) { /* ignore */ }
  }
}

function renderQueue() {
  const items = state.files;
  el.empty.hidden = items.length > 0;
  el.start.disabled = state.running || !items.some((i) => i.status === "ready");
  el.cancel.hidden = !state.running;
  el.queue.innerHTML = items.map((item, idx) => {
    const pct = Math.round((item.progress || 0) * 100);
    const done = item.status === "done";
    const saved = done ? Math.max(0, Math.round((1 - item.blob.size / item.file.size) * 100)) : 0;
    const shareBtn = done && item.canShare ? `<button class="secondary-action" data-share="${idx}" type="button">Share</button>` : "";
    return `
      <article class="video-card ${item.status}">
        ${done ? `<video src="${item.url}" controls preload="metadata" playsinline></video>` : `<div class="video-thumb" aria-hidden="true">▶</div>`}
        <div class="result-meta">
          <span class="result-name">${escapeHtml(item.file.name)}</span>
          <span>${formatBytes(item.file.size)}${item.meta ? ` · ${item.meta.width}×${item.meta.height} · ${formatTime(item.meta.duration)}` : ""}</span>
          ${done ? `<span class="saving">${formatBytes(item.blob.size)} · ${saved}% smaller · ${item.outW}×${item.outH}</span>` : ""}
          ${item.status === "working" ? `<div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div><small>${escapeHtml(item.message || "")} ${pct}%${item.eta ? ` · about ${formatTime(item.eta)} left` : ""}</small>` : ""}
          ${item.status === "error" ? `<span class="error-text">${escapeHtml(item.message)}</span>` : ""}
          ${item.status === "ready" ? `<small>Ready to compress</small>` : ""}
        </div>
        <div class="video-actions">
          ${done ? `<a class="primary-action" href="${item.url}" download="${escapeHtml(outputName(item.file))}">Download</a>${shareBtn}` : ""}
          ${!state.running && item.status !== "working" ? `<button class="icon-button" data-remove="${idx}" type="button" aria-label="Remove ${escapeHtml(item.file.name)}">×</button>` : ""}
        </div>
      </article>`;
  }).join("");
}

function addFiles(fileList) {
  const added = [...fileList].filter((f) => f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(f.name));
  if (!added.length) return;
  for (const file of added) state.files.push({ file, status: "ready", progress: 0 });
  renderQueue();
  if (!state.running) el.start.focus();
}

async function compressItem(item, baseSettings) {
  let settings = baseSettings;
  item.status = "working";
  item.message = "Reading video";
  item.progress = 0;
  renderQueue();

  let meta;
  try {
    meta = await probe(item.file);
  } catch (e) {
    meta = null;
  }
  if (meta) item.meta = meta;

  // Already under the limit: switch to quality mode so we only ever make it smaller.
  if (settings.targetBytes && item.file.size <= settings.targetBytes) {
    settings = { ...settings, targetBytes: null };
  }

  const fallbackMeta = meta || { duration: 60, width: 1280, height: 720, fps: 30, hasAudio: true };
  let p = plan(fallbackMeta, settings);
  if (p.tooSmall) {
    throw new Error(`This video is too long to fit in ${formatBytes(settings.targetBytes)} with watchable quality. Try a larger size or trim it first.`);
  }

  const useWebCodecs = supportsWebCodecs() && meta;
  const started = performance.now();
  const onProgress = (progress) => {
    item.progress = progress;
    const elapsed = (performance.now() - started) / 1000;
    item.eta = progress > 0.03 ? elapsed / progress - elapsed : null;
    renderQueue();
  };
  const registerCancel = (fn) => { state.cancel = fn; };

  let blob;
  let attempts = 0;
  let engine = useWebCodecs ? "webcodecs" : "ffmpeg";
  while (true) {
    attempts += 1;
    item.message = engine === "webcodecs" ? "Compressing (fast mode)" : "Compressing (compatibility mode)";
    try {
      blob = engine === "webcodecs"
        ? await encodeWithMediabunny(item.file, p, settings, onProgress, registerCancel)
        : await (async () => { item.message = "Loading compatibility engine (one-time, ~30 MB)"; renderQueue(); return encodeWithFfmpeg(item.file, p, settings, onProgress, registerCancel); })();
    } catch (e) {
      if (state.cancelled) throw e;
      if (engine === "webcodecs") {
        console.warn("WebCodecs path failed, falling back to ffmpeg.wasm", e);
        engine = "ffmpeg";
        attempts -= 1;
        continue;
      }
      throw e;
    }
    // Guarantee the size limit: if the encoder overshot, retry with a lower bitrate.
    if (settings.targetBytes && blob.size > settings.targetBytes && p.videoBitrate && attempts < 3) {
      const ratio = (settings.targetBytes / blob.size) * 0.92;
      p = { ...p, videoBitrate: Math.floor(p.videoBitrate * ratio) };
      item.progress = 0;
      item.message = "Fine-tuning to hit the size limit";
      renderQueue();
      continue;
    }
    break;
  }

  // Quality mode should never hand back a bigger file.
  if (!settings.targetBytes && blob.size >= item.file.size) {
    blob = item.file;
  }

  item.blob = blob;
  item.url = URL.createObjectURL(blob);
  item.outW = p.width;
  item.outH = p.height;
  item.status = "done";
  item.progress = 1;
  try {
    const shareFile = new File([blob], outputName(item.file), { type: "video/mp4" });
    item.canShare = !!(navigator.canShare && navigator.canShare({ files: [shareFile] }));
    item.shareFile = shareFile;
  } catch (e) { item.canShare = false; }
  if (settings.targetBytes && blob.size > settings.targetBytes) {
    item.message = "Could not get fully under the limit";
  }
}

async function runQueue() {
  if (state.running) return;
  state.running = true;
  state.cancelled = false;
  const settings = currentSettings();
  renderQueue();
  for (const item of state.files) {
    if (item.status !== "ready") continue;
    if (state.cancelled) break;
    try {
      await compressItem(item, settings);
    } catch (e) {
      item.status = state.cancelled ? "ready" : "error";
      item.message = state.cancelled ? "" : (e && e.message) || "Something went wrong.";
      item.progress = 0;
    }
    renderQueue();
  }
  state.running = false;
  state.cancel = null;
  renderQueue();
}

function init() {
  if (!el.input) return;
  const pagePreset = document.body.dataset.videoPreset;
  let saved = null;
  try { saved = localStorage.getItem("cp-video-preset"); } catch (e) { /* ignore */ }
  el.preset.value = pagePreset || (saved && PRESETS[saved] ? saved : "whatsapp");
  updateNote();

  el.engine.textContent = supportsWebCodecs()
    ? "Fast mode: uses your device's video hardware"
    : "Compatibility mode: slower, but works in this browser";

  el.select.addEventListener("click", () => el.input.click());
  el.input.addEventListener("change", () => { addFiles(el.input.files); el.input.value = ""; });
  ["dragenter", "dragover"].forEach((evt) => el.drop.addEventListener(evt, (e) => { e.preventDefault(); el.drop.classList.add("is-dragging"); }));
  ["dragleave", "drop"].forEach((evt) => el.drop.addEventListener(evt, (e) => { e.preventDefault(); el.drop.classList.remove("is-dragging"); }));
  el.drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
  el.preset.addEventListener("change", updateNote);
  el.start.addEventListener("click", runQueue);
  el.cancel.addEventListener("click", async () => {
    state.cancelled = true;
    if (state.cancel) { try { await state.cancel(); } catch (e) { /* ignore */ } }
  });
  el.queue.addEventListener("click", async (e) => {
    const remove = e.target.closest("[data-remove]");
    const share = e.target.closest("[data-share]");
    if (remove) {
      const item = state.files[Number(remove.dataset.remove)];
      if (item && item.url) URL.revokeObjectURL(item.url);
      state.files.splice(Number(remove.dataset.remove), 1);
      renderQueue();
    }
    if (share) {
      const item = state.files[Number(share.dataset.share)];
      try { await navigator.share({ files: [item.shareFile], title: item.shareFile.name }); } catch (err) { /* user cancelled */ }
    }
  });
  window.addEventListener("beforeunload", (e) => { if (state.running) { e.preventDefault(); e.returnValue = ""; } });
  renderQueue();
}

init();
