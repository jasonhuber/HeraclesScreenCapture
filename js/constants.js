export const DB_NAME = "heracles-file-access";
export const DB_VERSION = 3;
export const HANDLE_STORE = "handles";
export const HANDLE_KEY = "export-directory";
export const ASSET_STORE = "capture-assets";
export const ORIGINAL_STORE = "capture-originals";
export const ANNOTATION_STORE = "capture-annotations";
export const EDITOR_SESSION_STORE = "editor-sessions";

export const DEFAULT_SETTINGS = {
  runName: "training-run",
  documentTitle: "",
  narrationText: "",
  runFolderSlug: "",
  captureMode: "visible",
  captures: []
};

export const CAPTURE_MODE_LABELS = {
  visible: "Visible area",
  fullpage: "Full page",
  region: "Region"
};

export function normalizeCaptureMode(value) {
  return CAPTURE_MODE_LABELS[value] ? value : "visible";
}
