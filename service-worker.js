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
