/*
 * Shared user settings: image format/quality/downscale, transcription provider,
 * and the storage-usage readout. Persisted in chrome.storage.local. Feature
 * modules read the values through the synchronous getters below, which are
 * served from an in-memory cache warmed by initSettings() at startup, so the
 * capture/encode paths never have to await storage.
 */

const SETTINGS_KEYS = {
  imageFormat: "imageFormat",
  imageQuality: "imageQuality",
  maxCaptureWidth: "maxCaptureWidth",
  transcriptionProvider: "transcriptionProvider",
  openAiApiKey: "openAiApiKey"
};

const DEFAULT_SETTINGS_VALUES = {
  imageFormat: "png",
  imageQuality: 0.85,
  maxCaptureWidth: 0,
  transcriptionProvider: "browser",
  openAiApiKey: ""
};

const IMAGE_FORMATS = ["png", "webp", "jpeg"];
const TRANSCRIPTION_PROVIDERS = ["browser", "openai"];

const cache = { ...DEFAULT_SETTINGS_VALUES };

const els = {};

// --- pure helpers (unit-tested) ----------------------------------------------

export function normalizeImageFormat(value) {
  return IMAGE_FORMATS.includes(value) ? value : DEFAULT_SETTINGS_VALUES.imageFormat;
}

export function formatToMime(format) {
  if (format === "webp") {
    return "image/webp";
  }

  if (format === "jpeg") {
    return "image/jpeg";
  }

  return "image/png";
}

export function formatToExtension(format) {
  if (format === "webp") {
    return "webp";
  }

  if (format === "jpeg") {
    return "jpg";
  }

  return "png";
}

export function isLossyFormat(format) {
  return format === "webp" || format === "jpeg";
}

// Returns the dimensions an image should be encoded at given a max-width cap.
// maxWidth of 0 (or anything not smaller than the source) means "no change".
// Height scales proportionally and never rounds to zero.
export function downscaleDimensions(width, height, maxWidth) {
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  const cap = Math.max(0, Math.round(Number(maxWidth) || 0));

  if (cap === 0 || w === 0 || w <= cap) {
    return { width: w, height: h, scaled: false };
  }

  const ratio = cap / w;
  return {
    width: cap,
    height: Math.max(1, Math.round(h * ratio)),
    scaled: true
  };
}

export function clampQuality(value) {
  const q = Number(value);

  if (!Number.isFinite(q)) {
    return DEFAULT_SETTINGS_VALUES.imageQuality;
  }

  return Math.min(1, Math.max(0.4, q));
}

// --- synchronous getters (served from the warmed cache) ----------------------

export function getImageFormat() {
  return normalizeImageFormat(cache.imageFormat);
}

export function getImageQuality() {
  return clampQuality(cache.imageQuality);
}

export function getMaxCaptureWidth() {
  return Math.max(0, Math.round(Number(cache.maxCaptureWidth) || 0));
}

export function getTranscriptionProvider() {
  return TRANSCRIPTION_PROVIDERS.includes(cache.transcriptionProvider)
    ? cache.transcriptionProvider
    : DEFAULT_SETTINGS_VALUES.transcriptionProvider;
}

export function getOpenAiApiKey() {
  return String(cache.openAiApiKey || "").trim();
}

// --- lifecycle ---------------------------------------------------------------

export async function initSettings() {
  els.imageFormatSelect = document.getElementById("imageFormatSelect");
  els.imageQualityRange = document.getElementById("imageQualityRange");
  els.imageQualityValue = document.getElementById("imageQualityValue");
  els.maxWidthSelect = document.getElementById("maxWidthSelect");
  els.transcriptionProviderSelect = document.getElementById("transcriptionProviderSelect");
  els.openAiKeyInput = document.getElementById("openAiKeyInput");
  els.openAiKeyField = document.getElementById("openAiKeyField");
  els.storageUsageText = document.getElementById("storageUsageText");
  els.refreshStorageButton = document.getElementById("refreshStorageButton");

  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS_VALUES);
  Object.assign(cache, {
    imageFormat: normalizeImageFormat(stored.imageFormat),
    imageQuality: clampQuality(stored.imageQuality),
    maxCaptureWidth: Math.max(0, Math.round(Number(stored.maxCaptureWidth) || 0)),
    transcriptionProvider: TRANSCRIPTION_PROVIDERS.includes(stored.transcriptionProvider)
      ? stored.transcriptionProvider
      : DEFAULT_SETTINGS_VALUES.transcriptionProvider,
    openAiApiKey: String(stored.openAiApiKey || "")
  });

  if (!els.imageFormatSelect) {
    return;
  }

  els.imageFormatSelect.value = cache.imageFormat;
  els.imageQualityRange.value = String(cache.imageQuality);
  els.maxWidthSelect.value = String(cache.maxCaptureWidth);
  els.transcriptionProviderSelect.value = cache.transcriptionProvider;
  els.openAiKeyInput.value = cache.openAiApiKey;

  reflectFormatUi();
  reflectProviderUi();
  renderQualityValue();

  els.imageFormatSelect.addEventListener("change", () => {
    cache.imageFormat = normalizeImageFormat(els.imageFormatSelect.value);
    reflectFormatUi();
    void persist({ imageFormat: cache.imageFormat });
  });

  els.imageQualityRange.addEventListener("input", () => {
    cache.imageQuality = clampQuality(els.imageQualityRange.value);
    renderQualityValue();
  });

  els.imageQualityRange.addEventListener("change", () => {
    void persist({ imageQuality: cache.imageQuality });
  });

  els.maxWidthSelect.addEventListener("change", () => {
    cache.maxCaptureWidth = Math.max(0, Math.round(Number(els.maxWidthSelect.value) || 0));
    void persist({ maxCaptureWidth: cache.maxCaptureWidth });
  });

  els.transcriptionProviderSelect.addEventListener("change", () => {
    cache.transcriptionProvider = TRANSCRIPTION_PROVIDERS.includes(els.transcriptionProviderSelect.value)
      ? els.transcriptionProviderSelect.value
      : DEFAULT_SETTINGS_VALUES.transcriptionProvider;
    reflectProviderUi();
    void persist({ transcriptionProvider: cache.transcriptionProvider });
  });

  els.openAiKeyInput.addEventListener("change", () => {
    cache.openAiApiKey = String(els.openAiKeyInput.value || "");
    void persist({ openAiApiKey: cache.openAiApiKey });
  });

  if (els.refreshStorageButton) {
    els.refreshStorageButton.addEventListener("click", () => {
      void renderStorageUsage();
    });
  }

  await renderStorageUsage();
}

function reflectFormatUi() {
  if (!els.imageQualityRange) {
    return;
  }

  const lossy = isLossyFormat(cache.imageFormat);
  els.imageQualityRange.disabled = !lossy;
  const wrap = els.imageQualityRange.closest(".field");

  if (wrap) {
    wrap.style.opacity = lossy ? "1" : "0.5";
  }
}

function reflectProviderUi() {
  if (!els.openAiKeyField) {
    return;
  }

  els.openAiKeyField.classList.toggle("hidden", cache.transcriptionProvider !== "openai");
}

function renderQualityValue() {
  if (els.imageQualityValue) {
    els.imageQualityValue.textContent = `${Math.round(getImageQuality() * 100)}%`;
  }
}

async function persist(partial) {
  try {
    await chrome.storage.local.set(partial);
  } catch (error) {
    console.warn("Unable to persist a setting.", error);
  }
}

export async function renderStorageUsage() {
  if (!els.storageUsageText) {
    return;
  }

  if (!navigator.storage || typeof navigator.storage.estimate !== "function") {
    els.storageUsageText.textContent = "Storage usage is unavailable in this browser.";
    return;
  }

  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const usedMb = (usage / (1024 * 1024)).toFixed(1);

    if (quota > 0) {
      const quotaMb = (quota / (1024 * 1024)).toFixed(0);
      const pct = Math.min(100, Math.round((usage / quota) * 100));
      els.storageUsageText.textContent = `Using ${usedMb} MB of about ${quotaMb} MB available (${pct}%).`;
    } else {
      els.storageUsageText.textContent = `Using ${usedMb} MB.`;
    }
  } catch (error) {
    els.storageUsageText.textContent = "Storage usage could not be read.";
  }
}
