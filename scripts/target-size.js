// Compress an image to an exact file size (KB) in the browser.
import { $, formatBytes, escapeHtml, baseName, setupDropZone, decodeImage, sourceSize, drawToCanvas, canvasToBlob, downloadBlob, downloadAll } from "./tool-common.js";

const el = {
  zone: $("#tsDrop"), input: $("#tsInput"), choose: $("#tsChoose"),
  maxKb: $("#tsMaxKb"), minKb: $("#tsMinKb"), width: $("#tsWidth"), height: $("#tsHeight"),
  format: $("#tsFormat"), chips: $("#tsChips"), list: $("#tsResults"), empty: $("#tsEmpty"),
  downloadAll: $("#tsDownloadAll"), note: $("#tsNote")
};
const results = [];
let queue = Promise.resolve();

const accept = (f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name);

function settings() {
  const maxKb = Math.max(1, Number(el.maxKb.value) || 100);
  const minKb = Math.max(0, Number(el.minKb.value) || 0);
  return {
    maxKb,
    minKb: minKb && minKb < maxKb ? minKb : 0,
    // KB limits differ between sites (1000 vs 1024 bytes). Use the strictest reading of each limit.
    maxBytes: Math.floor(maxKb * 1000),
    minBytes: minKb && minKb < maxKb ? Math.ceil(minKb * 1024) : 0,
    width: Math.round(Number(el.width.value) || 0),
    height: Math.round(Number(el.height.value) || 0),
    type: el.format.value
  };
}

async function encode(src, w, h, s, q, cover) {
  const canvas = drawToCanvas(src, w, h, { cover, background: s.type === "image/jpeg" ? "#ffffff" : null });
  return canvasToBlob(canvas, s.type, q);
}

// Largest quality in [lo, hi] whose output fits under maxBytes. Returns {blob, q} or null.
async function searchQuality(src, w, h, s, lo, hi, cover) {
  let best = null;
  const top = await encode(src, w, h, s, hi, cover);
  if (top.size <= s.maxBytes) return { blob: top, q: hi };
  const bottom = await encode(src, w, h, s, lo, cover);
  if (bottom.size > s.maxBytes) return null;
  best = { blob: bottom, q: lo };
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    const b = await encode(src, w, h, s, mid, cover);
    if (b.size <= s.maxBytes) { best = { blob: b, q: mid }; lo = mid; } else { hi = mid; }
    if (hi - lo < 0.01) break;
  }
  return best;
}

async function compressToTarget(file, s) {
  const src = await decodeImage(file);
  const { width: ow, height: oh } = sourceSize(src);
  let w, h, cover = false, fixed = false;

  if (s.width && s.height) { w = s.width; h = s.height; cover = true; fixed = true; }
  else if (s.width) { w = s.width; h = Math.round(oh * s.width / ow); fixed = true; }
  else if (s.height) { h = s.height; w = Math.round(ow * s.height / oh); fixed = true; }
  else {
    const cap = 4096 / Math.max(ow, oh);
    const k = Math.min(1, cap);
    w = Math.round(ow * k); h = Math.round(oh * k);
  }

  let result = null;
  if (fixed) {
    result = await searchQuality(src, w, h, s, 0.05, 0.95, cover);
    if (!result) throw new Error(`Even at the lowest quality this image is bigger than ${s.maxKb} KB at ${w}×${h}px. Clear the width/height boxes so the tool can shrink it.`);
  } else {
    // Prefer good quality and smaller dimensions over very low quality.
    for (let i = 0; i < 25 && !result; i++) {
      const longSide = Math.max(w, h);
      const floorQ = longSide <= 400 ? 0.1 : longSide <= 900 ? 0.35 : 0.55;
      result = await searchQuality(src, w, h, s, floorQ, 0.92, cover);
      if (!result) {
        const probe = await encode(src, w, h, s, floorQ, cover);
        const ratio = Math.sqrt(s.maxBytes / probe.size) * 0.95;
        const k = Math.min(0.9, Math.max(0.5, ratio));
        w = Math.max(16, Math.round(w * k)); h = Math.max(16, Math.round(h * k));
        if (Math.max(w, h) <= 16) break;
      }
    }
    if (!result) throw new Error(`Could not get this image under ${s.maxKb} KB.`);
  }

  // Minimum size: some forms reject files that are too small.
  if (s.minBytes && result.blob.size < s.minBytes) {
    const hq = await encode(src, w, h, s, 1, cover);
    if (hq.size >= s.minBytes && hq.size <= s.maxBytes) result = { blob: hq, q: 1 };
    else if (!fixed) {
      for (let k = 1.15; k <= 3; k *= 1.15) {
        const up = await encode(src, Math.round(w * k), Math.round(h * k), s, 0.92, cover);
        if (up.size > s.maxBytes) break;
        result = { blob: up, q: 0.92 }; w = Math.round(w * k); h = Math.round(h * k);
        if (up.size >= s.minBytes) break;
      }
    }
  }
  if (src.close) src.close();
  return { ...result, w, h };
}

function render() {
  el.empty.hidden = results.length > 0;
  el.downloadAll.disabled = !results.some((r) => r.blob);
  el.list.innerHTML = results.map((r, i) => {
    if (r.status === "working") return `<article class="result-card"><div class="thumb-placeholder" aria-hidden="true"></div><div class="result-meta"><span class="result-name">${escapeHtml(r.file.name)}</span><span>Finding the best quality under ${r.s.maxKb} KB…</span></div></article>`;
    if (r.status === "error") return `<article class="result-card"><div class="thumb-placeholder" aria-hidden="true">!</div><div class="result-meta"><span class="result-name">${escapeHtml(r.file.name)}</span><span class="error-text">${escapeHtml(r.error)}</span></div></article>`;
    const okMin = !r.s.minBytes || r.blob.size >= r.s.minBytes;
    return `<article class="result-card">
      <img src="${r.url}" alt="Compressed preview of ${escapeHtml(r.file.name)}">
      <div class="result-meta">
        <span class="result-name">${escapeHtml(r.name)}</span>
        <span>${formatBytes(r.file.size)} → <strong>${formatBytes(r.blob.size)}</strong> · ${r.w}×${r.h}px · quality ${Math.round(r.q * 100)}%</span>
        <span class="saving">${okMin ? `Under ${r.s.maxKb} KB${r.s.minKb ? ` and over ${r.s.minKb} KB` : ""} ✓` : `Under ${r.s.maxKb} KB ✓ (could not reach the ${r.s.minKb} KB minimum)`}</span>
      </div>
      <button class="secondary-action" type="button" data-dl="${i}">Download</button>
    </article>`;
  }).join("");
}

function process(files) {
  const s = settings();
  for (const file of files) {
    const item = { file, s, status: "working" };
    results.unshift(item);
    render();
    queue = queue.then(async () => {
      try {
        const out = await compressToTarget(file, s);
        const ext = s.type === "image/webp" ? "webp" : "jpg";
        Object.assign(item, out, { status: "done", url: URL.createObjectURL(out.blob), name: `${baseName(file.name)}-${s.maxKb}kb.${ext}` });
      } catch (e) {
        Object.assign(item, { status: "error", error: e.message || "Something went wrong." });
      }
      render();
    });
  }
}

function init() {
  if (!el.zone) return;
  const preset = document.body.dataset.targetKb;
  if (preset) el.maxKb.value = preset;
  if (document.body.dataset.minKb) el.minKb.value = document.body.dataset.minKb;
  if (document.body.dataset.width) el.width.value = document.body.dataset.width;
  if (document.body.dataset.height) el.height.value = document.body.dataset.height;

  setupDropZone({ zone: el.zone, input: el.input, button: el.choose, accept, onFiles: process });
  el.chips.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-kb]");
    if (!chip) return;
    el.maxKb.value = chip.dataset.kb;
    el.chips.querySelectorAll("[data-kb]").forEach((c) => c.classList.toggle("is-active", c === chip));
  });
  el.list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-dl]");
    if (b) { const r = results[Number(b.dataset.dl)]; downloadBlob(r.blob, r.name); }
  });
  el.downloadAll.addEventListener("click", () => downloadAll(results.filter((r) => r.blob).map((r) => ({ blob: r.blob, name: r.name }))));
  el.chips.querySelectorAll("[data-kb]").forEach((c) => c.classList.toggle("is-active", c.dataset.kb === String(el.maxKb.value)));
  render();
}

init();
