import { getStoredHandle, storeHandle } from "./db.js";

const pickButton = document.getElementById("pickButton");
const regrantSection = document.getElementById("regrantSection");
const regrantText = document.getElementById("regrantText");
const regrantButton = document.getElementById("regrantButton");
const statusElement = document.getElementById("pickerStatus");

void initialize();

async function initialize() {
  pickButton.addEventListener("click", () => {
    void pickNewFolder();
  });

  regrantButton.addEventListener("click", () => {
    void regrantStoredFolder();
  });

  try {
    const storedHandle = await getStoredHandle();

    if (!storedHandle || typeof storedHandle.queryPermission !== "function") {
      return;
    }

    const permission = await storedHandle.queryPermission({ mode: "readwrite" });

    if (permission === "granted") {
      return;
    }

    regrantText.textContent =
      `"${storedHandle.name}" is already remembered, but Chrome needs you to re-allow access to it. ` +
      "You can also choose a different folder below.";
    regrantSection.classList.remove("hidden");
    pickButton.classList.remove("button-primary");
    pickButton.classList.add("button-secondary");
  } catch (error) {
    console.warn("Unable to inspect the stored folder handle.", error);
  }
}

async function pickNewFolder() {
  if (typeof window.showDirectoryPicker !== "function") {
    statusElement.textContent = "This Chrome build does not support the File System Access API. Exports will use Downloads.";
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    await storeHandle(handle);
    await chrome.storage.local.set({ exportFolderName: handle.name });
    finishSuccessfully(handle.name);
  } catch (error) {
    if (error?.name === "AbortError") {
      statusElement.textContent = "Folder selection cancelled. Pick a folder when you are ready.";
      return;
    }

    console.error("Unable to select an export folder.", error);
    statusElement.textContent = "Chrome could not open the folder picker here. Exports will use Downloads instead.";
  }
}

async function regrantStoredFolder() {
  try {
    const storedHandle = await getStoredHandle();

    if (!storedHandle || typeof storedHandle.requestPermission !== "function") {
      statusElement.textContent = "The remembered folder is no longer available. Choose a folder instead.";
      return;
    }

    const permission = await storedHandle.requestPermission({ mode: "readwrite" });

    if (permission !== "granted") {
      statusElement.textContent = "Access was not granted. Choose a folder, or try re-allowing again.";
      return;
    }

    finishSuccessfully(storedHandle.name);
  } catch (error) {
    console.error("Unable to re-grant folder access.", error);
    statusElement.textContent = "Chrome could not re-grant access. Choose the folder again instead.";
  }
}

function finishSuccessfully(folderName) {
  statusElement.textContent = `Export folder ready: ${folderName}. This tab closes itself in a moment.`;

  try {
    chrome.runtime.sendMessage({ type: "heracles-folder-picked", name: folderName });
  } catch (error) {
    // The side panel may be closed; the stored handle is picked up on its next load.
  }

  setTimeout(() => {
    window.close();
  }, 1200);
}
