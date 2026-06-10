import { elements, state, setLastNarrationSelection } from "./state.js";
import {
  buildCaptureMeta,
  captureVisibleTab,
  getActiveTab,
  validateActiveTab
} from "./capture.js";
import { storeCaptureAnnotations, storeCaptureAsset, storeCaptureOriginal } from "./db.js";
import { saveExportFile } from "./export.js";
import { canvasToBlob, clampNumber, dataUrlToBlob, loadImage } from "./image-utils.js";
import { buildCaptureFileName, buildCaptureMarkdown, normalizeInlineText } from "./markdown.js";
import {
  ensureRunFolderSlug,
  getCaptureById,
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

export function initAutoCapture() {
  toggleButton = document.getElementById("autoCaptureToggleButton");
  badgeElement = document.getElementById("autoCaptureBadge");
  statusLineElement = document.getElementById("autoCaptureStatus");

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

    chrome.tabs.onUpdated.addListener(handleRecordedTabUpdated);
    chrome.tabs.onRemoved.addListener(handleRecordedTabRemoved);

    updateAutoCaptureUi();
    setStatus("Auto-capture recording. Every click in the page becomes a documented step.", "success");
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

  chrome.tabs.onUpdated.removeListener(handleRecordedTabUpdated);
  chrome.tabs.onRemoved.removeListener(handleRecordedTabRemoved);

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
  const image = await loadImage(rawDataUrl);
  const stepNumber = state.captures.length + 1;
  const marker = drawClickBadge(image, payload, stepNumber);

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
  captureMeta.fileName = buildCaptureFileName(captureMeta.title, captureMeta.id);
  captureMeta.relativeImagePath = `screenshots/${captureMeta.fileName}`;

  const flattenedBlob = await canvasToBlob(marker.canvas);
  const unmarkedBlob = await dataUrlToBlob(rawDataUrl);

  await storeCaptureOriginal(captureMeta.id, unmarkedBlob);
  await storeCaptureAnnotations(captureMeta.id, {
    version: 1,
    baseWidth: marker.canvas.width,
    baseHeight: marker.canvas.height,
    shapes: [marker.badgeShape]
  });
  await storeCaptureAsset(captureMeta.id, flattenedBlob);
  await saveExportFile(runFolderSlug, captureMeta.relativeImagePath, flattenedBlob);

  state.captures.push(captureMeta);
  syncCaptureOrdering({ updateNarration: false });

  const currentCapture = getCaptureById(captureMeta.id) || captureMeta;
  appendStepNarration(currentCapture, label);

  await saveSettings();
  refreshCaptureList();
  renderPreview();
  refreshRunFolderHint();

  autoState.lastStepLabel = `Step ${currentCapture.indexLabel}: ${currentCapture.title}`;
  autoState.lastError = "";
  updateAutoCaptureUi();
  setStatus(`Auto-captured step ${currentCapture.indexLabel} (${currentCapture.title}).`, "success");
}

function drawClickBadge(image, payload, stepNumber) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;

  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);

  const scaleX = canvas.width / Math.max(1, Number(payload.viewportWidth) || canvas.width);
  const scaleY = canvas.height / Math.max(1, Number(payload.viewportHeight) || canvas.height);
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

  return {
    canvas,
    badgeShape: {
      id: `badge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      type: "badge",
      x: centerX,
      y: centerY,
      width: radius * 2,
      height: radius * 2,
      color: BADGE_COLOR,
      number: stepNumber,
      fontSize
    }
  };
}

function appendStepNarration(capture, label) {
  const heading = `## Step ${capture.captureNumber}: ${capture.title}`;
  const instruction = label ? `Click **${label}**.` : "Click the highlighted area to continue.";
  const image = buildCaptureMarkdown(capture);
  const block = [heading, instruction, image].join("\n\n");
  const currentValue = elements.narrationInput.value;
  const trimmedEnd = currentValue.replace(/\s+$/, "");
  const nextValue = trimmedEnd.length === 0 ? `${block}\n` : `${trimmedEnd}\n\n${block}\n`;

  elements.narrationInput.value = nextValue;

  const endPosition = nextValue.length;
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
          return { label: text, role: node.tagName.toLowerCase() };
        }
      }

      node = node.parentElement;
    }

    const fallbackElement = target instanceof Element ? target : null;
    const ownText = fallbackElement
      ? normalize(fallbackElement.getAttribute("aria-label") || fallbackElement.innerText || fallbackElement.value || "")
      : "";
    const tagName = fallbackElement && fallbackElement.tagName ? fallbackElement.tagName.toLowerCase() : "";

    return { label: ownText || tagName, role: tagName };
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
    const payload = {
      x: event.clientX,
      y: event.clientY,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      label: control.label,
      elementRole: control.role
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
