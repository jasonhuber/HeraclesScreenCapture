export const elements = {};

export const state = {
  busy: false,
  runFolderSlug: "",
  captureMode: "visible",
  captures: []
};

export let lastNarrationSelection = { start: 0, end: 0 };

export function setLastNarrationSelection(selection) {
  lastNarrationSelection = selection;
}
