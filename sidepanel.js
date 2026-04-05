const DB_NAME = "heracles-file-access";
const DB_VERSION = 1;
const HANDLE_STORE = "handles";
const HANDLE_KEY = "export-directory";

const DEFAULT_SETTINGS = {
  runName: "training-run",
  documentTitle: "",
  narrationText: "",
  nextCaptureNumber: 1,
  runFolderSlug: "",
  captures: []
};

const DEFAULT_EDITOR_COLOR = "#d97706";
const DEFAULT_EDITOR_STROKE = 4;

const elements = {};
const state = {
  nextCaptureNumber: 1,
  runFolderSlug: "",
  captures: [],
  editor: {
    isOpen: false,
    sourceCanvas: null,
    sourceContext: null,
    originalDataUrl: "",
    history: [],
    pendingCapture: null,
    isPointerDown: false,
    dragStart: null,
    draftRect: null,
    cropRect: null,
    lastPoint: null
  }
};

let lastNarrationSelection = { start: 0, end: 0 };

document.addEventListener("DOMContentLoaded", () => {
  void initialize();
});

async function initialize() {
  cacheElements();
  initializeEditorState();
  bindEvents();

  await restoreSettings();
  await refreshFolderStatus();
  await refreshActiveTabHint();
  refreshRunFolderHint();
  refreshCaptureList();
  renderPreview();
  updateEditorToolUi();
}

function cacheElements() {
  elements.runNameInput = document.getElementById("runNameInput");
  elements.documentTitleInput = document.getElementById("documentTitleInput");
  elements.narrationInput = document.getElementById("narrationInput");
  elements.selectFolderButton = document.getElementById("selectFolderButton");
  elements.clearFolderButton = document.getElementById("clearFolderButton");
  elements.captureButton = document.getElementById("captureButton");
  elements.captureEditButton = document.getElementById("captureEditButton");
  elements.previewButton = document.getElementById("previewButton");
  elements.saveMarkdownButton = document.getElementById("saveMarkdownButton");
  elements.resetRunButton = document.getElementById("resetRunButton");
  elements.statusText = document.getElementById("statusText");
  elements.previewOutput = document.getElementById("previewOutput");
  elements.lastExport = document.getElementById("lastExport");
  elements.folderStatusText = document.getElementById("folderStatusText");
  elements.folderStatusBadge = document.getElementById("folderStatusBadge");
  elements.activeUrlHint = document.getElementById("activeUrlHint");
  elements.runFolderHint = document.getElementById("runFolderHint");
  elements.captureList = document.getElementById("captureList");
  elements.editorCard = document.getElementById("editorCard");
  elements.editorMeta = document.getElementById("editorMeta");
  elements.editorHint = document.getElementById("editorHint");
  elements.editorToolSelect = document.getElementById("editorToolSelect");
  elements.editorColorInput = document.getElementById("editorColorInput");
  elements.editorStrokeInput = document.getElementById("editorStrokeInput");
  elements.editorCanvas = document.getElementById("editorCanvas");
  elements.applyCropButton = document.getElementById("applyCropButton");
  elements.undoEditButton = document.getElementById("undoEditButton");
  elements.resetImageButton = document.getElementById("resetImageButton");
  elements.saveEditedCaptureButton = document.getElementById("saveEditedCaptureButton");
  elements.cancelEditorButton = document.getElementById("cancelEditorButton");
}

function initializeEditorState() {
  state.editor.sourceCanvas = document.createElement("canvas");
  state.editor.sourceContext = state.editor.sourceCanvas.getContext("2d");
  elements.editorColorInput.value = DEFAULT_EDITOR_COLOR;
  elements.editorStrokeInput.value = String(DEFAULT_EDITOR_STROKE);
}

function bindEvents() {
  [elements.runNameInput, elements.documentTitleInput, elements.narrationInput].forEach((element) => {
    element.addEventListener("input", () => {
      if (element === elements.narrationInput) {
        updateNarrationSelection();
      }

      renderPreview();
      refreshRunFolderHint();
      void saveSettings();
    });
  });

  ["select", "keyup", "click", "focus"].forEach((eventName) => {
    elements.narrationInput.addEventListener(eventName, () => {
      updateNarrationSelection();
    });
  });

  elements.selectFolderButton.addEventListener("click", () => {
    void chooseExportFolder();
  });

  elements.clearFolderButton.addEventListener("click", () => {
    void clearStoredFolder();
  });

  elements.captureButton.addEventListener("click", () => {
    void captureAndInsert();
  });

  elements.captureEditButton.addEventListener("click", () => {
    void captureAndOpenEditor();
  });

  elements.previewButton.addEventListener("click", () => {
    renderPreview();
    setStatus("Preview updated.", "success");
  });

  elements.saveMarkdownButton.addEventListener("click", () => {
    void saveMarkdownDocument();
  });

  elements.resetRunButton.addEventListener("click", () => {
    void resetRun();
  });

  elements.editorToolSelect.addEventListener("change", () => {
    state.editor.cropRect = null;
    state.editor.draftRect = null;
    updateEditorToolUi();
    renderEditorCanvas();
  });

  elements.editorColorInput.addEventListener("input", () => {
    renderEditorCanvas();
  });

  elements.editorStrokeInput.addEventListener("input", () => {
    renderEditorCanvas();
  });

  elements.applyCropButton.addEventListener("click", () => {
    void applyEditorCrop();
  });

  elements.undoEditButton.addEventListener("click", () => {
    void undoEditorChange();
  });

  elements.resetImageButton.addEventListener("click", () => {
    void resetEditorImage();
  });

  elements.saveEditedCaptureButton.addEventListener("click", () => {
    void saveEditedCaptureAndInsert();
  });

  elements.cancelEditorButton.addEventListener("click", () => {
    closeEditorSession();
    setStatus("Editor closed without saving the image.", "warn");
  });

  elements.editorCanvas.addEventListener("pointerdown", onEditorPointerDown);
  elements.editorCanvas.addEventListener("pointermove", onEditorPointerMove);
  elements.editorCanvas.addEventListener("pointerup", onEditorPointerUp);
  elements.editorCanvas.addEventListener("pointerleave", onEditorPointerUp);
  elements.editorCanvas.addEventListener("pointercancel", onEditorPointerUp);

  window.addEventListener("resize", () => {
    if (state.editor.isOpen) {
      renderEditorCanvas();
    }
  });
}

async function restoreSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...stored };

  elements.runNameInput.value = settings.runName;
  elements.documentTitleInput.value = settings.documentTitle;
  elements.narrationInput.value = settings.narrationText;

  state.nextCaptureNumber = normalizeCaptureNumber(settings.nextCaptureNumber);
  state.runFolderSlug = String(settings.runFolderSlug || "");
  state.captures = Array.isArray(settings.captures) ? settings.captures : [];

  const endPosition = elements.narrationInput.value.length;
  lastNarrationSelection = { start: endPosition, end: endPosition };
}

async function saveSettings() {
  await chrome.storage.local.set(collectStoragePayload());
}

function collectStoragePayload() {
  return {
    runName: elements.runNameInput.value.trim() || DEFAULT_SETTINGS.runName,
    documentTitle: elements.documentTitleInput.value.trim(),
    narrationText: elements.narrationInput.value,
    nextCaptureNumber: state.nextCaptureNumber,
    runFolderSlug: state.runFolderSlug,
    captures: state.captures
  };
}

function normalizeCaptureNumber(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function setStatus(message, tone = "info") {
  elements.statusText.textContent = message;
  elements.statusText.className = "status";

  if (tone === "warn") {
    elements.statusText.classList.add("warn");
  }

  if (tone === "success") {
    elements.statusText.classList.add("success");
  }
}

function setBusy(isBusy) {
  [
    elements.selectFolderButton,
    elements.clearFolderButton,
    elements.captureButton,
    elements.captureEditButton,
    elements.previewButton,
    elements.saveMarkdownButton,
    elements.resetRunButton
  ].forEach((element) => {
    element.disabled = isBusy;
  });

  if (isBusy) {
    [
      elements.applyCropButton,
      elements.undoEditButton,
      elements.resetImageButton,
      elements.saveEditedCaptureButton,
      elements.cancelEditorButton
    ].forEach((element) => {
      element.disabled = true;
    });
    return;
  }

  updateEditorToolUi();
}

async function refreshActiveTabHint() {
  try {
    const activeTab = await getActiveTab();
    const url = activeTab?.url || "";

    if (!url) {
      elements.activeUrlHint.textContent = "";
      return;
    }

    elements.activeUrlHint.textContent = new URL(url).hostname;
  } catch (error) {
    elements.activeUrlHint.textContent = "";
  }
}

function refreshRunFolderHint() {
  const typedSlug = slugify(elements.runNameInput.value) || DEFAULT_SETTINGS.runName;

  if (!state.runFolderSlug) {
    elements.runFolderHint.textContent = `The first capture will create the run folder "${typedSlug}".`;
    return;
  }

  if (typedSlug === state.runFolderSlug) {
    elements.runFolderHint.textContent = `This run is saving into "${state.runFolderSlug}".`;
    return;
  }

  elements.runFolderHint.textContent =
    `This run is locked to "${state.runFolderSlug}". Click Start New Run if you want a different folder.`;
}

function updateNarrationSelection() {
  lastNarrationSelection = {
    start: elements.narrationInput.selectionStart ?? elements.narrationInput.value.length,
    end: elements.narrationInput.selectionEnd ?? elements.narrationInput.value.length
  };
}

async function chooseExportFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    setStatus("Folder picker is unavailable in this browser context. Exports will use Downloads instead.", "warn");
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await storeHandle(handle);
    await chrome.storage.local.set({ exportFolderName: handle.name });
    await refreshFolderStatus();
    setStatus(`Export folder ready: ${handle.name}`, "success");
  } catch (error) {
    if (error?.name === "AbortError") {
      setStatus("Folder selection cancelled.", "warn");
      return;
    }

    console.error("Unable to select export folder.", error);
    setStatus("Unable to open the folder picker. Downloads fallback is still available.", "warn");
  }
}

async function clearStoredFolder() {
  await deleteHandle();
  await chrome.storage.local.remove("exportFolderName");
  await refreshFolderStatus();
  setStatus("Stored folder cleared. Future exports will use Downloads unless you pick a folder again.");
}

async function refreshFolderStatus() {
  const handle = await getStoredHandle();
  const { exportFolderName = "" } = await chrome.storage.local.get({ exportFolderName: "" });

  if (!handle) {
    elements.folderStatusBadge.textContent = "Downloads";
    elements.folderStatusBadge.className = "badge badge-muted";
    elements.folderStatusText.textContent = "No folder handle stored. Exports will fall back to Downloads.";
    return;
  }

  const granted = await ensureFolderPermission(handle, false, false);
  const folderName = handle.name || exportFolderName || "Selected folder";

  if (!granted) {
    elements.folderStatusBadge.textContent = "Needs access";
    elements.folderStatusBadge.className = "badge badge-muted";
    elements.folderStatusText.textContent = `${folderName} is remembered, but Chrome will ask again before writing.`;
    return;
  }

  elements.folderStatusBadge.textContent = "Ready";
  elements.folderStatusBadge.className = "badge badge-ready";
  elements.folderStatusText.textContent = `Writing directly into "${folderName}".`;
}

function renderPreview() {
  elements.previewOutput.value = renderMarkdownDocument();
}

async function captureAndInsert() {
  setBusy(true);
  setStatus("Capturing the current screen and inserting it...");

  try {
    const session = await prepareCaptureSession();
    const screenshotBlob = await dataUrlToBlob(session.screenshotDataUrl);
    const saveResult = await saveExportFile(
      session.runFolderSlug,
      session.captureMeta.relativeImagePath,
      screenshotBlob
    );

    await finalizeCapture(session.captureMeta, saveResult, false);
  } catch (error) {
    console.error("Capture/insert failed.", error);
    setStatus(error.message || "Unable to capture this screen.", "warn");
  } finally {
    setBusy(false);
  }
}

async function captureAndOpenEditor() {
  setBusy(true);
  setStatus("Capturing the current screen and opening the editor...");

  try {
    const session = await prepareCaptureSession();
    await openEditorSession(session);
    setStatus("Editor ready. Crop or annotate the image, then save it into the narration.", "success");
  } catch (error) {
    console.error("Capture/editor launch failed.", error);
    setStatus(error.message || "Unable to open the editor for this screen.", "warn");
  } finally {
    setBusy(false);
  }
}

async function prepareCaptureSession() {
  const activeTab = await getActiveTab();
  validateActiveTab(activeTab);

  const [pageContext, screenshotDataUrl, runFolderSlug] = await Promise.all([
    extractPageContext(activeTab.id),
    captureVisibleTab(activeTab.windowId),
    ensureRunFolderSlug()
  ]);

  const captureMeta = buildCaptureMeta({
    activeTab,
    pageContext,
    runFolderSlug,
    captureNumber: state.nextCaptureNumber
  });

  return {
    activeTab,
    pageContext,
    screenshotDataUrl,
    runFolderSlug,
    captureMeta
  };
}

async function finalizeCapture(captureMeta, saveResult, edited) {
  const finalCaptureMeta = { ...captureMeta, edited };

  insertCaptureReference(finalCaptureMeta);
  state.captures.push(finalCaptureMeta);
  state.nextCaptureNumber += 1;

  await saveSettings();
  refreshCaptureList();
  renderPreview();
  refreshRunFolderHint();

  elements.lastExport.innerHTML = [
    `<strong>Screenshot</strong>: ${escapeHtml(saveResult.path)}`,
    `<strong>Mode</strong>: ${escapeHtml(saveResult.mode)}`,
    `<strong>Inserted tag</strong>: ${escapeHtml(finalCaptureMeta.relativeImagePath)}`
  ].join("<br>");

  setStatus(
    edited
      ? `Edited screenshot ${finalCaptureMeta.indexLabel} saved and inserted into the narration.`
      : `Screenshot ${finalCaptureMeta.indexLabel} inserted into the narration.`,
    "success"
  );
}

async function saveMarkdownDocument() {
  setBusy(true);
  setStatus("Saving the combined Markdown file...");

  try {
    const runFolderSlug = await ensureRunFolderSlug();
    const markdown = renderMarkdownDocument();
    const markdownFileName = `${state.runFolderSlug || runFolderSlug}.md`;
    const saveResult = await saveExportFile(
      runFolderSlug,
      markdownFileName,
      new Blob([markdown], { type: "text/markdown" })
    );

    await saveSettings();
    refreshRunFolderHint();

    elements.lastExport.innerHTML = [
      `<strong>Markdown</strong>: ${escapeHtml(saveResult.path)}`,
      `<strong>Mode</strong>: ${escapeHtml(saveResult.mode)}`,
      `<strong>Captured screens</strong>: ${escapeHtml(String(state.captures.length))}`
    ].join("<br>");

    setStatus("Markdown saved successfully.", "success");
  } catch (error) {
    console.error("Markdown save failed.", error);
    setStatus(error.message || "Unable to save the Markdown file.", "warn");
  } finally {
    setBusy(false);
  }
}

async function resetRun() {
  const confirmed = window.confirm(
    "Start a new run? This clears the current draft and capture list inside the extension. Files already exported on disk will stay there."
  );

  if (!confirmed) {
    return;
  }

  elements.documentTitleInput.value = "";
  elements.narrationInput.value = "";
  state.nextCaptureNumber = 1;
  state.runFolderSlug = "";
  state.captures = [];

  const endPosition = elements.narrationInput.value.length;
  lastNarrationSelection = { start: endPosition, end: endPosition };

  closeEditorSession();
  await saveSettings();
  refreshRunFolderHint();
  refreshCaptureList();
  renderPreview();

  elements.lastExport.textContent = "Nothing exported yet.";
  setStatus("Run reset. You can rename the run folder before the next capture.", "success");
}

async function ensureRunFolderSlug() {
  if (state.runFolderSlug) {
    return state.runFolderSlug;
  }

  state.runFolderSlug = slugify(elements.runNameInput.value) || DEFAULT_SETTINGS.runName;
  await saveSettings();
  return state.runFolderSlug;
}

function buildCaptureMeta({ activeTab, pageContext, runFolderSlug, captureNumber }) {
  const indexLabel = String(captureNumber).padStart(3, "0");
  const title = normalizeInlineText(pageContext.title || elements.documentTitleInput.value || `Screen ${indexLabel}`);
  const fileName = `${indexLabel}-${slugify(title) || "screen"}.png`;

  return {
    indexLabel,
    captureNumber,
    title,
    fileName,
    relativeImagePath: `screenshots/${fileName}`,
    pageUrl: pageContext.url || activeTab.url,
    pageTitle: pageContext.title || title,
    capturedAt: new Date().toISOString(),
    runFolderSlug
  };
}

function insertCaptureReference(captureMeta) {
  const snippet = buildCaptureMarkdown(captureMeta);
  const currentValue = elements.narrationInput.value;
  const selectionStart = clampSelection(lastNarrationSelection.start, currentValue.length);
  const selectionEnd = clampSelection(lastNarrationSelection.end, currentValue.length);
  const before = currentValue.slice(0, selectionStart);
  const after = currentValue.slice(selectionEnd);
  const prefix = before.length === 0 ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix = after.length === 0 ? "\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const insertion = `${prefix}${snippet}${suffix}`;
  const updatedValue = `${before}${insertion}${after}`;
  const newCursorPosition = (before + insertion).length;

  elements.narrationInput.value = updatedValue;
  elements.narrationInput.focus();
  elements.narrationInput.selectionStart = newCursorPosition;
  elements.narrationInput.selectionEnd = newCursorPosition;

  lastNarrationSelection = { start: newCursorPosition, end: newCursorPosition };
}

function clampSelection(value, max) {
  if (!Number.isFinite(value)) {
    return max;
  }

  return Math.max(0, Math.min(value, max));
}

function buildCaptureMarkdown(captureMeta) {
  const altText = escapeMarkdownText(`Screen ${captureMeta.indexLabel} - ${captureMeta.title}`);
  return `![${altText}](${captureMeta.relativeImagePath})`;
}

function renderMarkdownDocument() {
  const documentTitle = elements.documentTitleInput.value.trim();
  const narrationText = elements.narrationInput.value.trim();
  const lines = [];

  if (documentTitle) {
    lines.push(`# ${documentTitle}`, "");
  }

  if (narrationText) {
    lines.push(narrationText);
  } else {
    lines.push("_Start typing your narration here._");
  }

  return lines.join("\n");
}

function refreshCaptureList() {
  if (state.captures.length === 0) {
    elements.captureList.innerHTML = '<p class="small subtle">No screenshots captured yet.</p>';
    return;
  }

  elements.captureList.innerHTML = state.captures
    .map((capture) => {
      const host = safeHostname(capture.pageUrl);
      const editedLabel = capture.edited ? " • edited" : "";
      return [
        '<article class="capture-item">',
        `<p class="capture-title">Screen ${escapeHtml(capture.indexLabel)}: ${escapeHtml(capture.title)}</p>`,
        `<p class="capture-path">${escapeHtml(capture.relativeImagePath)}</p>`,
        `<p class="small subtle">${escapeHtml(host)} • ${escapeHtml(formatTimestamp(capture.capturedAt))}${escapeHtml(editedLabel)}</p>`,
        "</article>"
      ].join("");
    })
    .join("");
}

async function openEditorSession(session) {
  state.editor.pendingCapture = session;
  state.editor.originalDataUrl = session.screenshotDataUrl;
  state.editor.history = [];
  state.editor.isPointerDown = false;
  state.editor.dragStart = null;
  state.editor.draftRect = null;
  state.editor.cropRect = null;
  state.editor.lastPoint = null;
  state.editor.isOpen = true;

  elements.editorMeta.textContent = `Screen ${session.captureMeta.indexLabel} • ${session.captureMeta.title}`;
  elements.editorToolSelect.value = "crop";
  elements.editorColorInput.value = DEFAULT_EDITOR_COLOR;
  elements.editorStrokeInput.value = String(DEFAULT_EDITOR_STROKE);
  elements.editorCard.classList.remove("hidden");

  await loadEditorSourceFromDataUrl(session.screenshotDataUrl);
  updateEditorToolUi();
  renderEditorCanvas();
  elements.editorCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeEditorSession() {
  state.editor.isOpen = false;
  state.editor.pendingCapture = null;
  state.editor.originalDataUrl = "";
  state.editor.history = [];
  state.editor.isPointerDown = false;
  state.editor.dragStart = null;
  state.editor.draftRect = null;
  state.editor.cropRect = null;
  state.editor.lastPoint = null;
  elements.editorCard.classList.add("hidden");
  elements.editorMeta.textContent = "";
}

function updateEditorToolUi() {
  const tool = elements.editorToolSelect.value;
  const hasOpenImage = state.editor.isOpen;

  if (tool === "crop") {
    elements.editorHint.textContent = "Drag across the image to select a crop region, then click Apply Crop.";
  } else if (tool === "box") {
    elements.editorHint.textContent = "Drag to draw a rectangular callout. Color and stroke width apply to the outline.";
  } else {
    elements.editorHint.textContent = "Drag to draw freehand annotation lines on the image.";
  }

  const isCropTool = tool === "crop";
  elements.editorColorInput.disabled = !hasOpenImage || isCropTool;
  elements.editorStrokeInput.disabled = !hasOpenImage || isCropTool;
  elements.applyCropButton.disabled = !hasOpenImage || isCropTool === false || !state.editor.cropRect;
  elements.undoEditButton.disabled = !hasOpenImage || state.editor.history.length === 0;
  elements.resetImageButton.disabled = !hasOpenImage;
  elements.saveEditedCaptureButton.disabled = !hasOpenImage;
  elements.cancelEditorButton.disabled = !hasOpenImage;
}

function renderEditorCanvas() {
  if (!state.editor.isOpen || state.editor.sourceCanvas.width === 0 || state.editor.sourceCanvas.height === 0) {
    return;
  }

  const parentWidth = elements.editorCanvas.parentElement.clientWidth - 2;
  const sourceWidth = state.editor.sourceCanvas.width;
  const sourceHeight = state.editor.sourceCanvas.height;
  const displayScale = Math.min(1, parentWidth / sourceWidth);
  const displayWidth = Math.max(1, Math.round(sourceWidth * displayScale));
  const displayHeight = Math.max(1, Math.round(sourceHeight * displayScale));

  if (elements.editorCanvas.width !== displayWidth || elements.editorCanvas.height !== displayHeight) {
    elements.editorCanvas.width = displayWidth;
    elements.editorCanvas.height = displayHeight;
  }

  const ctx = elements.editorCanvas.getContext("2d");
  ctx.clearRect(0, 0, displayWidth, displayHeight);
  ctx.drawImage(state.editor.sourceCanvas, 0, 0, displayWidth, displayHeight);

  const previewRect = state.editor.draftRect || state.editor.cropRect;
  if (previewRect) {
    const rect = scaleRectToDisplay(previewRect, displayWidth, displayHeight);
    ctx.save();

    if (elements.editorToolSelect.value === "crop" || state.editor.cropRect) {
      ctx.fillStyle = "rgba(15, 118, 110, 0.14)";
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = "#0f766e";
      ctx.lineWidth = 2;
    } else {
      ctx.strokeStyle = elements.editorColorInput.value;
      ctx.lineWidth = 2;
    }

    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
  }

  updateEditorToolUi();
}

function scaleRectToDisplay(rect, displayWidth, displayHeight) {
  const scaleX = displayWidth / state.editor.sourceCanvas.width;
  const scaleY = displayHeight / state.editor.sourceCanvas.height;

  return {
    x: rect.x * scaleX,
    y: rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY
  };
}

function onEditorPointerDown(event) {
  if (!state.editor.isOpen || state.editor.sourceCanvas.width === 0) {
    return;
  }

  const point = getEditorSourcePoint(event);
  state.editor.isPointerDown = true;
  state.editor.dragStart = point;
  state.editor.lastPoint = point;

  elements.editorCanvas.setPointerCapture(event.pointerId);

  if (elements.editorToolSelect.value === "pen") {
    pushEditorHistory();
    drawEditorLine(point, point);
  }

  if (elements.editorToolSelect.value === "crop") {
    state.editor.cropRect = null;
    state.editor.draftRect = { x: point.x, y: point.y, width: 0, height: 0 };
  }

  if (elements.editorToolSelect.value === "box") {
    state.editor.draftRect = { x: point.x, y: point.y, width: 0, height: 0 };
  }

  renderEditorCanvas();
  event.preventDefault();
}

function onEditorPointerMove(event) {
  if (!state.editor.isOpen || !state.editor.isPointerDown) {
    return;
  }

  const point = getEditorSourcePoint(event);
  const tool = elements.editorToolSelect.value;

  if (tool === "pen") {
    drawEditorLine(state.editor.lastPoint, point);
    state.editor.lastPoint = point;
    renderEditorCanvas();
    return;
  }

  state.editor.draftRect = rectFromPoints(state.editor.dragStart, point);
  renderEditorCanvas();
}

function onEditorPointerUp(event) {
  if (!state.editor.isOpen || !state.editor.isPointerDown) {
    return;
  }

  const tool = elements.editorToolSelect.value;
  const point = getEditorSourcePoint(event);

  if (tool === "crop") {
    const rect = rectFromPoints(state.editor.dragStart, point);
    state.editor.cropRect = isMeaningfulRect(rect) ? rect : null;
    state.editor.draftRect = null;
  }

  if (tool === "box") {
    const rect = rectFromPoints(state.editor.dragStart, point);
    state.editor.draftRect = null;

    if (isMeaningfulRect(rect)) {
      pushEditorHistory();
      drawEditorBox(rect);
    }
  }

  state.editor.isPointerDown = false;
  state.editor.dragStart = null;
  state.editor.lastPoint = null;

  renderEditorCanvas();
}

function getEditorSourcePoint(event) {
  const rect = elements.editorCanvas.getBoundingClientRect();
  const x = clampNumber(event.clientX - rect.left, 0, rect.width);
  const y = clampNumber(event.clientY - rect.top, 0, rect.height);
  const scaleX = state.editor.sourceCanvas.width / rect.width;
  const scaleY = state.editor.sourceCanvas.height / rect.height;

  return {
    x: Math.round(x * scaleX),
    y: Math.round(y * scaleY)
  };
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function rectFromPoints(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}

function isMeaningfulRect(rect) {
  return rect && rect.width >= 4 && rect.height >= 4;
}

function pushEditorHistory() {
  state.editor.history.push(state.editor.sourceCanvas.toDataURL("image/png"));

  if (state.editor.history.length > 20) {
    state.editor.history.shift();
  }
}

function drawEditorLine(fromPoint, toPoint) {
  const ctx = state.editor.sourceContext;
  const scale = state.editor.sourceCanvas.width / elements.editorCanvas.width;

  ctx.save();
  ctx.strokeStyle = elements.editorColorInput.value;
  ctx.lineWidth = Number(elements.editorStrokeInput.value) * scale;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(fromPoint.x, fromPoint.y);
  ctx.lineTo(toPoint.x, toPoint.y);
  ctx.stroke();
  ctx.restore();
}

function drawEditorBox(rect) {
  const ctx = state.editor.sourceContext;
  const scale = state.editor.sourceCanvas.width / elements.editorCanvas.width;

  ctx.save();
  ctx.strokeStyle = elements.editorColorInput.value;
  ctx.lineWidth = Number(elements.editorStrokeInput.value) * scale;
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

async function applyEditorCrop() {
  if (!state.editor.cropRect || !isMeaningfulRect(state.editor.cropRect)) {
    setStatus("Select a crop region before applying the crop.", "warn");
    return;
  }

  pushEditorHistory();

  const cropRect = state.editor.cropRect;
  const nextCanvas = document.createElement("canvas");
  nextCanvas.width = cropRect.width;
  nextCanvas.height = cropRect.height;
  const nextContext = nextCanvas.getContext("2d");
  nextContext.drawImage(
    state.editor.sourceCanvas,
    cropRect.x,
    cropRect.y,
    cropRect.width,
    cropRect.height,
    0,
    0,
    cropRect.width,
    cropRect.height
  );

  state.editor.sourceCanvas = nextCanvas;
  state.editor.sourceContext = nextContext;
  state.editor.cropRect = null;
  state.editor.draftRect = null;

  renderEditorCanvas();
  setStatus("Crop applied. You can keep editing or save the image.", "success");
}

async function undoEditorChange() {
  const previous = state.editor.history.pop();

  if (!previous) {
    setStatus("There is nothing to undo.", "warn");
    return;
  }

  await loadEditorSourceFromDataUrl(previous);
  state.editor.cropRect = null;
  state.editor.draftRect = null;
  renderEditorCanvas();
  setStatus("Last image edit undone.", "success");
}

async function resetEditorImage() {
  if (!state.editor.originalDataUrl) {
    return;
  }

  await loadEditorSourceFromDataUrl(state.editor.originalDataUrl);
  state.editor.history = [];
  state.editor.cropRect = null;
  state.editor.draftRect = null;
  renderEditorCanvas();
  setStatus("The editor image has been reset to the original capture.", "success");
}

async function saveEditedCaptureAndInsert() {
  if (!state.editor.pendingCapture) {
    setStatus("There is no pending edited image to save.", "warn");
    return;
  }

  setBusy(true);
  setStatus("Saving the edited image and inserting it into the narration...");

  try {
    const screenshotBlob = await canvasToBlob(state.editor.sourceCanvas);
    const session = state.editor.pendingCapture;
    const saveResult = await saveExportFile(
      session.runFolderSlug,
      session.captureMeta.relativeImagePath,
      screenshotBlob
    );

    closeEditorSession();
    await finalizeCapture(session.captureMeta, saveResult, true);
  } catch (error) {
    console.error("Edited capture save failed.", error);
    setStatus(error.message || "Unable to save the edited image.", "warn");
  } finally {
    setBusy(false);
  }
}

async function loadEditorSourceFromDataUrl(dataUrl) {
  const image = await loadImage(dataUrl);
  state.editor.sourceCanvas.width = image.naturalWidth || image.width;
  state.editor.sourceCanvas.height = image.naturalHeight || image.height;
  state.editor.sourceContext = state.editor.sourceCanvas.getContext("2d");
  state.editor.sourceContext.clearRect(0, 0, state.editor.sourceCanvas.width, state.editor.sourceCanvas.height);
  state.editor.sourceContext.drawImage(image, 0, 0);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("Unable to load the captured image into the editor.")));
    image.src = src;
  });
}

async function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }

      reject(new Error("Chrome could not encode the edited image."));
    }, "image/png");
  });
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return url || "Unknown page";
  }
}

function formatTimestamp(isoString) {
  try {
    return new Date(isoString).toLocaleString();
  } catch (error) {
    return isoString;
  }
}

function normalizeInlineText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeMarkdownText(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

async function saveExportFile(runFolderSlug, relativePath, data) {
  const fullPath = `${runFolderSlug}/${relativePath}`;
  const folderHandle = await getStoredHandle();

  if (folderHandle && await ensureFolderPermission(folderHandle, true, true)) {
    await writeFileToDirectory(folderHandle, fullPath, data);

    return {
      mode: `Local folder (${folderHandle.name})`,
      path: fullPath
    };
  }

  await downloadBlob(fullPath, data);

  return {
    mode: "Chrome Downloads fallback",
    path: `Downloads/${fullPath}`
  };
}

function validateActiveTab(tab) {
  if (!tab?.id || !tab.url) {
    throw new Error("Open the target web app in an active browser tab before capturing.");
  }

  if (!/^https?:/i.test(tab.url)) {
    throw new Error("This extension can only inspect normal web pages, not Chrome internal tabs.");
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0];
}

async function captureVisibleTab(windowId) {
  const response = await chrome.runtime.sendMessage({
    type: "capture-visible-tab",
    windowId
  });

  if (!response?.ok || !response.dataUrl) {
    throw new Error(response?.error || "Chrome could not capture the current screen.");
  }

  return response.dataUrl;
}

async function extractPageContext(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      title: document.title.replace(/\s+/g, " ").trim(),
      url: window.location.href
    })
  });

  return result?.result || { title: "", url: "" };
}

async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

async function writeFileToDirectory(rootHandle, relativePath, data) {
  const segments = relativePath.split("/").filter(Boolean);
  const fileName = segments.pop();
  let currentHandle = rootHandle;

  for (const segment of segments) {
    currentHandle = await currentHandle.getDirectoryHandle(segment, { create: true });
  }

  const fileHandle = await currentHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

async function downloadBlob(relativePath, blob) {
  const url = URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url,
      filename: relativePath,
      saveAs: false,
      conflictAction: "overwrite"
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(HANDLE_STORE)) {
        database.createObjectStore(HANDLE_STORE);
      }
    });

    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function withStore(mode, callback) {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(HANDLE_STORE, mode);
    const store = transaction.objectStore(HANDLE_STORE);

    let settled = false;

    transaction.addEventListener("complete", () => {
      if (!settled) {
        resolve(undefined);
      }

      database.close();
    });

    transaction.addEventListener("error", () => {
      database.close();
      reject(transaction.error);
    });

    callback(store, (value) => {
      settled = true;
      resolve(value);
    });
  });
}

async function storeHandle(handle) {
  await withStore("readwrite", (store) => {
    store.put(handle, HANDLE_KEY);
  });
}

async function getStoredHandle() {
  return withStore("readonly", (store, resolve) => {
    const request = store.get(HANDLE_KEY);
    request.addEventListener("success", () => resolve(request.result || null));
    request.addEventListener("error", () => resolve(null));
  });
}

async function deleteHandle() {
  await withStore("readwrite", (store) => {
    store.delete(HANDLE_KEY);
  });
}

async function ensureFolderPermission(handle, writeAccess, promptUser = true) {
  if (!handle) {
    return false;
  }

  const options = { mode: writeAccess ? "readwrite" : "read" };

  if (typeof handle.queryPermission === "function") {
    const permission = await handle.queryPermission(options);
    if (permission === "granted") {
      return true;
    }
  }

  if (!promptUser) {
    return false;
  }

  if (typeof handle.requestPermission === "function") {
    const permission = await handle.requestPermission(options);
    return permission === "granted";
  }

  return false;
}
