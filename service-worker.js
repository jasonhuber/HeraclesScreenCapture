const panelBehavior = { openPanelOnActionClick: true };

async function configureSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior(panelBehavior);
  } catch (error) {
    console.error("Unable to configure side panel behavior.", error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void configureSidePanel();
});

chrome.runtime.onStartup.addListener(() => {
  void configureSidePanel();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "capture-visible-tab") {
    return undefined;
  }

  chrome.tabs.captureVisibleTab(
    message.windowId,
    { format: "png" },
    (dataUrl) => {
      const runtimeError = chrome.runtime.lastError;

      if (runtimeError) {
        sendResponse({ ok: false, error: runtimeError.message });
        return;
      }

      sendResponse({ ok: true, dataUrl });
    }
  );

  return true;
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  try {
    const stored = await chrome.storage.session.get({ heraclesFloatWindow: null });

    if (stored.heraclesFloatWindow?.windowId === windowId) {
      await chrome.storage.session.remove("heraclesFloatWindow");
    }
  } catch (error) {
    // Session storage may be unavailable during shutdown; nothing to clean up then.
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (!["quick-capture", "capture-and-edit", "toggle-dictation"].includes(command)) {
    return;
  }

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const { heraclesFloatWindow = null } = await chrome.storage.session.get({ heraclesFloatWindow: null });

    if (!heraclesFloatWindow && chrome.sidePanel?.open && activeTab?.windowId) {
      try {
        await chrome.sidePanel.open({ windowId: activeTab.windowId });
      } catch (error) {
        console.warn("Unable to auto-open the side panel for a shortcut command.", error);
      }
    }

    const pendingShortcutCommand = { command, ts: Date.now() };
    await chrome.storage.session.set({ pendingShortcutCommand });

    try {
      await chrome.runtime.sendMessage({
        type: "shortcut-command",
        command,
        ts: pendingShortcutCommand.ts
      });
    } catch (error) {
      // The panel may still be loading; it picks up pendingShortcutCommand on init.
    }
  } catch (error) {
    console.error("Unable to relay the shortcut command to the side panel.", error);
  }
});
