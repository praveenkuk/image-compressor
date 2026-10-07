// Remove GPS location and other metadata from photos, without re-compressing where possible.
import { $, formatBytes, escapeHtml, baseName, setupDropZone, decodeImage, sourceSize, drawToCanvas, canvasToBlob, downloadBlob, downloadAll } from "./tool-common.js";

const HEIC_LIB = "https://cdn.jsdelivr.net/npm/heic-to@1.6.5/dist/heic-to.min.js";
const el = { zone: $("#mdDrop"), input: $("#mdInput"), choose: $("#mdChoose"), list: $("#mdResults"), empty: $("#mdEmpty"), downloadAll: $("#mdDownloadAll") };
const results = [];
let queue = Promise.resolve();
let heic = null;

// ---------------------------------------------------------------- EXIF reader (TIFF structure)
function readExif(tiff) {
  const v = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const le = v.getUint16(0) === 0x4949;
  const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
  const info = {};
  const ascii = (off, n) => { let s = ""; for (let i = 0; i < n - 1 && off + i < v.byteLength; i++) { const c = v.getUint8(off + i); if (!c) break; s += String.fromCharCode(c); } return s.trim(); };
  const rational = (off) => u32(off) / (u32(off + 4) || 1);
  function ifd(off, handler) {
    if (off < 8 || off + 2 > v.byteLength) return;
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > v.byteLength) return;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 }[type] || 1) * count;
      const valOff = size > 4 ? u32(e + 8) : e + 8;
      handler(tag, type, count, valOff);
    }
  }
  const ifd0 = u32(4);
  let gpsOff = 0, exifOff = 0;
  ifd(ifd0, (tag, type, count, off) => {
    if (tag === 0x010f) info.make = ascii(off, count);
    if (tag === 0x0110) info.model = ascii(off, count);
    if (tag === 0x0132) info.date = ascii(off, count);
    if (tag === 0x0131) info.software = ascii(off, count);
    if (tag === 0x0112) info.orientation = u16(off);
    if (tag === 0x8825) gpsOff = u32(off);
    if (tag === 0x8769) exifOff = u32(off);
  });
  if (exifOff) ifd(exifOff, (tag, type, count, off) => { if (tag === 0x9003) info.date = ascii(off, count); if (tag === 0xa434) info.lens = ascii(off, count); });
  if (gpsOff) {
    const g = {};
    ifd(gpsOff, (tag, type, count, off) => {
      if (tag === 1) g.latRef = String.fromCharCode(v.getUint8(off));
      if (tag === 3) g.lonRef = String.fromCharCode(v.getUint8(off));
      if ((tag === 2 || tag === 4) && type === 5 && count >= 3) {
        const d = rational(off) + rational(off + 8) / 60 + rational(off + 16) / 3600;
        if (tag === 2) g.lat = d; else g.lon = d;
      }
    });
    if (g.lat != null && g.lon != null && (g.lat || g.lon)) {
      info.gps = [g.latRef === "S" ? -g.lat : g.lat, g.lonRef === "W" ? -g.lon : g.lon];
    } else if (Object.keys(g).length) info.gpsPresent = true;
  }
  return info;
}

// ---------------------------------------------------------------- format strippers
function stripJpeg(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const parts = [bytes.subarray(0, 2)];
  let info = {}, found = [];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xda) { parts.push(bytes.subarray(i)); break; } // start of scan: copy the rest
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const seg = bytes.subarray(i, i + 2 + len);
    const id = String.fromCharCode(...bytes.subarray(i + 4, i + 4 + Math.min(12, len - 2)));
    let keep = true;
    if (marker === 0xe1 && id.startsWith("Exif")) { info = { ...info, ...readExif(bytes.subarray(i + 10, i + 2 + len)) }; found.push("EXIF"); keep = false; }
    else if (marker === 0xe1) { found.push("XMP"); keep = false; }
    else if (marker === 0xed) { found.push("IPTC"); keep = false; }
    else if (marker === 0xfe) { found.push("Comment"); keep = false; }
    else if (marker >= 0xe3 && marker <= 0xef && marker !== 0xee) { found.push(`APP${marker - 0xe0}`); keep = false; }
    // keep APP0 (JFIF), APP2 (ICC colour profile), APP14 (Adobe colour info), tables and frame headers
    if (keep) parts.push(seg);
    i += 2 + len;
  }
  return { parts, info, found, type: "image/jpeg" };
}

function stripPng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, k) => bytes[k] === b)) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.subarray(0, 8)];
  const found = [];
  let info = {};
  let i = 8;
  while (i + 8 <= bytes.length) {
    const len = v.getUint32(i);
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    const chunk = bytes.subarray(i, i + 12 + len);
    if (["eXIf", "tEXt", "iTXt", "zTXt", "tIME"].includes(type)) {
      found.push(type === "eXIf" ? "EXIF" : type === "tIME" ? "Timestamp" : "Text");
      if (type === "eXIf") info = readExif(bytes.subarray(i + 8, i + 8 + len));
    } else parts.push(chunk);
    i += 12 + len;
    if (type === "IEND") break;
  }
  return { parts, info, found, type: "image/png" };
}

function stripWebp(bytes) {
  const tag = (o) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP") return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  const found = [];
  let info = {};
  let i = 12;
  while (i + 8 <= bytes.length) {
    const t = tag(i), len = v.getUint32(i + 4, true);
    const total = 8 + len + (len % 2);
    if (t === "EXIF") { found.push("EXIF"); info = readExif(bytes.subarray(i + 8 + (tag(i + 8) === "Exif" ? 6 : 0), i + 8 + len)); }
    else if (t === "XMP ") found.push("XMP");
    else chunks.push(new Uint8Array(bytes.subarray(i, i + total)));
    i += total;
  }
  const vp8x = chunks.find((c) => String.fromCharCode(...c.subarray(0, 4)) === "VP8X");
  if (vp8x) vp8x[8] &= ~(0x08 | 0x04); // clear EXIF and XMP flags
  const size = 4 + chunks.reduce((n, c) => n + c.length, 0);
  const head = new Uint8Array(12);
  head.set(bytes.subarray(0, 12));
  new DataView(head.buffer).setUint32(4, size, true);
  return { parts: [head, ...chunks], info, found, type: "image/webp" };
}

async function reencode(file) {
  let src;
  if (/\.(heic|heif)$/i.test(file.name) || /image\/hei[cf]/.test(file.type)) {
    try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) {
      if (!heic) heic = await import(HEIC_LIB);
      src = await heic.heicTo({ blob: file, type: "bitmap", options: { imageOrientation: "from-image" } });
    }
  } else src = await decodeImage(file);
  const { width, height } = sourceSize(src);
  const blob = await canvasToBlob(drawToCanvas(src, width, height, { background: "#fff" }), "image/jpeg", 0.95);
  return blob;
}

async function clean(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const res = stripJpeg(bytes) || stripPng(bytes) || stripWebp(bytes);
  if (!res) {
    // HEIC and other formats: decode and save as a clean JPG
    const blob = await reencode(file);
    return { blob, info: {}, found: ["All metadata (converted to JPG)"], name: `${baseName(file.name)}-clean.jpg`, lossless: false };
  }
  // Removing EXIF also removes the rotation flag: bake the rotation in so the photo still displays upright.
  if (res.info.orientation && res.info.orientation !== 1) {
    const blob = await reencode(file);
    return { blob, info: res.info, found: res.found, name: `${baseName(file.name)}-clean.jpg`, lossless: false };
  }
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[res.type];
  return { blob: new Blob(res.parts, { type: res.type }), info: res.info, found: res.found, name: `${baseName(file.name)}-clean.${ext}`, lossless: true };
}

function describe(r) {
  const rows = [];
  if (r.info.gps) rows.push(`<strong class="error-text">GPS location: ${r.info.gps[0].toFixed(5)}, ${r.info.gps[1].toFixed(5)}</strong> <a href="https://www.openstreetmap.org/?mlat=${r.info.gps[0]}&mlon=${r.info.gps[1]}#map=16/${r.info.gps[0]}/${r.info.gps[1]}" target="_blank" rel="noopener nofollow">see on map</a>`);
  else if (r.info.gpsPresent) rows.push(`<strong class="error-text">GPS data</strong>`);
  if (r.info.make || r.info.model) rows.push(`Camera: ${escapeHtml([r.info.make, r.info.model].filter(Boolean).join(" "))}`);
  if (r.info.date) rows.push(`Taken: ${escapeHtml(r.info.date)}`);
  if (r.info.software) rows.push(`Software: ${escapeHtml(r.info.software)}`);
  return rows;
}

function render() {
  el.empty.hidden = results.length > 0;
  el.downloadAll.disabled = !results.some((r) => r.blob);
  el.list.innerHTML = results.map((r, i) => {
    if (r.status === "working") return `<article class="result-card"><div class="thumb-placeholder" aria-hidden="true">…</div><div class="result-meta"><span class="result-name">${escapeHtml(r.file.name)}</span><span>Checking…</span></div></article>`;
    if (r.status === "error") return `<article class="result-card"><div class="thumb-placeholder" aria-hidden="true">!</div><div class="result-meta"><span class="result-name">${escapeHtml(r.file.name)}</span><span class="error-text">${escapeHtml(r.error)}</span></div></article>`;
    const rows = describe(r);
    const uniq = [...new Set(r.found)];
    return `<article class="result-card">
      <img src="${r.url}" alt="Cleaned preview of ${escapeHtml(r.file.name)}">
      <div class="result-meta">
        <span class="result-name">${escapeHtml(r.name)}</span>
        ${rows.map((x) => `<span>${x}</span>`).join("")}
        <span class="saving">${uniq.length ? `Removed: ${escapeHtml(uniq.join(", "))}` : "No hidden metadata found"} · ${r.lossless ? "no quality loss" : "saved as high-quality JPG"} · ${formatBytes(r.blob.size)}</span>
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
        Object.assign(item, await clean(file), { status: "done" });
        item.url = URL.createObjectURL(item.blob);
      } catch (e) {
        console.warn(e);
        Object.assign(item, { status: "error", error: "Could not read this file." });
      }
      render();
    });
  }
}

function init() {
  if (!el.zone) return;
  setupDropZone({ zone: el.zone, input: el.input, button: el.choose, accept: (f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name), onFiles: process });
  el.list.addEventListener("click", (e) => {
    const b = e.target.closest("[data-dl]");
    if (b) { const r = results[Number(b.dataset.dl)]; downloadBlob(r.blob, r.name); }
  });
  el.downloadAll.addEventListener("click", () => downloadAll(results.filter((r) => r.blob).map((r) => ({ blob: r.blob, name: r.name }))));
  render();
}

init();
