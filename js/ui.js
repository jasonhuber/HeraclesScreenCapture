import { DEFAULT_SETTINGS } from "./constants.js";
import { elements, state, lastNarrationSelection, setLastNarrationSelection } from "./state.js";
import { buildCaptureMarkdown, renderMarkdownDocument, slugify } from "./markdown.js";

export function setStatus(message, tone = "info") {
  elements.statusText.textContent = message;
  elements.statusText.className = "status";

  if (tone === "warn") {
    elements.statusText.classList.add("warn");
  }

  if (tone === "success") {
    elements.statusText.classList.add("success");
  }
}

export function setBusy(isBusy) {
  state.busy = isBusy;

  [
    elements.selectFolderButton,
    elements.clearFolderButton,
    elements.captureButton,
    elements.captureEditButton,
    elements.suggestTitlesButton,
    elements.draftNarrationButton,
    elements.saveMarkdownButton,
    elements.exportPackageButton,
    elements.saveStandaloneHtmlButton,
    elements.exportScormButton,
    elements.autoCaptureToggleButton,
    elements.resetRunButton
  ].forEach((element) => {
    element.disabled = isBusy;
  });

  refreshActionAvailability();
}

export function refreshActionAvailability() {
  const hasCaptures = state.captures.length > 0;
  const hasNarration = elements.narrationInput.value.trim().length > 0;

  elements.suggestTitlesButton.disabled = state.busy || !hasCaptures;
  elements.draftNarrationButton.disabled = state.busy || !hasCaptures;
  elements.exportPackageButton.disabled = state.busy || (!hasCaptures && !hasNarration);
  elements.saveStandaloneHtmlButton.disabled = state.busy || (!hasCaptures && !hasNarration);
  elements.exportScormButton.disabled = state.busy || (!hasCaptures && !hasNarration);
}

export function renderPreview() {
  elements.previewOutput.value = renderMarkdownDocument();
}

export function refreshRunFolderHint() {
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

export function updateNarrationSelection() {
  setLastNarrationSelection({
    start: elements.narrationInput.selectionStart ?? elements.narrationInput.value.length,
    end: elements.narrationInput.selectionEnd ?? elements.narrationInput.value.length
  });
}

export function insertCaptureReference(captureMeta) {
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

  setLastNarrationSelection({ start: newCursorPosition, end: newCursorPosition });
}

function clampSelection(value, max) {
  if (!Number.isFinite(value)) {
    return max;
  }

  return Math.max(0, Math.min(value, max));
}

export function getCaptureById(captureId) {
  return state.captures.find((capture) => capture.id === captureId) || null;
}

export async function saveSettings() {
  await chrome.storage.local.set(collectStoragePayload());
}

function collectStoragePayload() {
  return {
    runName: elements.runNameInput.value.trim() || DEFAULT_SETTINGS.runName,
    documentTitle: elements.documentTitleInput.value.trim(),
    narrationText: elements.narrationInput.value,
    runFolderSlug: state.runFolderSlug,
    captureMode: state.captureMode,
    captures: state.captures
  };
}

export async function ensureRunFolderSlug() {
  if (state.runFolderSlug) {
    return state.runFolderSlug;
  }

  state.runFolderSlug = slugify(elements.runNameInput.value) || DEFAULT_SETTINGS.runName;
  await saveSettings();
  return state.runFolderSlug;
}
