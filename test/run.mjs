/*
 * Heracles test suite — pure-logic coverage, zero dependencies.
 *
 * Runs the genuinely deterministic modules (markdown, zip, SCORM manifest)
 * under Node. The DOM/chrome-bound code is out of scope here; these cover the
 * string, packaging, and escaping logic that is easy to break silently and
 * hard to notice in a screenshot. Run with `npm test` or `node test/run.mjs`.
 */

import assert from "node:assert/strict";
import { crc32 as nodeCrc32 } from "node:zlib";

import {
  buildAutoInstruction,
  buildCaptureFileName,
  buildCaptureMarkdown,
  escapeHtml,
  escapeHtmlAttribute,
  normalizeInlineText,
  removeCaptureReferenceFromNarration,
  renderMarkdownToHtml,
  replaceCaptureReferenceInNarration,
  slugify,
  startCaseFromSlug
} from "../js/markdown.js";
import { buildZipBlob } from "../js/zip.js";
import { buildScormManifest } from "../js/export-formats.js";
import {
  downscaleDimensions,
  formatToExtension,
  formatToMime,
  isLossyFormat
} from "../js/settings.js";

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// --- slugify / text helpers --------------------------------------------------

test("slugify lowercases, hyphenates, trims", () => {
  assert.equal(slugify("  Hello World!  "), "hello-world");
  assert.equal(slugify("Edit Policy / Settings"), "edit-policy-settings");
  assert.equal(slugify("___"), "");
});

test("normalizeInlineText collapses whitespace", () => {
  assert.equal(normalizeInlineText("  a\n  b\t c "), "a b c");
  assert.equal(normalizeInlineText(null), "");
});

test("startCaseFromSlug title-cases", () => {
  assert.equal(startCaseFromSlug("onboarding-flow"), "Onboarding Flow");
});

test("escapeHtml / escapeHtmlAttribute neutralize markup", () => {
  assert.equal(escapeHtml("<b>&'\"</b>"), "&lt;b&gt;&amp;'\"&lt;/b&gt;");
  const attr = escapeHtmlAttribute('"><img src=x onerror=alert(1)>');
  assert.ok(!attr.includes('"'), "double quote must be encoded in attribute context");
  assert.ok(!attr.includes("<"), "angle bracket must be encoded in attribute context");
});

// --- auto instruction (element-context capture) ------------------------------

test("buildAutoInstruction with label + named container", () => {
  assert.equal(
    buildAutoInstruction("Save", "button", { kind: "dialog", label: "Edit Policy" }),
    "Click **Save** in the **Edit Policy** dialog."
  );
});

test("buildAutoInstruction with label, unlabeled meaningful container", () => {
  assert.equal(
    buildAutoInstruction("Users", "a", { kind: "navigation", label: "" }),
    "Click **Users** in the navigation."
  );
  // An unlabeled generic section adds no locator noise.
  assert.equal(
    buildAutoInstruction("Save", "button", { kind: "section", label: "" }),
    "Click **Save**."
  );
});

test("buildAutoInstruction falls back cleanly with no context", () => {
  assert.equal(buildAutoInstruction("", "", null), "Click the highlighted area.");
  assert.equal(buildAutoInstruction("Submit", "button", null), "Click **Submit**.");
});

// --- capture markdown + filenames --------------------------------------------

test("buildCaptureFileName is slugged and id-suffixed", () => {
  const name = buildCaptureFileName("Create New Policy", "capture-abc-def123");
  assert.match(name, /^step-create-new-policy-[a-z0-9]+\.png$/);
});

test("buildCaptureFileName defaults to .png and honours an explicit extension", () => {
  const id = "capture-abc-def123";
  assert.match(buildCaptureFileName("Save", id), /^step-save-[a-z0-9]+\.png$/);
  assert.match(buildCaptureFileName("Save", id, "webp"), /^step-save-[a-z0-9]+\.webp$/);
  assert.match(buildCaptureFileName("Save", id, "jpg"), /^step-save-[a-z0-9]+\.jpg$/);
  // A leading dot in the extension is tolerated.
  assert.match(buildCaptureFileName("Save", id, ".webp"), /^step-save-[a-z0-9]+\.webp$/);
});

// --- image format / downscale settings helpers -------------------------------

test("formatToExtension maps formats to disk extensions", () => {
  assert.equal(formatToExtension("png"), "png");
  assert.equal(formatToExtension("webp"), "webp");
  assert.equal(formatToExtension("jpeg"), "jpg");
  assert.equal(formatToExtension("nonsense"), "png");
});

test("formatToMime maps formats to mime types", () => {
  assert.equal(formatToMime("png"), "image/png");
  assert.equal(formatToMime("webp"), "image/webp");
  assert.equal(formatToMime("jpeg"), "image/jpeg");
  assert.equal(formatToMime("nonsense"), "image/png");
});

test("isLossyFormat is true only for webp/jpeg", () => {
  assert.equal(isLossyFormat("png"), false);
  assert.equal(isLossyFormat("webp"), true);
  assert.equal(isLossyFormat("jpeg"), true);
});

test("downscaleDimensions: no-op under cap, scales height proportionally over cap, 0 = no cap", () => {
  // Under the cap -> unchanged, not flagged scaled.
  assert.deepEqual(downscaleDimensions(800, 600, 1000), { width: 800, height: 600, scaled: false });
  // Exactly at the cap -> unchanged.
  assert.deepEqual(downscaleDimensions(1000, 750, 1000), { width: 1000, height: 750, scaled: false });
  // Over the cap -> width clamped, height scaled proportionally.
  assert.deepEqual(downscaleDimensions(2000, 1000, 1000), { width: 1000, height: 500, scaled: true });
  // 0 means no cap.
  assert.deepEqual(downscaleDimensions(2000, 1000, 0), { width: 2000, height: 1000, scaled: false });
  // Height never rounds to zero.
  assert.equal(downscaleDimensions(2000, 1, 10).height, 1);
});

test("buildCaptureMarkdown escapes brackets in alt text", () => {
  const md = buildCaptureMarkdown({
    indexLabel: "001",
    title: "Pick [A] or (B)",
    relativeImagePath: "screenshots/x.png"
  });
  assert.equal(md, "![Step 001 - Pick \\[A\\] or \\(B\\)](screenshots/x.png)");
});

// --- narration reference rewrite (escaped-bracket regression) ----------------

test("replaceCaptureReferenceInNarration handles escaped brackets in alt text", () => {
  const path = "screenshots/step-x.png";
  const original = buildCaptureMarkdown({ indexLabel: "002", title: "Choose [Plan]", relativeImagePath: path });
  const narration = `Intro.\n\n${original}\n\nOutro.`;
  const replacement = buildCaptureMarkdown({ indexLabel: "002", title: "Choose [Plan B]", relativeImagePath: path });
  const result = replaceCaptureReferenceInNarration(narration, path, replacement);
  assert.ok(result.includes("Choose \\[Plan B\\]"), "the bracketed title must be replaced");
  assert.ok(!result.includes("Choose \\[Plan\\]"), "the old reference must be gone");
});

test("removeCaptureReferenceFromNarration strips a bracketed-title reference", () => {
  const path = "screenshots/step-y.png";
  const ref = buildCaptureMarkdown({ indexLabel: "003", title: "Open [Settings]", relativeImagePath: path });
  const narration = `Before.\n\n${ref}\n\nAfter.`;
  const result = removeCaptureReferenceFromNarration(narration, path);
  assert.ok(!result.includes(path), "image reference must be removed");
  assert.ok(result.includes("Before.") && result.includes("After."), "surrounding prose must remain");
});

// --- markdown -> html --------------------------------------------------------

test("renderMarkdownToHtml renders headings, lists, emphasis, images", () => {
  const html = renderMarkdownToHtml(
    "# Title\n\nDo **this** and *that*.\n\n- one\n- two\n\n![alt](shot.png)"
  );
  assert.ok(html.includes("<h1>Title</h1>"));
  assert.ok(html.includes("<strong>this</strong>"));
  assert.ok(html.includes("<em>that</em>"));
  assert.ok(html.includes("<ul>") && html.includes("<li>one</li>"));
  assert.ok(html.includes('<img src="shot.png"'));
});

test("renderMarkdownToHtml escapes raw HTML in prose", () => {
  const html = renderMarkdownToHtml("A <script>alert(1)</script> line.");
  assert.ok(!html.includes("<script>"), "raw script tags must be escaped");
});

// --- ZIP writer (cross-checked against zlib.crc32) ---------------------------

async function readZip(files) {
  const blob = await buildZipBlob(files);
  return new Uint8Array(await blob.arrayBuffer());
}

function readU32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

test("buildZipBlob writes valid signatures and the right file count", async () => {
  const files = [
    { path: "a.txt", blob: new Blob([new TextEncoder().encode("hello")]) },
    { path: "dir/b.txt", blob: new Blob([new TextEncoder().encode("world!!")]) }
  ];
  const bytes = await readZip(files);

  assert.equal(readU32(bytes, 0), 0x04034b50, "first local file header signature");

  // End-of-central-directory record is the last 22 bytes; total entries at +10.
  const eocd = bytes.length - 22;
  assert.equal(readU32(bytes, eocd), 0x06054b50, "EOCD signature");
  const totalEntries = bytes[eocd + 10] | (bytes[eocd + 11] << 8);
  assert.equal(totalEntries, 2, "EOCD entry count");
});

test("buildZipBlob CRC-32 matches Node's zlib.crc32", async () => {
  const payload = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
  const bytes = await readZip([{ path: "fox.txt", blob: new Blob([payload]) }]);

  // CRC-32 lives at offset 14 of the local file header (little-endian).
  const storedCrc = readU32(bytes, 14);
  const expected = nodeCrc32(Buffer.from(payload)) >>> 0;
  assert.equal(storedCrc, expected, "hand-rolled CRC-32 must equal zlib.crc32");
});

// --- SCORM 1.2 manifest ------------------------------------------------------

test("buildScormManifest is well-formed and SCORM 1.2-shaped", () => {
  const xml = buildScormManifest("onboarding-flow", "How to Create a Policy", [
    "index.html",
    "scorm-api.js",
    "screenshots/step-001.png"
  ]);
  assert.ok(xml.startsWith("<?xml"), "has XML declaration");
  assert.ok(/<manifest\b/.test(xml) && xml.includes("</manifest>"), "single manifest root");
  assert.ok(xml.includes("imscp_rootv1p1p2"), "IMS CP namespace");
  assert.ok(xml.includes("adlcp_rootv1p2"), "ADLCP namespace");
  assert.ok(xml.includes("1.2"), "schemaversion 1.2");
  assert.ok(xml.includes('href="index.html"'), "resource entry point");
  ["index.html", "scorm-api.js", "screenshots/step-001.png"].forEach((file) => {
    assert.ok(xml.includes(`href="${file}"`), `lists file ${file}`);
  });
});

test("buildScormManifest escapes XML-hostile titles", () => {
  const xml = buildScormManifest("run", 'A & B <"C">', ["index.html"]);
  assert.ok(xml.includes("&amp;"), "& escaped");
  assert.ok(xml.includes("&lt;") && xml.includes("&gt;"), "angle brackets escaped");
  assert.ok(!/<title>[^<]*<"/.test(xml), "raw quote/markup must not leak into the title element");
});

// --- runner ------------------------------------------------------------------

console.log("\nHeracles pure-logic tests\n");

let passed = 0;
const failures = [];

for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}`);
  }
}

console.log(`\n${passed} passed, ${failures.length} failed`);

if (failures.length > 0) {
  console.log("");
  failures.forEach(({ name, error }) => {
    console.log(`FAIL ${name}\n  ${error.message}\n`);
  });
  process.exitCode = 1;
}
