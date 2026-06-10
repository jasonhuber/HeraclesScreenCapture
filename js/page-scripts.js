export function inspectPageContextInPage() {
  const normalizeText = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const isVisible = (element) => {
    if (!element || !(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);

    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
  };

  const pushUniqueText = (list, value, limit) => {
    const text = normalizeText(value);

    if (!text || list.includes(text) || list.length >= limit) {
      return;
    }

    list.push(text);
  };

  const headings = [];
  document.querySelectorAll("h1, h2, h3, [role='heading']").forEach((element) => {
    if (isVisible(element)) {
      pushUniqueText(headings, element.textContent, 6);
    }
  });

  const actions = [];
  document
    .querySelectorAll("button, [role='button'], a, input[type='button'], input[type='submit']")
    .forEach((element) => {
      if (!isVisible(element)) {
        return;
      }

      const text = normalizeText(element.textContent || element.value || element.getAttribute("aria-label") || "");
      if (text.length >= 2) {
        pushUniqueText(actions, text, 8);
      }
    });

  const sensitiveRects = [];
  const maxSensitiveRects = 40;

  const addSensitiveRect = (rect, kind, label) => {
    if (!rect || sensitiveRects.length >= maxSensitiveRects) {
      return;
    }

    const x = Math.max(0, Math.round(rect.left));
    const y = Math.max(0, Math.round(rect.top));
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);

    if (width < 4 || height < 4 || x > viewportWidth || y > viewportHeight) {
      return;
    }

    sensitiveRects.push({
      x,
      y,
      width,
      height,
      kind,
      label: normalizeText(label)
    });
  };

  const findMatches = (text, regex) => {
    const matches = [];
    let result = null;
    const pattern = new RegExp(regex.source, regex.flags);

    while ((result = pattern.exec(text)) !== null) {
      matches.push({
        value: result[0],
        index: result.index
      });
    }

    return matches;
  };

  const matchKindsForText = (text, tagName) => {
    const matches = [];

    findMatches(text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi).forEach((match) => {
      matches.push({ ...match, kind: "email" });
    });

    findMatches(text, /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi).forEach(
      (match) => {
        matches.push({ ...match, kind: "id" });
      }
    );

    findMatches(text, /\b(?:sk|pk|rk|tok|key|secret|token|bearer)[-_A-Za-z0-9]{8,}\b/gi).forEach((match) => {
      matches.push({ ...match, kind: "secret" });
    });

    findMatches(text, /\b[A-Z0-9]{10,}\b/g).forEach((match) => {
      matches.push({ ...match, kind: "id" });
    });

    findMatches(text, /\b\d{6,}\b/g).forEach((match) => {
      matches.push({ ...match, kind: "id" });
    });

    if (!["H1", "H2", "H3"].includes(tagName) && text.length <= 60) {
      findMatches(text, /\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,2}\b/g).forEach((match) => {
        matches.push({ ...match, kind: "name" });
      });
    }

    return matches;
  };

  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node?.textContent || !node.parentElement) {
        return NodeFilter.FILTER_REJECT;
      }

      const text = normalizeText(node.textContent);

      if (!text || text.length < 3 || !isVisible(node.parentElement)) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    }
  });

  let textNodeCount = 0;
  let textNode = null;

  while ((textNode = walker.nextNode()) && textNodeCount < 1200 && sensitiveRects.length < maxSensitiveRects) {
    textNodeCount += 1;
    const rawText = textNode.textContent || "";
    const tagName = textNode.parentElement?.tagName || "";
    const matches = matchKindsForText(rawText, tagName);

    for (const match of matches) {
      if (sensitiveRects.length >= maxSensitiveRects) {
        break;
      }

      const range = document.createRange();

      try {
        range.setStart(textNode, match.index);
        range.setEnd(textNode, match.index + match.value.length);

        Array.from(range.getClientRects()).forEach((rect) => {
          addSensitiveRect(rect, match.kind, match.value);
        });
      } catch (error) {
        continue;
      }
    }
  }

  document.querySelectorAll("input, textarea").forEach((element) => {
    if (sensitiveRects.length >= maxSensitiveRects || !isVisible(element)) {
      return;
    }

    const fieldType = normalizeText(element.getAttribute("type") || "");
    const fieldValue = normalizeText(element.value || element.getAttribute("value") || "");

    if (fieldType === "password" && fieldValue) {
      addSensitiveRect(element.getBoundingClientRect(), "secret", "password");
      return;
    }

    if (!fieldValue) {
      return;
    }

    const matches = matchKindsForText(fieldValue, element.tagName);

    if (matches.length > 0) {
      addSensitiveRect(element.getBoundingClientRect(), matches[0].kind, matches[0].value);
    }
  });

  return {
    title: normalizeText(document.title),
    url: window.location.href,
    mainHeading: headings[0] || "",
    headings,
    actions,
    sensitiveRects,
    viewportWidth,
    viewportHeight
  };
}

export function requestRegionSelectionInPage() {
  return new Promise((resolve) => {
    const existingOverlay = document.getElementById("__heracles_region_overlay");
    if (existingOverlay) {
      existingOverlay.remove();
    }

    const overlay = document.createElement("div");
    overlay.id = "__heracles_region_overlay";
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "2147483647";
    overlay.style.cursor = "crosshair";
    overlay.style.background = "rgba(15, 23, 42, 0.08)";
    overlay.style.backdropFilter = "blur(1px)";

    const hint = document.createElement("div");
    hint.textContent = "Drag to select a capture region. Press Esc to cancel.";
    hint.style.position = "fixed";
    hint.style.top = "16px";
    hint.style.left = "16px";
    hint.style.padding = "10px 14px";
    hint.style.borderRadius = "999px";
    hint.style.background = "rgba(17, 24, 39, 0.92)";
    hint.style.color = "#ffffff";
    hint.style.font = "600 13px/1.2 system-ui, sans-serif";
    hint.style.boxShadow = "0 10px 24px rgba(15, 23, 42, 0.3)";
    hint.style.pointerEvents = "none";

    const selection = document.createElement("div");
    selection.style.position = "fixed";
    selection.style.border = "2px solid #0f766e";
    selection.style.background = "rgba(15, 118, 110, 0.16)";
    selection.style.boxShadow = "0 0 0 1px rgba(255, 255, 255, 0.65)";
    selection.style.pointerEvents = "none";
    selection.style.display = "none";

    overlay.appendChild(hint);
    overlay.appendChild(selection);
    document.documentElement.appendChild(overlay);

    let startPoint = null;

    const cleanup = (result) => {
      window.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve(result);
    };

    const updateSelection = (event) => {
      if (!startPoint) {
        return;
      }

      const x = Math.min(startPoint.x, event.clientX);
      const y = Math.min(startPoint.y, event.clientY);
      const width = Math.abs(event.clientX - startPoint.x);
      const height = Math.abs(event.clientY - startPoint.y);

      selection.style.display = "block";
      selection.style.left = `${x}px`;
      selection.style.top = `${y}px`;
      selection.style.width = `${width}px`;
      selection.style.height = `${height}px`;
    };

    const onPointerDown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      startPoint = { x: event.clientX, y: event.clientY };
      updateSelection(event);
    };

    const onPointerMove = (event) => {
      event.preventDefault();
      event.stopPropagation();
      updateSelection(event);
    };

    const onPointerUp = (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (!startPoint) {
        cleanup(null);
        return;
      }

      const x = Math.min(startPoint.x, event.clientX);
      const y = Math.min(startPoint.y, event.clientY);
      const width = Math.abs(event.clientX - startPoint.x);
      const height = Math.abs(event.clientY - startPoint.y);
      const result = width >= 4 && height >= 4 ? { x, y, width, height } : null;
      cleanup(result);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cleanup(null);
      }
    };

    overlay.addEventListener("pointerdown", onPointerDown, { once: true });
    overlay.addEventListener("pointermove", onPointerMove);
    overlay.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("keydown", onKeyDown, true);
  });
}

export function getPageMetricsInPage() {
  const root = document.documentElement;
  const body = document.body || root;

  return {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    documentWidth: Math.max(root.scrollWidth, body.scrollWidth, root.clientWidth, window.innerWidth),
    documentHeight: Math.max(root.scrollHeight, body.scrollHeight, root.clientHeight, window.innerHeight),
    scrollX: window.scrollX,
    scrollY: window.scrollY
  };
}

export function scrollPageToInPage(x, y) {
  window.scrollTo(x, y);
  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY
  };
}

export async function primeFullPageForCaptureInPage() {
  const waitFor = (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

  if (!document.getElementById("__heracles_capture_scrollbar_style")) {
    const style = document.createElement("style");
    style.id = "__heracles_capture_scrollbar_style";
    style.textContent = "* { scrollbar-width: none !important; } ::-webkit-scrollbar { display: none !important; }";
    (document.head || document.documentElement).appendChild(style);
  }

  const root = document.documentElement;
  const body = document.body || root;
  const viewportHeight = Math.max(1, window.innerHeight);
  const documentHeight = Math.max(root.scrollHeight, body.scrollHeight, root.clientHeight, window.innerHeight);
  const lastStop = Math.max(0, documentHeight - viewportHeight);

  window.scrollTo(0, 0);

  for (let position = 0; position <= lastStop; position += viewportHeight) {
    window.scrollTo(0, position);
    await waitFor(150);
  }

  window.scrollTo(0, lastStop);
  await waitFor(150);
  window.scrollTo(0, 0);
  await waitFor(300);
}

export function hideFixedAndStickyElementsInPage() {
  const maxCandidates = 400;
  const records = [];

  for (const element of document.querySelectorAll("body *")) {
    if (records.length >= maxCandidates) {
      break;
    }

    const position = window.getComputedStyle(element).position;

    if (position !== "fixed" && position !== "sticky") {
      continue;
    }

    records.push({
      element,
      visibility: element.style.getPropertyValue("visibility"),
      priority: element.style.getPropertyPriority("visibility")
    });
    element.style.setProperty("visibility", "hidden", "important");
  }

  window.__heraclesHiddenStickyRecords = records;
  return records.length;
}

export function restoreFullPageCaptureInPage() {
  const records = Array.isArray(window.__heraclesHiddenStickyRecords) ? window.__heraclesHiddenStickyRecords : [];

  records.forEach((record) => {
    const element = record?.element;

    if (!element || !element.style) {
      return;
    }

    if (record.visibility) {
      element.style.setProperty("visibility", record.visibility, record.priority || "");
    } else {
      element.style.removeProperty("visibility");
    }
  });

  window.__heraclesHiddenStickyRecords = [];

  const style = document.getElementById("__heracles_capture_scrollbar_style");

  if (style) {
    style.remove();
  }

  return records.length;
}
