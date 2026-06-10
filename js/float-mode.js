const FLOAT_STORAGE_KEY = "heraclesFloatWindow";
const FLOAT_WINDOW_WIDTH = 460;
const FLOAT_WINDOW_HEIGHT = 760;

export function isFloatWindow() {
  return new URLSearchParams(window.location.search).get("float") === "1";
}

export async function getVerifiedFloatWindowId() {
  const stored = await chrome.storage.session.get({ [FLOAT_STORAGE_KEY]: null });
  const windowId = Number(stored[FLOAT_STORAGE_KEY]?.windowId);

  if (!Number.isFinite(windowId)) {
    return null;
  }

  try {
    await chrome.windows.get(windowId);
    return windowId;
  } catch (error) {
    await chrome.storage.session.remove(FLOAT_STORAGE_KEY);
    return null;
  }
}

export async function registerFloatInstance() {
  document.body.classList.add("float-mode");
  document.title = "Heracles Capture — Floating";

  try {
    const currentWindow = await chrome.windows.getCurrent();
    await chrome.storage.session.set({
      [FLOAT_STORAGE_KEY]: { windowId: currentWindow.id, createdAt: Date.now() }
    });
  } catch (error) {
    console.warn("Unable to register the floating window.", error);
  }
}

export async function detachToFloatingWindow() {
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL("sidepanel.html?float=1"),
    type: "popup",
    width: FLOAT_WINDOW_WIDTH,
    height: FLOAT_WINDOW_HEIGHT
  });

  await chrome.storage.session.set({
    [FLOAT_STORAGE_KEY]: { windowId: created.id, createdAt: Date.now() }
  });

  window.location.reload();
}

export async function returnToSidePanel() {
  await chrome.storage.session.remove(FLOAT_STORAGE_KEY);

  try {
    const currentWindow = await chrome.windows.getCurrent();
    await chrome.windows.remove(currentWindow.id);
  } catch (error) {
    window.close();
  }
}

export function renderPassivePanel(windowId) {
  document.body.innerHTML = [
    '<main class="panel">',
    '<section class="card">',
    '<div class="section-heading">',
    "<h2>Floating window active</h2>",
    '<span class="badge badge-ready">Detached</span>',
    "</div>",
    '<p class="subtle">',
    "Heracles is running in its own floating window, so this panel is parked. Close the floating window or",
    " reattach here to use the side panel again.",
    "</p>",
    '<div class="button-row">',
    '<button id="focusFloatButton" class="button button-primary" type="button">Focus Floating Window</button>',
    '<button id="reattachButton" class="button button-secondary" type="button">Use Side Panel Instead</button>',
    "</div>",
    "</section>",
    "</main>"
  ].join("");

  document.getElementById("focusFloatButton").addEventListener("click", () => {
    void chrome.windows.update(windowId, { focused: true, drawAttention: true }).catch(() => {});
  });

  document.getElementById("reattachButton").addEventListener("click", async () => {
    try {
      await chrome.windows.remove(windowId);
    } catch (error) {
      // The floating window may already be gone.
    }

    await chrome.storage.session.remove(FLOAT_STORAGE_KEY);
    window.location.reload();
  });
}

export function watchFloatChanges() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "session" || !(FLOAT_STORAGE_KEY in changes)) {
      return;
    }

    if (isFloatWindow()) {
      return;
    }

    window.location.reload();
  });
}
