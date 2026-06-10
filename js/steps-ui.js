import { CAPTURE_MODE_LABELS, DEFAULT_SETTINGS, normalizeCaptureMode } from "./constants.js";
import { elements, state, setLastNarrationSelection } from "./state.js";
import { deleteCaptureData, getCaptureAsset } from "./db.js";
import {
  buildCaptureFileName,
  buildCaptureMarkdown,
  deriveSuggestedTitle,
  escapeHtml,
  escapeHtmlAttribute,
  formatTimestamp,
  normalizeInlineText,
  removeCaptureReferenceFromNarration,
  replaceCaptureReferenceInNarration,
  safeHostname,
  slugify,
  startCaseFromSlug
} from "./markdown.js";
import {
  getCaptureById,
  insertCaptureReference,
  refreshActionAvailability,
  renderPreview,
  saveSettings,
  setStatus,
  updateNarrationSelection
} from "./ui.js";

const thumbnailObjectUrls = new Map();
let thumbnailRefreshToken = 0;
let captureListDndBound = false;
let dragCaptureId = null;
let dropInsertIndex = -1;

export function refreshCaptureList() {
  ensureCaptureListDnd();

  if (state.captures.length === 0) {
    releaseAllThumbnailUrls();
    elements.captureList.innerHTML = '<p class="small subtle">No captured steps yet.</p>';
    refreshActionAvailability();
    return;
  }

  elements.captureList.innerHTML = state.captures
    .map((capture, index) => {
      const host = safeHostname(capture.pageUrl);
      const editedLabel = capture.edited ? " • edited" : "";
      const suggestionLabel =
        capture.suggestedTitle && capture.suggestedTitle !== capture.title
          ? `Suggested title: ${capture.suggestedTitle}`
          : "Suggested title already in use.";
      const modeLabel = CAPTURE_MODE_LABELS[capture.captureMode] || "Visible area";
      const cachedThumbUrl = thumbnailObjectUrls.get(capture.id) || "";

      return [
        `<article class="capture-item" data-capture-id="${escapeHtmlAttribute(capture.id)}" draggable="false">`,
        '<div class="capture-body">',
        `<img class="capture-thumb" data-thumb-for="${escapeHtmlAttribute(capture.id)}" data-step-action="edit" data-capture-id="${escapeHtmlAttribute(
          capture.id
        )}" alt="" draggable="false" title="Open this step in the image editor"${
          cachedThumbUrl ? ` src="${escapeHtmlAttribute(cachedThumbUrl)}"` : " hidden"
        }>`,
        '<div class="capture-content">',
        '<div class="capture-toprow">',
        '<div class="capture-title-group">',
        '<span class="capture-drag-handle" data-drag-handle="true" title="Drag to reorder" aria-hidden="true">⠿</span>',
        `<p class="capture-title">Step ${escapeHtml(capture.indexLabel)}</p>`,
        "</div>",
        `<span class="badge badge-muted">${escapeHtml(modeLabel)}</span>`,
        "</div>",
        `<label class="field compact-field"><span>Step Title</span><input data-capture-id="${escapeHtmlAttribute(
          capture.id
        )}" data-capture-title-input="true" value="${escapeHtmlAttribute(capture.title)}"></label>`,
        "</div>",
        "</div>",
        `<p class="capture-path">${escapeHtml(capture.relativeImagePath)}</p>`,
        `<p class="capture-meta small subtle">${escapeHtml(host)} • ${escapeHtml(formatTimestamp(capture.capturedAt))}${escapeHtml(
          editedLabel
        )}</p>`,
        `<p class="capture-suggestion small subtle">${escapeHtml(suggestionLabel)}</p>`,
        '<div class="button-row step-actions">',
        `<button class="button button-secondary" type="button" data-step-action="move-up" data-capture-id="${escapeHtmlAttribute(
          capture.id
        )}"${index === 0 ? " disabled" : ""}>Move Up</button>`,
        `<button class="button button-secondary" type="button" data-step-action="move-down" data-capture-id="${escapeHtmlAttribute(
          capture.id
        )}"${index === state.captures.length - 1 ? " disabled" : ""}>Move Down</button>`,
        `<button class="button button-secondary" type="button" data-step-action="edit" data-capture-id="${escapeHtmlAttribute(
          capture.id
        )}">Edit Image</button>`,
        `<button class="button button-secondary" type="button" data-step-action="reinsert" data-capture-id="${escapeHtmlAttribute(
          capture.id
        )}">Reinsert</button>`,
        `<button class="button button-secondary" type="button" data-step-action="use-suggestion" data-capture-id="${escapeHtmlAttribute(
          capture.id
        )}">Use Suggestion</button>`,
        `<button class="button button-ghost" type="button" data-step-action="delete" data-capture-id="${escapeHtmlAttribute(
          capture.id
        )}">Delete</button>`,
        "</div>",
        "</article>"
      ].join("");
    })
    .join("");

  bindCaptureItemDragHandlers();
  void hydrateCaptureThumbnails();
  refreshActionAvailability();
}

function releaseAllThumbnailUrls() {
  thumbnailRefreshToken += 1;
  thumbnailObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  thumbnailObjectUrls.clear();
}

async function hydrateCaptureThumbnails() {
  const token = ++thumbnailRefreshToken;
  const liveCaptureIds = new Set(state.captures.map((capture) => capture.id));

  thumbnailObjectUrls.forEach((url, captureId) => {
    if (!liveCaptureIds.has(captureId)) {
      URL.revokeObjectURL(url);
      thumbnailObjectUrls.delete(captureId);
    }
  });

  for (const capture of state.captures) {
    const blob = await getCaptureAsset(capture.id);

    if (token !== thumbnailRefreshToken) {
      return;
    }

    const image = elements.captureList.querySelector(`img[data-thumb-for="${CSS.escape(capture.id)}"]`);
    const previousUrl = thumbnailObjectUrls.get(capture.id) || "";

    if (!blob) {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
        thumbnailObjectUrls.delete(capture.id);
      }

      if (image) {
        image.removeAttribute("src");
        image.hidden = true;
      }

      continue;
    }

    const nextUrl = URL.createObjectURL(blob);
    thumbnailObjectUrls.set(capture.id, nextUrl);

    if (image) {
      image.src = nextUrl;
      image.hidden = false;
    }

    if (previousUrl && previousUrl !== nextUrl) {
      URL.revokeObjectURL(previousUrl);
    }
  }
}

function ensureCaptureListDnd() {
  if (captureListDndBound || !elements.captureList) {
    return;
  }

  captureListDndBound = true;

  elements.captureList.addEventListener("dragover", (event) => {
    if (!dragCaptureId || state.busy) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    updateDropIndicator(event.clientY);
  });

  elements.captureList.addEventListener("drop", (event) => {
    if (!dragCaptureId || state.busy) {
      return;
    }

    event.preventDefault();

    const captureId = dragCaptureId;
    const insertIndex = computeDropInsertIndex(event.clientY);

    dragCaptureId = null;
    clearDropIndicators();
    void completeCaptureDrop(captureId, insertIndex);
  });

  elements.captureList.addEventListener("dragleave", (event) => {
    const nextTarget = event.relatedTarget;

    if (!nextTarget || !(nextTarget instanceof Node) || !elements.captureList.contains(nextTarget)) {
      clearDropIndicators();
    }
  });
}

function bindCaptureItemDragHandlers() {
  elements.captureList.querySelectorAll(".capture-item").forEach((item) => {
    const handle = item.querySelector("[data-drag-handle]");

    if (handle) {
      handle.addEventListener("pointerdown", () => {
        if (state.busy) {
          return;
        }

        item.setAttribute("draggable", "true");
        window.addEventListener(
          "pointerup",
          () => {
            item.setAttribute("draggable", "false");
          },
          { once: true }
        );
      });
    }

    item.addEventListener("dragstart", (event) => {
      if (item.getAttribute("draggable") !== "true") {
        return;
      }

      if (state.busy) {
        event.preventDefault();
        return;
      }

      dragCaptureId = item.getAttribute("data-capture-id");
      item.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", dragCaptureId);
    });

    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      item.setAttribute("draggable", "false");
      dragCaptureId = null;
      clearDropIndicators();
    });
  });
}

function computeDropInsertIndex(clientY) {
  const items = Array.from(elements.captureList.querySelectorAll(".capture-item"));

  for (let index = 0; index < items.length; index += 1) {
    const rect = items[index].getBoundingClientRect();

    if (clientY < rect.top + rect.height / 2) {
      return index;
    }
  }

  return items.length;
}

function updateDropIndicator(clientY) {
  const insertIndex = computeDropInsertIndex(clientY);

  if (insertIndex === dropInsertIndex) {
    return;
  }

  dropInsertIndex = insertIndex;

  const items = Array.from(elements.captureList.querySelectorAll(".capture-item"));

  items.forEach((item) => item.classList.remove("drop-before", "drop-after"));

  const fromIndex = state.captures.findIndex((capture) => capture.id === dragCaptureId);

  if (fromIndex !== -1 && (insertIndex === fromIndex || insertIndex === fromIndex + 1)) {
    return;
  }

  if (insertIndex < items.length) {
    items[insertIndex].classList.add("drop-before");
  } else if (items.length > 0) {
    items[items.length - 1].classList.add("drop-after");
  }
}

function clearDropIndicators() {
  dropInsertIndex = -1;
  elements.captureList.querySelectorAll(".drop-before, .drop-after").forEach((item) => {
    item.classList.remove("drop-before", "drop-after");
  });
}

async function completeCaptureDrop(captureId, insertIndex) {
  const fromIndex = state.captures.findIndex((capture) => capture.id === captureId);

  if (fromIndex === -1) {
    return;
  }

  const boundedInsertIndex = Math.max(0, Math.min(insertIndex, state.captures.length));
  const toIndex = boundedInsertIndex > fromIndex ? boundedInsertIndex - 1 : boundedInsertIndex;

  if (toIndex === fromIndex) {
    return;
  }

  await applyCaptureReorder(captureId, fromIndex, toIndex);
}

export function syncCaptureOrdering({ updateNarration = true } = {}) {
  const previousReferences = state.captures.map((capture) => ({
    id: capture.id,
    relativeImagePath: capture.relativeImagePath,
    previousMarkdown: buildCaptureMarkdown(capture)
  }));

  state.captures = state.captures.map((capture, index) => {
    const captureNumber = index + 1;
    const suggestedTitle = normalizeInlineText(
      capture.suggestedTitle || deriveSuggestedTitle({ ...capture.pageContext, title: capture.pageTitle, url: capture.pageUrl }, captureNumber)
    );
    const title = normalizeInlineText(capture.title || suggestedTitle || `Screen ${String(captureNumber).padStart(3, "0")}`);
    const fileName = capture.fileName || buildCaptureFileName(title, capture.id);

    return {
      ...capture,
      captureNumber,
      indexLabel: String(captureNumber).padStart(3, "0"),
      title,
      suggestedTitle,
      fileName,
      relativeImagePath: capture.relativeImagePath || `screenshots/${fileName}`,
      captureMode: normalizeCaptureMode(capture.captureMode),
      runFolderSlug: capture.runFolderSlug || state.runFolderSlug || slugify(elements.runNameInput.value) || DEFAULT_SETTINGS.runName
    };
  });

  if (!updateNarration) {
    return;
  }

  let nextNarration = elements.narrationInput.value;

  previousReferences.forEach((reference) => {
    const capture = getCaptureById(reference.id);

    if (!capture) {
      nextNarration = removeCaptureReferenceFromNarration(nextNarration, reference.relativeImagePath);
      return;
    }

    nextNarration = replaceCaptureReferenceInNarration(
      nextNarration,
      reference.relativeImagePath,
      buildCaptureMarkdown(capture)
    );
  });

  if (nextNarration !== elements.narrationInput.value) {
    elements.narrationInput.value = nextNarration;
    updateNarrationSelection();
  }
}

async function applyCaptureReorder(captureId, fromIndex, toIndex) {
  const captures = [...state.captures];
  const [movedCapture] = captures.splice(fromIndex, 1);
  captures.splice(toIndex, 0, movedCapture);
  state.captures = captures;

  syncCaptureOrdering({ updateNarration: true });
  await saveSettings();
  refreshCaptureList();
  renderPreview();

  const refreshedCapture = getCaptureById(captureId);
  setStatus(`Moved ${refreshedCapture?.title || "the step"} to position ${refreshedCapture?.indexLabel || "?"}.`, "success");
}

export async function moveCapture(captureId, delta) {
  const index = state.captures.findIndex((capture) => capture.id === captureId);

  if (index === -1) {
    return;
  }

  const nextIndex = index + delta;

  if (nextIndex < 0 || nextIndex >= state.captures.length) {
    return;
  }

  await applyCaptureReorder(captureId, index, nextIndex);
}

export async function reinsertCapture(captureId) {
  const capture = getCaptureById(captureId);

  if (!capture) {
    return;
  }

  insertCaptureReference(capture);
  await saveSettings();
  renderPreview();
  setStatus(`Inserted step ${capture.indexLabel} at the current cursor position.`, "success");
}

export async function useSuggestedTitle(captureId) {
  const capture = getCaptureById(captureId);

  if (!capture) {
    return;
  }

  const nextTitle = normalizeInlineText(capture.suggestedTitle || deriveSuggestedTitle(capture, capture.captureNumber));

  if (!nextTitle || nextTitle === capture.title) {
    setStatus("The suggested title already matches this step.", "warn");
    return;
  }

  await updateCaptureTitle(captureId, nextTitle);
}

export async function updateCaptureTitle(captureId, rawTitle) {
  const capture = getCaptureById(captureId);

  if (!capture) {
    return;
  }

  const nextTitle = normalizeInlineText(rawTitle) || capture.suggestedTitle || capture.title;

  if (nextTitle === capture.title) {
    refreshCaptureList();
    return;
  }

  capture.title = nextTitle;
  syncCaptureOrdering({ updateNarration: true });
  await saveSettings();
  refreshCaptureList();
  renderPreview();
  setStatus(`Updated the title for step ${capture.indexLabel}.`, "success");
}

export async function deleteCapture(captureId) {
  const capture = getCaptureById(captureId);

  if (!capture) {
    return;
  }

  const confirmed = window.confirm(
    `Delete step ${capture.indexLabel}?\n\nThis removes the screenshot reference from the narration and deletes the cached image inside the extension.`
  );

  if (!confirmed) {
    return;
  }

  elements.narrationInput.value = removeCaptureReferenceFromNarration(elements.narrationInput.value, capture.relativeImagePath);
  state.captures = state.captures.filter((item) => item.id !== captureId);
  await deleteCaptureData(captureId);

  syncCaptureOrdering({ updateNarration: true });
  await saveSettings();
  refreshCaptureList();
  renderPreview();
  setStatus(`Deleted step ${capture.indexLabel}.`, "success");
}

export async function applySuggestedTitlesToAll() {
  if (state.captures.length === 0) {
    setStatus("Capture a few steps first, then I can suggest titles for them.", "warn");
    return;
  }

  let updatedCount = 0;

  state.captures.forEach((capture) => {
    const nextTitle = normalizeInlineText(
      deriveSuggestedTitle({ ...capture.pageContext, title: capture.pageTitle, url: capture.pageUrl }, capture.captureNumber)
    );
    capture.suggestedTitle = nextTitle;

    if (nextTitle && nextTitle !== capture.title) {
      capture.title = nextTitle;
      updatedCount += 1;
    }
  });

  syncCaptureOrdering({ updateNarration: true });
  await saveSettings();
  refreshCaptureList();
  renderPreview();

  if (updatedCount === 0) {
    setStatus("The current step titles already match the latest suggestions.", "warn");
    return;
  }

  setStatus(`Updated ${updatedCount} step title${updatedCount === 1 ? "" : "s"} from page context.`, "success");
}

export async function draftNarrationFromSteps() {
  if (state.captures.length === 0) {
    setStatus("Capture at least one step before drafting narration.", "warn");
    return;
  }

  const existingNarration = elements.narrationInput.value.trim();

  if (
    existingNarration &&
    !window.confirm("Replace the current narration with a fresh draft built from the step sequence?")
  ) {
    return;
  }

  if (!elements.documentTitleInput.value.trim()) {
    elements.documentTitleInput.value = startCaseFromSlug(state.runFolderSlug || elements.runNameInput.value || "training-run");
  }

  elements.narrationInput.value = state.captures
    .map((capture, index) => {
      const heading = `## Step ${index + 1}: ${capture.title}`;
      const instruction = buildStepNarration(capture, index);
      const image = buildCaptureMarkdown(capture);
      return [heading, instruction, image].join("\n\n");
    })
    .join("\n\n");

  const endPosition = elements.narrationInput.value.length;
  setLastNarrationSelection({ start: endPosition, end: endPosition });
  elements.narrationInput.selectionStart = endPosition;
  elements.narrationInput.selectionEnd = endPosition;

  renderPreview();
  await saveSettings();
  refreshActionAvailability();
  setStatus("Drafted narration from the current step sequence.", "success");
}

function buildStepNarration(capture, index) {
  const contextLabel = normalizeInlineText(
    capture.pageContext?.mainHeading || capture.pageTitle || capture.title || `step ${index + 1}`
  );
  const primaryAction = normalizeInlineText((capture.pageContext?.actions || [])[0] || "");

  if (index === 0) {
    return `Open **${contextLabel}** and confirm you are starting from the expected screen.`;
  }

  if (primaryAction && !capture.title.toLowerCase().includes(primaryAction.toLowerCase())) {
    return `Use **${primaryAction}** on **${contextLabel}** to move to this step.`;
  }

  if (/create|add|new|invite|upload|submit/i.test(capture.title)) {
    return `Complete the required action on **${contextLabel}** and continue when the page finishes updating.`;
  }

  if (/review|details|summary|dashboard|overview|settings|results/i.test(capture.title)) {
    return `Review the information on **${contextLabel}** before moving to the next step.`;
  }

  return `Continue to **${contextLabel}** and follow the on-screen prompts for this step.`;
}
