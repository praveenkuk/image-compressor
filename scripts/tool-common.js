// Shared helpers for CompressPixel browser tools (loaded as an ES module)

export const $ = (sel, root = document) => root.querySelector(sel);

export function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function baseName(name) {
  return name.replace(/\.[^.]+$/, "");
}

// Wire a drop zone + hidden file input + "choose" button. Calls onFiles(File[]).
export function setupDropZone({ zone, input, button, accept, onFiles }) {
  const filter = (list) => [...list].filter((f) => !accept || accept(f));
  button?.addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const files = filter(input.files);
    input.value = "";
    if (files.length) onFiles(files);
  });
  ["dragenter", "dragover"].forEach((evt) => zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.add("is-dragging"); }));
  ["dragleave", "drop"].forEach((evt) => zone.addEventListener(evt, (e) => { e.preventDefault(); zone.classList.remove("is-dragging"); }));
  zone.addEventListener("drop", (e) => {
    const files = filter(e.dataTransfer.files);
    if (files.length) onFiles(files);
  });
  // Paste images from clipboard
  window.addEventListener("paste", (e) => {
    const files = filter([...(e.clipboardData?.files || [])]);
    if (files.length) onFiles(files);
  });
}

// Decode an image file into an ImageBitmap (or HTMLImageElement fallback), honouring EXIF orientation.
export async function decodeImage(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (e) { /* fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function sourceSize(src) {
  return { width: src.width || src.naturalWidth, height: src.height || src.naturalHeight };
}

// Draw source onto a canvas of (w,h). mode: "fit" (stretch to exact box keeping aspect via cover crop) or "scale".
export function drawToCanvas(src, w, h, { cover = false, background = null } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d");
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.imageSmoothingQuality = "high";
  const { width: sw, height: sh } = sourceSize(src);
  if (cover) {
    const scale = Math.max(canvas.width / sw, canvas.height / sh);
    const cw = canvas.width / scale;
    const ch = canvas.height / scale;
    ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

export function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Your browser could not create this image format."))), type, quality);
  });
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function downloadAll(items) {
  for (const { blob, name } of items) {
    downloadBlob(blob, name);
    await new Promise((r) => setTimeout(r, 350));
  }
}

export const isImageFile = (f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(f.name);
