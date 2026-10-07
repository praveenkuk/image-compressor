// Video tools: trim, video to GIF, video to MP3, mute, MOV to MP4. Runs in the browser.
// Fast path: WebCodecs via Mediabunny. Fallback: ffmpeg.wasm (single-threaded).
import * as mb from "mediabunny";
import { $, formatBytes, escapeHtml, baseName, setupDropZone, downloadBlob } from "./tool-common.js";

const MP3_ENCODER = "https://cdn.jsdelivr.net/npm/@mediabunny/mp3-encoder@1.61.3/dist/bundles/mediabunny-mp3-encoder.min.mjs";
const GIFENC = "https://cdn.jsdelivr.net/npm/gifenc@1.0.3/dist/gifenc.esm.js";
const FFMPEG_CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";

const MODE = document.body.dataset.mode || "trim";
const el = {
  zone: $("#vtDrop"), input: $("#vtInput"), choose: $("#vtChoose"), panel: $("#vtPanel"),
  preview: $("#vtPreview"), video: $("#vtVideo"), start: $("#vtStart"), end: $("#vtEnd"),
  setStart: $("#vtSetStart"), setEnd: $("#vtSetEnd"), range: $("#vtRangeInfo"),
  gifWidth: $("#vtGifWidth"), gifFps: $("#vtGifFps"), mp3Rate: $("#vtMp3Rate"), compat: $("#vtCompat"),
  run: $("#vtRun"), cancel: $("#vtCancel"), status: $("#vtStatus"), result: $("#vtResult"), fileInfo: $("#vtFileInfo")
};
const state = { file: null, duration: 0, running: false, cancel: null, ffmpeg: null };

const fmtTime = (t) => {
  if (!isFinite(t)) return "0:00.0";
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
};
const hasWebCodecs = () => typeof window.VideoEncoder === "function" && typeof window.VideoDecoder === "function";

function setStatus(text, pct) {
  el.status.hidden = !text;
  el.status.innerHTML = text ? `<span>${escapeHtml(text)}</span>${pct != null ? `<div class="progress"><span style="width:${Math.round(pct * 100)}%"></span></div>` : ""}` : "";
}

function selection() {
  const start = Math.max(0, Number(el.start?.value) || 0);
  let end = Number(el.end?.value) || state.duration;
  end = Math.min(state.duration || end, Math.max(start + 0.1, end));
  return { start, end };
}

function updateRangeInfo() {
  if (!el.range) return;
  const { start, end } = selection();
  let msg = `Selected ${fmtTime(start)} – ${fmtTime(end)} (${(end - start).toFixed(1)}s)`;
  if (MODE === "gif" && end - start > 30) msg += " · GIFs longer than 30 s get very large; we'll use the first 30 s";
  el.range.textContent = msg;
}

async function loadFile(file) {
  state.file = file;
  el.result.innerHTML = "";
  setStatus("");
  if (el.video) {
    el.video.src = URL.createObjectURL(file);
    await new Promise((res) => { el.video.onloadedmetadata = res; el.video.onerror = res; });
  }
  let duration = el.video && isFinite(el.video.duration) ? el.video.duration : 0;
  try {
    const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
    duration = await input.computeDuration();
  } catch (e) { /* use <video> duration */ }
  state.duration = duration;
  if (el.start) { el.start.value = "0"; el.start.max = duration.toFixed(1); }
  if (el.end) {
    const defEnd = MODE === "gif" ? Math.min(duration, 5) : duration;
    el.end.value = defEnd.toFixed(1); el.end.max = duration.toFixed(1);
  }
  el.fileInfo.textContent = `${file.name} · ${formatBytes(file.size)} · ${fmtTime(duration)}`;
  el.panel.hidden = false;
  el.run.disabled = false;
  updateRangeInfo();
}

// ---------------------------------------------------------------- fast path
async function runMediabunny(onProgress) {
  const file = state.file;
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const { start, end } = selection();

  if (MODE === "gif") return makeGif(input, start, Math.min(end, start + 30), onProgress);

  let format, video, audio, ext, mime;
  const trim = MODE === "trim" || MODE === "gif" ? { start, end } : undefined;
  if (MODE === "mp3") {
    const { registerMp3Encoder } = await import(MP3_ENCODER);
    if (!(await mb.canEncodeAudio("mp3"))) registerMp3Encoder();
    format = new mb.Mp3OutputFormat();
    video = { discard: true };
    audio = { codec: "mp3", quality: new mb.Quality({ bitrate: Number(el.mp3Rate.value) * 1000 }), forceTranscode: true };
    ext = "mp3"; mime = "audio/mpeg";
  } else {
    format = new mb.Mp4OutputFormat({ fastStart: "in-memory" });
    ext = "mp4"; mime = "video/mp4";
    if (MODE === "mute") {
      video = {}; audio = { discard: true };
    } else if (MODE === "mov") {
      const compat = el.compat ? el.compat.checked : true;
      video = compat ? { codec: "avc", forceTranscode: true, quality: new mb.Quality("high") } : {};
      audio = compat ? { codec: "aac", forceTranscode: false } : {};
    } else { // trim: re-encode so the cut is frame-accurate
      video = { codec: "avc", forceTranscode: true, quality: new mb.Quality("high") };
      audio = {};
    }
  }
  const output = new mb.Output({ format, target: new mb.BufferTarget() });
  const conversion = await mb.Conversion.init({ input, output, video, audio, trim, showWarnings: false });
  if (!conversion.isValid) throw new Error("fast-path-unavailable");
  const lostAudio = conversion.discardedTracks.some((d) => d.track.type === "audio" && d.reason !== "discarded_by_user");
  if (lostAudio && (MODE === "mp3" || MODE === "trim" || MODE === "mov")) throw new Error("fast-path-unavailable");
  const lostVideo = conversion.discardedTracks.some((d) => d.track.type === "video" && d.reason !== "discarded_by_user");
  if (lostVideo && MODE !== "mp3") throw new Error("fast-path-unavailable");
  if (MODE === "mp3" && !conversion.utilizedTracks.some((t) => t.type === "audio")) throw new Error("This video has no sound track to extract.");
  conversion.onProgress = (p) => onProgress(p);
  state.cancel = () => conversion.cancel();
  await conversion.execute();
  return { blob: new Blob([output.target.buffer], { type: mime }), ext };
}

async function makeGif(input, start, end, onProgress) {
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("No video track found.");
  if (!(await track.canDecode())) throw new Error("fast-path-unavailable");
  const { GIFEncoder, quantize, applyPalette } = await import(GIFENC);
  const width = Math.min(Number(el.gifWidth.value), track.displayWidth);
  const height = Math.round(width * track.displayHeight / track.displayWidth / 2) * 2;
  const fps = Number(el.gifFps.value);
  const sink = new mb.CanvasSink(track, { width, height, fit: "contain", poolSize: 2 });
  const times = [];
  for (let t = start; t < end; t += 1 / fps) times.push(t);
  const gif = GIFEncoder();
  const delay = Math.round(1000 / fps);
  let i = 0;
  let cancelled = false;
  state.cancel = () => { cancelled = true; };
  for await (const wrapped of sink.canvasesAtTimestamps(times)) {
    if (cancelled) throw new Error("cancelled");
    if (!wrapped) continue;
    const ctx = wrapped.canvas.getContext("2d", { willReadFrequently: true });
    const { data } = ctx.getImageData(0, 0, width, height);
    const palette = quantize(data, 256, { format: "rgb444" });
    gif.writeFrame(applyPalette(data, palette, "rgb444"), width, height, { palette, delay });
    i += 1;
    onProgress(i / times.length);
    if (i % 5 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  gif.finish();
  return { blob: new Blob([gif.bytes()], { type: "image/gif" }), ext: "gif" };
}

// ---------------------------------------------------------------- fallback
async function loadFfmpeg() {
  if (state.ffmpeg) return state.ffmpeg;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = new URL("../vendor/ffmpeg/ffmpeg.js", import.meta.url).href;
    s.onload = resolve; s.onerror = () => reject(new Error("Could not load the compatibility engine."));
    document.head.appendChild(s);
  });
  const toBlobURL = async (url, type) => URL.createObjectURL(new Blob([await (await fetch(url)).arrayBuffer()], { type }));
  const ffmpeg = new window.FFmpegWASM.FFmpeg();
  await ffmpeg.load({
    coreURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`, "application/wasm")
  });
  state.ffmpeg = ffmpeg;
  return ffmpeg;
}

async function runFfmpeg(onProgress) {
  setStatus("Loading the compatibility engine (one-time, about 30 MB)…", 0);
  const ffmpeg = await loadFfmpeg();
  const file = state.file;
  const inName = `in.${(file.name.split(".").pop() || "mp4").toLowerCase()}`;
  await ffmpeg.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
  const { start, end } = selection();
  const handler = ({ progress }) => onProgress(Math.min(1, Math.max(0, progress)));
  ffmpeg.on("progress", handler);
  state.cancel = () => { ffmpeg.terminate(); state.ffmpeg = null; };
  let args, out, mime, ext;
  if (MODE === "trim") {
    args = ["-ss", String(start), "-to", String(end), "-i", inName, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart", "out.mp4"];
    out = "out.mp4"; mime = "video/mp4"; ext = "mp4";
  } else if (MODE === "gif") {
    const e2 = Math.min(end, start + 30);
    args = ["-ss", String(start), "-to", String(e2), "-i", inName, "-vf", `fps=${el.gifFps.value},scale=${el.gifWidth.value}:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse`, "out.gif"];
    out = "out.gif"; mime = "image/gif"; ext = "gif";
  } else if (MODE === "mp3") {
    args = ["-i", inName, "-vn", "-c:a", "libmp3lame", "-b:a", `${el.mp3Rate.value}k`, "out.mp3"];
    out = "out.mp3"; mime = "audio/mpeg"; ext = "mp3";
  } else if (MODE === "mute") {
    args = ["-i", inName, "-c:v", "copy", "-an", "-movflags", "+faststart", "out.mp4"];
    out = "out.mp4"; mime = "video/mp4"; ext = "mp4";
  } else {
    const compat = el.compat ? el.compat.checked : true;
    args = compat
      ? ["-i", inName, "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "out.mp4"]
      : ["-i", inName, "-c", "copy", "-movflags", "+faststart", "out.mp4"];
    out = "out.mp4"; mime = "video/mp4"; ext = "mp4";
  }
  try {
    await ffmpeg.exec(args);
    const data = await ffmpeg.readFile(out);
    if (!data || !data.length) throw new Error("No output was produced. The file may have no sound track or an unsupported format.");
    return { blob: new Blob([data.buffer], { type: mime }), ext };
  } finally {
    ffmpeg.off("progress", handler);
    try { await ffmpeg.deleteFile(inName); await ffmpeg.deleteFile(out); } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------- run
async function run() {
  if (!state.file || state.running) return;
  state.running = true;
  el.run.disabled = true;
  el.cancel.hidden = false;
  el.result.innerHTML = "";
  const started = performance.now();
  const onProgress = (p) => {
    const elapsed = (performance.now() - started) / 1000;
    const eta = p > 0.05 ? Math.round(elapsed / p - elapsed) : null;
    setStatus(`Working… ${Math.round(p * 100)}%${eta != null ? ` · about ${eta}s left` : ""}`, p);
  };
  try {
    let res;
    try {
      if (!hasWebCodecs()) throw new Error("fast-path-unavailable");
      setStatus("Working…", 0);
      res = await runMediabunny(onProgress);
    } catch (e) {
      if (state.cancelled) throw e;
      if (e.message !== "fast-path-unavailable" && !/codec|decod|encod|support/i.test(e.message || "")) throw e;
      res = await runFfmpeg(onProgress);
    }
    const name = `${baseName(state.file.name)}${MODE === "trim" ? "-trimmed" : MODE === "mute" ? "-muted" : ""}.${res.ext}`;
    const url = URL.createObjectURL(res.blob);
    const media = res.ext === "gif" ? `<img src="${url}" alt="GIF preview">` : res.ext === "mp3" ? `<audio src="${url}" controls></audio>` : `<video src="${url}" controls playsinline></video>`;
    el.result.innerHTML = `<div class="tool-preview">${media}</div>
      <div class="results-header"><span><strong>${escapeHtml(name)}</strong> · ${formatBytes(res.blob.size)}</span>
      <button class="primary-action" type="button" id="vtDownload">Download ${res.ext.toUpperCase()}</button></div>`;
    $("#vtDownload").addEventListener("click", () => downloadBlob(res.blob, name));
    setStatus(`Done in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  } catch (e) {
    setStatus(state.cancelled ? "Cancelled." : (e.message || "Something went wrong."));
    console.warn(e);
  } finally {
    state.running = false; state.cancelled = false; state.cancel = null;
    el.run.disabled = false; el.cancel.hidden = true;
  }
}

function init() {
  if (!el.zone) return;
  setupDropZone({
    zone: el.zone, input: el.input, button: el.choose,
    accept: (f) => f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i.test(f.name),
    onFiles: (files) => loadFile(files[0])
  });
  el.setStart?.addEventListener("click", () => { el.start.value = el.video.currentTime.toFixed(1); updateRangeInfo(); });
  el.setEnd?.addEventListener("click", () => { el.end.value = el.video.currentTime.toFixed(1); updateRangeInfo(); });
  [el.start, el.end].forEach((i) => i?.addEventListener("input", updateRangeInfo));
  el.run.addEventListener("click", run);
  el.cancel.addEventListener("click", async () => { state.cancelled = true; if (state.cancel) await state.cancel(); });
}

init();
