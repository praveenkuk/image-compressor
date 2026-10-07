// Image format converter: JPG, PNG, WebP, AVIF, HEIC input -> JPG/PNG/WebP/AVIF output. Runs in the browser.
import { $, formatBytes, escapeHtml, baseName, setupDropZone, decodeImage, sourceSize, drawToCanvas, canvasToBlob, downloadBlob, downloadAll } from "./tool-common.js";

const HEIC_LIB = "https://cdn.jsdelivr.net/npm/heic-to@1.6.5/dist/heic-to.min.js";
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif" };
const el = {
  zone: $("#cvDrop"), input: $("#cvInput"), choose: $("#cvChoose"), to: $("#cvTo"), quality: $("#cvQuality"),
  qualityValue: $("#cvQualityValue"), bg: $("#cvBg"), maxWidth: $("#cvMaxWidth"), list: $("#cvResults"),
  empty: $("#cvEmpty"), downloadAll: $("#cvDownloadAll"), note: $("#cvNote")
};
const results = [];
let queue = Promise.resolve();
let heic = null;

const isHeic = (f) => /\.(heic|heif)$/i.test(f.name) || /image\/hei[cf]/.test(f.type);
const accept = (f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|svg)$/i.test(f.name);

async function supportsEncode(type) {
  const c = document.createElement("canvas");
  c.width = c.height = 2;
  const b = await new Promise((r) => c.toBlob(r, type, 0.8));
  return !!b && b.type === type;
}

async function decode(file) {
  if (isHeic(file)) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { /* use wasm */ }
    if (!heic) heic = await import(HEIC_LIB);
    return heic.heicTo({ blob: file, type: "bitmap", options: { imageOrientation: "from-image" } });
  }
  return decodeImage(file);
}

async function convert(file) {
  const type = el.to.value;
  const src = await decode(file);
  let { width: w, height: h } = sourceSize(src);
  const maxW = Number(el.maxWidth.value) || 0;
  if (maxW && w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
  const flatten = type === "image/jpeg" ? el.bg.value : null;
  const canvas = drawToCanvas(src, w, h, { background: flatten });
  if (src.close) src.close();
  const blob = await canvasToBlob(canvas, type, type === "image/png" ? undefined : Number(el.quality.value) / 100);
  return { blob, w, h, name: `${baseName(file.name)}.${EXT[type]}` };
}

function render() {
  el.empty.hidden = results.length > 0;
  el.downloadAll.disabled = !results.some((r) => r.blob);
  el.list.innerHTML = results.map((r, i) => {
    if (r.status === "working") return `<article class="result-card"><div class="thumb-placeholder" aria-hidden="true">…</div><div class="result-meta"><span class="result-name">${escapeHtml(r.file.name)}</span><span>Converting…</span></div></article>`;
    if (r.status === "error") return `<article class="result-card"><div class="thumb-placeholder" aria-hidden="true">!</div><div class="result-meta"><span class="result-name">${escapeHtml(r.file.name)}</span><span class="error-text">${escapeHtml(r.error)}</span></div></article>`;
    const diff = Math.round((1 - r.blob.size / r.file.size) * 100);
    return `<article class="result-card">
      <img src="${r.url}" alt="Converted preview of ${escapeHtml(r.file.name)}">
      <div class="result-meta">
        <span class="result-name">${escapeHtml(r.name)}</span>
        <span>${formatBytes(r.file.size)} → <strong>${formatBytes(r.blob.size)}</strong> · ${r.w}×${r.h}px</span>
        <span class="saving">${diff > 0 ? `${diff}% smaller` : diff < 0 ? `${-diff}% larger (normal for this format)` : "Same size"}</span>
      </div>
      <button class="secondary-action" type="button" data-dl="${i}">Download</button>
    </article>`;
  }).join("");
}

function process(files) {
  for (const file of files) {
    const item = { file, status: "working" };
    results.unshift(item);
    render();
    queue = queue.then(async () => {
      try {
        Object.assign(item, await convert(file), { status: "done" });
        item.url = URL.createObjectURL(item.blob);
      } catch (e) {
        Object.assign(item, { status: "error", error: "Could not convert this file. Try another image." });
        console.warn(e);
      }
      render();
    });
  }
}

function init() {
  if (!el.zone) return;
  const def = document.body.dataset.to;
  if (def) el.to.value = def;
  const sync = () => {
    el.qualityValue.textContent = `${el.quality.value}%`;
    el.quality.disabled = el.to.value === "image/png";
    el.bg.disabled = el.to.value !== "image/jpeg";
  };
  [el.to, el.quality].forEach((x) => x.addEventListener("input", sync));
  sync();
  setupDropZone({ zone: el.zone, input: el.input, button: el.choose, accept, onFiles: process });
  el.list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-dl]");
    if (b) { const r = results[Number(b.dataset.dl)]; downloadBlob(r.blob, r.name); }
  });
  el.downloadAll.addEventListener("click", () => downloadAll(results.filter((r) => r.blob).map((r) => ({ blob: r.blob, name: r.name }))));
  render();
  // AVIF encoding is only available in some browsers
  supportsEncode("image/avif").then((ok) => {
    if (ok) return;
    const opt = el.to.querySelector('option[value="image/avif"]');
    if (opt) { opt.disabled = true; opt.textContent += " (not supported in this browser)"; }
    if (el.to.value === "image/avif") { el.to.value = "image/webp"; sync(); }
  });
}

init();
