import { DEFAULT_SETTINGS } from "./constants.js";
import { elements, state } from "./state.js";
import { storeHandle, getStoredHandle, deleteHandle, getCaptureAsset } from "./db.js";
import { escapeHtml, renderMarkdownDocument, renderMarkdownToHtml } from "./markdown.js";
import { buildZipBlob } from "./zip.js";
import { setStatus, setBusy, saveSettings, refreshRunFolderHint, ensureRunFolderSlug } from "./ui.js";

export async function saveExportFile(runFolderSlug, relativePath, data) {
  const fullPath = `${runFolderSlug}/${relativePath}`;
  const folderHandle = await getStoredHandle();

  if (folderHandle && await ensureFolderPermission(folderHandle, true, true)) {
    await writeFileToDirectory(folderHandle, fullPath, data);

    return {
      mode: `Local folder (${folderHandle.name})`,
      path: fullPath
    };
  }

  await downloadBlob(fullPath, data);

  return {
    mode: "Chrome Downloads fallback",
    path: `Downloads/${fullPath}`
  };
}

export async function writeFileToDirectory(rootHandle, relativePath, data) {
  const segments = relativePath.split("/").filter(Boolean);
  const fileName = segments.pop();
  let currentHandle = rootHandle;

  for (const segment of segments) {
    currentHandle = await currentHandle.getDirectoryHandle(segment, { create: true });
  }

  const fileHandle = await currentHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

export async function readFileFromDirectory(rootHandle, relativePath) {
  const segments = relativePath.split("/").filter(Boolean);
  const fileName = segments.pop();
  let currentHandle = rootHandle;

  for (const segment of segments) {
    currentHandle = await currentHandle.getDirectoryHandle(segment);
  }

  const fileHandle = await currentHandle.getFileHandle(fileName);
  return fileHandle.getFile();
}

export async function downloadBlob(relativePath, blob) {
  const url = URL.createObjectURL(blob);

  try {
    await chrome.downloads.download({
      url,
      filename: relativePath,
      saveAs: false,
      conflictAction: "overwrite"
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
}

export async function ensureFolderPermission(handle, writeAccess, promptUser = true) {
  if (!handle) {
    return false;
  }

  const options = { mode: writeAccess ? "readwrite" : "read" };

  if (typeof handle.queryPermission === "function") {
    const permission = await handle.queryPermission(options);
    if (permission === "granted") {
      return true;
    }
  }

  if (!promptUser) {
    return false;
  }

  if (typeof handle.requestPermission === "function") {
    const permission = await handle.requestPermission(options);
    return permission === "granted";
  }

  return false;
}

export async function chooseExportFolder() {
  if (typeof window.showDirectoryPicker === "function") {
    try {
      const handle = await window.showDirectoryPicker({ mode: "readwrite" });
      await storeHandle(handle);
      await chrome.storage.local.set({ exportFolderName: handle.name });
      await refreshFolderStatus();
      setStatus(`Export folder ready: ${handle.name}`, "success");
      return;
    } catch (error) {
      if (error?.name === "AbortError") {
        setStatus("Folder selection cancelled.", "warn");
        return;
      }

      // Chrome blocks the system folder picker inside side panel documents, so open it in a real tab instead.
      console.warn("Side panel folder picker unavailable; opening the picker tab.", error);
    }
  }

  await chrome.tabs.create({
    url: chrome.runtime.getURL("folder-picker.html")
  });

  setStatus("Pick the export folder in the tab that just opened.");
}

export async function clearStoredFolder() {
  await deleteHandle();
  await chrome.storage.local.remove("exportFolderName");
  await refreshFolderStatus();
  setStatus("Stored folder cleared. Future exports will use Downloads unless you pick a folder again.");
}

export async function refreshFolderStatus() {
  const handle = await getStoredHandle();
  const { exportFolderName = "" } = await chrome.storage.local.get({ exportFolderName: "" });

  if (!handle) {
    elements.folderStatusBadge.textContent = "Downloads";
    elements.folderStatusBadge.className = "badge badge-muted";
    elements.folderStatusText.textContent = "No folder handle stored. Exports will fall back to Downloads.";
    return;
  }

  const granted = await ensureFolderPermission(handle, false, false);
  const folderName = handle.name || exportFolderName || "Selected folder";

  if (!granted) {
    elements.folderStatusBadge.textContent = "Needs access";
    elements.folderStatusBadge.className = "badge badge-muted";
    elements.folderStatusText.textContent =
      `"${folderName}" is remembered, but Chrome needs access re-granted. Click Select Export Folder to re-allow it.`;
    return;
  }

  elements.folderStatusBadge.textContent = "Ready";
  elements.folderStatusBadge.className = "badge badge-ready";
  elements.folderStatusText.textContent = `Writing directly into "${folderName}".`;
}

export async function getCaptureAssetBlob(capture) {
  const storedAsset = await getCaptureAsset(capture.id);

  if (storedAsset) {
    return storedAsset;
  }

  const folderHandle = await getStoredHandle();
  const runFolderSlug = capture.runFolderSlug || state.runFolderSlug;

  if (!folderHandle || !runFolderSlug) {
    return null;
  }

  try {
    return await readFileFromDirectory(folderHandle, `${runFolderSlug}/${capture.relativeImagePath}`);
  } catch (error) {
    return null;
  }
}

export async function saveMarkdownDocument() {
  if (state.busy) {
    return;
  }

  setBusy(true);
  setStatus("Saving the combined Markdown file...");

  try {
    const runFolderSlug = await ensureRunFolderSlug();
    const markdown = renderMarkdownDocument();
    const markdownFileName = `${state.runFolderSlug || runFolderSlug}.md`;
    const saveResult = await saveExportFile(
      runFolderSlug,
      markdownFileName,
      new Blob([markdown], { type: "text/markdown" })
    );

    await saveSettings();
    refreshRunFolderHint();

    elements.lastExport.innerHTML = [
      `<strong>Markdown</strong>: ${escapeHtml(saveResult.path)}`,
      `<strong>Mode</strong>: ${escapeHtml(saveResult.mode)}`,
      `<strong>Captured steps</strong>: ${escapeHtml(String(state.captures.length))}`
    ].join("<br>");

    setStatus("Markdown saved successfully.", "success");
  } catch (error) {
    console.error("Markdown save failed.", error);
    setStatus(error.message || "Unable to save the Markdown file.", "warn");
  } finally {
    setBusy(false);
  }
}

export async function exportLmsPackage() {
  if (state.busy) {
    return;
  }

  setBusy(true);
  setStatus("Building the LMS package...");

  try {
    const runFolderSlug = await ensureRunFolderSlug();
    const markdown = renderMarkdownDocument();
    const html = buildPackageHtml(markdown);
    const manifest = JSON.stringify(buildPackageManifest(runFolderSlug), null, 2);
    const packageFiles = [
      {
        path: `${runFolderSlug}/${runFolderSlug}.md`,
        blob: new Blob([markdown], { type: "text/markdown" })
      },
      {
        path: `${runFolderSlug}/index.html`,
        blob: new Blob([html], { type: "text/html" })
      },
      {
        path: `${runFolderSlug}/steps.json`,
        blob: new Blob([manifest], { type: "application/json" })
      }
    ];

    for (const capture of state.captures) {
      const assetBlob = await getCaptureAssetBlob(capture);

      if (!assetBlob) {
        throw new Error(
          `The image for step ${capture.indexLabel} is missing from the extension cache. Re-capture or re-edit that step before exporting the package.`
        );
      }

      packageFiles.push({
        path: `${runFolderSlug}/${capture.relativeImagePath}`,
        blob: assetBlob
      });
    }

    const packageBlob = await buildZipBlob(packageFiles);
    const fileName = `${runFolderSlug}-lms-package.zip`;
    const saveResult = await saveExportFile(runFolderSlug, fileName, packageBlob);

    elements.lastExport.innerHTML = [
      `<strong>Package</strong>: ${escapeHtml(saveResult.path)}`,
      `<strong>Mode</strong>: ${escapeHtml(saveResult.mode)}`,
      `<strong>Included files</strong>: ${escapeHtml(String(packageFiles.length))}`
    ].join("<br>");

    setStatus("LMS package exported successfully.", "success");
  } catch (error) {
    console.error("Package export failed.", error);
    setStatus(error.message || "Unable to export the LMS package.", "warn");
  } finally {
    setBusy(false);
  }
}

function buildPackageManifest(runFolderSlug) {
  return {
    runName: elements.runNameInput.value.trim() || DEFAULT_SETTINGS.runName,
    documentTitle: elements.documentTitleInput.value.trim(),
    runFolder: runFolderSlug,
    exportedAt: new Date().toISOString(),
    captureCount: state.captures.length,
    captures: state.captures.map((capture) => ({
      stepNumber: capture.captureNumber,
      title: capture.title,
      relativeImagePath: capture.relativeImagePath,
      pageUrl: capture.pageUrl,
      pageTitle: capture.pageTitle,
      captureMode: capture.captureMode,
      capturedAt: capture.capturedAt,
      edited: capture.edited
    }))
  };
}

export function buildPackageHtml(markdown) {
  const body = renderMarkdownToHtml(markdown);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(elements.documentTitleInput.value.trim() || "Training Package")}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f2e9;
        --panel: #fffdf8;
        --text: #2a241c;
        --muted: #6e6458;
        --line: #ddd2bd;
        --accent: #115e59;
      }
      body {
        margin: 0;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #faf7f1 0%, var(--bg) 100%);
        color: var(--text);
      }
      main {
        max-width: 880px;
        margin: 0 auto;
        padding: 40px 20px 72px;
      }
      article {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 28px;
        box-shadow: 0 14px 32px rgba(56, 41, 17, 0.08);
      }
      h1, h2, h3, h4, h5, h6 {
        color: var(--accent);
        line-height: 1.15;
      }
      p, li {
        line-height: 1.7;
      }
      code {
        font-family: "SFMono-Regular", "Consolas", monospace;
        background: rgba(17, 94, 89, 0.08);
        padding: 2px 6px;
        border-radius: 6px;
      }
      figure {
        margin: 24px 0;
      }
      img {
        max-width: 100%;
        height: auto;
        border-radius: 14px;
        border: 1px solid var(--line);
        box-shadow: 0 14px 32px rgba(56, 41, 17, 0.08);
      }
      figcaption {
        margin-top: 10px;
        color: var(--muted);
        font-size: 14px;
      }
      ul, ol {
        padding-left: 24px;
      }
      a {
        color: var(--accent);
      }
    </style>
  </head>
  <body>
    <main>
      <article>
${body}
      </article>
    </main>
  </body>
</html>`;
}
