import { elements, state, setLastNarrationSelection } from "./state.js";
import {
  buildCaptureMeta,
  captureVisibleTab,
  getActiveTab,
  validateActiveTab
} from "./capture.js";
import { storeCaptureAnnotations, storeCaptureAsset, storeCaptureOriginal } from "./db.js";
import { prepareDictatedChunk, startRoutedDictation, stopRoutedDictation } from "./dictation.js";
import {
  canvasToBlob,
  clampNumber,
  dataUrlToCanvas,
  downscaleCanvas,
  encodeCanvasBlob
} from "./image-utils.js";
import {
  formatToExtension,
  getImageFormat,
  getImageQuality,
  getMaxCaptureWidth
} from "./settings.js";
import { buildAutoInstruction, buildCaptureFileName, buildCaptureMarkdown, normalizeInlineText } from "./markdown.js";
import {
  ensureRunFolderSlug,
  getCaptureById,
  refreshActionAvailability,
  refreshRunFolderHint,
  renderPreview,
  saveSettings,
  setStatus
} from "./ui.js";
import { refreshCaptureList, syncCaptureOrdering } from "./steps-ui.js";

const AUTO_CLICK_MESSAGE_TYPE = "heracles-auto-click";
const MAX_PENDING_CLICKS = 3;
const BADGE_COLOR = "#d97706";

const autoState = {
  recording: false,
  recordedTabId: null,
  pendingClicks: 0,
  droppedClicks: 0,
  queueTail: Promise.resolve(),
  lastStepLabel: "",
  lastError: ""
};

let toggleButton = null;
let badgeElement = null;
let statusLineElement = null;
let voiceCheckbox = null;

const recordState = {
  currentStep: null
};

export function initAutoCapture() {
  toggleButton = document.getElementById("autoCaptureToggleButton");
  badgeElement = document.getElementById("autoCaptureBadge");
  statusLineElement = document.getElementById("autoCaptureStatus");
  voiceCheckbox = document.getElementById("autoCaptureVoiceCheckbox");

  if (voiceCheckbox) {
    void chrome.storage.local.get({ autoCaptureVoice: true }).then((stored) => {
      voiceCheckbox.checked = Boolean(stored.autoCaptureVoice);
    });

    voiceCheckbox.addEventListener("change", () => {
      void chrome.storage.local.set({ autoCaptureVoice: voiceCheckbox.checked });
    });
  }

  if (!toggleButton || !badgeElement || !statusLineElement) {
    console.warn("Auto-capture UI elements are missing; auto-step capture is unavailable.");
    return;
  }

  toggleButton.addEventListener("click", () => {
    if (state.busy) {
      return;
    }

    if (autoState.recording) {
      void stopAutoCapture("Auto-capture stopped.");
    } else {
      void startAutoCapture();
    }
  });

  chrome.runtime.onMessage.addListener(handleAutoClickMessage);

  updateAutoCaptureUi();
}

async function startAutoCapture() {
  if (autoState.recording || state.busy) {
    return;
  }

  try {
    const tab = await getActiveTab();
    validateActiveTab(tab);
    await injectClickListener(tab.id);

    autoState.recording = true;
    autoState.recordedTabId = tab.id;
    autoState.pendingClicks = 0;
    autoState.droppedClicks = 0;
    autoState.lastStepLabel = "";
    autoState.lastError = "";
    recordState.currentStep = null;

    chrome.tabs.onUpdated.addListener(handleRecordedTabUpdated);
    chrome.tabs.onRemoved.addListener(handleRecordedTabRemoved);

    updateAutoCaptureUi();

    if (voiceCheckbox?.checked) {
      setStatus("Auto-capture recording with voice. Click through the app and narrate out loud.", "success");
      await startRoutedDictation(handleRoutedSpeech);
    } else {
      setStatus("Auto-capture recording. Every click in the page becomes a documented step.", "success");
    }
  } catch (error) {
    console.error("Unable to start auto-capture.", error);
    setStatus(error.message || "Unable to start auto-capture on this tab.", "warn");
  }
}

async function stopAutoCapture(statusMessage) {
  if (!autoState.recording) {
    return;
  }

  autoState.recording = false;
  const tabId = autoState.recordedTabId;
  autoState.recordedTabId = null;
  recordState.currentStep = null;

  chrome.tabs.onUpdated.removeListener(handleRecordedTabUpdated);
  chrome.tabs.onRemoved.removeListener(handleRecordedTabRemoved);

  await stopRoutedDictation();

  if (typeof tabId === "number") {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: autoCaptureStopInPage
      });
    } catch (error) {
      console.warn("Could not disable the in-page auto-capture listener (the tab may be gone).", error);
    }
  }

  updateAutoCaptureUi();
  setStatus(statusMessage || "Auto-capture stopped.");
}

async function injectClickListener(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: autoCaptureStartInPage
  });
}

function handleRecordedTabUpdated(tabId, changeInfo, tab) {
  if (!autoState.recording || tabId !== autoState.recordedTabId || changeInfo.status !== "complete") {
    return;
  }

  if (!/^https?:/i.test(tab?.url || "")) {
    return;
  }

  injectClickListener(tabId).catch((error) => {
    console.warn("Unable to re-arm the auto-capture listener after navigation.", error);
    autoState.lastError = "Could not re-attach the click listener after navigation.";
    updateAutoCaptureUi();
  });
}

function handleRecordedTabRemoved(tabId) {
  if (!autoState.recording || tabId !== autoState.recordedTabId) {
    return;
  }

  autoState.recordedTabId = null;
  void stopAutoCapture("Auto-capture stopped: the recorded tab was closed.");
}

function handleAutoClickMessage(message, sender) {
  if (message?.type !== AUTO_CLICK_MESSAGE_TYPE) {
    return undefined;
  }

  if (!autoState.recording || sender.tab?.id !== autoState.recordedTabId) {
    return undefined;
  }

  enqueueAutoClick(message.payload || {});
  return undefined;
}

function enqueueAutoClick(payload) {
  if (autoState.pendingClicks >= MAX_PENDING_CLICKS) {
    autoState.droppedClicks += 1;
    updateAutoCaptureUi();
    return;
  }

  autoState.pendingClicks += 1;
  autoState.queueTail = autoState.queueTail
    .then(() => processAutoClick(payload))
    .catch((error) => {
      console.error("Auto-capture step failed.", error);
      autoState.lastError = error?.message || "Auto-capture step failed.";
      updateAutoCaptureUi();
    })
    .finally(() => {
      autoState.pendingClicks = Math.max(0, autoState.pendingClicks - 1);
    });
}

async function processAutoClick(payload) {
  if (!autoState.recording) {
    return;
  }

  let tab = null;

  try {
    tab = await chrome.tabs.get(autoState.recordedTabId);
  } catch (error) {
    await stopAutoCapture("Auto-capture stopped: the recorded tab is gone.");
    return;
  }

  if (!tab.active) {
    autoState.lastError = "Skipped a click: the recorded tab was no longer in front.";
    updateAutoCaptureUi();
    return;
  }

  const runFolderSlug = await ensureRunFolderSlug();
  const rawDataUrl = await captureVisibleTab(tab.windowId);
  // Downscale once, up front, so the badge/box, the stored original, the
  // annotations, and the encoded asset all live in one (final) coordinate space.
  const nativeCanvas = await dataUrlToCanvas(rawDataUrl);
  const baseCanvas = downscaleCanvas(nativeCanvas, getMaxCaptureWidth());
  const stepNumber = state.captures.length + 1;
  const marker = drawClickMarkers(baseCanvas, payload, stepNumber);

  const pageContext = {
    title: tab.title || "",
    url: tab.url || "",
    mainHeading: "",
    headings: [],
    actions: [],
    sensitiveRects: []
  };

  const captureMeta = buildCaptureMeta({
    activeTab: tab,
    pageContext,
    runFolderSlug,
    captureMode: "visible",
    sensitiveRects: [],
    assetWidth: marker.canvas.width,
    assetHeight: marker.canvas.height
  });

  const label = normalizeInlineText(payload.label || "");
  const roleLabel = normalizeInlineText(payload.elementRole || "");
  captureMeta.title = label
    ? `Click "${label}"`
    : roleLabel
      ? `Click ${roleLabel}`
      : "Click the highlighted area";
  captureMeta.suggestedTitle = captureMeta.title;
  captureMeta.fileName = buildCaptureFileName(captureMeta.title, captureMeta.id, formatToExtension(getImageFormat()));
  captureMeta.relativeImagePath = `screenshots/${captureMeta.fileName}`;
  captureMeta.clickContext = {
    label,
    role: roleLabel,
    container: payload.container || null,
    rect: marker.elementRect || null
  };

  // Asset (referenced by markdown / written to disk) uses the chosen format;
  // the stored original stays lossless PNG at the same final size.
  const flattenedBlob = await encodeCanvasBlob(marker.canvas, getImageFormat(), getImageQuality());
  const unmarkedBlob = await canvasToBlob(baseCanvas);

  await storeCaptureOriginal(captureMeta.id, unmarkedBlob);
  await storeCaptureAnnotations(captureMeta.id, {
    version: 1,
    baseWidth: marker.canvas.width,
    baseHeight: marker.canvas.height,
    shapes: marker.shapes
  });
  await storeCaptureAsset(captureMeta.id, flattenedBlob);

  state.captures.push(captureMeta);
  syncCaptureOrdering({ updateNarration: false });

  const currentCapture = getCaptureById(captureMeta.id) || captureMeta;
  const narrationParts = appendStepNarration(
    currentCapture,
    buildAutoInstruction(label, roleLabel, payload.container)
  );
  recordState.currentStep = {
    paragraph: "",
    canned: narrationParts.instruction,
    anchor: narrationParts.image
  };

  await saveSettings();
  refreshCaptureList();
  renderPreview();
  refreshRunFolderHint();

  autoState.lastStepLabel = `Step ${currentCapture.indexLabel}: ${currentCapture.title}`;
  autoState.lastError = "";
  updateAutoCaptureUi();
  setStatus(`Auto-captured step ${currentCapture.indexLabel} (${currentCapture.title}).`, "success");
}

function drawClickMarkers(source, payload, stepNumber) {
  const canvas = document.createElement("canvas");
  canvas.width = source.naturalWidth || source.width;
  canvas.height = source.naturalHeight || source.height;

  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0);

  // scaleX/scaleY map page-viewport click/element coords into the final
  // (possibly downscaled) canvas space, since canvas.width is the final width.
  const scaleX = canvas.width / Math.max(1, Number(payload.viewportWidth) || canvas.width);
  const scaleY = canvas.height / Math.max(1, Number(payload.viewportHeight) || canvas.height);
  const shapes = [];

  const elementRect = scaleElementRect(payload.rect, scaleX, scaleY, canvas);

  if (elementRect) {
    const strokeWidth = Math.max(3, Math.round(canvas.width * 0.003));

    context.save();
    context.strokeStyle = BADGE_COLOR;
    context.lineWidth = strokeWidth;
    context.lineJoin = "round";
    roundedRectPath(context, elementRect.x, elementRect.y, elementRect.width, elementRect.height, 6);
    context.stroke();
    context.restore();

    shapes.push({
      id: `box-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: "box",
      x: elementRect.x,
      y: elementRect.y,
      width: elementRect.width,
      height: elementRect.height,
      color: BADGE_COLOR,
      strokeWidth
    });
  }

  const radius = clampNumber(Math.round(canvas.width * 0.025), 18, 48);
  const fontSize = Math.round(radius / 0.85);
  const centerX = Math.round(clampNumber((Number(payload.x) || 0) * scaleX, radius, Math.max(radius, canvas.width - radius)));
  const centerY = Math.round(clampNumber((Number(payload.y) || 0) * scaleY, radius, Math.max(radius, canvas.height - radius)));

  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.fillStyle = BADGE_COLOR;
  context.fill();
  context.lineWidth = Math.max(3, radius * 0.12);
  context.strokeStyle = "rgba(255, 255, 255, 0.92)";
  context.stroke();

  context.fillStyle = "#ffffff";
  context.font = `700 ${fontSize}px "Avenir Next", "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(stepNumber), centerX, centerY + fontSize * 0.05);

  shapes.push({
    id: `badge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type: "badge",
    x: centerX,
    y: centerY,
    width: radius * 2,
    height: radius * 2,
    color: BADGE_COLOR,
    number: stepNumber,
    fontSize
  });

  return { canvas, shapes, elementRect };
}

function scaleElementRect(rect, scaleX, scaleY, canvas) {
  const width = Number(rect?.width) || 0;
  const height = Number(rect?.height) || 0;

  if (width < 6 || height < 6) {
    return null;
  }

  const paddedX = (Number(rect.x) || 0) - 4;
  const paddedY = (Number(rect.y) || 0) - 4;
  const x = clampNumber(Math.round(paddedX * scaleX), 0, canvas.width - 1);
  const y = clampNumber(Math.round(paddedY * scaleY), 0, canvas.height - 1);
  const right = clampNumber(Math.round((paddedX + width + 8) * scaleX), 0, canvas.width);
  const bottom = clampNumber(Math.round((paddedY + height + 8) * scaleY), 0, canvas.height);

  if (right - x < 8 || bottom - y < 8) {
    return null;
  }

  return { x, y, width: right - x, height: bottom - y };
}

function roundedRectPath(context, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));

  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function appendStepNarration(capture, instruction) {
  const heading = `## Step ${capture.captureNumber}: ${capture.title}`;
  const image = buildCaptureMarkdown(capture);
  const block = [heading, instruction, image].join("\n\n");
  const currentValue = elements.narrationInput.value;
  const trimmedEnd = currentValue.replace(/\s+$/, "");
  const nextValue = trimmedEnd.length === 0 ? `${block}\n` : `${trimmedEnd}\n\n${block}\n`;

  elements.narrationInput.value = nextValue;
  syncNarrationCursorToEnd();

  return { instruction, image };
}

function handleRoutedSpeech(rawText) {
  const step = recordState.currentStep;

  if (!step) {
    appendSpeechAtEnd(prepareDictatedChunk("", rawText));
    return;
  }

  const chunk = prepareDictatedChunk(step.paragraph, rawText);

  if (!chunk) {
    return;
  }

  const nextParagraph = step.paragraph ? `${step.paragraph}${chunk}` : chunk.trim();
  const target = `${step.paragraph || step.canned}\n\n${step.anchor}`;
  const replacement = `${nextParagraph}\n\n${step.anchor}`;
  const narration = elements.narrationInput;

  if (!narration.value.includes(target)) {
    appendSpeechAtEnd(chunk);
    return;
  }

  narration.value = narration.value.split(target).join(replacement);
  step.paragraph = nextParagraph;
  syncNarrationCursorToEnd();
  renderPreview();
  refreshActionAvailability();
  void saveSettings();
}

function appendSpeechAtEnd(chunk) {
  const text = String(chunk || "").trim();

  if (!text) {
    return;
  }

  const narration = elements.narrationInput;
  const trimmedEnd = narration.value.replace(/\s+$/, "");
  narration.value = trimmedEnd.length === 0 ? `${text}\n` : `${trimmedEnd}\n\n${text}\n`;
  syncNarrationCursorToEnd();
  renderPreview();
  refreshActionAvailability();
  void saveSettings();
}

function syncNarrationCursorToEnd() {
  const endPosition = elements.narrationInput.value.length;
  elements.narrationInput.selectionStart = endPosition;
  elements.narrationInput.selectionEnd = endPosition;
  setLastNarrationSelection({ start: endPosition, end: endPosition });
}

function updateAutoCaptureUi() {
  if (!toggleButton || !badgeElement || !statusLineElement) {
    return;
  }

  if (autoState.recording) {
    badgeElement.textContent = "Recording";
    badgeElement.className = "badge badge-recording";
    toggleButton.textContent = "Stop Auto-Capture";
  } else {
    badgeElement.textContent = "Off";
    badgeElement.className = "badge badge-muted";
    toggleButton.textContent = "Start Auto-Capture";
  }

  const parts = [];

  if (autoState.recording) {
    parts.push(
      autoState.lastStepLabel
        ? `Last auto step — ${autoState.lastStepLabel}.`
        : "Waiting for the first click in the recorded tab."
    );
  } else {
    parts.push(autoState.lastStepLabel ? `Stopped. Last auto step — ${autoState.lastStepLabel}.` : "Not recording.");
  }

  if (autoState.droppedClicks > 0) {
    parts.push(`Skipped ${autoState.droppedClicks} rapid click${autoState.droppedClicks === 1 ? "" : "s"} (capture rate limit).`);
  }

  if (autoState.lastError) {
    parts.push(autoState.lastError);
  }

  statusLineElement.textContent = parts.join(" ");
}

function autoCaptureStartInPage() {
  window.__heraclesAutoCaptureActive = true;

  if (window.__heraclesAutoCaptureInstalled) {
    return true;
  }

  window.__heraclesAutoCaptureInstalled = true;
  window.__heraclesAutoCaptureFailures = 0;

  const findControl = (target) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const controlSelector =
      "button, a, [role='button'], input[type='button'], input[type='submit'], select, label";
    let node = target instanceof Element ? target : null;

    for (let depth = 0; node && depth <= 4; depth += 1) {
      if (typeof node.matches === "function" && node.matches(controlSelector)) {
        const text = normalize(
          node.getAttribute("aria-label") ||
            node.innerText ||
            node.value ||
            node.getAttribute("title") ||
            node.getAttribute("placeholder") ||
            ""
        );

        if (text) {
          return { label: text, role: node.tagName.toLowerCase(), element: node };
        }
      }

      node = node.parentElement;
    }

    const fallbackElement = target instanceof Element ? target : null;
    const ownText = fallbackElement
      ? normalize(fallbackElement.getAttribute("aria-label") || fallbackElement.innerText || fallbackElement.value || "")
      : "";
    const tagName = fallbackElement && fallbackElement.tagName ? fallbackElement.tagName.toLowerCase() : "";

    return { label: ownText || tagName, role: tagName, element: fallbackElement };
  };

  const describeContainer = (start) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const containerSelector =
      "dialog, [role='dialog'], [role='alertdialog'], nav, [role='navigation'], form, table, fieldset, header, footer, aside, section, article, main";

    const kindFor = (element) => {
      const role = (element.getAttribute("role") || "").toLowerCase();
      const tag = element.tagName.toLowerCase();

      if (role === "dialog" || role === "alertdialog" || tag === "dialog") return "dialog";
      if (role === "navigation" || tag === "nav") return "navigation";
      if (tag === "form") return "form";
      if (tag === "table") return "table";
      if (tag === "fieldset") return "form section";
      if (tag === "header") return "page header";
      if (tag === "footer") return "page footer";
      if (tag === "aside") return "sidebar";
      if (tag === "main") return "page";
      return "section";
    };

    const labelFor = (element) => {
      const direct = normalize(element.getAttribute("aria-label"));

      if (direct) {
        return direct;
      }

      const labelledBy = element.getAttribute("aria-labelledby");

      if (labelledBy) {
        const resolved = normalize(
          labelledBy
            .split(/\s+/)
            .map((id) => {
              const labelElement = document.getElementById(id);
              return labelElement ? labelElement.textContent : "";
            })
            .join(" ")
        );

        if (resolved) {
          return resolved;
        }
      }

      const named = element.querySelector("legend, caption, h1, h2, h3, h4");
      return named ? normalize(named.textContent) : "";
    };

    let node = start instanceof Element ? start.parentElement : null;

    while (node && node !== document.body) {
      if (typeof node.matches === "function" && node.matches(containerSelector)) {
        const kind = kindFor(node);
        const label = labelFor(node);

        if (label || ["dialog", "navigation", "form", "table", "page header", "page footer", "sidebar"].includes(kind)) {
          return { kind, label };
        }
      }

      node = node.parentElement;
    }

    return null;
  };

  const deactivate = (handler) => {
    window.removeEventListener("mousedown", handler, true);
    window.__heraclesAutoCaptureInstalled = false;
    window.__heraclesAutoCaptureActive = false;
  };

  const handler = (event) => {
    if (!window.__heraclesAutoCaptureActive || event.button !== 0) {
      return;
    }

    const control = findControl(event.target);
    const anchorElement = control.element || (event.target instanceof Element ? event.target : null);
    let elementRect = null;

    if (anchorElement && typeof anchorElement.getBoundingClientRect === "function") {
      const bounds = anchorElement.getBoundingClientRect();

      if (
        bounds.width >= 6 &&
        bounds.height >= 6 &&
        bounds.width < window.innerWidth * 0.9 &&
        bounds.height < window.innerHeight * 0.6
      ) {
        elementRect = { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height };
      }
    }

    const payload = {
      x: event.clientX,
      y: event.clientY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      label: control.label,
      elementRole: control.role,
      rect: elementRect,
      container: describeContainer(anchorElement)
    };

    try {
      chrome.runtime.sendMessage({ type: "heracles-auto-click", payload }, () => {
        if (chrome.runtime.lastError) {
          window.__heraclesAutoCaptureFailures += 1;
        } else {
          window.__heraclesAutoCaptureFailures = 0;
        }

        if (window.__heraclesAutoCaptureFailures >= 3) {
          deactivate(handler);
        }
      });
    } catch (error) {
      window.__heraclesAutoCaptureFailures += 1;

      if (window.__heraclesAutoCaptureFailures >= 3) {
        deactivate(handler);
      }
    }
  };

  window.addEventListener("mousedown", handler, true);
  return true;
}

function autoCaptureStopInPage() {
  window.__heraclesAutoCaptureActive = false;
  return true;
}
