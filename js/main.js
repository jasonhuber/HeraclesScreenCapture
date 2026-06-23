import { CAPTURE_MODE_LABELS, DEFAULT_SETTINGS, normalizeCaptureMode } from "./constants.js";
import { elements, state, setLastNarrationSelection } from "./state.js";
import { deleteCaptureData } from "./db.js";
import { dataUrlToBlob, normalizeRect } from "./image-utils.js";
import {
  buildCaptureFileName,
  createCaptureId,
  deriveSuggestedTitle,
  normalizeInlineText
} from "./markdown.js";
import {
  refreshActionAvailability,
  refreshRunFolderHint,
  renderPreview,
  saveSettings,
  setBusy,
  setStatus,
  updateNarrationSelection
} from "./ui.js";
import {
  finalizeNewCapture,
  getActiveTab,
  normalizeStoredPageContext,
  prepareCaptureSession
} from "./capture.js";
import { initAutoCapture } from "./autocapture.js";
import { initDictation, toggleDictation } from "./dictation.js";
import {
  detachToFloatingWindow,
  getVerifiedFloatWindowId,
  isFloatWindow,
  registerFloatInstance,
  renderPassivePanel,
  returnToSidePanel,
  watchFloatChanges
} from "./float-mode.js";
import {
  chooseExportFolder,
  clearStoredFolder,
  exportLmsPackage,
  refreshFolderStatus,
  saveMarkdownDocument
} from "./export.js";
import { initExportFormats } from "./export-formats.js";
import { initSettings } from "./settings.js";
import {
  applySuggestedTitlesToAll,
  deleteCapture,
  draftNarrationFromSteps,
  moveCapture,
  refreshCaptureList,
  reinsertCapture,
  syncCaptureOrdering,
  updateCaptureTitle,
  useSuggestedTitle
} from "./steps-ui.js";
import {
  handleEditorResultMessage,
  openEditorTabForCapture,
  openEditorTabForNewCapture,
  processPendingEditorWork
} from "./editor-launch.js";

const PENDING_SHORTCUT_KEY = "pendingShortcutCommand";
const PENDING_SHORTCUT_MAX_AGE_MS = 15000;

let lastShortcutCommandTs = 0;

document.addEventListener("DOMContentLoaded", () => {
  void initialize();
});

async function initialize() {
  if (isFloatWindow()) {
    await registerFloatInstance();
  } else {
    const floatWindowId = await getVerifiedFloatWindowId();

    if (floatWindowId !== null) {
      renderPassivePanel(floatWindowId);
      watchFloatChanges();
      return;
    }
  }

  watchFloatChanges();
  cacheElements();
  bindEvents();
  initExportFormats();
  await initSettings();
  renderShortcutHint();

  if (isFloatWindow()) {
    elements.floatToggleButton.textContent = "Return to Side Panel";
  }

  await restoreSettings();
  await refreshFolderStatus();
  await refreshActiveTabHint();
  refreshRunFolderHint();
  refreshCaptureList();
  renderPreview();
  refreshActionAvailability();
  initAutoCapture();
  initDictation();

  await processPendingEditorWork();
  await runPendingShortcutCommand();
}

function cacheElements() {
  elements.runNameInput = document.getElementById("runNameInput");
  elements.documentTitleInput = document.getElementById("documentTitleInput");
  elements.captureModeSelect = document.getElementById("captureModeSelect");
  elements.shortcutHint = document.getElementById("shortcutHint");
  elements.narrationInput = document.getElementById("narrationInput");
  elements.selectFolderButton = document.getElementById("selectFolderButton");
  elements.clearFolderButton = document.getElementById("clearFolderButton");
  elements.captureButton = document.getElementById("captureButton");
  elements.captureEditButton = document.getElementById("captureEditButton");
  elements.suggestTitlesButton = document.getElementById("suggestTitlesButton");
  elements.draftNarrationButton = document.getElementById("draftNarrationButton");
  elements.saveMarkdownButton = document.getElementById("saveMarkdownButton");
  elements.exportPackageButton = document.getElementById("exportPackageButton");
  elements.saveStandaloneHtmlButton = document.getElementById("saveStandaloneHtmlButton");
  elements.exportScormButton = document.getElementById("exportScormButton");
  elements.autoCaptureToggleButton = document.getElementById("autoCaptureToggleButton");
  elements.resetRunButton = document.getElementById("resetRunButton");
  elements.statusText = document.getElementById("statusText");
  elements.previewOutput = document.getElementById("previewOutput");
  elements.lastExport = document.getElementById("lastExport");
  elements.folderStatusText = document.getElementById("folderStatusText");
  elements.folderStatusBadge = document.getElementById("folderStatusBadge");
  elements.activeUrlHint = document.getElementById("activeUrlHint");
  elements.runFolderHint = document.getElementById("runFolderHint");
  elements.captureList = document.getElementById("captureList");
  elements.floatToggleButton = document.getElementById("floatToggleButton");
}

function bindEvents() {
  [elements.runNameInput, elements.documentTitleInput, elements.narrationInput].forEach((element) => {
    element.addEventListener("input", () => {
      if (element === elements.narrationInput) {
        updateNarrationSelection();
      }

      renderPreview();
      refreshRunFolderHint();
      refreshActionAvailability();
      void saveSettings();
    });
  });

  elements.captureModeSelect.addEventListener("change", () => {
    state.captureMode = normalizeCaptureMode(elements.captureModeSelect.value);
    elements.captureModeSelect.value = state.captureMode;
    void saveSettings();
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

  elements.suggestTitlesButton.addEventListener("click", () => {
    void applySuggestedTitlesToAll();
  });

  elements.draftNarrationButton.addEventListener("click", () => {
    void draftNarrationFromSteps();
  });

  elements.saveMarkdownButton.addEventListener("click", () => {
    void saveMarkdownDocument();
  });

  elements.exportPackageButton.addEventListener("click", () => {
    void exportLmsPackage();
  });

  elements.resetRunButton.addEventListener("click", () => {
    void resetRun();
  });

  elements.floatToggleButton.addEventListener("click", () => {
    if (isFloatWindow()) {
      void returnToSidePanel();
    } else {
      void detachToFloatingWindow();
    }
  });

  elements.captureList.addEventListener("click", (event) => {
    void handleCaptureListClick(event);
  });

  elements.captureList.addEventListener("change", (event) => {
    void handleCaptureListChange(event);
  });

  elements.captureList.addEventListener("keydown", (event) => {
    if (event.target instanceof HTMLInputElement && event.key === "Enter") {
      event.preventDefault();
      event.target.blur();
    }
  });

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  window.addEventListener("focus", () => {
    void refreshActiveTabHint();
  });
}

function handleRuntimeMessage(message) {
  if (message?.type === "editor-saved" || message?.type === "editor-cancelled") {
    void handleEditorResultMessage(message);
    return undefined;
  }

  if (message?.type === "heracles-folder-picked") {
    void refreshFolderStatus();
    setStatus(`Export folder ready: ${message.name || "selected folder"}.`, "success");
    return undefined;
  }

  if (message?.type !== "shortcut-command") {
    return undefined;
  }

  void chrome.storage.session.remove(PENDING_SHORTCUT_KEY);

  const commandTs = Number(message.ts) || 0;

  if (commandTs && commandTs <= lastShortcutCommandTs) {
    return undefined;
  }

  if (commandTs) {
    lastShortcutCommandTs = commandTs;
  }

  executeShortcutCommand(message.command);
  return undefined;
}

function executeShortcutCommand(command) {
  if (command === "toggle-dictation") {
    void toggleDictation();
    return;
  }

  if (state.busy) {
    setStatus("Wait for the current action to finish before triggering another shortcut.", "warn");
    return;
  }

  if (command === "quick-capture") {
    void captureAndInsert();
    return;
  }

  if (command === "capture-and-edit") {
    void captureAndOpenEditor();
  }
}

async function runPendingShortcutCommand() {
  const stored = await chrome.storage.session.get({ [PENDING_SHORTCUT_KEY]: null });
  const pendingCommand = stored[PENDING_SHORTCUT_KEY];

  if (!pendingCommand) {
    return;
  }

  await chrome.storage.session.remove(PENDING_SHORTCUT_KEY);

  const commandTs = Number(pendingCommand.ts) || 0;

  if (!commandTs || Date.now() - commandTs >= PENDING_SHORTCUT_MAX_AGE_MS || commandTs <= lastShortcutCommandTs) {
    return;
  }

  lastShortcutCommandTs = commandTs;
  executeShortcutCommand(pendingCommand.command);
}

async function restoreSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...stored };

  elements.runNameInput.value = settings.runName;
  elements.documentTitleInput.value = settings.documentTitle;
  elements.narrationInput.value = settings.narrationText;

  state.runFolderSlug = String(settings.runFolderSlug || "");
  state.captureMode = normalizeCaptureMode(settings.captureMode);
  elements.captureModeSelect.value = state.captureMode;
  state.captures = normalizeStoredCaptures(settings.captures, state.runFolderSlug);

  syncCaptureOrdering({ updateNarration: false });

  const endPosition = elements.narrationInput.value.length;
  setLastNarrationSelection({ start: endPosition, end: endPosition });
}

function normalizeStoredCaptures(captures, runFolderSlug) {
  if (!Array.isArray(captures)) {
    return [];
  }

  return captures.map((capture, index) => {
    const captureId = capture?.id || createCaptureId();
    const pageContext = normalizeStoredPageContext(capture?.pageContext);
    const titleSource = normalizeInlineText(capture?.title || capture?.pageTitle || "");
    const suggestedTitle = normalizeInlineText(
      capture?.suggestedTitle || deriveSuggestedTitle({ ...pageContext, title: capture?.pageTitle, url: capture?.pageUrl }, index + 1)
    );
    const title = titleSource || suggestedTitle || `Screen ${String(index + 1).padStart(3, "0")}`;
    const fileName = capture?.fileName || buildCaptureFileName(title, captureId);

    return {
      id: captureId,
      captureNumber: index + 1,
      indexLabel: String(index + 1).padStart(3, "0"),
      title,
      suggestedTitle,
      fileName,
      relativeImagePath: capture?.relativeImagePath || `screenshots/${fileName}`,
      pageUrl: capture?.pageUrl || "",
      pageTitle: capture?.pageTitle || title,
      pageContext,
      sensitiveRects: Array.isArray(capture?.sensitiveRects) ? capture.sensitiveRects.map(normalizeRect).filter(Boolean) : [],
      clickContext: capture?.clickContext || null,
      captureMode: normalizeCaptureMode(capture?.captureMode),
      capturedAt: capture?.capturedAt || new Date().toISOString(),
      edited: Boolean(capture?.edited),
      assetWidth: Number(capture?.assetWidth) || 0,
      assetHeight: Number(capture?.assetHeight) || 0,
      runFolderSlug: capture?.runFolderSlug || runFolderSlug || ""
    };
  });
}

function renderShortcutHint() {
  const isMac = /mac/i.test(navigator.platform);
  const quickCapture = isMac ? "Command+Shift+1" : "Ctrl+Shift+1";
  const captureAndEdit = isMac ? "Command+Shift+2" : "Ctrl+Shift+2";
  const dictation = isMac ? "Command+Shift+3" : "Ctrl+Shift+3";
  elements.shortcutHint.textContent =
    `Shortcuts: ${quickCapture} captures with the current mode, ${captureAndEdit} captures and opens the editor, ` +
    `${dictation} toggles dictation.`;
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

async function captureAndInsert() {
  await runCaptureFlow({ openEditor: false });
}

async function captureAndOpenEditor() {
  await runCaptureFlow({ openEditor: true });
}

async function runCaptureFlow({ openEditor }) {
  if (state.busy) {
    return;
  }

  setBusy(true);

  const modeLabel = CAPTURE_MODE_LABELS[state.captureMode] || "Visible area";
  setStatus(
    openEditor
      ? `Capturing ${modeLabel.toLowerCase()} and opening the editor...`
      : `Capturing ${modeLabel.toLowerCase()} and inserting it...`
  );

  try {
    const session = await prepareCaptureSession();

    if (openEditor) {
      await openEditorTabForNewCapture(session);
      setStatus("Editor opened in a new tab. This step is added to the run when you save it there.", "success");
      return;
    }

    const screenshotBlob = await dataUrlToBlob(session.screenshotDataUrl);
    await finalizeNewCapture(session, screenshotBlob, false);
  } catch (error) {
    console.error("Capture flow failed.", error);
    setStatus(error.message || "Unable to capture this screen.", "warn");
  } finally {
    setBusy(false);
  }
}

async function handleCaptureListClick(event) {
  const button = event.target.closest("[data-step-action]");

  if (!button || state.busy) {
    return;
  }

  const captureId = button.getAttribute("data-capture-id");
  const action = button.getAttribute("data-step-action");

  if (!captureId || !action) {
    return;
  }

  if (action === "move-up") {
    await moveCapture(captureId, -1);
    return;
  }

  if (action === "move-down") {
    await moveCapture(captureId, 1);
    return;
  }

  if (action === "edit") {
    await openEditorTabForCapture(captureId);
    return;
  }

  if (action === "reinsert") {
    await reinsertCapture(captureId);
    return;
  }

  if (action === "use-suggestion") {
    await useSuggestedTitle(captureId);
    return;
  }

  if (action === "delete") {
    await deleteCapture(captureId);
  }
}

async function handleCaptureListChange(event) {
  if (state.busy || !(event.target instanceof HTMLInputElement)) {
    return;
  }

  const captureId = event.target.getAttribute("data-capture-id");

  if (!captureId) {
    return;
  }

  await updateCaptureTitle(captureId, event.target.value);
}

async function resetRun() {
  const confirmed = window.confirm(
    "Start a new run? This clears the current draft, step list, and cached images inside the extension. Files already exported on disk will stay there."
  );

  if (!confirmed) {
    return;
  }

  const deletions = state.captures.map((capture) => deleteCaptureData(capture.id));
  await Promise.allSettled(deletions);

  elements.documentTitleInput.value = "";
  elements.narrationInput.value = "";
  state.runFolderSlug = "";
  state.captures = [];

  const endPosition = elements.narrationInput.value.length;
  setLastNarrationSelection({ start: endPosition, end: endPosition });

  await saveSettings();
  refreshRunFolderHint();
  refreshCaptureList();
  renderPreview();
  refreshActionAvailability();

  elements.lastExport.textContent = "Nothing exported yet.";
  setStatus("Run reset. You can rename the run folder before the next capture.", "success");
}
