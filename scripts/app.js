const state = {
  results: []
};

const elements = {
  fileInput: document.querySelector("#fileInput"),
  selectFiles: document.querySelector("#selectFiles"),
  dropZone: document.querySelector("#dropZone"),
  quality: document.querySelector("#quality"),
  qualityValue: document.querySelector("#qualityValue"),
  maxWidth: document.querySelector("#maxWidth"),
  format: document.querySelector("#format"),
  preset: document.querySelector("#preset"),
  recommendation: document.querySelector("#recommendation"),
  resultList: document.querySelector("#resultList"),
  emptyState: document.querySelector("#emptyState"),
  downloadAll: document.querySelector("#downloadAll"),
  themeToggle: document.querySelector("#themeToggle")
};

const presets = {
  custom: { quality: 72, width: 1920, note: "AI recommendation: 72% quality and 1920px width balances clarity and speed for most web images." },
  instagram: { quality: 78, width: 1080, note: "AI recommendation: 78% quality and 1080px width is a strong fit for Instagram posts." },
  whatsapp: { quality: 64, width: 1280, note: "AI recommendation: 64% quality keeps WhatsApp shares light while preserving detail." },
  linkedin: { quality: 76, width: 1200, note: "AI recommendation: 76% quality and 1200px width works well for LinkedIn feed images." },
  seo: { quality: 70, width: 1600, note: "AI recommendation: 70% quality and 1600px width usually improves page speed without obvious quality loss." }
};

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function outputExtension(type, originalName) {
  if (type === "image/webp") return "webp";
  if (type === "image/jpeg") return "jpg";
  return originalName.split(".").pop() || "jpg";
}

function optimizedName(file, type) {
  const base = file.name.replace(/\.[^.]+$/, "");
  return `${base}-compressed.${outputExtension(type, file.name)}`;
}

function performanceScore(originalSize, compressedSize) {
  const saved = Math.max(0, 1 - compressedSize / originalSize);
  return Math.min(99, Math.max(40, Math.round(58 + saved * 44)));
}

function renderResults() {
  elements.emptyState.hidden = state.results.length > 0;
  elements.downloadAll.disabled = state.results.length === 0;
  elements.resultList.innerHTML = state.results.map((item, index) => `
    <article class="result-card">
      <img src="${item.previewUrl}" alt="Preview of ${item.name}">
      <div class="result-meta">
        <span class="result-name">${item.name}</span>
        <span>${formatBytes(item.originalSize)} to ${formatBytes(item.compressedSize)}</span>
        <span class="saving">${item.savedPercent}% smaller - score ${item.score}</span>
      </div>
      <a class="secondary-action" href="${item.downloadUrl}" download="${item.name}" data-index="${index}">Download</a>
    </article>
  `).join("");
}

async function compressFile(file) {
  const quality = Number(elements.quality.value) / 100;
  const maxWidthOrHeight = Number(elements.maxWidth.value) || 1920;
  const requestedType = elements.format.value === "auto" ? file.type : elements.format.value;

  const options = {
    maxSizeMB: 10,
    maxWidthOrHeight,
    useWebWorker: true,
    initialQuality: quality,
    fileType: requestedType
  };

  const compressed = await imageCompression(file, options);
  const downloadUrl = URL.createObjectURL(compressed);
  const previewUrl = URL.createObjectURL(compressed);
  const savedPercent = Math.max(0, Math.round((1 - compressed.size / file.size) * 100));

  state.results.unshift({
    name: optimizedName(file, requestedType),
    originalSize: file.size,
    compressedSize: compressed.size,
    savedPercent,
    score: performanceScore(file.size, compressed.size),
    previewUrl,
    downloadUrl
  });
}

async function handleFiles(files) {
  if (typeof imageCompression === "undefined") {
    elements.emptyState.textContent = "The compression library is still loading or was blocked. Refresh the page and try again.";
    elements.emptyState.hidden = false;
    return;
  }

  const images = [...files].filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;

  elements.emptyState.textContent = "Compressing images...";
  elements.emptyState.hidden = false;

  for (const file of images) {
    try {
      await compressFile(file);
      renderResults();
    } catch (error) {
      elements.emptyState.textContent = "One image could not be compressed. Try a JPG, PNG, or WebP file.";
    }
  }
}

function applyPreset(name) {
  const preset = presets[name] || presets.custom;
  elements.quality.value = preset.quality;
  elements.maxWidth.value = preset.width;
  elements.qualityValue.textContent = `${preset.quality}%`;
  elements.recommendation.textContent = preset.note;
}

elements.selectFiles.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", (event) => handleFiles(event.target.files));

["dragenter", "dragover"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-dragging");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("is-dragging");
  });
});

elements.dropZone.addEventListener("drop", (event) => handleFiles(event.dataTransfer.files));

elements.quality.addEventListener("input", () => {
  elements.qualityValue.textContent = `${elements.quality.value}%`;
});

elements.preset.addEventListener("change", (event) => applyPreset(event.target.value));

elements.downloadAll.addEventListener("click", () => {
  state.results.forEach((item) => {
    const link = document.createElement("a");
    link.href = item.downloadUrl;
    link.download = item.name;
    link.click();
  });
});

elements.themeToggle.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem("theme", nextTheme);
});

const savedTheme = localStorage.getItem("theme");
if (savedTheme) {
  document.documentElement.dataset.theme = savedTheme;
}
