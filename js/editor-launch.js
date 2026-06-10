import { elements, state } from "./state.js";
import {
  deleteCaptureData,
  getCaptureAsset,
  putEditorSession,
  storeCaptureAsset
} from "./db.js";
import { cloneRects, dataUrlToBlob } from "./image-utils.js";
import { getCaptureAssetBlob } from "./export.js";
import { escapeHtml } from "./markdown.js";
import {
  ensureRunFolderSlug,
  getCaptureById,
  insertCaptureReference,
  refreshActionAvailability,
  refreshRunFolderHint,
  renderPreview,
  saveSettings,
  setBusy,
  setStatus
} from "./ui.js";
import { refreshCaptureList, syncCaptureOrdering } from "./steps-ui.js";

const PENDING_EDITOR_SESSIONS_KEY = "pendingEditorSessions";
const PENDING_EDITOR_RESULTS_KEY = "pendingEditorResults";
const PENDING_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function readPendingSessions() {
  const stored = await chrome.storage.local.get({ [PENDING_EDITOR_SESSIONS_KEY]: {} });
  const pendingSessions = stored[PENDING_EDITOR_SESSIONS_KEY];
  return pendingSessions && typeof pendingSessions === "object" ? { ...pendingSessions } : {};
}

async function writePendingSessions(pendingSessions) {
  await chrome.storage.local.set({ [PENDING_EDITOR_SESSIONS_KEY]: pendingSessions });
}

async function addPendingSession(sessionId, entry) {
  const pendingSessions = await readPendingSessions();
  pendingSessions[sessionId] = entry;
  await writePendingSessions(pendingSessions);
}

async function removePendingSession(sessionId) {
  if (!sessionId) {
    return;
  }

  const pendingSessions = await readPendingSessions();

  if (!(sessionId in pendingSessions)) {
    return;
  }

  delete pendingSessions[sessionId];
  await writePendingSessions(pendingSessions);
}

async function launchEditorTab({ mode, runFolderSlug, captureMeta }) {
  const sessionId = crypto.randomUUID();
  const createdAt = Date.now();

  await addPendingSession(sessionId, {
    captureId: captureMeta.id,
    mode,
    runFolderSlug,
    captureMeta,
    createdAt
  });

  await putEditorSession({
    sessionId,
    captureId: captureMeta.id,
    mode,
    runFolderSlug,
    captureMeta,
    createdAt
  });

  await chrome.tabs.create({
    url: chrome.runtime.getURL(`editor.html?sessionId=${sessionId}`)
  });

  return sessionId;
}

export async function openEditorTabForNewCapture(session) {
  const screenshotBlob = await dataUrlToBlob(session.screenshotDataUrl);
  await storeCaptureAsset(session.captureMeta.id, screenshotBlob);

  await launchEditorTab({
    mode: "new",
    runFolderSlug: session.runFolderSlug,
    captureMeta: {
      ...session.captureMeta,
      sensitiveRects: cloneRects(session.captureMeta.sensitiveRects)
    }
  });
}

export async function openEditorTabForCapture(captureId) {
  const capture = getCaptureById(captureId);

  if (!capture) {
    return;
  }

  setBusy(true);
  setStatus("Opening the saved image in the editor tab...");

  try {
    let assetBlob = await getCaptureAsset(capture.id);

    if (!assetBlob) {
      assetBlob = await getCaptureAssetBlob(capture);

      if (!assetBlob) {
        throw new Error(
          "This saved step image is not available inside the extension anymore. Re-capture it or reselect the export folder that contains it."
        );
      }

      await storeCaptureAsset(capture.id, assetBlob);
    }

    const runFolderSlug = capture.runFolderSlug || state.runFolderSlug || await ensureRunFolderSlug();

    await launchEditorTab({
      mode: "existing",
      runFolderSlug,
      captureMeta: {
        ...capture,
        sensitiveRects: cloneRects(capture.sensitiveRects)
      }
    });

    setStatus(`Step ${capture.indexLabel} is open in the editor tab. Save there to update this run.`, "success");
  } catch (error) {
    console.error("Unable to open an existing capture in the editor tab.", error);
    setStatus(error.message || "Unable to open this step in the editor.", "warn");
  } finally {
    setBusy(false);
  }
}

export async function handleEditorResultMessage(message) {
  try {
    await processEditorResult(message);
  } catch (error) {
    console.error("Unable to process the editor result.", error);
    setStatus(error.message || "Unable to apply the editor result.", "warn");
  }

  await removePendingResultRecords(message?.sessionId);
}

export async function processPendingEditorWork() {
  const stored = await chrome.storage.session.get({ [PENDING_EDITOR_RESULTS_KEY]: [] });
  const results = Array.isArray(stored[PENDING_EDITOR_RESULTS_KEY]) ? stored[PENDING_EDITOR_RESULTS_KEY] : [];

  if (results.length > 0) {
    await chrome.storage.session.remove(PENDING_EDITOR_RESULTS_KEY);

    for (const result of results) {
      try {
        await processEditorResult(result);
      } catch (error) {
        console.error("Unable to process a stored editor result.", error);
      }
    }
  }

  await prunePendingSessions();
}

async function processEditorResult(result) {
  const sessionId = String(result?.sessionId || "");
  const pendingSessions = await readPendingSessions();
  const pendingEntry = sessionId ? pendingSessions[sessionId] || null : null;
  const mode = result?.mode || pendingEntry?.mode || "new";
  const captureId = result?.captureId || pendingEntry?.captureId || "";

  if (result?.type === "editor-cancelled") {
    if (mode === "new" && captureId && !getCaptureById(captureId)) {
      await deleteCaptureData(captureId);
    }

    await removePendingSession(sessionId);
    setStatus(
      mode === "new"
        ? "Editor closed without saving. The pending capture was discarded."
        : "Editor closed without saving changes to that step.",
      "warn"
    );
    return;
  }

  if (result?.type !== "editor-saved") {
    return;
  }

  if (mode === "existing") {
    await applySavedResultToExistingCapture(result, pendingEntry, captureId);
  } else {
    await applySavedResultToNewCapture(result, pendingEntry, captureId);
  }

  await removePendingSession(sessionId);
}

async function applySavedResultToNewCapture(result, pendingEntry, captureId) {
  if (captureId && getCaptureById(captureId)) {
    return;
  }

  const captureMeta = pendingEntry?.captureMeta;

  if (!captureMeta) {
    setStatus("The editor saved an image, but the matching capture session was no longer available.", "warn");
    return;
  }

  const newCapture = {
    ...captureMeta,
    edited: true,
    assetWidth: Number(result.width) || Number(captureMeta.assetWidth) || 0,
    assetHeight: Number(result.height) || Number(captureMeta.assetHeight) || 0
  };

  state.captures.push(newCapture);
  syncCaptureOrdering({ updateNarration: false });

  const currentCapture = getCaptureById(newCapture.id) || newCapture;
  insertCaptureReference(currentCapture);

  await saveSettings();
  refreshCaptureList();
  renderPreview();
  refreshRunFolderHint();
  refreshActionAvailability();

  elements.lastExport.innerHTML = [
    `<strong>Screenshot</strong>: ${escapeHtml(currentCapture.relativeImagePath)} (cached in extension)`,
    `<strong>Storage</strong>: In-memory until you save or export the run`
  ].join("<br>");

  setStatus(`Edited step ${currentCapture.indexLabel} saved and inserted into the narration.`, "success");
}

async function applySavedResultToExistingCapture(result, pendingEntry, captureId) {
  const existingCapture = getCaptureById(captureId);

  if (!existingCapture) {
    setStatus("The editor saved an image for a step that is no longer part of this run.", "warn");
    return;
  }

  existingCapture.edited = true;
  existingCapture.assetWidth = Number(result.width) || existingCapture.assetWidth;
  existingCapture.assetHeight = Number(result.height) || existingCapture.assetHeight;

  await saveSettings();
  refreshCaptureList();
  renderPreview();
  refreshActionAvailability();

  elements.lastExport.innerHTML = [
    `<strong>Screenshot</strong>: ${escapeHtml(existingCapture.relativeImagePath)} (cached in extension)`,
    `<strong>Updated step</strong>: ${escapeHtml(existingCapture.indexLabel)}`
  ].join("<br>");

  setStatus(`Updated the image for step ${existingCapture.indexLabel}.`, "success");
}

async function removePendingResultRecords(sessionId) {
  if (!sessionId) {
    return;
  }

  try {
    const stored = await chrome.storage.session.get({ [PENDING_EDITOR_RESULTS_KEY]: [] });
    const results = Array.isArray(stored[PENDING_EDITOR_RESULTS_KEY]) ? stored[PENDING_EDITOR_RESULTS_KEY] : [];
    const remaining = results.filter((entry) => entry?.sessionId !== sessionId);

    if (remaining.length !== results.length) {
      await chrome.storage.session.set({ [PENDING_EDITOR_RESULTS_KEY]: remaining });
    }
  } catch (error) {
    console.warn("Unable to prune stored editor results.", error);
  }
}

async function prunePendingSessions() {
  const pendingSessions = await readPendingSessions();
  const now = Date.now();
  let changed = false;

  for (const [sessionId, entry] of Object.entries(pendingSessions)) {
    const createdAt = Number(entry?.createdAt) || 0;

    if (createdAt && now - createdAt < PENDING_SESSION_MAX_AGE_MS) {
      continue;
    }

    if (entry?.mode === "new" && entry?.captureId && !getCaptureById(entry.captureId)) {
      try {
        await deleteCaptureData(entry.captureId);
      } catch (error) {
        console.warn("Unable to delete orphaned capture data for an expired editor session.", error);
      }
    }

    delete pendingSessions[sessionId];
    changed = true;
  }

  if (changed) {
    await writePendingSessions(pendingSessions);
  }
}
