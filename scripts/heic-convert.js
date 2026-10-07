// HEIC / HEIF to JPG, PNG or WebP converter. Runs in the browser.
import { $, formatBytes, escapeHtml, baseName, setupDropZone, sourceSize, drawToCanvas, canvasToBlob, downloadBlob, downloadAll } from "./tool-common.js";

const HEIC_LIB = "https://cdn.jsdelivr.net/npm/heic-to@1.6.5/dist/heic-to.min.js";
const el = {
  zone: $("#hcDrop"), input: $("#hcInput"), choose: $("#hcChoose"), format: $("#hcFormat"),
  quality: $("#hcQuality"), qualityValue: $("#hcQualityValue"), maxWidth: $("#hcMaxWidth"),
  list: $("#hcResults"), empty: $("#hcEmpty"), downloadAll: $("#hcDownloadAll")
};
const results = [];
let lib = null;
let queue = Promise.resolve();

const accept = (f) => /\.(heic|heif)$/i.test(f.name) || /image\/hei[cf]/.test(f.type) || f.type.startsWith("image/");

async function loadLib() {
  if (!lib) lib = await import(HEIC_LIB);
  return lib;
}

// Safari can decode HEIC natively; everyone else uses the libheif WebAssembly decoder.
async function decodeHeic(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    if (bmp.width > 0) return bmp;
  } catch (e) { /* not supported natively */ }
  const { heicTo } = await loadLib();
  return heicTo({ blob: file, type: "bitmap", options: { imageOrientation: "from-image" } });
}

async function convert(file) {
  const type = el.format.value;
  const quality = Number(el.quality.value) / 100;
  const maxW = Number(el.maxWidth.value) || 0;
  const src = await decodeHeic(file);
  let { width: w, height: h } = sourceSize(src);
  if (maxW && w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
  const canvas = drawToCanvas(src, w, h, { background: type === "image/jpeg" ? "#ffffff" : null });
  if (src.close) src.close();
  const blob = await canvasToBlob(canvas, type, type === "image/png" ? undefined : quality);
  const ext = type === "image/png" ? "png" : type === "image/webp" ? "webp" : "jpg";
  return { blob, w, h, name: `${baseName(file.name)}.${ext}` };
}

function render() {
  el.empty.hidden = results.length > 0;
  el.downloadAll.disabled = !results.some((r) => r.blob);
  el.list.innerHTML = results.map((r, i) => {
    if (r.status === "working") return `<article class="result-card"><div class="thumb-placeholder" aria-hidden="true">…</div><div class="result-meta"><span class="result-name">${escapeHtml(r.file.name)}</span><span>${r.msg || "Converting…"}</span></div></article>`;
    if (r.status === "error") return `<article class="result-card"><div class="thumb-placeholder" aria-hidden="true">!</div><div class="result-meta"><span class="result-name">${escapeHtml(r.file.name)}</span><span class="error-text">${escapeHtml(r.error)}</span></div></article>`;
    return `<article class="result-card">
      <img src="${r.url}" alt="Converted preview of ${escapeHtml(r.file.name)}">
      <div class="result-meta">
        <span class="result-name">${escapeHtml(r.name)}</span>
        <span>${formatBytes(r.file.size)} HEIC → <strong>${formatBytes(r.blob.size)}</strong> · ${r.w}×${r.h}px</span>
        <span class="saving">Converted · location data removed</span>
      </div>
      <button class="secondary-action" type="button" data-dl="${i}">Download</button>
    </article>`;
  }).join("");
}

function process(files) {
  for (const file of files) {
    const item = { file, status: "working", msg: lib ? "Converting…" : "Loading the HEIC decoder (first time only)…" };
    results.unshift(item);
    render();
    queue = queue.then(async () => {
      try {
        Object.assign(item, await convert(file), { status: "done" });
        item.url = URL.createObjectURL(item.blob);
      } catch (e) {
        item.status = "error";
        item.error = "Could not read this file. Make sure it is a HEIC/HEIF photo (for example IMG_1234.HEIC).";
        console.warn(e);
      }
      render();
    });
  }
}

function init() {
  if (!el.zone) return;
  if (document.body.dataset.format) el.format.value = document.body.dataset.format;
  const syncQ = () => {
    el.qualityValue.textContent = `${el.quality.value}%`;
    el.quality.disabled = el.format.value === "image/png";
  };
  el.quality.addEventListener("input", syncQ);
  el.format.addEventListener("change", syncQ);
  syncQ();
  setupDropZone({ zone: el.zone, input: el.input, button: el.choose, accept, onFiles: process });
  el.list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-dl]");
    if (b) { const r = results[Number(b.dataset.dl)]; downloadBlob(r.blob, r.name); }
  });
  el.downloadAll.addEventListener("click", () => downloadAll(results.filter((r) => r.blob).map((r) => ({ blob: r.blob, name: r.name }))));
  render();
}

init();
