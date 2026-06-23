import { elements } from "./state.js";

export function normalizeInlineText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeMarkdownText(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function unescapeMarkdownText(value) {
  return String(value || "")
    .replaceAll("\\(", "(")
    .replaceAll("\\)", ")")
    .replaceAll("\\[", "[")
    .replaceAll("\\]", "]")
    .replaceAll("\\\\", "\\");
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function escapeHtmlAttribute(value) {
  return escapeHtml(value)
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function startCaseFromSlug(value) {
  return normalizeInlineText(value)
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function capitalize(value) {
  const text = normalizeInlineText(value);
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

function trimLeadingArticles(value) {
  return value.replace(/^(the|a|an)\s+/i, "").trim();
}

function startsWithVerb(value) {
  return /^(open|create|add|edit|update|review|manage|select|configure|invite|upload|download|submit|approve|assign|search|filter|choose|save)\b/i.test(
    value
  );
}

function cleanPageTitle(value) {
  const normalized = normalizeInlineText(value);

  if (!normalized) {
    return "";
  }

  const parts = normalized.split(/\s+[|•-]\s+/).filter((part) => part.length >= 3);
  return normalizeInlineText(parts[0] || normalized);
}

function humanizeUrlPath(value) {
  try {
    const url = new URL(value);
    const tokens = url.pathname
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part).replace(/[-_]+/g, " ").trim())
      .filter((part) => part && !/^\d+$/.test(part) && !/^[0-9a-f-]{8,}$/i.test(part));

    if (tokens.length === 0) {
      return "";
    }

    return startCaseFromSlug(tokens.slice(-2).join(" "));
  } catch (error) {
    return "";
  }
}

export function deriveSuggestedTitle(pageContext, captureNumber) {
  const action = normalizeInlineText((pageContext?.actions || [])[0] || "");
  const heading = normalizeInlineText(pageContext?.mainHeading || (pageContext?.headings || [])[0] || "");
  const pageTitle = cleanPageTitle(pageContext?.title || pageContext?.pageTitle || "");
  const pathLabel = humanizeUrlPath(pageContext?.url || pageContext?.pageUrl || "");

  if (action && heading) {
    if (action.split(/\s+/).length === 1) {
      return `${capitalize(action)} ${trimLeadingArticles(heading)}`;
    }

    return action;
  }

  const candidate = heading || pageTitle || pathLabel;

  if (!candidate) {
    return `Screen ${String(captureNumber).padStart(3, "0")}`;
  }

  if (startsWithVerb(candidate)) {
    return candidate;
  }

  if (/dashboard|details|summary|overview|settings|results|history|queue|list|home/i.test(candidate)) {
    return `Review ${candidate}`;
  }

  return `Open ${candidate}`;
}

export function buildCaptureFileName(title, captureId, extension = "png") {
  const shortId = captureId.split("-").slice(-1)[0];
  const ext = String(extension || "png").replace(/^\.+/, "").toLowerCase() || "png";
  return `step-${slugify(title) || "screen"}-${shortId}.${ext}`;
}

export function createCaptureId() {
  return `capture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch (error) {
    return url || "Unknown page";
  }
}

export function formatTimestamp(isoString) {
  try {
    return new Date(isoString).toLocaleString();
  } catch (error) {
    return isoString;
  }
}

export function buildCaptureMarkdown(captureMeta) {
  const altText = escapeMarkdownText(`Step ${captureMeta.indexLabel} - ${captureMeta.title}`);
  return `![${altText}](${captureMeta.relativeImagePath})`;
}

export function buildAutoInstruction(label, roleLabel, container) {
  const cleanLabel = normalizeInlineText(label || "");
  const cleanRole = normalizeInlineText(roleLabel || "");
  const base = cleanLabel
    ? `Click **${cleanLabel}**`
    : cleanRole
      ? `Click the ${cleanRole}`
      : "Click the highlighted area";
  const containerLabel = normalizeInlineText(container?.label || "");
  const containerKind = normalizeInlineText(container?.kind || "");

  if (containerLabel) {
    return `${base} in the **${containerLabel}** ${containerKind || "area"}.`;
  }

  if (containerKind && containerKind !== "section" && containerKind !== "page") {
    return `${base} in the ${containerKind}.`;
  }

  return `${base}.`;
}

export function replaceCaptureReferenceInNarration(markdown, relativeImagePath, replacement) {
  const pathPattern = escapeRegExp(relativeImagePath);
  const imageRegex = new RegExp(`!\\[(?:\\\\.|[^\\]\\\\])*\\]\\(${pathPattern}\\)`, "g");
  return markdown.replace(imageRegex, replacement);
}

export function removeCaptureReferenceFromNarration(markdown, relativeImagePath) {
  const pathPattern = escapeRegExp(relativeImagePath);
  const imageRegex = new RegExp(`(?:\\n{0,2})!\\[(?:\\\\.|[^\\]\\\\])*\\]\\(${pathPattern}\\)(?:\\n{0,2})`, "g");
  return markdown.replace(imageRegex, "\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function renderMarkdownDocument() {
  const documentTitle = elements.documentTitleInput.value.trim();
  const narrationText = elements.narrationInput.value.trim();
  const lines = [];

  if (documentTitle) {
    lines.push(`# ${documentTitle}`, "");
  }

  if (narrationText) {
    lines.push(narrationText);
  } else {
    lines.push("_Start typing your narration here._");
  }

  return lines.join("\n");
}

export function renderMarkdownToHtml(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const parts = [];
  let paragraph = [];
  let listItems = [];
  let listType = "";

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }

    const text = paragraph.join(" ").trim();
    paragraph = [];

    if (!text) {
      return;
    }

    if (/^!\[(?:\\.|[^\]\\])*]\([^)]+\)$/.test(text)) {
      parts.push(renderStandaloneImage(text));
      return;
    }

    parts.push(`        <p>${renderInlineMarkdown(text)}</p>`);
  };

  const flushList = () => {
    if (listItems.length === 0) {
      return;
    }

    const tag = listType === "ol" ? "ol" : "ul";
    parts.push(`        <${tag}>`);
    listItems.forEach((item) => {
      parts.push(`          <li>${renderInlineMarkdown(item)}</li>`);
    });
    parts.push(`        </${tag}>`);
    listItems = [];
    listType = "";
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);

    if (headingMatch) {
      flushParagraph();
      flushList();
      const level = headingMatch[1].length;
      parts.push(`        <h${level}>${renderInlineMarkdown(headingMatch[2].trim())}</h${level}>`);
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.*)$/);

    if (orderedMatch) {
      flushParagraph();

      if (listType && listType !== "ol") {
        flushList();
      }

      listType = "ol";
      listItems.push(orderedMatch[1]);
      continue;
    }

    const unorderedMatch = line.match(/^[-*]\s+(.*)$/);

    if (unorderedMatch) {
      flushParagraph();

      if (listType && listType !== "ul") {
        flushList();
      }

      listType = "ul";
      listItems.push(unorderedMatch[1]);
      continue;
    }

    if (/^!\[(?:\\.|[^\]\\])*]\([^)]+\)$/.test(line)) {
      flushParagraph();
      flushList();
      parts.push(renderStandaloneImage(line));
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();

  return parts.join("\n");
}

function renderStandaloneImage(markdownImage) {
  const match = markdownImage.match(/^!\[(.*?)\]\((.+?)\)$/);

  if (!match) {
    return `        <p>${renderInlineMarkdown(markdownImage)}</p>`;
  }

  const alt = unescapeMarkdownText(match[1]);
  const src = match[2];

  return [
    "        <figure>",
    `          <img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(alt)}">`,
    alt ? `          <figcaption>${escapeHtml(alt)}</figcaption>` : "",
    "        </figure>"
  ]
    .filter(Boolean)
    .join("\n");
}

function renderInlineMarkdown(value) {
  const placeholders = [];
  let output = String(value || "");

  output = output.replace(/!\[([^\]]*)]\(([^)]+)\)/g, (_, alt, src) => {
    const token = `@@HTML${placeholders.length}@@`;
    placeholders.push(`<img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(unescapeMarkdownText(alt))}">`);
    return token;
  });

  output = output.replace(/\[([^\]]+)]\(([^)]+)\)/g, (_, label, href) => {
    const token = `@@HTML${placeholders.length}@@`;
    placeholders.push(`<a href="${escapeHtmlAttribute(href)}">${escapeHtml(label)}</a>`);
    return token;
  });

  output = output.replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@HTML${placeholders.length}@@`;
    placeholders.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  output = escapeHtml(output);
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  output = output.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  placeholders.forEach((html, index) => {
    output = output.replace(`@@HTML${index}@@`, html);
  });

  return output;
}
