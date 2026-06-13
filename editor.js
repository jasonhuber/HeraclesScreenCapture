"use strict";

/*
 * Heracles Editor v2 — full-tab, object-model annotation editor.
 *
 * Storage contract (shared with sidepanel.js):
 *   IndexedDB "heracles-file-access" v3 with stores:
 *     handles, capture-assets, capture-originals, capture-annotations, editor-sessions
 *   capture-assets:       flattened PNG Blob keyed by captureId (annotations baked in)
 *   capture-originals:    un-annotated base bitmap PNG Blob keyed by captureId
 *   capture-annotations:  {version: 1, baseWidth, baseHeight, shapes: [...]} keyed by captureId
 *   editor-sessions:      {sessionId, captureId, mode, runFolderSlug, captureMeta, createdAt}
 *
 * Result channel: append {type: "editor-saved"|"editor-cancelled", ...} to the
 * "pendingEditorResults" array in chrome.storage.session, then sendMessage the
 * same record (best effort).
 */

const DB_NAME = "heracles-file-access";
const DB_VERSION = 3;
const HANDLE_STORE = "handles";
const ASSET_STORE = "capture-assets";
const ORIGINAL_STORE = "capture-originals";
const ANNOTATION_STORE = "capture-annotations";
const SESSION_STORE = "editor-sessions";
const ALL_STORES = [HANDLE_STORE, ASSET_STORE, ORIGINAL_STORE, ANNOTATION_STORE, SESSION_STORE];
const PENDING_RESULTS_KEY = "pendingEditorResults";

const DEFAULT_COLOR = "#d97706";
const DEFAULT_STROKE = 4;
const DEFAULT_FONT_SIZE = 18;
const DEFAULT_HIGHLIGHT_COLOR = "#fde047";
const REDACTION_COLOR = "#111111";
const HIGHLIGHT_ALPHA = 0.45;
const DEFAULT_PIXELATE_BLOCK = 12;
const MIN_PIXELATE_BLOCK = 4;
const MAX_PIXELATE_BLOCK = 60;
const DEFAULT_STAMP_COLOR = "#16a34a";
const DEFAULT_STAMP_GLYPH = "check";
const DEFAULT_STAMP_SIZE = 56;
const STAMP_GLYPHS = ["check", "cross", "star", "dot", "question", "exclaim", "arrow-right"];
const DEFAULT_TEXT_BACKING = "light";
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const MAX_HISTORY = 60;
const TEXT_FONT_FAMILY = "\"Avenir Next\", \"Segoe UI\", sans-serif";

const SWATCH_COLORS = ["#d97706", "#dc2626", "#2563eb", "#0f766e", "#7c3aed", "#111111", "#ffffff"];
const SUGGESTION_KIND_COLORS = ["#dc2626", "#7c3aed", "#2563eb", "#b45309", "#0f766e", "#be185d"];

const DRAG_RECT_TOOLS = ["box", "ellipse", "highlight", "redact", "pixelate"];
const STROKE_SHAPE_TYPES = ["arrow", "line", "box", "ellipse", "pen", "callout"];
const COLOR_SHAPE_TYPES = ["arrow", "line", "box", "ellipse", "pen", "highlight", "text", "callout", "badge", "stamp"];
const FONT_SHAPE_TYPES = ["text", "callout", "badge"];
const PIXELATE_SHAPE_TYPES = ["pixelate"];
const GLYPH_SHAPE_TYPES = ["stamp"];
const BACKING_SHAPE_TYPES = ["text", "callout"];

const TOOL_SHORTCUTS = {
  v: "select",
  a: "arrow",
  l: "line",
  r: "box",
  e: "ellipse",
  p: "pen",
  h: "highlight",
  t: "text",
  c: "callout",
  n: "badge",
  d: "redact",
  z: "pixelate",
  m: "stamp",
  x: "crop"
};

const TOOL_HINTS = {
  select: "Click a shape to select it. Drag to move, handles to resize, Delete to remove, arrows to nudge.",
  pan: "Drag to pan the view. Hold Space or use the middle mouse button from any tool.",
  crop: "Drag a region, then click Apply Crop. Cropping rebases the image and shape coordinates.",
  arrow: "Drag from the tail to the tip of the arrow.",
  line: "Drag from one end of the line to the other.",
  box: "Drag to draw a rectangle outline.",
  ellipse: "Drag to draw an ellipse outline.",
  pen: "Drag to draw freehand.",
  highlight: "Drag to lay a translucent highlight over the image.",
  text: "Click where the text should start, then type. Blur or Escape commits.",
  callout: "Drag from the anchor point to where the note box should sit, then type.",
  badge: "Click to drop a numbered badge. Double-click a badge to edit its number.",
  redact: "Drag a solid block over anything sensitive. Redactions are burned in permanently on save.",
  pixelate: "Drag over anything to blur it into a mosaic. Pixelation is burned in permanently on save.",
  stamp: "Click to drop a stamp. Pick a glyph in the bar above; drag handles to resize."
};

const elements = {};

const state = {
  devMode: false,
  sessionId: "",
  session: null,
  captureId: "",
  mode: "new",
  baseCanvas: null,
  baseContext: null,
  baseLoaded: false,
  shapes: [],
  selectedId: null,
  tool: "select",
  color: DEFAULT_COLOR,
  highlightColor: DEFAULT_HIGHLIGHT_COLOR,
  strokeWidth: DEFAULT_STROKE,
  fontSize: DEFAULT_FONT_SIZE,
  pixelateBlock: DEFAULT_PIXELATE_BLOCK,
  stampGlyph: DEFAULT_STAMP_GLYPH,
  stampColor: DEFAULT_STAMP_COLOR,
  textBacking: DEFAULT_TEXT_BACKING,
  zoom: 1,
  panX: 0,
  panY: 0,
  spaceDown: false,
  gesture: null,
  cropRect: null,
  editing: null,
  sensitiveRects: [],
  suggestionsApplied: false,
  showSuggestions: false,
  undoStack: [],
  redoStack: [],
  dirty: false,
  busy: false,
  closing: false,
  notified: false,
  shapeIdCounter: 1,
  propEditBefore: null,
  lastNudge: null,
  renderQueued: false
};

const measureContext = document.createElement("canvas").getContext("2d");
const mosaicCanvas = document.createElement("canvas");
const mosaicContext = mosaicCanvas.getContext("2d");
let toastTimer = null;

document.addEventListener("DOMContentLoaded", () => {
  void initialize();
});

async function initialize() {
  cacheElements();
  buildSwatches();
  buildGlyphPicker();
  buildBackingButtons();
  bindUi();
  bindPointerEvents();
  bindKeyboard();
  setTool("select");

  const params = new URLSearchParams(window.location.search);
  state.devMode = params.get("dev") === "1" || !hasChromeApis();

  if (state.devMode) {
    enterDevMode();
    return;
  }

  state.sessionId = params.get("sessionId") || "";

  if (!state.sessionId) {
    showErrorState("Missing session", "The editor was opened without a session id in the URL.");
    return;
  }

  let session = null;

  try {
    session = await idbGet(SESSION_STORE, state.sessionId);
  } catch (error) {
    showErrorState("Storage unavailable", `Could not open local storage: ${error.message || error}`);
    return;
  }

  if (!session) {
    showErrorState(
      "Session not found",
      "This editing session has expired or was already completed. Close this tab and reopen the editor from the side panel."
    );
    return;
  }

  state.session = session;
  state.captureId = session.captureId;
  state.mode = session.mode || "new";
  state.sensitiveRects = cloneRects(session.captureMeta && session.captureMeta.sensitiveRects);

  let baseBlob = null;

  try {
    baseBlob = await idbGet(ORIGINAL_STORE, state.captureId);

    if (!baseBlob) {
      baseBlob = await idbGet(ASSET_STORE, state.captureId);
    }
  } catch (error) {
    showErrorState("Image unavailable", `Could not read the stored capture: ${error.message || error}`);
    return;
  }

  if (!baseBlob) {
    showErrorState("Image unavailable", "No stored image was found for this capture. It may have been deleted.");
    return;
  }

  try {
    const bitmap = await createImageBitmap(baseBlob);
    setBaseBitmap(bitmap);
  } catch (error) {
    showErrorState("Image unreadable", `The stored capture could not be decoded: ${error.message || error}`);
    return;
  }

  try {
    const annotations = await idbGet(ANNOTATION_STORE, state.captureId);

    if (annotations && Array.isArray(annotations.shapes)) {
      state.shapes = annotations.shapes.map(rehydrateShape).filter(Boolean);
    }
  } catch (error) {
    console.warn("Heracles editor: could not load stored annotations.", error);
  }

  updateHeader();
  updateSuggestionsButton();
  fitToWindow();
  updateAllUi();
}

function hasChromeApis() {
  try {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime) && Boolean(chrome.runtime.id);
  } catch (error) {
    return false;
  }
}

function cacheElements() {
  const ids = [
    "app", "stepLabel", "undoButton", "redoButton", "zoomOutButton", "zoomInButton",
    "zoomLevelButton", "fitButton", "suggestionsButton", "cancelButton", "saveButton",
    "propsBar", "colorGroup", "swatches", "colorInput", "strokeGroup", "strokeInput",
    "strokeValue", "fontGroup", "fontInput", "fontValue", "pixelateGroup", "pixelateInput",
    "pixelateValue", "glyphGroup", "glyphButtons", "backingGroup", "cropGroup", "applyCropButton",
    "clearCropButton", "cropSizeLabel", "propHint", "toolbar", "workspace", "stage",
    "overlayLayer", "dropZone", "devFileInput", "suggestionsPopover", "suggestionsList",
    "applySuggestionsButton", "hideSuggestionsButton", "statusToast", "errorState",
    "errorTitle", "errorMessage", "errorCloseButton"
  ];

  ids.forEach((id) => {
    elements[id] = document.getElementById(id);
  });

  elements.toolButtons = Array.from(elements.toolbar.querySelectorAll("[data-tool]"));
  elements.stageContext = elements.stage.getContext("2d");
  state.baseCanvas = document.createElement("canvas");
  state.baseContext = state.baseCanvas.getContext("2d");
}

function buildSwatches() {
  SWATCH_COLORS.forEach((color) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "swatch";
    button.dataset.color = color;
    button.title = color;
    button.style.background = color;
    button.addEventListener("click", () => {
      applyColor(color);
    });
    elements.swatches.appendChild(button);
  });
}

const STAMP_GLYPH_LABELS = {
  check: "Check",
  cross: "Cross",
  star: "Star",
  dot: "Dot",
  question: "Question",
  exclaim: "Exclamation",
  "arrow-right": "Pointer"
};

function buildGlyphPicker() {
  STAMP_GLYPHS.forEach((glyph) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "glyph-button";
    button.dataset.glyph = glyph;
    button.title = STAMP_GLYPH_LABELS[glyph] || glyph;

    const canvas = document.createElement("canvas");
    canvas.width = 24;
    canvas.height = 24;
    const context = canvas.getContext("2d");
    drawStampGlyph(context, glyph, 3, 3, 18, 18, "#2d261c", false);
    button.appendChild(canvas);

    button.addEventListener("click", () => applyStampGlyph(glyph));
    elements.glyphButtons.appendChild(button);
  });
}

function buildBackingButtons() {
  const options = [
    { value: "none", label: "None" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" }
  ];

  options.forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "backing-button";
    button.dataset.backing = option.value;
    button.textContent = option.label;
    button.title = `${option.label} text backing`;
    button.addEventListener("click", () => applyTextBacking(option.value));
    elements.backingGroup.appendChild(button);
  });
}

function bindUi() {
  elements.undoButton.addEventListener("click", () => void undo());
  elements.redoButton.addEventListener("click", () => void redo());
  elements.zoomInButton.addEventListener("click", () => zoomBy(1.25));
  elements.zoomOutButton.addEventListener("click", () => zoomBy(1 / 1.25));
  elements.zoomLevelButton.addEventListener("click", () => setZoom(1));
  elements.fitButton.addEventListener("click", () => {
    fitToWindow();
    scheduleRender();
  });
  elements.saveButton.addEventListener("click", () => void doSave());
  elements.cancelButton.addEventListener("click", () => void doCancel());
  elements.errorCloseButton.addEventListener("click", () => closeTab());

  elements.suggestionsButton.addEventListener("click", () => toggleSuggestions());
  elements.applySuggestionsButton.addEventListener("click", () => applyAllSuggestions());
  elements.hideSuggestionsButton.addEventListener("click", () => {
    state.showSuggestions = false;
    elements.suggestionsPopover.hidden = true;
    scheduleRender();
  });

  elements.applyCropButton.addEventListener("click", () => void applyCrop());
  elements.clearCropButton.addEventListener("click", () => {
    state.cropRect = null;
    updatePropsBar();
    scheduleRender();
  });

  elements.colorInput.addEventListener("input", () => {
    beginPropEdit();
    applyColor(elements.colorInput.value, true);
  });
  elements.colorInput.addEventListener("change", () => endPropEdit());

  elements.strokeInput.addEventListener("input", () => {
    beginPropEdit();
    applyStrokeWidth(Number(elements.strokeInput.value));
  });
  elements.strokeInput.addEventListener("change", () => endPropEdit());

  elements.fontInput.addEventListener("input", () => {
    beginPropEdit();
    applyFontSize(Number(elements.fontInput.value));
  });
  elements.fontInput.addEventListener("change", () => endPropEdit());

  elements.pixelateInput.addEventListener("input", () => {
    beginPropEdit();
    applyPixelateBlock(Number(elements.pixelateInput.value));
  });
  elements.pixelateInput.addEventListener("change", () => endPropEdit());

  elements.toolButtons.forEach((button) => {
    button.addEventListener("click", () => setTool(button.dataset.tool));
  });

  elements.workspace.addEventListener("wheel", onWheel, { passive: false });
  elements.stage.addEventListener("dblclick", onDoubleClick);
  elements.stage.addEventListener("contextmenu", (event) => {
    if (state.gesture) {
      event.preventDefault();
    }
  });

  const resizeObserver = new ResizeObserver(() => scheduleRender());
  resizeObserver.observe(elements.workspace);

  window.addEventListener("beforeunload", (event) => {
    if (state.dirty && !state.closing) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  window.addEventListener("pagehide", () => {
    if (!state.closing && !state.notified && !state.devMode && state.session) {
      notifyResultBestEffort(buildResultRecord("editor-cancelled"));
    }
  });
}

/* ===================== IndexedDB ===================== */

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.addEventListener("upgradeneeded", () => {
      const database = request.result;

      ALL_STORES.forEach((storeName) => {
        if (!database.objectStoreNames.contains(storeName)) {
          database.createObjectStore(storeName);
        }
      });
    });

    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error || new Error("IndexedDB open failed.")));
    request.addEventListener("blocked", () => {
      console.warn("Heracles editor: IndexedDB upgrade is blocked by another open tab.");
    });
  });
}

async function withStore(storeName, mode, callback) {
  const database = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);

    let settled = false;
    let settledValue;

    transaction.addEventListener("complete", () => {
      database.close();
      resolve(settled ? settledValue : undefined);
    });

    transaction.addEventListener("error", () => {
      database.close();
      reject(transaction.error || new Error("IndexedDB transaction failed."));
    });

    transaction.addEventListener("abort", () => {
      database.close();
      reject(transaction.error || new Error("IndexedDB transaction aborted."));
    });

    callback(store, (value) => {
      settled = true;
      settledValue = value;
    });
  });
}

async function idbGet(storeName, key) {
  return withStore(storeName, "readonly", (store, settle) => {
    const request = store.get(key);
    request.addEventListener("success", () => settle(request.result));
  });
}

async function idbPut(storeName, key, value) {
  await withStore(storeName, "readwrite", (store) => {
    store.put(value, key);
  });
}

async function idbDelete(storeName, key) {
  await withStore(storeName, "readwrite", (store) => {
    store.delete(key);
  });
}

/* ===================== Session header / error state ===================== */

function updateHeader() {
  const meta = (state.session && state.session.captureMeta) || {};
  const label = `Step ${meta.indexLabel || "?"} • ${meta.title || "Untitled step"}`;
  elements.stepLabel.textContent = label;
  document.title = `Heracles Editor — ${label}`;
  elements.saveButton.textContent = state.mode === "existing" ? "Save Changes" : "Save & Insert";
}

function showErrorState(title, message) {
  elements.errorTitle.textContent = title;
  elements.errorMessage.textContent = message;
  elements.errorState.hidden = false;
}

/* ===================== Dev mode ===================== */

function enterDevMode() {
  elements.stepLabel.textContent = "Dev Mode • standalone editor";
  document.title = "Heracles Editor — Dev Mode";
  elements.saveButton.textContent = "Save PNG";
  elements.dropZone.hidden = false;

  elements.devFileInput.addEventListener("change", () => {
    const file = elements.devFileInput.files && elements.devFileInput.files[0];

    if (file) {
      void loadDevImage(file);
    }
  });

  elements.workspace.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("drag-over");
  });

  elements.workspace.addEventListener("dragleave", () => {
    elements.dropZone.classList.remove("drag-over");
  });

  elements.workspace.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("drag-over");
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];

    if (file && file.type.startsWith("image/")) {
      void loadDevImage(file);
    }
  });

  window.__heraclesEditorDev = {
    loadImageFromDataUrl: async (dataUrl) => {
      const image = await loadImage(dataUrl);
      setBaseBitmap(image);
      seedDevSuggestions();
      fitToWindow();
      updateAllUi();
    },
    getState: () => state,
    getShapes: () => state.shapes,
    setTool: (tool) => setTool(tool)
  };
}

async function loadDevImage(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    setBaseBitmap(bitmap);
    seedDevSuggestions();
    fitToWindow();
    updateAllUi();
    setStatus("Test image loaded. Save downloads the flattened PNG.", "success");
  } catch (error) {
    setStatus(`Could not load that image: ${error.message || error}`, "warn");
  }
}

function seedDevSuggestions() {
  const width = state.baseCanvas.width;
  const height = state.baseCanvas.height;
  state.sensitiveRects = [
    {
      x: Math.round(width * 0.08),
      y: Math.round(height * 0.12),
      width: Math.round(width * 0.26),
      height: Math.max(18, Math.round(height * 0.05)),
      kind: "email",
      label: "user@example.com"
    },
    {
      x: Math.round(width * 0.12),
      y: Math.round(height * 0.32),
      width: Math.round(width * 0.2),
      height: Math.max(16, Math.round(height * 0.04)),
      kind: "token",
      label: "api key"
    }
  ];
  state.suggestionsApplied = false;
  updateSuggestionsButton();
}

/* ===================== Base bitmap ===================== */

function setBaseBitmap(source) {
  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  state.baseCanvas.width = width;
  state.baseCanvas.height = height;
  state.baseContext.clearRect(0, 0, width, height);
  state.baseContext.drawImage(source, 0, 0);
  state.baseLoaded = true;
  elements.dropZone.hidden = true;
}

/* ===================== Shapes ===================== */

function makeShapeId() {
  state.shapeIdCounter += 1;
  return `shape-${Date.now().toString(36)}-${state.shapeIdCounter}`;
}

function cloneShape(shape) {
  const copy = { ...shape };

  if (Array.isArray(shape.points)) {
    copy.points = shape.points.map((point) => ({ x: point.x, y: point.y }));
  }

  if (shape.anchor) {
    copy.anchor = { x: shape.anchor.x, y: shape.anchor.y };
  }

  delete copy.hidden;
  return copy;
}

function rehydrateShape(raw) {
  if (!raw || typeof raw !== "object" || !raw.type) {
    return null;
  }

  const shape = cloneShape(raw);

  if (!shape.id) {
    shape.id = makeShapeId();
  }

  return shape;
}

function serializeShape(shape) {
  const out = { id: shape.id, type: shape.type };
  const numericFields = ["x", "y", "width", "height", "strokeWidth", "fontSize", "number", "blockSize"];

  numericFields.forEach((field) => {
    if (typeof shape[field] === "number" && Number.isFinite(shape[field])) {
      out[field] = roundCoord(shape[field]);
    }
  });

  if (typeof shape.color === "string") {
    out.color = shape.color;
  }

  if (typeof shape.text === "string") {
    out.text = shape.text;
  }

  if (typeof shape.glyph === "string") {
    out.glyph = shape.glyph;
  }

  if (shape.backing === "light" || shape.backing === "dark" || shape.backing === "none") {
    out.backing = shape.backing;
  }

  if (Array.isArray(shape.points)) {
    out.points = shape.points.map((point) => ({ x: roundCoord(point.x), y: roundCoord(point.y) }));
  }

  if (shape.anchor) {
    out.anchor = { x: roundCoord(shape.anchor.x), y: roundCoord(shape.anchor.y) };
  }

  return out;
}

function roundCoord(value) {
  return Math.round(value * 100) / 100;
}

function getShapeById(id) {
  return state.shapes.find((shape) => shape.id === id) || null;
}

function removeShape(id) {
  const index = state.shapes.findIndex((shape) => shape.id === id);

  if (index >= 0) {
    state.shapes.splice(index, 1);
  }

  if (state.selectedId === id) {
    state.selectedId = null;
  }
}

function nextBadgeNumber() {
  let highest = 0;

  state.shapes.forEach((shape) => {
    if (shape.type === "badge" && typeof shape.number === "number") {
      highest = Math.max(highest, shape.number);
    }
  });

  return highest + 1;
}

function badgeRadius(shape) {
  return Math.max(10, (shape.fontSize || DEFAULT_FONT_SIZE) * 0.85);
}

function measureTextBlock(text, fontSize) {
  measureContext.font = `600 ${fontSize}px ${TEXT_FONT_FAMILY}`;
  const lines = String(text || "").split("\n");
  let widest = 0;

  lines.forEach((line) => {
    widest = Math.max(widest, measureContext.measureText(line || " ").width);
  });

  return {
    width: Math.max(widest, fontSize * 0.6),
    height: Math.max(lines.length, 1) * fontSize * 1.25
  };
}

function shapeBounds(shape) {
  switch (shape.type) {
    case "arrow":
    case "line": {
      const x2 = shape.x + shape.width;
      const y2 = shape.y + shape.height;
      return normalizeRect({ x: shape.x, y: shape.y, width: x2 - shape.x, height: y2 - shape.y });
    }
    case "pen": {
      const points = shape.points || [];

      if (points.length === 0) {
        return { x: shape.x || 0, y: shape.y || 0, width: 0, height: 0 };
      }

      let minX = points[0].x;
      let minY = points[0].y;
      let maxX = points[0].x;
      let maxY = points[0].y;

      points.forEach((point) => {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      });

      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }
    case "text": {
      const size = measureTextBlock(shape.text, shape.fontSize || DEFAULT_FONT_SIZE);
      return { x: shape.x, y: shape.y, width: size.width, height: size.height };
    }
    case "badge": {
      const radius = badgeRadius(shape);
      return { x: shape.x - radius, y: shape.y - radius, width: radius * 2, height: radius * 2 };
    }
    default:
      return normalizeRect({ x: shape.x, y: shape.y, width: shape.width, height: shape.height });
  }
}

function normalizeRect(rect) {
  return {
    x: rect.width < 0 ? rect.x + rect.width : rect.x,
    y: rect.height < 0 ? rect.y + rect.height : rect.y,
    width: Math.abs(rect.width),
    height: Math.abs(rect.height)
  };
}

function rectsIntersect(rectA, rectB) {
  return (
    rectA.x < rectB.x + rectB.width &&
    rectA.x + rectA.width > rectB.x &&
    rectA.y < rectB.y + rectB.height &&
    rectA.y + rectA.height > rectB.y
  );
}

function cloneRects(rects) {
  return Array.isArray(rects) ? rects.map((rect) => ({ ...rect })) : [];
}

/* ===================== History ===================== */

function makeSnapshot(includeBitmap) {
  return {
    shapes: state.shapes.map(cloneShape),
    sensitiveRects: cloneRects(state.sensitiveRects),
    suggestionsApplied: state.suggestionsApplied,
    bitmap: includeBitmap ? state.baseCanvas.toDataURL("image/png") : null
  };
}

function commitHistory(beforeSnapshot) {
  state.undoStack.push(beforeSnapshot);

  if (state.undoStack.length > MAX_HISTORY) {
    state.undoStack.shift();
  }

  state.redoStack.length = 0;
  state.dirty = true;
  updateUndoRedoButtons();
}

function pushHistory(includeBitmap) {
  commitHistory(makeSnapshot(includeBitmap));
}

async function restoreSnapshot(snapshot) {
  state.shapes = snapshot.shapes.map(cloneShape);
  state.sensitiveRects = cloneRects(snapshot.sensitiveRects);
  state.suggestionsApplied = snapshot.suggestionsApplied;
  state.selectedId = null;
  state.cropRect = null;

  if (snapshot.bitmap) {
    const image = await loadImage(snapshot.bitmap);
    setBaseBitmap(image);
    fitToWindow();
  }

  updateAllUi();
}

async function undo() {
  cancelTextEditing();
  const entry = state.undoStack.pop();

  if (!entry) {
    return;
  }

  state.redoStack.push(makeSnapshot(Boolean(entry.bitmap)));
  await restoreSnapshot(entry);
  state.dirty = true;
  updateUndoRedoButtons();
}

async function redo() {
  cancelTextEditing();
  const entry = state.redoStack.pop();

  if (!entry) {
    return;
  }

  state.undoStack.push(makeSnapshot(Boolean(entry.bitmap)));
  await restoreSnapshot(entry);
  state.dirty = true;
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  elements.undoButton.disabled = state.undoStack.length === 0;
  elements.redoButton.disabled = state.redoStack.length === 0;
}

/* ===================== View transform ===================== */

function screenToImage(clientX, clientY) {
  const rect = elements.stage.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.panX) / state.zoom,
    y: (clientY - rect.top - state.panY) / state.zoom
  };
}

function imageToScreen(x, y) {
  return {
    x: x * state.zoom + state.panX,
    y: y * state.zoom + state.panY
  };
}

function fitToWindow() {
  if (!state.baseLoaded) {
    return;
  }

  const rect = elements.workspace.getBoundingClientRect();
  const margin = 36;
  const availableWidth = Math.max(60, rect.width - margin);
  const availableHeight = Math.max(60, rect.height - margin);
  const zoom = clampNumber(
    Math.min(availableWidth / state.baseCanvas.width, availableHeight / state.baseCanvas.height, 1),
    MIN_ZOOM,
    MAX_ZOOM
  );

  state.zoom = zoom;
  state.panX = (rect.width - state.baseCanvas.width * zoom) / 2;
  state.panY = (rect.height - state.baseCanvas.height * zoom) / 2;
  updateZoomLabel();
  scheduleRender();
}

function setZoom(nextZoom, focusClientX, focusClientY) {
  if (!state.baseLoaded) {
    return;
  }

  const rect = elements.stage.getBoundingClientRect();
  const focusX = typeof focusClientX === "number" ? focusClientX - rect.left : rect.width / 2;
  const focusY = typeof focusClientY === "number" ? focusClientY - rect.top : rect.height / 2;
  const clamped = clampNumber(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const imageX = (focusX - state.panX) / state.zoom;
  const imageY = (focusY - state.panY) / state.zoom;

  state.zoom = clamped;
  state.panX = focusX - imageX * clamped;
  state.panY = focusY - imageY * clamped;
  updateZoomLabel();
  scheduleRender();
}

function zoomBy(factor, focusClientX, focusClientY) {
  setZoom(state.zoom * factor, focusClientX, focusClientY);
}

function updateZoomLabel() {
  elements.zoomLevelButton.textContent = `${Math.round(state.zoom * 100)}%`;
}

function onWheel(event) {
  if (!state.baseLoaded) {
    return;
  }

  event.preventDefault();

  if (event.ctrlKey || event.metaKey) {
    const factor = Math.exp(-event.deltaY * 0.0016);
    zoomBy(factor, event.clientX, event.clientY);
    return;
  }

  if (event.shiftKey) {
    state.panX -= event.deltaY;
  } else {
    state.panX -= event.deltaX;
    state.panY -= event.deltaY;
  }

  scheduleRender();
}

/* ===================== Tools / properties UI ===================== */

function setTool(tool) {
  commitTextEditing();
  state.tool = tool;

  if (tool !== "crop") {
    state.cropRect = null;
  }

  if (tool !== "select") {
    state.selectedId = null;
  }

  updateAllUi();
}

function updateToolButtons() {
  elements.toolButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === state.tool);
  });
}

function currentDefaultColor() {
  if (state.tool === "highlight") {
    return state.highlightColor;
  }

  if (state.tool === "stamp") {
    return state.stampColor;
  }

  return state.color;
}

function applyColor(color, fromCustomInput) {
  const selected = getShapeById(state.selectedId);

  if (selected && COLOR_SHAPE_TYPES.includes(selected.type)) {
    if (!fromCustomInput) {
      pushHistory(false);
    }

    selected.color = color;
  } else if (state.tool === "highlight") {
    state.highlightColor = color;
  } else if (state.tool === "stamp") {
    state.stampColor = color;
  } else {
    state.color = color;
  }

  updatePropsBar();
  scheduleRender();
}

function applyStrokeWidth(width) {
  const value = clampNumber(Math.round(width), 1, 40);
  const selected = getShapeById(state.selectedId);

  if (selected && STROKE_SHAPE_TYPES.includes(selected.type)) {
    selected.strokeWidth = value;
  } else {
    state.strokeWidth = value;
  }

  updatePropsBar();
  scheduleRender();
}

function applyFontSize(size) {
  const value = clampNumber(Math.round(size), 8, 120);
  const selected = getShapeById(state.selectedId);

  if (selected && FONT_SHAPE_TYPES.includes(selected.type)) {
    selected.fontSize = value;
  } else {
    state.fontSize = value;
  }

  updatePropsBar();
  scheduleRender();
}

function applyPixelateBlock(size) {
  const value = clampNumber(Math.round(size), MIN_PIXELATE_BLOCK, MAX_PIXELATE_BLOCK);
  const selected = getShapeById(state.selectedId);

  if (selected && PIXELATE_SHAPE_TYPES.includes(selected.type)) {
    selected.blockSize = value;
  } else {
    state.pixelateBlock = value;
  }

  updatePropsBar();
  scheduleRender();
}

function applyStampGlyph(glyph) {
  if (!STAMP_GLYPHS.includes(glyph)) {
    return;
  }

  const selected = getShapeById(state.selectedId);

  if (selected && selected.type === "stamp") {
    if (selected.glyph !== glyph) {
      pushHistory(false);
      selected.glyph = glyph;
    }
  }

  state.stampGlyph = glyph;
  updatePropsBar();
  scheduleRender();
}

function applyTextBacking(backing) {
  const value = backing === "light" || backing === "dark" ? backing : "none";
  const selected = getShapeById(state.selectedId);

  if (selected && BACKING_SHAPE_TYPES.includes(selected.type)) {
    if (textBackingOf(selected) !== value) {
      pushHistory(false);
      selected.backing = value;
    }
  } else {
    state.textBacking = value;
  }

  updatePropsBar();
  scheduleRender();
}

function textBackingOf(shape) {
  if (shape.backing === "light" || shape.backing === "dark") {
    return shape.backing;
  }

  return "none";
}

function beginPropEdit() {
  if (!state.propEditBefore && getShapeById(state.selectedId)) {
    state.propEditBefore = makeSnapshot(false);
  }
}

function endPropEdit() {
  if (state.propEditBefore) {
    commitHistory(state.propEditBefore);
    state.propEditBefore = null;
  }
}

function updatePropsBar() {
  const selected = getShapeById(state.selectedId);
  const colorTarget = selected ? selected.type : state.tool;
  const showColor = COLOR_SHAPE_TYPES.includes(colorTarget);
  const showStroke = STROKE_SHAPE_TYPES.includes(colorTarget);
  const showFont = FONT_SHAPE_TYPES.includes(colorTarget);
  const showPixelate = PIXELATE_SHAPE_TYPES.includes(colorTarget);
  const showGlyph = GLYPH_SHAPE_TYPES.includes(colorTarget);
  const showBacking = BACKING_SHAPE_TYPES.includes(colorTarget);
  const showCrop = state.tool === "crop" && Boolean(state.cropRect);

  elements.colorGroup.hidden = !showColor;
  elements.strokeGroup.hidden = !showStroke;
  elements.fontGroup.hidden = !showFont;
  elements.pixelateGroup.hidden = !showPixelate;
  elements.glyphGroup.hidden = !showGlyph;
  elements.backingGroup.hidden = !showBacking;
  elements.cropGroup.hidden = !showCrop;

  const activeColor = selected && selected.color ? selected.color : currentDefaultColor();
  const activeStroke = selected && typeof selected.strokeWidth === "number" ? selected.strokeWidth : state.strokeWidth;
  const activeFont = selected && typeof selected.fontSize === "number" ? selected.fontSize : state.fontSize;
  const activeBlock = selected && typeof selected.blockSize === "number" ? selected.blockSize : state.pixelateBlock;
  const activeGlyph = selected && selected.type === "stamp" && selected.glyph ? selected.glyph : state.stampGlyph;
  const activeBacking = selected && BACKING_SHAPE_TYPES.includes(selected.type) ? textBackingOf(selected) : state.textBacking;

  if (showColor) {
    Array.from(elements.swatches.children).forEach((swatch) => {
      swatch.classList.toggle("active", swatch.dataset.color.toLowerCase() === String(activeColor).toLowerCase());
    });

    if (/^#[0-9a-fA-F]{6}$/.test(String(activeColor))) {
      elements.colorInput.value = activeColor;
    }
  }

  if (showStroke) {
    elements.strokeInput.value = String(activeStroke);
    elements.strokeValue.textContent = String(activeStroke);
  }

  if (showFont) {
    elements.fontInput.value = String(activeFont);
    elements.fontValue.textContent = String(activeFont);
  }

  if (showPixelate) {
    elements.pixelateInput.value = String(activeBlock);
    elements.pixelateValue.textContent = String(activeBlock);
  }

  if (showGlyph) {
    Array.from(elements.glyphButtons.children).forEach((button) => {
      button.classList.toggle("active", button.dataset.glyph === activeGlyph);
    });
  }

  if (showBacking) {
    Array.from(elements.backingGroup.children).forEach((button) => {
      if (button.dataset.backing) {
        button.classList.toggle("active", button.dataset.backing === activeBacking);
      }
    });
  }

  if (showCrop && state.cropRect) {
    elements.cropSizeLabel.textContent = `${Math.round(state.cropRect.width)} × ${Math.round(state.cropRect.height)} px`;
  }

  if (selected) {
    elements.propHint.textContent = `Selected: ${selected.type}. Drag to move, Delete to remove, arrows to nudge (Shift = 10px).`;
  } else {
    elements.propHint.textContent = TOOL_HINTS[state.tool] || "";
  }
}

function updateAllUi() {
  updateToolButtons();
  updatePropsBar();
  updateUndoRedoButtons();
  updateSuggestionsButton();
  updateZoomLabel();
  updateCursor();
  scheduleRender();
}

function updateCursor(hoverHandle) {
  const canvas = elements.stage;

  if (state.gesture && state.gesture.type === "pan") {
    canvas.style.cursor = "grabbing";
    return;
  }

  if (state.spaceDown || state.tool === "pan") {
    canvas.style.cursor = "grab";
    return;
  }

  if (hoverHandle) {
    canvas.style.cursor = handleCursor(hoverHandle);
    return;
  }

  if (state.tool === "select") {
    canvas.style.cursor = "default";
  } else if (state.tool === "text") {
    canvas.style.cursor = "text";
  } else {
    canvas.style.cursor = "crosshair";
  }
}

function handleCursor(handleId) {
  switch (handleId) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    default:
      return "move";
  }
}

/* ===================== Pointer interactions ===================== */

function bindPointerEvents() {
  elements.stage.addEventListener("pointerdown", onPointerDown);
  elements.stage.addEventListener("pointermove", onPointerMove);
  elements.stage.addEventListener("pointerup", onPointerUp);
  elements.stage.addEventListener("pointercancel", onPointerCancel);
}

function onPointerDown(event) {
  if (!state.baseLoaded || state.busy) {
    return;
  }

  commitTextEditing();

  if (state.showSuggestions) {
    state.showSuggestions = false;
    elements.suggestionsPopover.hidden = true;
  }

  const point = screenToImage(event.clientX, event.clientY);
  elements.stage.setPointerCapture(event.pointerId);
  event.preventDefault();

  if (event.button === 1 || state.spaceDown || state.tool === "pan") {
    state.gesture = {
      type: "pan",
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPanX: state.panX,
      startPanY: state.panY
    };
    updateCursor();
    return;
  }

  if (event.button !== 0) {
    return;
  }

  switch (state.tool) {
    case "select":
      startSelectGesture(point);
      break;
    case "crop":
      state.cropRect = null;
      state.gesture = { type: "crop", start: point, rect: null };
      break;
    case "pen":
      state.gesture = {
        type: "pen",
        shape: {
          id: makeShapeId(),
          type: "pen",
          points: [{ x: point.x, y: point.y }],
          color: state.color,
          strokeWidth: state.strokeWidth
        }
      };
      break;
    case "text":
      startTextShape(point);
      break;
    case "callout":
      state.gesture = {
        type: "callout",
        start: point,
        shape: {
          id: makeShapeId(),
          type: "callout",
          x: point.x + 40,
          y: point.y - 70,
          width: 170,
          height: 64,
          anchor: { x: point.x, y: point.y },
          color: state.color,
          strokeWidth: Math.max(2, state.strokeWidth),
          fontSize: state.fontSize,
          backing: state.textBacking,
          text: ""
        }
      };
      break;
    case "badge":
      placeBadge(point);
      break;
    case "stamp":
      placeStamp(point);
      break;
    case "arrow":
    case "line":
      state.gesture = {
        type: "draw",
        shape: {
          id: makeShapeId(),
          type: state.tool,
          x: point.x,
          y: point.y,
          width: 0,
          height: 0,
          color: state.color,
          strokeWidth: state.strokeWidth
        }
      };
      break;
    case "pixelate":
      state.gesture = {
        type: "draw",
        start: point,
        shape: {
          id: makeShapeId(),
          type: "pixelate",
          x: point.x,
          y: point.y,
          width: 0,
          height: 0,
          blockSize: state.pixelateBlock
        }
      };
      break;
    default:
      if (DRAG_RECT_TOOLS.includes(state.tool)) {
        state.gesture = {
          type: "draw",
          start: point,
          shape: {
            id: makeShapeId(),
            type: state.tool,
            x: point.x,
            y: point.y,
            width: 0,
            height: 0,
            color: state.tool === "redact" ? REDACTION_COLOR : currentDefaultColor(),
            strokeWidth: state.strokeWidth
          }
        };
      }
      break;
  }

  scheduleRender();
}

function startSelectGesture(point) {
  const selected = getShapeById(state.selectedId);

  if (selected) {
    const handle = handleAtPoint(selected, point);

    if (handle === "anchor") {
      state.gesture = {
        type: "anchor",
        shapeId: selected.id,
        original: cloneShape(selected),
        before: makeSnapshot(false),
        moved: false
      };
      return;
    }

    if (handle) {
      state.gesture = {
        type: "resize",
        shapeId: selected.id,
        handle,
        original: cloneShape(selected),
        originalBounds: shapeBounds(selected),
        before: makeSnapshot(false),
        moved: false
      };
      return;
    }
  }

  const hit = hitTest(point);

  if (hit) {
    state.selectedId = hit.id;
    state.gesture = {
      type: "move",
      shapeId: hit.id,
      start: point,
      original: cloneShape(hit),
      before: makeSnapshot(false),
      moved: false
    };
  } else {
    state.selectedId = null;
  }

  updatePropsBar();
}

function placeBadge(point) {
  pushHistory(false);
  const shape = {
    id: makeShapeId(),
    type: "badge",
    x: point.x,
    y: point.y,
    number: nextBadgeNumber(),
    color: state.color,
    fontSize: state.fontSize
  };
  state.shapes.push(shape);
  state.selectedId = shape.id;
  updatePropsBar();
}

function placeStamp(point) {
  pushHistory(false);
  const size = DEFAULT_STAMP_SIZE;
  const shape = {
    id: makeShapeId(),
    type: "stamp",
    x: point.x - size / 2,
    y: point.y - size / 2,
    width: size,
    height: size,
    glyph: STAMP_GLYPHS.includes(state.stampGlyph) ? state.stampGlyph : DEFAULT_STAMP_GLYPH,
    color: state.stampColor
  };
  state.shapes.push(shape);
  state.selectedId = shape.id;
  updatePropsBar();
}

function startTextShape(point) {
  const shape = {
    id: makeShapeId(),
    type: "text",
    x: point.x,
    y: point.y,
    color: state.color,
    fontSize: state.fontSize,
    backing: state.textBacking,
    text: ""
  };
  openTextEditor(shape, true);
}

function onPointerMove(event) {
  if (!state.baseLoaded) {
    return;
  }

  if (!state.gesture) {
    updateHoverCursor(event);
    return;
  }

  const gesture = state.gesture;
  const point = screenToImage(event.clientX, event.clientY);

  switch (gesture.type) {
    case "pan":
      state.panX = gesture.startPanX + (event.clientX - gesture.startClientX);
      state.panY = gesture.startPanY + (event.clientY - gesture.startClientY);
      break;
    case "crop":
      gesture.rect = clampRectToImage(normalizeRect({
        x: gesture.start.x,
        y: gesture.start.y,
        width: point.x - gesture.start.x,
        height: point.y - gesture.start.y
      }));
      break;
    case "draw":
      if (gesture.shape.type === "arrow" || gesture.shape.type === "line") {
        gesture.shape.width = point.x - gesture.shape.x;
        gesture.shape.height = point.y - gesture.shape.y;
      } else {
        const rect = normalizeRect({
          x: gesture.start.x,
          y: gesture.start.y,
          width: point.x - gesture.start.x,
          height: point.y - gesture.start.y
        });
        gesture.shape.x = rect.x;
        gesture.shape.y = rect.y;
        gesture.shape.width = rect.width;
        gesture.shape.height = rect.height;
      }
      break;
    case "pen": {
      const points = gesture.shape.points;
      const last = points[points.length - 1];
      const minStep = 1 / Math.max(state.zoom, 0.5);

      if (Math.hypot(point.x - last.x, point.y - last.y) >= minStep) {
        points.push({ x: point.x, y: point.y });
      }
      break;
    }
    case "callout":
      gesture.shape.x = point.x + 14;
      gesture.shape.y = point.y - gesture.shape.height / 2;
      gesture.moved = true;
      break;
    case "move":
      applyMove(gesture, point);
      break;
    case "resize":
      applyResize(gesture, point);
      break;
    case "anchor": {
      const shape = getShapeById(gesture.shapeId);

      if (shape) {
        shape.anchor = { x: point.x, y: point.y };
        gesture.moved = true;
      }
      break;
    }
    default:
      break;
  }

  scheduleRender();
}

function updateHoverCursor(event) {
  if (state.tool !== "select") {
    updateCursor();
    return;
  }

  const point = screenToImage(event.clientX, event.clientY);
  const selected = getShapeById(state.selectedId);
  const handle = selected ? handleAtPoint(selected, point) : null;
  updateCursor(handle || (hitTest(point) ? "move" : null));
}

function applyMove(gesture, point) {
  const shape = getShapeById(gesture.shapeId);

  if (!shape) {
    return;
  }

  const dx = point.x - gesture.start.x;
  const dy = point.y - gesture.start.y;

  if (Math.abs(dx) + Math.abs(dy) > 0.01) {
    gesture.moved = true;
  }

  translateShape(shape, gesture.original, dx, dy, false);
}

function translateShape(shape, original, dx, dy, includeAnchor) {
  if (shape.type === "pen") {
    shape.points = original.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
    return;
  }

  shape.x = original.x + dx;
  shape.y = original.y + dy;

  if (shape.type === "callout" && includeAnchor && original.anchor) {
    shape.anchor = { x: original.anchor.x + dx, y: original.anchor.y + dy };
  }
}

function applyResize(gesture, point) {
  const shape = getShapeById(gesture.shapeId);

  if (!shape) {
    return;
  }

  gesture.moved = true;

  if (shape.type === "arrow" || shape.type === "line") {
    const original = gesture.original;
    const endX = original.x + original.width;
    const endY = original.y + original.height;

    if (gesture.handle === "a") {
      shape.x = point.x;
      shape.y = point.y;
      shape.width = endX - point.x;
      shape.height = endY - point.y;
    } else {
      shape.x = original.x;
      shape.y = original.y;
      shape.width = point.x - original.x;
      shape.height = point.y - original.y;
    }
    return;
  }

  const bounds = gesture.originalBounds;
  let x1 = bounds.x;
  let y1 = bounds.y;
  let x2 = bounds.x + bounds.width;
  let y2 = bounds.y + bounds.height;
  const handle = gesture.handle;

  if (handle === "nw" || handle === "w" || handle === "sw") {
    x1 = point.x;
  }

  if (handle === "ne" || handle === "e" || handle === "se") {
    x2 = point.x;
  }

  if (handle === "nw" || handle === "n" || handle === "ne") {
    y1 = point.y;
  }

  if (handle === "sw" || handle === "s" || handle === "se") {
    y2 = point.y;
  }

  const next = normalizeRect({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
  next.width = Math.max(next.width, 2);
  next.height = Math.max(next.height, 2);

  if (shape.type === "pen") {
    const scaleX = bounds.width > 0 ? next.width / bounds.width : 1;
    const scaleY = bounds.height > 0 ? next.height / bounds.height : 1;
    shape.points = gesture.original.points.map((pt) => ({
      x: next.x + (pt.x - bounds.x) * scaleX,
      y: next.y + (pt.y - bounds.y) * scaleY
    }));
    return;
  }

  shape.x = next.x;
  shape.y = next.y;
  shape.width = next.width;
  shape.height = next.height;
}

function onPointerUp(event) {
  const gesture = state.gesture;

  if (!gesture) {
    return;
  }

  state.gesture = null;

  if (elements.stage.hasPointerCapture(event.pointerId)) {
    elements.stage.releasePointerCapture(event.pointerId);
  }

  switch (gesture.type) {
    case "crop":
      state.cropRect = gesture.rect && gesture.rect.width >= 4 && gesture.rect.height >= 4 ? gesture.rect : null;
      break;
    case "draw": {
      const shape = gesture.shape;
      const meaningful = shape.type === "arrow" || shape.type === "line"
        ? Math.hypot(shape.width, shape.height) >= 3
        : shape.width >= 3 && shape.height >= 3;

      if (meaningful) {
        pushHistory(false);
        state.shapes.push(shape);

        if (shape.type !== "redact" && shape.type !== "highlight") {
          state.selectedId = shape.id;
        }
      }
      break;
    }
    case "pen":
      if (gesture.shape.points.length >= 2) {
        pushHistory(false);
        state.shapes.push(gesture.shape);
      }
      break;
    case "callout": {
      const shape = gesture.shape;

      if (!gesture.moved) {
        shape.x = shape.anchor.x + 40;
        shape.y = shape.anchor.y - 70;
      }

      openTextEditor(shape, true);
      break;
    }
    case "move":
    case "resize":
    case "anchor":
      if (gesture.moved) {
        commitHistory(gesture.before);
      }
      break;
    default:
      break;
  }

  updatePropsBar();
  updateCursor();
  scheduleRender();
}

function onPointerCancel(event) {
  if (state.gesture && elements.stage.hasPointerCapture(event.pointerId)) {
    elements.stage.releasePointerCapture(event.pointerId);
  }

  if (state.gesture && (state.gesture.type === "move" || state.gesture.type === "resize" || state.gesture.type === "anchor")) {
    void restoreSnapshot(state.gesture.before);
  }

  state.gesture = null;
  scheduleRender();
}

function onDoubleClick(event) {
  if (state.tool !== "select" || !state.baseLoaded) {
    return;
  }

  const point = screenToImage(event.clientX, event.clientY);
  const hit = hitTest(point);

  if (!hit) {
    return;
  }

  state.selectedId = hit.id;

  if (hit.type === "text" || hit.type === "callout") {
    openTextEditor(hit, false);
  } else if (hit.type === "badge") {
    openBadgeEditor(hit);
  }

  updatePropsBar();
  scheduleRender();
}

/* ===================== Hit testing / handles ===================== */

function hitTest(point) {
  const tolerance = Math.max(6 / state.zoom, 3);

  for (let index = state.shapes.length - 1; index >= 0; index -= 1) {
    const shape = state.shapes[index];

    if (shape.hidden) {
      continue;
    }

    if (shapeContainsPoint(shape, point, tolerance)) {
      return shape;
    }
  }

  return null;
}

function shapeContainsPoint(shape, point, tolerance) {
  const stroke = (shape.strokeWidth || DEFAULT_STROKE) / 2;

  switch (shape.type) {
    case "arrow":
    case "line":
      return segmentDistance(point, { x: shape.x, y: shape.y }, { x: shape.x + shape.width, y: shape.y + shape.height }) <=
        Math.max(tolerance, stroke + 2);
    case "pen": {
      const points = shape.points || [];

      for (let index = 0; index < points.length - 1; index += 1) {
        if (segmentDistance(point, points[index], points[index + 1]) <= Math.max(tolerance, stroke + 2)) {
          return true;
        }
      }

      return false;
    }
    case "box": {
      const rect = shapeBounds(shape);
      const pad = Math.max(tolerance, stroke + 2);
      const outer = pointInRect(point, expandRect(rect, pad));
      const inner = pointInRect(point, expandRect(rect, -pad));
      return outer && !inner;
    }
    case "ellipse": {
      const rect = shapeBounds(shape);
      const rx = rect.width / 2;
      const ry = rect.height / 2;

      if (rx < 1 || ry < 1) {
        return false;
      }

      const nx = (point.x - (rect.x + rx)) / rx;
      const ny = (point.y - (rect.y + ry)) / ry;
      const radial = Math.sqrt(nx * nx + ny * ny);
      const band = Math.max(tolerance, stroke + 2) / Math.min(rx, ry);
      return Math.abs(radial - 1) <= band;
    }
    case "highlight":
    case "redact":
    case "pixelate":
    case "stamp":
      return pointInRect(point, shapeBounds(shape));
    case "text":
      return pointInRect(point, expandRect(shapeBounds(shape), 3));
    case "callout": {
      const rect = normalizeRect({ x: shape.x, y: shape.y, width: shape.width, height: shape.height });

      if (pointInRect(point, expandRect(rect, 2))) {
        return true;
      }

      if (shape.anchor) {
        const edge = calloutLeaderStart(rect, shape.anchor);

        if (edge && segmentDistance(point, edge, shape.anchor) <= tolerance) {
          return true;
        }

        if (Math.hypot(point.x - shape.anchor.x, point.y - shape.anchor.y) <= tolerance * 1.5) {
          return true;
        }
      }

      return false;
    }
    case "badge":
      return Math.hypot(point.x - shape.x, point.y - shape.y) <= badgeRadius(shape) + tolerance / 2;
    default:
      return false;
  }
}

function pointInRect(point, rect) {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function expandRect(rect, amount) {
  return {
    x: rect.x - amount,
    y: rect.y - amount,
    width: Math.max(0, rect.width + amount * 2),
    height: Math.max(0, rect.height + amount * 2)
  };
}

function segmentDistance(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) {
    return Math.hypot(point.x - a.x, point.y - a.y);
  }

  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  t = clampNumber(t, 0, 1);
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function getHandles(shape) {
  if (shape.type === "arrow" || shape.type === "line") {
    return [
      { id: "a", x: shape.x, y: shape.y },
      { id: "b", x: shape.x + shape.width, y: shape.y + shape.height }
    ];
  }

  if (shape.type === "text" || shape.type === "badge") {
    return [];
  }

  const rect = shape.type === "callout"
    ? normalizeRect({ x: shape.x, y: shape.y, width: shape.width, height: shape.height })
    : shapeBounds(shape);
  const midX = rect.x + rect.width / 2;
  const midY = rect.y + rect.height / 2;
  const handles = [
    { id: "nw", x: rect.x, y: rect.y },
    { id: "n", x: midX, y: rect.y },
    { id: "ne", x: rect.x + rect.width, y: rect.y },
    { id: "e", x: rect.x + rect.width, y: midY },
    { id: "se", x: rect.x + rect.width, y: rect.y + rect.height },
    { id: "s", x: midX, y: rect.y + rect.height },
    { id: "sw", x: rect.x, y: rect.y + rect.height },
    { id: "w", x: rect.x, y: midY }
  ];

  if (shape.type === "callout" && shape.anchor) {
    handles.push({ id: "anchor", x: shape.anchor.x, y: shape.anchor.y });
  }

  return handles;
}

function handleAtPoint(shape, point) {
  const radius = 7 / state.zoom;
  const handles = getHandles(shape);

  for (const handle of handles) {
    if (Math.hypot(point.x - handle.x, point.y - handle.y) <= radius) {
      return handle.id;
    }
  }

  return null;
}

/* ===================== Keyboard ===================== */

function bindKeyboard() {
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", (event) => {
    if (event.key === " ") {
      state.spaceDown = false;
      updateCursor();
    }
  });
}

function isTypingTarget(target) {
  if (!target) {
    return false;
  }

  const tag = target.tagName;
  return tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT" || target.isContentEditable;
}

function onKeyDown(event) {
  if (isTypingTarget(event.target)) {
    return;
  }

  const key = event.key;
  const lower = key.toLowerCase();
  const ctrl = event.ctrlKey || event.metaKey;

  if (ctrl && lower === "z" && !event.shiftKey) {
    event.preventDefault();
    void undo();
    return;
  }

  if (ctrl && (lower === "y" || (lower === "z" && event.shiftKey))) {
    event.preventDefault();
    void redo();
    return;
  }

  if (ctrl && lower === "s") {
    event.preventDefault();
    void doSave();
    return;
  }

  if (ctrl) {
    return;
  }

  if (key === " ") {
    if (!state.spaceDown) {
      state.spaceDown = true;
      updateCursor();
    }

    event.preventDefault();
    return;
  }

  if (key === "+" || key === "=") {
    zoomBy(1.25);
    return;
  }

  if (key === "-" || key === "_") {
    zoomBy(1 / 1.25);
    return;
  }

  if (key === "0") {
    fitToWindow();
    return;
  }

  if (key === "Escape") {
    if (!elements.suggestionsPopover.hidden) {
      state.showSuggestions = false;
      elements.suggestionsPopover.hidden = true;
    } else if (state.cropRect) {
      state.cropRect = null;
    } else {
      state.selectedId = null;
    }

    updatePropsBar();
    scheduleRender();
    return;
  }

  if (key === "Delete" || key === "Backspace") {
    if (state.selectedId) {
      event.preventDefault();
      pushHistory(false);
      removeShape(state.selectedId);
      updatePropsBar();
      scheduleRender();
    }
    return;
  }

  if (key === "Enter" && state.tool === "crop" && state.cropRect) {
    event.preventDefault();
    void applyCrop();
    return;
  }

  if (key.startsWith("Arrow") && state.selectedId) {
    event.preventDefault();
    nudgeSelection(key, event.shiftKey ? 10 : 1);
    return;
  }

  if (TOOL_SHORTCUTS[lower] && !event.altKey) {
    setTool(TOOL_SHORTCUTS[lower]);
  }
}

function nudgeSelection(arrowKey, step) {
  const shape = getShapeById(state.selectedId);

  if (!shape) {
    return;
  }

  const now = Date.now();
  const isNewBurst =
    !state.lastNudge || state.lastNudge.shapeId !== shape.id || now - state.lastNudge.time > 900;

  if (isNewBurst) {
    pushHistory(false);
  }

  state.lastNudge = { shapeId: shape.id, time: now };

  const dx = arrowKey === "ArrowLeft" ? -step : arrowKey === "ArrowRight" ? step : 0;
  const dy = arrowKey === "ArrowUp" ? -step : arrowKey === "ArrowDown" ? step : 0;
  translateShape(shape, cloneShape(shape), dx, dy, true);
  state.dirty = true;
  scheduleRender();
}

/* ===================== Text / number overlays ===================== */

function openTextEditor(shape, isNew) {
  commitTextEditing();

  const textarea = document.createElement("textarea");
  textarea.className = "overlay-textarea";
  textarea.value = shape.text || "";
  textarea.spellcheck = false;
  elements.overlayLayer.appendChild(textarea);

  state.editing = {
    kind: "text",
    shape,
    isNew,
    textarea,
    originalText: shape.text || "",
    before: makeSnapshot(false),
    committed: false
  };

  shape.hidden = true;
  positionTextOverlay();
  scheduleRender();

  window.setTimeout(() => {
    textarea.focus();
    textarea.select();
  }, 0);

  textarea.addEventListener("blur", () => commitTextEditing());
  textarea.addEventListener("keydown", (event) => {
    event.stopPropagation();

    if (event.key === "Escape" || (event.key === "Enter" && (event.ctrlKey || event.metaKey))) {
      event.preventDefault();
      commitTextEditing();
    }
  });
  textarea.addEventListener("input", () => positionTextOverlay());
}

function positionTextOverlay() {
  const editing = state.editing;

  if (!editing || editing.kind !== "text") {
    return;
  }

  const shape = editing.shape;
  const fontSize = (shape.fontSize || DEFAULT_FONT_SIZE) * state.zoom;
  const textarea = editing.textarea;
  const value = textarea.value || shape.text || "";
  const measured = measureTextBlock(value || "Mg", shape.fontSize || DEFAULT_FONT_SIZE);

  let screen;
  let width;
  let height;

  if (shape.type === "callout") {
    const rect = normalizeRect({ x: shape.x, y: shape.y, width: shape.width, height: shape.height });
    screen = imageToScreen(rect.x, rect.y);
    width = Math.max(rect.width * state.zoom, (measured.width + 24) * state.zoom);
    height = Math.max(rect.height * state.zoom, (measured.height + 18) * state.zoom);
  } else {
    screen = imageToScreen(shape.x, shape.y);
    width = Math.max(140, (measured.width + 30) * state.zoom);
    height = Math.max(fontSize * 1.6, (measured.height + 10) * state.zoom);
  }

  textarea.style.left = `${Math.round(screen.x - 4)}px`;
  textarea.style.top = `${Math.round(screen.y - 4)}px`;
  textarea.style.width = `${Math.round(width)}px`;
  textarea.style.height = `${Math.round(height)}px`;
  textarea.style.fontSize = `${fontSize}px`;
  textarea.style.color = shape.type === "callout" ? "#2d261c" : shape.color || state.color;
}

function commitTextEditing() {
  const editing = state.editing;

  if (!editing || editing.kind !== "text" || editing.committed) {
    if (editing && editing.kind === "number") {
      commitBadgeEditing();
    }
    return;
  }

  editing.committed = true;
  const value = editing.textarea.value.replace(/\s+$/u, "");
  editing.textarea.remove();
  state.editing = null;

  const shape = editing.shape;
  delete shape.hidden;

  if (editing.isNew) {
    if (value.trim()) {
      shape.text = value;
      commitHistory(editing.before);
      state.shapes.push(shape);
      state.selectedId = shape.id;
    }
  } else if (!value.trim()) {
    commitHistory(editing.before);
    removeShape(shape.id);
  } else if (value !== editing.originalText) {
    commitHistory(editing.before);
    shape.text = value;
  }

  updatePropsBar();
  scheduleRender();
}

function cancelTextEditing() {
  const editing = state.editing;

  if (!editing) {
    return;
  }

  if (editing.kind === "text") {
    editing.committed = true;
    editing.textarea.remove();
    delete editing.shape.hidden;
  } else if (editing.kind === "number") {
    editing.committed = true;
    editing.input.remove();
  }

  state.editing = null;
  scheduleRender();
}

function openBadgeEditor(shape) {
  commitTextEditing();

  const input = document.createElement("input");
  input.type = "number";
  input.className = "overlay-number";
  input.min = "1";
  input.value = String(shape.number || 1);
  elements.overlayLayer.appendChild(input);

  const screen = imageToScreen(shape.x, shape.y);
  input.style.left = `${Math.round(screen.x - 32)}px`;
  input.style.top = `${Math.round(screen.y + badgeRadius(shape) * state.zoom + 8)}px`;

  state.editing = {
    kind: "number",
    shape,
    input,
    before: makeSnapshot(false),
    originalNumber: shape.number,
    committed: false
  };

  window.setTimeout(() => {
    input.focus();
    input.select();
  }, 0);

  input.addEventListener("blur", () => commitBadgeEditing());
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();

    if (event.key === "Enter") {
      event.preventDefault();
      commitBadgeEditing();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelTextEditing();
    }
  });
}

function commitBadgeEditing() {
  const editing = state.editing;

  if (!editing || editing.kind !== "number" || editing.committed) {
    return;
  }

  editing.committed = true;
  const value = Math.max(1, Math.round(Number(editing.input.value) || editing.originalNumber || 1));
  editing.input.remove();
  state.editing = null;

  if (value !== editing.originalNumber) {
    commitHistory(editing.before);
    editing.shape.number = value;
  }

  scheduleRender();
}

/* ===================== Crop ===================== */

function clampRectToImage(rect) {
  const x = clampNumber(rect.x, 0, state.baseCanvas.width);
  const y = clampNumber(rect.y, 0, state.baseCanvas.height);
  const right = clampNumber(rect.x + rect.width, 0, state.baseCanvas.width);
  const bottom = clampNumber(rect.y + rect.height, 0, state.baseCanvas.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

async function applyCrop() {
  const rect = state.cropRect;

  if (!rect || rect.width < 4 || rect.height < 4) {
    setStatus("Drag a crop region first, then apply.", "warn");
    return;
  }

  commitTextEditing();

  const crop = {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height))
  };

  pushHistory(true);

  const nextCanvas = document.createElement("canvas");
  nextCanvas.width = crop.width;
  nextCanvas.height = crop.height;
  nextCanvas.getContext("2d").drawImage(
    state.baseCanvas,
    crop.x, crop.y, crop.width, crop.height,
    0, 0, crop.width, crop.height
  );
  setBaseBitmap(nextCanvas);

  const imageRect = { x: 0, y: 0, width: crop.width, height: crop.height };

  state.shapes = state.shapes.filter((shape) => {
    translateShape(shape, cloneShape(shape), -crop.x, -crop.y, true);
    return rectsIntersect(shapeBounds(shape), imageRect);
  });

  state.sensitiveRects = state.sensitiveRects
    .map((sensitive) => {
      const moved = { ...sensitive, x: sensitive.x - crop.x, y: sensitive.y - crop.y };
      const left = Math.max(0, moved.x);
      const top = Math.max(0, moved.y);
      const right = Math.min(crop.width, moved.x + moved.width);
      const bottom = Math.min(crop.height, moved.y + moved.height);

      if (right - left < 2 || bottom - top < 2) {
        return null;
      }

      return { ...moved, x: left, y: top, width: right - left, height: bottom - top };
    })
    .filter(Boolean);

  state.cropRect = null;
  state.selectedId = null;
  fitToWindow();
  updateAllUi();
  setStatus(`Cropped to ${crop.width} × ${crop.height} px.`, "success");
}

/* ===================== Suggested redactions ===================== */

function updateSuggestionsButton() {
  const count = state.sensitiveRects.length;
  elements.suggestionsButton.hidden = count === 0;
  elements.suggestionsButton.disabled = state.suggestionsApplied;
  elements.suggestionsButton.textContent = state.suggestionsApplied
    ? "Suggested Redactions applied"
    : `Suggested Redactions (${count})`;

  if (count === 0 || state.suggestionsApplied) {
    state.showSuggestions = false;
    elements.suggestionsPopover.hidden = true;
  }
}

function suggestionKindColor(kind) {
  const kinds = [];

  state.sensitiveRects.forEach((rect) => {
    const key = rect.kind || "item";

    if (!kinds.includes(key)) {
      kinds.push(key);
    }
  });

  const index = kinds.indexOf(kind || "item");
  return SUGGESTION_KIND_COLORS[Math.max(0, index) % SUGGESTION_KIND_COLORS.length];
}

function toggleSuggestions() {
  if (state.sensitiveRects.length === 0 || state.suggestionsApplied) {
    return;
  }

  state.showSuggestions = !state.showSuggestions;
  elements.suggestionsPopover.hidden = !state.showSuggestions;

  if (state.showSuggestions) {
    renderSuggestionsList();
  }

  scheduleRender();
}

function renderSuggestionsList() {
  const counts = new Map();

  state.sensitiveRects.forEach((rect) => {
    const key = rect.kind || "item";
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  elements.suggestionsList.textContent = "";

  counts.forEach((count, kind) => {
    const item = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "suggestion-dot";
    dot.style.background = `${suggestionKindColor(kind)}33`;
    dot.style.borderColor = suggestionKindColor(kind);

    const label = document.createElement("span");
    const kindLabel = document.createElement("span");
    kindLabel.className = "suggestion-kind";
    kindLabel.textContent = kind;
    label.appendChild(kindLabel);
    label.appendChild(document.createTextNode(` — ${count} region${count === 1 ? "" : "s"}`));

    item.appendChild(dot);
    item.appendChild(label);
    elements.suggestionsList.appendChild(item);
  });
}

function applyAllSuggestions() {
  if (state.sensitiveRects.length === 0 || state.suggestionsApplied) {
    return;
  }

  pushHistory(false);

  state.sensitiveRects.forEach((rect) => {
    state.shapes.push({
      id: makeShapeId(),
      type: "redact",
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      color: REDACTION_COLOR
    });
  });

  state.suggestionsApplied = true;
  state.showSuggestions = false;
  elements.suggestionsPopover.hidden = true;
  updateSuggestionsButton();
  scheduleRender();
  setStatus(`Added ${state.sensitiveRects.length} redaction block${state.sensitiveRects.length === 1 ? "" : "s"}. They burn in on save.`, "success");
}

/* ===================== Rendering ===================== */

function scheduleRender() {
  if (state.renderQueued) {
    return;
  }

  state.renderQueued = true;
  window.requestAnimationFrame(() => {
    state.renderQueued = false;
    render();
  });
}

function render() {
  const canvas = elements.stage;
  const ctx = elements.stageContext;
  const dpr = window.devicePixelRatio || 1;
  const width = elements.workspace.clientWidth;
  const height = elements.workspace.clientHeight;
  const deviceWidth = Math.max(1, Math.round(width * dpr));
  const deviceHeight = Math.max(1, Math.round(height * dpr));

  if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
    canvas.width = deviceWidth;
    canvas.height = deviceHeight;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (!state.baseLoaded) {
    return;
  }

  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.zoom, state.zoom);
  ctx.imageSmoothingEnabled = state.zoom < 2;
  ctx.imageSmoothingQuality = "high";

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, state.baseCanvas.width, state.baseCanvas.height);
  ctx.drawImage(state.baseCanvas, 0, 0);

  state.shapes.forEach((shape) => {
    if (!shape.hidden) {
      drawShape(ctx, shape);
    }
  });

  if (state.gesture && (state.gesture.type === "draw" || state.gesture.type === "pen" || state.gesture.type === "callout")) {
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * 0.92;
    drawShape(ctx, state.gesture.shape);
    ctx.restore();
  }

  if (state.showSuggestions && !state.suggestionsApplied) {
    drawSuggestionOverlays(ctx);
  }

  const cropPreview = state.gesture && state.gesture.type === "crop" ? state.gesture.rect : state.cropRect;

  if (cropPreview && cropPreview.width > 0 && cropPreview.height > 0) {
    drawCropOverlay(ctx, cropPreview);
  }

  drawSelection(ctx);

  ctx.lineWidth = 1 / state.zoom;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
  ctx.strokeRect(0, 0, state.baseCanvas.width, state.baseCanvas.height);

  ctx.restore();
  positionTextOverlay();
}

function drawShape(ctx, shape) {
  switch (shape.type) {
    case "arrow":
      drawArrow(ctx, shape);
      break;
    case "line":
      drawLine(ctx, shape);
      break;
    case "box":
      drawBox(ctx, shape);
      break;
    case "ellipse":
      drawEllipse(ctx, shape);
      break;
    case "pen":
      drawPen(ctx, shape);
      break;
    case "highlight":
      drawHighlight(ctx, shape);
      break;
    case "text":
      drawText(ctx, shape);
      break;
    case "callout":
      drawCallout(ctx, shape);
      break;
    case "badge":
      drawBadge(ctx, shape);
      break;
    case "redact":
      drawRedact(ctx, shape);
      break;
    case "pixelate":
      drawPixelate(ctx, shape);
      break;
    case "stamp":
      drawStamp(ctx, shape);
      break;
    default:
      break;
  }
}

function drawArrow(ctx, shape) {
  const x1 = shape.x;
  const y1 = shape.y;
  const x2 = shape.x + shape.width;
  const y2 = shape.y + shape.height;
  const stroke = Math.max(1, shape.strokeWidth || DEFAULT_STROKE);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(10, stroke * 3.2);

  ctx.save();
  ctx.strokeStyle = shape.color || DEFAULT_COLOR;
  ctx.fillStyle = shape.color || DEFAULT_COLOR;
  ctx.lineWidth = stroke;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2 - Math.cos(angle) * head * 0.7, y2 - Math.sin(angle) * head * 0.7);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - Math.cos(angle - 0.45) * head, y2 - Math.sin(angle - 0.45) * head);
  ctx.lineTo(x2 - Math.cos(angle + 0.45) * head, y2 - Math.sin(angle + 0.45) * head);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawLine(ctx, shape) {
  ctx.save();
  ctx.strokeStyle = shape.color || DEFAULT_COLOR;
  ctx.lineWidth = Math.max(1, shape.strokeWidth || DEFAULT_STROKE);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(shape.x, shape.y);
  ctx.lineTo(shape.x + shape.width, shape.y + shape.height);
  ctx.stroke();
  ctx.restore();
}

function drawBox(ctx, shape) {
  const rect = shapeBounds(shape);
  ctx.save();
  ctx.strokeStyle = shape.color || DEFAULT_COLOR;
  ctx.lineWidth = Math.max(1, shape.strokeWidth || DEFAULT_STROKE);
  ctx.lineJoin = "round";
  roundedRectPath(ctx, rect.x, rect.y, rect.width, rect.height, 6);
  ctx.stroke();
  ctx.restore();
}

function drawEllipse(ctx, shape) {
  const rect = shapeBounds(shape);
  ctx.save();
  ctx.strokeStyle = shape.color || DEFAULT_COLOR;
  ctx.lineWidth = Math.max(1, shape.strokeWidth || DEFAULT_STROKE);
  ctx.beginPath();
  ctx.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, Math.max(1, rect.width / 2), Math.max(1, rect.height / 2), 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawPen(ctx, shape) {
  const points = shape.points || [];

  if (points.length === 0) {
    return;
  }

  ctx.save();
  ctx.strokeStyle = shape.color || DEFAULT_COLOR;
  ctx.lineWidth = Math.max(1, shape.strokeWidth || DEFAULT_STROKE);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);

  for (let index = 1; index < points.length; index += 1) {
    ctx.lineTo(points[index].x, points[index].y);
  }

  ctx.stroke();
  ctx.restore();
}

function drawHighlight(ctx, shape) {
  const rect = shapeBounds(shape);
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.globalAlpha = HIGHLIGHT_ALPHA;
  ctx.fillStyle = shape.color || DEFAULT_HIGHLIGHT_COLOR;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function backingFill(backing) {
  if (backing === "dark") {
    return "rgba(17, 17, 17, 0.72)";
  }

  return "rgba(255, 255, 255, 0.82)";
}

function drawTextBackingPill(ctx, shape, backing) {
  const fontSize = shape.fontSize || DEFAULT_FONT_SIZE;
  const size = measureTextBlock(shape.text, fontSize);
  const padX = Math.max(5, fontSize * 0.35);
  const padY = Math.max(3, fontSize * 0.2);
  const radius = Math.max(4, fontSize * 0.3);

  ctx.save();
  ctx.fillStyle = backingFill(backing);
  roundedRectPath(
    ctx,
    shape.x - padX,
    shape.y - padY,
    size.width + padX * 2,
    size.height + padY * 2,
    radius
  );
  ctx.fill();
  ctx.restore();
}

function drawText(ctx, shape) {
  const fontSize = shape.fontSize || DEFAULT_FONT_SIZE;
  const lines = String(shape.text || "").split("\n");
  const backing = textBackingOf(shape);

  if (backing !== "none") {
    drawTextBackingPill(ctx, shape, backing);
  }

  ctx.save();
  ctx.font = `600 ${fontSize}px ${TEXT_FONT_FAMILY}`;
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";

  // The pill already guarantees legibility; only fall back to the white halo
  // when there is no backing so previously-saved annotations look unchanged.
  if (backing === "none") {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.88)";
    ctx.lineWidth = Math.max(2, fontSize / 6);
  }

  ctx.fillStyle = shape.color || DEFAULT_COLOR;

  lines.forEach((line, index) => {
    const y = shape.y + index * fontSize * 1.25;

    if (backing === "none") {
      ctx.strokeText(line, shape.x, y);
    }

    ctx.fillText(line, shape.x, y);
  });

  ctx.restore();
}

function calloutLeaderStart(rect, anchor) {
  const edgeX = clampNumber(anchor.x, rect.x, rect.x + rect.width);
  const edgeY = clampNumber(anchor.y, rect.y, rect.y + rect.height);

  if (edgeX === anchor.x && edgeY === anchor.y) {
    return null;
  }

  return { x: edgeX, y: edgeY };
}

function drawCallout(ctx, shape) {
  const rect = normalizeRect({ x: shape.x, y: shape.y, width: shape.width, height: shape.height });
  const stroke = Math.max(2, shape.strokeWidth || DEFAULT_STROKE);
  const fontSize = shape.fontSize || DEFAULT_FONT_SIZE;
  const color = shape.color || DEFAULT_COLOR;
  const dark = textBackingOf(shape) === "dark";

  ctx.save();

  if (shape.anchor) {
    const edge = calloutLeaderStart(rect, shape.anchor);

    if (edge) {
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1.5, stroke * 0.75);
      ctx.beginPath();
      ctx.moveTo(edge.x, edge.y);
      ctx.lineTo(shape.anchor.x, shape.anchor.y);
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(shape.anchor.x, shape.anchor.y, Math.max(3, stroke * 0.9), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.fillStyle = dark ? "rgba(17, 17, 17, 0.78)" : "rgba(255, 253, 247, 0.96)";
  ctx.strokeStyle = color;
  ctx.lineWidth = stroke;
  roundedRectPath(ctx, rect.x, rect.y, rect.width, rect.height, 10);
  ctx.fill();
  ctx.stroke();

  if (shape.text) {
    ctx.font = `600 ${fontSize}px ${TEXT_FONT_FAMILY}`;
    ctx.textBaseline = "top";
    ctx.fillStyle = dark ? "#ffffff" : "#2d261c";
    const padding = 9;
    const lines = String(shape.text).split("\n");

    ctx.beginPath();
    ctx.rect(rect.x + 2, rect.y + 2, Math.max(0, rect.width - 4), Math.max(0, rect.height - 4));
    ctx.clip();

    lines.forEach((line, index) => {
      ctx.fillText(line, rect.x + padding, rect.y + padding + index * fontSize * 1.25);
    });
  }

  ctx.restore();
}

function drawBadge(ctx, shape) {
  const radius = badgeRadius(shape);
  const fontSize = shape.fontSize || DEFAULT_FONT_SIZE;

  ctx.save();
  ctx.fillStyle = shape.color || DEFAULT_COLOR;
  ctx.beginPath();
  ctx.arc(shape.x, shape.y, radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
  ctx.lineWidth = Math.max(1.5, radius * 0.12);
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${fontSize}px ${TEXT_FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(shape.number || 1), shape.x, shape.y + fontSize * 0.05);
  ctx.restore();
}

function drawRedact(ctx, shape) {
  const rect = shapeBounds(shape);
  ctx.save();
  ctx.fillStyle = shape.color || REDACTION_COLOR;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function pixelateBlockSize(shape) {
  return clampNumber(Math.round(shape.blockSize || DEFAULT_PIXELATE_BLOCK), MIN_PIXELATE_BLOCK, MAX_PIXELATE_BLOCK);
}

// Samples the base bitmap under `rect` and paints a coarse mosaic of it onto
// `ctx` (in image-space coordinates), clipped to the rect. Shared by the live
// renderer and the save burn-in so the on-screen and baked output match.
function mosaicRegion(ctx, source, rect, blockSize) {
  const sx = Math.max(0, Math.floor(rect.x));
  const sy = Math.max(0, Math.floor(rect.y));
  const sw = Math.min(source.width - sx, Math.ceil(rect.x + rect.width) - sx);
  const sh = Math.min(source.height - sy, Math.ceil(rect.y + rect.height) - sy);

  if (sw < 1 || sh < 1) {
    return;
  }

  const block = clampNumber(Math.round(blockSize || DEFAULT_PIXELATE_BLOCK), MIN_PIXELATE_BLOCK, MAX_PIXELATE_BLOCK);
  const smallWidth = Math.max(1, Math.ceil(sw / block));
  const smallHeight = Math.max(1, Math.ceil(sh / block));

  mosaicCanvas.width = smallWidth;
  mosaicCanvas.height = smallHeight;
  mosaicContext.imageSmoothingEnabled = false;
  mosaicContext.clearRect(0, 0, smallWidth, smallHeight);
  mosaicContext.drawImage(source, sx, sy, sw, sh, 0, 0, smallWidth, smallHeight);

  ctx.save();
  ctx.beginPath();
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.clip();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(mosaicCanvas, 0, 0, smallWidth, smallHeight, sx, sy, sw, sh);
  ctx.restore();
}

function drawPixelate(ctx, shape) {
  const rect = shapeBounds(shape);

  if (rect.width < 1 || rect.height < 1) {
    return;
  }

  mosaicRegion(ctx, state.baseCanvas, rect, pixelateBlockSize(shape));
}

function drawStamp(ctx, shape) {
  const rect = shapeBounds(shape);

  if (rect.width < 1 || rect.height < 1) {
    return;
  }

  drawStampGlyph(ctx, shape.glyph || DEFAULT_STAMP_GLYPH, rect.x, rect.y, rect.width, rect.height, shape.color || DEFAULT_STAMP_COLOR, true);
}

// Draws one stamp glyph as crisp vector paths fitted to the given bbox. When
// `halo` is true a soft white outline is laid down first so it reads on any
// background (mirrors the white outline on badges/text). Reused at small size
// to render the glyph-picker thumbnails.
function drawStampGlyph(ctx, glyph, x, y, width, height, color, halo) {
  const size = Math.min(width, height);
  const cx = x + width / 2;
  const cy = y + height / 2;
  const haloWidth = Math.max(1, size * 0.16);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const strokeGlyph = (drawPath, lineWidth) => {
    ctx.beginPath();
    drawPath();

    if (halo) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
      ctx.lineWidth = lineWidth + haloWidth;
      ctx.stroke();
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  };

  const fillGlyph = (drawPath) => {
    ctx.beginPath();
    drawPath();

    if (halo) {
      ctx.lineWidth = haloWidth;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
      ctx.stroke();
    }

    ctx.fillStyle = color;
    ctx.fill();
  };

  switch (glyph) {
    case "cross": {
      const lineWidth = Math.max(2, size * 0.18);
      const arm = size * 0.3;
      strokeGlyph(() => {
        ctx.moveTo(cx - arm, cy - arm);
        ctx.lineTo(cx + arm, cy + arm);
        ctx.moveTo(cx + arm, cy - arm);
        ctx.lineTo(cx - arm, cy + arm);
      }, lineWidth);
      break;
    }
    case "star": {
      const outer = size * 0.42;
      const inner = outer * 0.42;
      fillGlyph(() => {
        for (let i = 0; i < 10; i += 1) {
          const radius = i % 2 === 0 ? outer : inner;
          const angle = -Math.PI / 2 + (i * Math.PI) / 5;
          const px = cx + Math.cos(angle) * radius;
          const py = cy + Math.sin(angle) * radius;

          if (i === 0) {
            ctx.moveTo(px, py);
          } else {
            ctx.lineTo(px, py);
          }
        }

        ctx.closePath();
      });
      break;
    }
    case "dot": {
      fillGlyph(() => {
        ctx.arc(cx, cy, size * 0.34, 0, Math.PI * 2);
      });
      break;
    }
    case "question":
    case "exclaim": {
      const radius = size * 0.44;
      fillGlyph(() => {
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      });
      ctx.fillStyle = "#ffffff";
      ctx.font = `800 ${size * 0.62}px ${TEXT_FONT_FAMILY}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(glyph === "question" ? "?" : "!", cx, cy + size * 0.04);
      break;
    }
    case "arrow-right": {
      const halfH = size * 0.22;
      const headW = size * 0.32;
      const tailW = size * 0.16;
      const left = cx - size * 0.4;
      const right = cx + size * 0.4;
      fillGlyph(() => {
        ctx.moveTo(left, cy - tailW);
        ctx.lineTo(right - headW, cy - tailW);
        ctx.lineTo(right - headW, cy - halfH);
        ctx.lineTo(right, cy);
        ctx.lineTo(right - headW, cy + halfH);
        ctx.lineTo(right - headW, cy + tailW);
        ctx.lineTo(left, cy + tailW);
        ctx.closePath();
      });
      break;
    }
    case "check":
    default: {
      const lineWidth = Math.max(2, size * 0.18);
      strokeGlyph(() => {
        ctx.moveTo(cx - size * 0.32, cy + size * 0.02);
        ctx.lineTo(cx - size * 0.08, cy + size * 0.28);
        ctx.lineTo(cx + size * 0.34, cy - size * 0.28);
      }, lineWidth);
      break;
    }
  }

  ctx.restore();
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawSuggestionOverlays(ctx) {
  ctx.save();
  ctx.lineWidth = 2 / state.zoom;
  ctx.setLineDash([8 / state.zoom, 5 / state.zoom]);
  ctx.font = `700 ${12 / state.zoom}px ${TEXT_FONT_FAMILY}`;
  ctx.textBaseline = "bottom";

  state.sensitiveRects.forEach((rect) => {
    const color = suggestionKindColor(rect.kind || "item");
    ctx.fillStyle = `${color}22`;
    ctx.strokeStyle = color;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.fillStyle = color;
    ctx.fillText(`${rect.kind || "item"}${rect.label ? `: ${rect.label}` : ""}`, rect.x, rect.y - 3 / state.zoom);
  });

  ctx.restore();
}

function drawCropOverlay(ctx, rect) {
  ctx.save();
  ctx.fillStyle = "rgba(20, 16, 10, 0.5)";
  ctx.beginPath();
  ctx.rect(0, 0, state.baseCanvas.width, state.baseCanvas.height);
  ctx.rect(rect.x, rect.y, rect.width, rect.height);
  ctx.fill("evenodd");

  ctx.strokeStyle = "#0f766e";
  ctx.lineWidth = 2 / state.zoom;
  ctx.setLineDash([8 / state.zoom, 6 / state.zoom]);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

  ctx.setLineDash([]);
  ctx.font = `700 ${12 / state.zoom}px ${TEXT_FONT_FAMILY}`;
  ctx.fillStyle = "#d6f1ed";
  ctx.textBaseline = "bottom";
  ctx.fillText(`${Math.round(rect.width)} × ${Math.round(rect.height)}`, rect.x, rect.y - 4 / state.zoom);
  ctx.restore();
}

function drawSelection(ctx) {
  const shape = getShapeById(state.selectedId);

  if (!shape || shape.hidden) {
    return;
  }

  const lineWidth = 1.5 / state.zoom;
  const pad = 4 / state.zoom;
  const handleSize = 8 / state.zoom;

  ctx.save();
  ctx.strokeStyle = "#0f766e";
  ctx.lineWidth = lineWidth;

  if (shape.type !== "arrow" && shape.type !== "line") {
    const rect = shape.type === "callout"
      ? normalizeRect({ x: shape.x, y: shape.y, width: shape.width, height: shape.height })
      : shapeBounds(shape);
    ctx.setLineDash([6 / state.zoom, 4 / state.zoom]);
    ctx.strokeRect(rect.x - pad, rect.y - pad, rect.width + pad * 2, rect.height + pad * 2);
    ctx.setLineDash([]);
  }

  getHandles(shape).forEach((handle) => {
    ctx.fillStyle = handle.id === "anchor" ? "#0f766e" : "#ffffff";
    ctx.strokeStyle = handle.id === "anchor" ? "#ffffff" : "#0f766e";

    if (handle.id === "anchor" || handle.id === "a" || handle.id === "b") {
      ctx.beginPath();
      ctx.arc(handle.x, handle.y, handleSize * 0.65, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize);
      ctx.strokeRect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize);
    }
  });

  ctx.restore();
}

/* ===================== Save / Cancel ===================== */

function renderFlattened() {
  const width = state.baseCanvas.width;
  const height = state.baseCanvas.height;

  const burnedCanvas = document.createElement("canvas");
  burnedCanvas.width = width;
  burnedCanvas.height = height;
  const burnedContext = burnedCanvas.getContext("2d");
  burnedContext.drawImage(state.baseCanvas, 0, 0);

  // Both redact and pixelate are privacy tools: they burn destructively into the
  // base clone (and therefore the stored original) so the obscured pixels never
  // survive and the obscuring can't be undone-away after save. Pixelate samples
  // from a pristine copy of the base so overlapping pixelate rects don't read
  // each other's already-mosaicked output.
  const burnSourceCanvas = document.createElement("canvas");
  burnSourceCanvas.width = width;
  burnSourceCanvas.height = height;
  burnSourceCanvas.getContext("2d").drawImage(state.baseCanvas, 0, 0);

  const burnInShapes = state.shapes.filter((shape) => shape.type === "redact" || shape.type === "pixelate");
  const remainingShapes = state.shapes.filter((shape) => shape.type !== "redact" && shape.type !== "pixelate");
  const redactionCount = burnInShapes.length;

  burnInShapes.forEach((shape) => {
    if (shape.type === "pixelate") {
      const rect = shapeBounds(shape);

      if (rect.width >= 1 && rect.height >= 1) {
        mosaicRegion(burnedContext, burnSourceCanvas, rect, pixelateBlockSize(shape));
      }
    } else {
      drawShape(burnedContext, shape);
    }
  });

  const flatCanvas = document.createElement("canvas");
  flatCanvas.width = width;
  flatCanvas.height = height;
  const flatContext = flatCanvas.getContext("2d");
  flatContext.fillStyle = "#ffffff";
  flatContext.fillRect(0, 0, width, height);
  flatContext.drawImage(burnedCanvas, 0, 0);
  remainingShapes.forEach((shape) => drawShape(flatContext, shape));

  return { burnedCanvas, flatCanvas, remainingShapes, redactionCount };
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }

      reject(new Error("Chrome could not encode the image."));
    }, "image/png");
  });
}

function buildResultRecord(type) {
  const record = {
    type,
    sessionId: state.sessionId,
    captureId: state.captureId,
    mode: state.mode
  };

  if (type === "editor-saved") {
    record.width = state.baseCanvas.width;
    record.height = state.baseCanvas.height;
    record.savedAt = Date.now();
  }

  return record;
}

async function appendPendingResult(record) {
  const data = await chrome.storage.session.get({ [PENDING_RESULTS_KEY]: [] });
  const list = Array.isArray(data[PENDING_RESULTS_KEY]) ? data[PENDING_RESULTS_KEY].slice() : [];
  list.push(record);
  await chrome.storage.session.set({ [PENDING_RESULTS_KEY]: list });
}

async function sendResultMessage(record) {
  try {
    await chrome.runtime.sendMessage(record);
  } catch (error) {
    // The side panel may be closed; the storage record is the reliable channel.
  }
}

function notifyResultBestEffort(record) {
  state.notified = true;

  try {
    void appendPendingResult(record);
  } catch (error) {
    // Best effort during unload.
  }

  void sendResultMessage(record);

  try {
    void idbDelete(SESSION_STORE, state.sessionId);
  } catch (error) {
    // Best effort during unload.
  }
}

async function doSave() {
  if (state.busy || !state.baseLoaded) {
    return;
  }

  commitTextEditing();
  setBusy(true);

  try {
    const { burnedCanvas, flatCanvas, remainingShapes, redactionCount } = renderFlattened();

    if (state.devMode) {
      const flatBlob = await canvasToBlob(flatCanvas);
      downloadBlob(flatBlob, "heracles-editor-test.png");
      setStatus(`Flattened PNG downloaded${redactionCount ? ` with ${redactionCount} redaction(s) burned in` : ""}.`, "success");
      return;
    }

    const [flatBlob, baseBlob] = await Promise.all([canvasToBlob(flatCanvas), canvasToBlob(burnedCanvas)]);

    await idbPut(ANNOTATION_STORE, state.captureId, {
      version: 1,
      baseWidth: burnedCanvas.width,
      baseHeight: burnedCanvas.height,
      shapes: remainingShapes.map(serializeShape)
    });
    await idbPut(ORIGINAL_STORE, state.captureId, baseBlob);
    await idbPut(ASSET_STORE, state.captureId, flatBlob);

    const record = buildResultRecord("editor-saved");
    record.width = flatCanvas.width;
    record.height = flatCanvas.height;

    await appendPendingResult(record);
    await sendResultMessage(record);
    await idbDelete(SESSION_STORE, state.sessionId);

    state.notified = true;
    state.dirty = false;
    closeTab();
  } catch (error) {
    console.error("Heracles editor: save failed.", error);
    setStatus(`Save failed: ${error.message || error}`, "warn");
  } finally {
    setBusy(false);
  }
}

async function doCancel() {
  if (state.busy) {
    return;
  }

  commitTextEditing();

  if (state.dirty && !window.confirm("Discard unsaved annotation changes?")) {
    return;
  }

  state.dirty = false;

  if (state.devMode || !state.session) {
    closeTab();
    return;
  }

  setBusy(true);

  try {
    const record = buildResultRecord("editor-cancelled");
    await appendPendingResult(record);
    await sendResultMessage(record);
    await idbDelete(SESSION_STORE, state.sessionId);
    state.notified = true;
    closeTab();
  } catch (error) {
    console.error("Heracles editor: cancel cleanup failed.", error);
    state.notified = true;
    closeTab();
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  state.busy = busy;
  elements.saveButton.disabled = busy;
  elements.cancelButton.disabled = busy;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function closeTab() {
  state.closing = true;

  if (hasChromeApis() && chrome.tabs && typeof chrome.tabs.getCurrent === "function") {
    chrome.tabs.getCurrent((tab) => {
      if (tab && typeof tab.id === "number") {
        chrome.tabs.remove(tab.id, () => {
          if (chrome.runtime.lastError) {
            window.close();
          }
        });
      } else {
        window.close();
      }
    });
    return;
  }

  window.close();
}

/* ===================== Misc helpers ===================== */

function setStatus(message, kind) {
  const toast = elements.statusToast;
  toast.textContent = message;
  toast.className = `status-toast${kind ? ` ${kind}` : ""}`;
  toast.hidden = false;

  if (toastTimer) {
    window.clearTimeout(toastTimer);
  }

  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("Unable to load image.")));
    image.src = src;
  });
}
