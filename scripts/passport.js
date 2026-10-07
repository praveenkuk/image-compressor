// Passport / visa photo maker: crop to official size, white background, printable 6x4 sheet.
import { $, escapeHtml, baseName, setupDropZone, decodeImage, sourceSize, canvasToBlob, downloadBlob } from "./tool-common.js";

const SEG_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/";

// width/height in mm, digital export size in px
const SIZES = {
  uk: { label: "UK passport (35×45 mm)", w: 35, h: 45, px: [827, 1063], tip: "UK: plain cream or light grey background, neutral expression, mouth closed, no glasses glare. Online applications need at least 600×750 px (this download is 827×1063)." },
  us: { label: "US passport & visa (2×2 in)", w: 51, h: 51, px: [1200, 1200], tip: "US: white background, head 1–1 3/8 in (25–35 mm) from chin to top of hair, no glasses. Digital uploads need 600–1200 px square (this download is 1200×1200)." },
  eu: { label: "Schengen / EU (35×45 mm)", w: 35, h: 45, px: [827, 1063], tip: "Schengen and most EU countries: light background, face 32–36 mm from chin to crown, looking straight at the camera." },
  in: { label: "India passport (35×45 mm)", w: 35, h: 45, px: [827, 1063], tip: "India passport: white background, full face front view, ears visible where possible. Check the Passport Seva portal for the current rules." },
  inv: { label: "India visa / OCI (2×2 in)", w: 51, h: 51, px: [1200, 1200], tip: "India e-Visa and OCI: square photo with plain white background, face centred." },
  ca: { label: "Canada passport (50×70 mm)", w: 50, h: 70, px: [1181, 1654], tip: "Canada: plain white or light background, face 31–36 mm from chin to crown." },
  au: { label: "Australia passport (35×45 mm)", w: 35, h: 45, px: [827, 1063], tip: "Australia: plain light background, face 32–36 mm from chin to crown." },
  cn: { label: "China visa (33×48 mm)", w: 33, h: 48, px: [780, 1134], tip: "China visa: white background, face 28–33 mm tall, ears visible." }
};

const el = {
  zone: $("#ppDrop"), input: $("#ppInput"), choose: $("#ppChoose"), editor: $("#ppEditor"),
  canvas: $("#ppCanvas"), size: $("#ppSize"), zoom: $("#ppZoom"), bg: $("#ppBg"), tip: $("#ppTip"),
  status: $("#ppStatus"), dlPhoto: $("#ppDownload"), dlSheet: $("#ppSheet")
};
const st = { src: null, file: null, cutout: null, scale: 1, baseScale: 1, x: 0, y: 0, seg: null };
const VIEW_W = 360;

function preset() { return SIZES[el.size.value]; }

function viewSize() {
  const p = preset();
  return [VIEW_W, Math.round(VIEW_W * p.h / p.w)];
}

function resetFrame() {
  const [vw, vh] = viewSize();
  const { width: sw, height: sh } = sourceSize(st.src);
  st.baseScale = Math.max(vw / sw, vh / sh);
  st.scale = st.baseScale * Number(el.zoom.value);
  st.x = (vw - sw * st.scale) / 2;
  st.y = (vh - sh * st.scale) / 2;
}

function sourceLayer() {
  return el.bg.checked && st.cutout ? st.cutout : st.src;
}

// Draw the photo into ctx for a frame of size (w,h), mapping view coordinates by factor k.
function paint(ctx, w, h, k) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  const { width: sw, height: sh } = sourceSize(st.src);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceLayer(), st.x * k, st.y * k, sw * st.scale * k, sh * st.scale * k);
}

function render() {
  if (!st.src) return;
  const [vw, vh] = viewSize();
  const dpr = window.devicePixelRatio || 1;
  el.canvas.width = vw * dpr; el.canvas.height = vh * dpr;
  el.canvas.style.width = `${vw}px`; el.canvas.style.aspectRatio = `${vw} / ${vh}`;
  const ctx = el.canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  paint(ctx, vw, vh, 1);
  // Guides: head oval and eye line
  ctx.strokeStyle = "rgba(15,118,110,0.9)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  const top = vh * 0.1, bottom = vh * (preset().w === preset().h ? 0.72 : 0.8);
  ctx.beginPath();
  ctx.ellipse(vw / 2, (top + bottom) / 2, vw * 0.27, (bottom - top) / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
}

function exportCanvas() {
  const p = preset();
  const [vw] = viewSize();
  const [ow, oh] = p.px;
  const c = document.createElement("canvas");
  c.width = ow; c.height = oh;
  paint(c.getContext("2d"), ow, oh, ow / vw);
  return c;
}

async function loadSegmenter() {
  if (st.seg) return st.seg;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SEG_BASE + "selfie_segmentation.js";
    s.crossOrigin = "anonymous";
    s.onload = resolve; s.onerror = () => reject(new Error("Could not load the background tool."));
    document.head.appendChild(s);
  });
  const seg = new window.SelfieSegmentation({ locateFile: (f) => SEG_BASE + f });
  seg.setOptions({ modelSelection: 0, selfieMode: false });
  st.seg = seg;
  return seg;
}

async function makeCutout() {
  if (st.cutout || !st.src) return;
  el.status.textContent = "Making the background white… (first time loads a small AI model)";
  try {
    const seg = await loadSegmenter();
    const { width: sw, height: sh } = sourceSize(st.src);
    // Segment a downscaled copy for speed, then scale the mask up.
    const k = Math.min(1, 1024 / Math.max(sw, sh));
    const small = document.createElement("canvas");
    small.width = Math.round(sw * k); small.height = Math.round(sh * k);
    small.getContext("2d").drawImage(st.src, 0, 0, small.width, small.height);
    const mask = document.createElement("canvas");
    mask.width = sw; mask.height = sh;
    await new Promise((resolve, reject) => {
      seg.onResults((res) => {
        try {
          const mctx = mask.getContext("2d");
          mctx.filter = `blur(${Math.max(1, Math.round(2 / k))}px)`;
          mctx.drawImage(res.segmentationMask, 0, 0, sw, sh);
          resolve();
        } catch (e) { reject(e); }
      });
      seg.send({ image: small }).catch(reject);
    });
    const out = document.createElement("canvas");
    out.width = sw; out.height = sh;
    const octx = out.getContext("2d");
    octx.drawImage(st.src, 0, 0);
    octx.globalCompositeOperation = "destination-in";
    octx.drawImage(mask, 0, 0);
    st.cutout = out;
    el.status.textContent = "Background replaced with white. Turn it off if the edges don't look right.";
  } catch (e) {
    console.warn(e);
    el.bg.checked = false;
    el.status.textContent = "The automatic white background isn't available in this browser. Use a photo taken against a plain wall.";
  }
  render();
}

async function loadPhoto(file) {
  el.status.textContent = "";
  st.file = file;
  st.cutout = null;
  try {
    st.src = await decodeImage(file);
  } catch (e) {
    el.status.textContent = "Could not open this image. Try a JPG or PNG photo.";
    return;
  }
  el.editor.hidden = false;
  el.zoom.value = "1";
  resetFrame();
  render();
  el.editor.scrollIntoView({ behavior: "smooth", block: "start" });
  if (el.bg.checked) makeCutout();
}

function sheet() {
  // 6x4 inch print at 300 dpi
  const W = 1800, H = 1200, mmPx = 300 / 25.4, gap = 24;
  const p = preset();
  const pw = Math.round(p.w * mmPx), ph = Math.round(p.h * mmPx);
  const cols = Math.max(1, Math.floor((W - gap) / (pw + gap)));
  const rows = Math.max(1, Math.floor((H - gap) / (ph + gap)));
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
  const photo = exportCanvas();
  const ox = Math.round((W - cols * pw - (cols - 1) * gap) / 2);
  const oy = Math.round((H - rows * ph - (rows - 1) * gap) / 2);
  ctx.strokeStyle = "#bbbbbb"; ctx.lineWidth = 1;
  for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) {
    const x = ox + col * (pw + gap), y = oy + r * (ph + gap);
    ctx.drawImage(photo, x, y, pw, ph);
    ctx.strokeRect(x - 0.5, y - 0.5, pw + 1, ph + 1);
  }
  return { canvas: c, count: rows * cols };
}

function init() {
  if (!el.zone) return;
  const def = document.body.dataset.size;
  el.size.innerHTML = Object.entries(SIZES).map(([k, v]) => `<option value="${k}">${escapeHtml(v.label)}</option>`).join("");
  if (def && SIZES[def]) el.size.value = def;
  el.tip.textContent = preset().tip;

  setupDropZone({ zone: el.zone, input: el.input, button: el.choose, accept: (f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(f.name), onFiles: (f) => loadPhoto(f[0]) });
  el.size.addEventListener("change", () => { el.tip.textContent = preset().tip; if (st.src) { resetFrame(); render(); } });
  el.zoom.addEventListener("input", () => {
    if (!st.src) return;
    const [vw, vh] = viewSize();
    const cx = (vw / 2 - st.x) / st.scale, cy = (vh / 2 - st.y) / st.scale;
    st.scale = st.baseScale * Number(el.zoom.value);
    st.x = vw / 2 - cx * st.scale; st.y = vh / 2 - cy * st.scale;
    render();
  });
  el.bg.addEventListener("change", () => { if (el.bg.checked) makeCutout(); render(); });

  // Drag to position
  let drag = null;
  el.canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, sx: st.x, sy: st.y }; el.canvas.setPointerCapture(e.pointerId); });
  el.canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const k = viewSize()[0] / el.canvas.getBoundingClientRect().width;
    st.x = drag.sx + (e.clientX - drag.x) * k; st.y = drag.sy + (e.clientY - drag.y) * k;
    render();
  });
  ["pointerup", "pointercancel"].forEach((t) => el.canvas.addEventListener(t, () => { drag = null; }));
  el.canvas.addEventListener("wheel", (e) => {
    if (!st.src) return;
    e.preventDefault();
    el.zoom.value = String(Math.min(3, Math.max(1, Number(el.zoom.value) * (e.deltaY < 0 ? 1.05 : 0.95))));
    el.zoom.dispatchEvent(new Event("input"));
  }, { passive: false });

  el.dlPhoto.addEventListener("click", async () => {
    const blob = await canvasToBlob(exportCanvas(), "image/jpeg", 0.95);
    downloadBlob(blob, `${baseName(st.file.name)}-passport-${el.size.value}.jpg`);
  });
  el.dlSheet.addEventListener("click", async () => {
    const { canvas, count } = sheet();
    const blob = await canvasToBlob(canvas, "image/jpeg", 0.95);
    downloadBlob(blob, `${baseName(st.file.name)}-passport-${el.size.value}-6x4-print-${count}.jpg`);
  });
}

init();
