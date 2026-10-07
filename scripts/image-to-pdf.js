// JPG / PNG / any image to a single PDF. Runs in the browser with pdf-lib.
import { $, formatBytes, escapeHtml, baseName, setupDropZone, decodeImage, sourceSize, drawToCanvas, canvasToBlob, downloadBlob } from "./tool-common.js";

const PDF_LIB = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.esm.min.js";
const HEIC_LIB = "https://cdn.jsdelivr.net/npm/heic-to@1.6.5/dist/heic-to.min.js";
const PAGE = { a4: [595.28, 841.89], letter: [612, 792] };
const QUALITY = { high: [0.9, 3000], medium: [0.8, 2000], small: [0.65, 1400] };

const el = {
  zone: $("#pdDrop"), input: $("#pdInput"), choose: $("#pdChoose"), size: $("#pdSize"), orient: $("#pdOrient"),
  margin: $("#pdMargin"), quality: $("#pdQuality"), list: $("#pdList"), empty: $("#pdEmpty"),
  make: $("#pdMake"), status: $("#pdStatus"), name: $("#pdName")
};
const items = [];
let heic = null;

const accept = (f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(f.name);

async function decode(file) {
  if (/\.(heic|heif)$/i.test(file.name) || /image\/hei[cf]/.test(file.type)) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { /* wasm */ }
    if (!heic) heic = await import(HEIC_LIB);
    return heic.heicTo({ blob: file, type: "bitmap", options: { imageOrientation: "from-image" } });
  }
  return decodeImage(file);
}

function render() {
  el.empty.hidden = items.length > 0;
  el.make.disabled = items.length === 0;
  el.list.innerHTML = items.map((it, i) => `<article class="result-card">
      <img src="${it.thumb}" alt="Page ${i + 1}: ${escapeHtml(it.file.name)}">
      <div class="result-meta"><span class="result-name">Page ${i + 1} · ${escapeHtml(it.file.name)}</span><span>${formatBytes(it.file.size)}</span></div>
      <div class="result-actions">
        <button class="icon-button" type="button" data-up="${i}" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
        <button class="icon-button" type="button" data-down="${i}" aria-label="Move down" ${i === items.length - 1 ? "disabled" : ""}>↓</button>
        <button class="icon-button" type="button" data-rm="${i}" aria-label="Remove">×</button>
      </div>
    </article>`).join("");
}

async function add(files) {
  for (const file of files) {
    try {
      const src = await decode(file);
      const { width, height } = sourceSize(src);
      const k = Math.min(1, 160 / Math.max(width, height));
      const thumb = drawToCanvas(src, width * k, height * k, { background: "#fff" }).toDataURL("image/jpeg", 0.7);
      items.push({ file, src, thumb });
    } catch (e) {
      el.status.textContent = `Skipped ${file.name}: not a readable image.`;
    }
    render();
  }
  if (!el.name.value && items[0]) el.name.value = baseName(items[0].file.name);
}

async function makePdf() {
  el.make.disabled = true;
  el.status.textContent = "Building PDF…";
  try {
    const { PDFDocument } = await import(PDF_LIB);
    const doc = await PDFDocument.create();
    const [q, maxPx] = QUALITY[el.quality.value];
    const margin = Number(el.margin.value) * 2.835; // mm -> pt
    for (let i = 0; i < items.length; i++) {
      el.status.textContent = `Adding page ${i + 1} of ${items.length}…`;
      const { src } = items[i];
      let { width: w, height: h } = sourceSize(src);
      const k = Math.min(1, maxPx / Math.max(w, h));
      w = Math.round(w * k); h = Math.round(h * k);
      const jpg = await canvasToBlob(drawToCanvas(src, w, h, { background: "#ffffff" }), "image/jpeg", q);
      const img = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
      let pw, ph;
      if (el.size.value === "fit") { pw = w * 0.75 + margin * 2; ph = h * 0.75 + margin * 2; }
      else {
        [pw, ph] = PAGE[el.size.value];
        const landscape = el.orient.value === "landscape" || (el.orient.value === "auto" && w > h);
        if (landscape) [pw, ph] = [ph, pw];
      }
      const page = doc.addPage([pw, ph]);
      const s = Math.min((pw - margin * 2) / w, (ph - margin * 2) / h);
      const dw = w * s, dh = h * s;
      page.drawImage(img, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
    }
    doc.setTitle(el.name.value || "Images");
    doc.setProducer("CompressPixel");
    const bytes = await doc.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const name = `${(el.name.value || "images").replace(/[\\/:*?"<>|]+/g, "-")}.pdf`;
    downloadBlob(blob, name);
    el.status.textContent = `Done: ${name} · ${items.length} page${items.length > 1 ? "s" : ""} · ${formatBytes(blob.size)}`;
  } catch (e) {
    console.warn(e);
    el.status.textContent = "Could not create the PDF. Try fewer or smaller images.";
  } finally {
    el.make.disabled = items.length === 0;
  }
}

function init() {
  if (!el.zone) return;
  setupDropZone({ zone: el.zone, input: el.input, button: el.choose, accept, onFiles: add });
  el.list.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const move = (from, to) => { const [x] = items.splice(from, 1); items.splice(to, 0, x); };
    if (t.dataset.up) move(Number(t.dataset.up), Number(t.dataset.up) - 1);
    if (t.dataset.down) move(Number(t.dataset.down), Number(t.dataset.down) + 1);
    if (t.dataset.rm) items.splice(Number(t.dataset.rm), 1);
    render();
  });
  el.size.addEventListener("change", () => { el.orient.disabled = el.size.value === "fit"; });
  el.make.addEventListener("click", makePdf);
  render();
}

init();
