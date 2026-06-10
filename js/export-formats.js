import { DEFAULT_SETTINGS } from "./constants.js";
import { elements, state } from "./state.js";
import { escapeHtml, escapeHtmlAttribute, renderMarkdownDocument } from "./markdown.js";
import { buildZipBlob } from "./zip.js";
import { blobToDataUrl } from "./image-utils.js";
import { setStatus, setBusy, ensureRunFolderSlug } from "./ui.js";
import { buildPackageHtml, getCaptureAssetBlob, saveExportFile } from "./export.js";

const SCORM_API_SOURCE = `(function () {
  "use strict";

  function findApiIn(startWindow) {
    var current = startWindow;
    var hops = 0;

    while (current && hops <= 10) {
      try {
        if (current.API) {
          return current.API;
        }
      } catch (error) {
        return null;
      }

      if (current.parent === current) {
        break;
      }

      current = current.parent;
      hops += 1;
    }

    return null;
  }

  function findApi() {
    var api = findApiIn(window);

    if (!api) {
      try {
        if (window.opener) {
          api = findApiIn(window.opener);
        }
      } catch (error) {
        api = null;
      }
    }

    return api;
  }

  var api = null;
  var finished = false;

  function call(method, args) {
    if (!api || typeof api[method] !== "function") {
      return null;
    }

    try {
      return api[method].apply(api, args);
    } catch (error) {
      return null;
    }
  }

  function start() {
    try {
      api = findApi();
    } catch (error) {
      api = null;
    }

    if (!api) {
      return;
    }

    call("LMSInitialize", [""]);
    call("LMSSetValue", ["cmi.core.lesson_status", "completed"]);
    call("LMSCommit", [""]);
  }

  function finish() {
    if (!api || finished) {
      return;
    }

    finished = true;
    call("LMSFinish", [""]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  window.addEventListener("beforeunload", finish);
  window.addEventListener("pagehide", finish);
})();
`;

export function initExportFormats() {
  const standaloneButton = document.getElementById("saveStandaloneHtmlButton");
  const scormButton = document.getElementById("exportScormButton");

  if (standaloneButton) {
    standaloneButton.addEventListener("click", () => {
      void exportStandaloneHtml();
    });
  }

  if (scormButton) {
    scormButton.addEventListener("click", () => {
      void exportScormPackage();
    });
  }
}

export async function exportStandaloneHtml() {
  if (state.busy) {
    return;
  }

  setBusy(true);
  setStatus("Building the single-file HTML export...");

  try {
    const runFolderSlug = await ensureRunFolderSlug();
    const markdown = renderMarkdownDocument();
    let html = buildPackageHtml(markdown);

    for (const capture of state.captures) {
      const assetBlob = await getCaptureAssetBlob(capture);

      if (!assetBlob) {
        throw new Error(
          `The image for step ${capture.indexLabel} is missing from the extension cache. Re-capture or re-edit that step before exporting the standalone HTML.`
        );
      }

      const dataUrl = await blobToDataUrl(assetBlob);
      const escapedPath = escapeHtmlAttribute(capture.relativeImagePath);
      html = html.split(`src="${escapedPath}"`).join(`src="${dataUrl}"`);
    }

    const fileName = `${runFolderSlug}-standalone.html`;
    const saveResult = await saveExportFile(runFolderSlug, fileName, new Blob([html], { type: "text/html" }));

    elements.lastExport.innerHTML = [
      `<strong>Standalone HTML</strong>: ${escapeHtml(saveResult.path)}`,
      `<strong>Mode</strong>: ${escapeHtml(saveResult.mode)}`,
      `<strong>Embedded images</strong>: ${escapeHtml(String(state.captures.length))}`
    ].join("<br>");

    setStatus("Single-file HTML saved successfully.", "success");
  } catch (error) {
    console.error("Standalone HTML export failed.", error);
    setStatus(error.message || "Unable to export the standalone HTML file.", "warn");
  } finally {
    setBusy(false);
  }
}

export async function exportScormPackage() {
  if (state.busy) {
    return;
  }

  setBusy(true);
  setStatus("Building the SCORM 1.2 package...");

  try {
    const runFolderSlug = await ensureRunFolderSlug();
    const markdown = renderMarkdownDocument();
    const indexHtml = injectBeforeBodyClose(
      buildPackageHtml(markdown),
      "<script src=\"scorm-api.js\"></script>\n  "
    );
    const packageFiles = [
      {
        path: "index.html",
        blob: new Blob([indexHtml], { type: "text/html" })
      },
      {
        path: "scorm-api.js",
        blob: new Blob([SCORM_API_SOURCE], { type: "text/javascript" })
      }
    ];

    for (const capture of state.captures) {
      const assetBlob = await getCaptureAssetBlob(capture);

      if (!assetBlob) {
        throw new Error(
          `The image for step ${capture.indexLabel} is missing from the extension cache. Re-capture or re-edit that step before exporting the SCORM package.`
        );
      }

      packageFiles.push({
        path: capture.relativeImagePath,
        blob: assetBlob
      });
    }

    const documentTitle = elements.documentTitleInput.value.trim()
      || elements.runNameInput.value.trim()
      || DEFAULT_SETTINGS.runName;
    const manifestXml = buildScormManifest(runFolderSlug, documentTitle, packageFiles.map((file) => file.path));

    packageFiles.unshift({
      path: "imsmanifest.xml",
      blob: new Blob([manifestXml], { type: "application/xml" })
    });

    const packageBlob = await buildZipBlob(packageFiles);
    const fileName = `${runFolderSlug}-scorm12.zip`;
    const saveResult = await saveExportFile(runFolderSlug, fileName, packageBlob);

    elements.lastExport.innerHTML = [
      `<strong>SCORM 1.2</strong>: ${escapeHtml(saveResult.path)}`,
      `<strong>Mode</strong>: ${escapeHtml(saveResult.mode)}`,
      `<strong>Included files</strong>: ${escapeHtml(String(packageFiles.length))}`
    ].join("<br>");

    setStatus("SCORM 1.2 package exported successfully.", "success");
  } catch (error) {
    console.error("SCORM export failed.", error);
    setStatus(error.message || "Unable to export the SCORM 1.2 package.", "warn");
  } finally {
    setBusy(false);
  }
}

export function buildScormManifest(runFolderSlug, documentTitle, filePaths) {
  const manifestId = `heracles-${runFolderSlug}-manifest`;
  const orgId = `heracles-${runFolderSlug}-org`;
  const itemId = `heracles-${runFolderSlug}-item`;
  const resourceId = `heracles-${runFolderSlug}-resource`;
  const fileEntries = filePaths
    .map((path) => `      <file href="${escapeXml(path)}"/>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="${escapeXml(manifestId)}" version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="${escapeXml(orgId)}">
    <organization identifier="${escapeXml(orgId)}">
      <title>${escapeXml(documentTitle)}</title>
      <item identifier="${escapeXml(itemId)}" identifierref="${escapeXml(resourceId)}" isvisible="true">
        <title>${escapeXml(documentTitle)}</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="${escapeXml(resourceId)}" type="webcontent" adlcp:scormtype="sco" href="index.html">
${fileEntries}
    </resource>
  </resources>
</manifest>
`;
}

function injectBeforeBodyClose(html, snippet) {
  const closeIndex = html.lastIndexOf("</body>");

  if (closeIndex === -1) {
    return `${html}\n${snippet}`;
  }

  return `${html.slice(0, closeIndex)}${snippet}${html.slice(closeIndex)}`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
