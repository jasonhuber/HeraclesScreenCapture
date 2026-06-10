import { normalizeCaptureMode } from "./constants.js";
import { elements, state } from "./state.js";
import {
  getPageMetricsInPage,
  hideFixedAndStickyElementsInPage,
  inspectPageContextInPage,
  primeFullPageForCaptureInPage,
  requestRegionSelectionInPage,
  restoreFullPageCaptureInPage,
  scrollPageToInPage
} from "./page-scripts.js";
import {
  cloneRects,
  cropDataUrl,
  getImageDimensions,
  loadImage,
  remapRectsToRegion,
  scaleRectsToAsset,
  sleep
} from "./image-utils.js";
import { storeCaptureAsset } from "./db.js";
import {
  buildCaptureFileName,
  createCaptureId,
  deriveSuggestedTitle,
  escapeHtml,
  normalizeInlineText
} from "./markdown.js";
import {
  ensureRunFolderSlug,
  getCaptureById,
  insertCaptureReference,
  refreshRunFolderHint,
  renderPreview,
  saveSettings,
  setStatus
} from "./ui.js";
import { refreshCaptureList, syncCaptureOrdering } from "./steps-ui.js";

const MIN_CAPTURE_INTERVAL_MS = 550;
const CAPTURE_RETRY_DELAY_MS = 800;
const MAX_CAPTURE_ATTEMPTS = 3;

let lastCaptureVisibleTabAt = 0;

export function validateActiveTab(tab) {
  if (!tab?.id || !tab.url) {
    throw new Error("Open the target web app in an active browser tab before capturing.");
  }

  if (!/^https?:/i.test(tab.url)) {
    throw new Error("This extension can only inspect normal web pages, not Chrome internal tabs.");
  }
}

export async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0];
}

export async function captureVisibleTab(windowId) {
  let lastError = "Chrome could not capture the current screen.";

  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt += 1) {
    const waitMs = lastCaptureVisibleTabAt + MIN_CAPTURE_INTERVAL_MS - Date.now();

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    lastCaptureVisibleTabAt = Date.now();

    const response = await chrome.runtime.sendMessage({
      type: "capture-visible-tab",
      windowId
    });

    if (response?.ok && response.dataUrl) {
      return response.dataUrl;
    }

    lastError = response?.error || lastError;

    if (attempt < MAX_CAPTURE_ATTEMPTS && /MAX_CAPTURE_VISIBLE_TAB|quota/i.test(lastError)) {
      await sleep(CAPTURE_RETRY_DELAY_MS);
      continue;
    }

    break;
  }

  throw new Error(lastError);
}

async function inspectPageContext(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: inspectPageContextInPage
  });

  return result?.result || {
    title: "",
    url: "",
    mainHeading: "",
    headings: [],
    actions: [],
    sensitiveRects: [],
    viewportWidth: 0,
    viewportHeight: 0
  };
}

async function requestRegionSelection(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: requestRegionSelectionInPage
  });

  return result?.result || null;
}

async function readPageMetrics(tabId) {
  const [metricsResult] = await chrome.scripting.executeScript({
    target: { tabId },
    func: getPageMetricsInPage
  });

  return metricsResult?.result || null;
}

async function captureFullPage(tabId, windowId) {
  const initialMetrics = await readPageMetrics(tabId);

  if (!initialMetrics) {
    throw new Error("Unable to read the current page size for full-page capture.");
  }

  let canvas = null;
  let context = null;
  let scaleX = 1;
  let scaleY = 1;
  let metrics = initialMetrics;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: primeFullPageForCaptureInPage
    });

    metrics = await readPageMetrics(tabId) || initialMetrics;

    const xStops = buildScrollStops(metrics.documentWidth, metrics.viewportWidth);
    const yStops = buildScrollStops(metrics.documentHeight, metrics.viewportHeight);
    let capturedTileCount = 0;

    for (const y of yStops) {
      for (const x of xStops) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: scrollPageToInPage,
          args: [x, y]
        });

        await sleep(140);

        const dataUrl = await captureVisibleTab(windowId);
        const image = await loadImage(dataUrl);

        if (!canvas) {
          scaleX = image.naturalWidth / metrics.viewportWidth;
          scaleY = image.naturalHeight / metrics.viewportHeight;
          canvas = document.createElement("canvas");
          canvas.width = Math.round(metrics.documentWidth * scaleX);
          canvas.height = Math.round(metrics.documentHeight * scaleY);
          context = canvas.getContext("2d");
        }

        const drawX = Math.round(x * scaleX);
        const drawY = Math.round(y * scaleY);
        const drawWidth = Math.min(image.naturalWidth, canvas.width - drawX);
        const drawHeight = Math.min(image.naturalHeight, canvas.height - drawY);

        context.drawImage(image, 0, 0, drawWidth, drawHeight, drawX, drawY, drawWidth, drawHeight);

        capturedTileCount += 1;

        if (capturedTileCount === 1) {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: hideFixedAndStickyElementsInPage
          });
        }
      }
    }
  } finally {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: restoreFullPageCaptureInPage
      });
    } catch (error) {
      console.warn("Unable to restore hidden page elements after full-page capture.", error);
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      func: scrollPageToInPage,
      args: [initialMetrics.scrollX, initialMetrics.scrollY]
    });
  }

  return {
    dataUrl: canvas.toDataURL("image/png"),
    cssWidth: metrics.documentWidth,
    cssHeight: metrics.documentHeight
  };
}

function buildScrollStops(totalSize, viewportSize) {
  if (!Number.isFinite(totalSize) || !Number.isFinite(viewportSize) || totalSize <= viewportSize) {
    return [0];
  }

  const stops = [];
  let position = 0;
  const lastStop = Math.max(0, totalSize - viewportSize);

  while (position < lastStop) {
    stops.push(position);
    position += viewportSize;
  }

  if (stops[stops.length - 1] !== lastStop) {
    stops.push(lastStop);
  }

  return Array.from(new Set(stops));
}

export async function prepareCaptureSession() {
  const activeTab = await getActiveTab();
  validateActiveTab(activeTab);

  const runFolderSlug = await ensureRunFolderSlug();
  const pageContext = await inspectPageContext(activeTab.id);

  let screenshotDataUrl = "";
  let sourceSensitiveRects = [];
  let sourceWidth = pageContext.viewportWidth || 1;
  let sourceHeight = pageContext.viewportHeight || 1;

  if (state.captureMode === "fullpage") {
    const fullPageCapture = await captureFullPage(activeTab.id, activeTab.windowId);
    screenshotDataUrl = fullPageCapture.dataUrl;
    sourceWidth = fullPageCapture.cssWidth || sourceWidth;
    sourceHeight = fullPageCapture.cssHeight || sourceHeight;
    sourceSensitiveRects = [];
  } else if (state.captureMode === "region") {
    setStatus("Select a region on the page to capture.");
    const regionRect = await requestRegionSelection(activeTab.id);

    if (!regionRect) {
      throw new Error("Region capture cancelled.");
    }

    await sleep(80);

    const visibleDataUrl = await captureVisibleTab(activeTab.windowId);
    screenshotDataUrl = await cropDataUrl(
      visibleDataUrl,
      regionRect,
      pageContext.viewportWidth || 1,
      pageContext.viewportHeight || 1
    );
    sourceSensitiveRects = remapRectsToRegion(pageContext.sensitiveRects || [], regionRect);
    sourceWidth = regionRect.width;
    sourceHeight = regionRect.height;
  } else {
    screenshotDataUrl = await captureVisibleTab(activeTab.windowId);
    sourceSensitiveRects = Array.isArray(pageContext.sensitiveRects) ? pageContext.sensitiveRects : [];
  }

  const imageSize = await getImageDimensions(screenshotDataUrl);
  const sensitiveRects = scaleRectsToAsset(
    sourceSensitiveRects,
    sourceWidth,
    sourceHeight,
    imageSize.width,
    imageSize.height
  );

  const captureMeta = buildCaptureMeta({
    activeTab,
    pageContext,
    runFolderSlug,
    captureMode: state.captureMode,
    sensitiveRects,
    assetWidth: imageSize.width,
    assetHeight: imageSize.height
  });

  return {
    runFolderSlug,
    screenshotDataUrl,
    captureMeta
  };
}

export function buildCaptureMeta({ activeTab, pageContext, runFolderSlug, captureMode, sensitiveRects, assetWidth, assetHeight }) {
  const captureNumber = state.captures.length + 1;
  const indexLabel = String(captureNumber).padStart(3, "0");
  const id = createCaptureId();
  const suggestedTitle = deriveSuggestedTitle(pageContext, captureNumber);
  const title = normalizeInlineText(suggestedTitle || pageContext.title || `Screen ${indexLabel}`);
  const fileName = buildCaptureFileName(title, id);

  return {
    id,
    captureNumber,
    indexLabel,
    title,
    suggestedTitle,
    fileName,
    relativeImagePath: `screenshots/${fileName}`,
    pageUrl: pageContext.url || activeTab.url || "",
    pageTitle: pageContext.title || title,
    pageContext: normalizeStoredPageContext(pageContext),
    sensitiveRects: cloneRects(sensitiveRects),
    captureMode: normalizeCaptureMode(captureMode),
    capturedAt: new Date().toISOString(),
    edited: false,
    assetWidth,
    assetHeight,
    runFolderSlug
  };
}

export function normalizeStoredPageContext(pageContext) {
  return {
    mainHeading: normalizeInlineText(pageContext?.mainHeading || ""),
    headings: Array.isArray(pageContext?.headings) ? pageContext.headings.map(normalizeInlineText).filter(Boolean).slice(0, 6) : [],
    actions: Array.isArray(pageContext?.actions) ? pageContext.actions.map(normalizeInlineText).filter(Boolean).slice(0, 8) : []
  };
}

export async function finalizeNewCapture(session, blob, edited) {
  const captureMeta = {
    ...session.captureMeta,
    edited
  };

  await storeCaptureAsset(captureMeta.id, blob);

  state.captures.push(captureMeta);
  syncCaptureOrdering({ updateNarration: false });

  const currentCapture = getCaptureById(captureMeta.id) || captureMeta;
  insertCaptureReference(currentCapture);

  await saveSettings();
  refreshCaptureList();
  renderPreview();
  refreshRunFolderHint();

  elements.lastExport.innerHTML = [
    `<strong>Screenshot</strong>: ${escapeHtml(currentCapture.relativeImagePath)} (cached in extension)`,
    `<strong>Storage</strong>: In-memory until you save or export the run`
  ].join("<br>");

  setStatus(
    edited
      ? `Edited step ${currentCapture.indexLabel} saved and inserted into the narration.`
      : `Step ${currentCapture.indexLabel} inserted into the narration.`,
    "success"
  );
}
