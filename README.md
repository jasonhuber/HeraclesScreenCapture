# Heracles Screen Capture Coach

This project is a Chrome extension for documenting a web application as LMS-ready Markdown with inline screenshots, step management, redaction tools, and packaged exports.

## What it does

- Opens in a Chrome side panel so you can keep it visible while navigating your app.
- Gives you one live narration box where you type the walkthrough yourself.
- Voice dictation: speak your narration instead of typing, with spoken punctuation commands and live interim preview.
- Captures the current step as a `.png` using visible-area, full-page, or region mode.
- Auto-step capture mode: records a documented step on every click in the page, Scribe-style — screenshot, a highlight box drawn around the exact element you clicked, a numbered click badge, and a container-aware instruction like "Click **Save** in the **Edit Policy** dialog" — optionally with simultaneous voice narration that lands under each step automatically. The element's label, bounds, and enclosing dialog/nav/form are stored with the step, and the markers are editable annotations in the image editor.
- Supports keyboard shortcuts for quick capture and capture-and-edit.
- Inserts a Markdown image tag at the current cursor position in your narration.
- Keeps captures cached in the extension while you work — nothing is written to disk on each click; the run folder (Markdown + `screenshots/`) is written in one go when you save or export.
- Opens captures in a full-tab image editor with non-destructive annotations: arrows, lines, boxes, ellipses, freehand pen, highlighter, text, callouts, numbered step badges, crop, and solid redaction.
- Lets you rename, reorder (drag-and-drop or buttons), reinsert, and delete captured steps, with thumbnails in the step list.
- Suggests step titles from page context and can draft narration from the current step sequence.
- Saves the combined narration as a single Markdown file.
- Exports a zipped LMS package, a SCORM 1.2 package, or a fully self-contained single-file HTML document.

## Authoring flow

1. Type your narration into the live script box.
2. Place the cursor where the next image should appear.
3. Choose the capture mode you want: visible area, full page, or region.
4. Click **Quick Capture & Insert** or use the keyboard shortcut.
5. Keep moving through the app and repeat.
6. Use the step manager to retitle, reorder, reinsert, or delete captures.
7. Click **Save Run to Folder** when you want the `.md` file and all screenshots written to disk in one go.
8. Click **Export LMS Package**, **Export SCORM 1.2**, or **Save Single-File HTML** for a handoff package.

Or flip on **Auto-Step Capture** and just click through the task in the page — each click becomes a step with a screenshot, a numbered click badge, and a drafted "Click **Save**"-style instruction appended to the narration. With **Capture my voice too** checked, whatever you say after a click is transcribed and replaces that step's drafted instruction automatically — narrate the whole walkthrough hands-free, then save or export once at the end.

## The image editor

**Capture & Edit** (or **Edit Image** on any step) opens the screenshot in a full-tab editor. Annotations are objects, not baked pixels — every shape stays selectable, movable, resizable, and deletable across editing sessions, because the original bitmap, the annotation list, and the flattened export are stored separately.

- Tools: Select (V), Arrow (A), Line (L), Box (R), Ellipse (E), Pen (P), Highlight (H), Text (T), Callout (C), numbered Badge (N), Stamp (M), Pixelate (Z), Redact (D), Crop (X), plus pan (Space-drag) and zoom (Ctrl+wheel, +/−, 0 to fit).
- **Stamps**: drop a checkmark, cross, star, dot, question, exclaim, or chunky arrow — recolorable and resizable, for marking steps approved/rejected/important.
- **Pixelate**: a privacy mosaic over a region — softer-looking than solid redaction, and like redaction it is burned destructively into both the export and the stored original on save (the clear pixels do not survive). Use solid **Redact** when you need guaranteed secrecy; use **Pixelate** when you want it to still look like a screenshot.
- **Text backing**: text and callouts can sit on a light or dark rounded pill so they stay legible on any background (Skitch-style), or "none" for the classic halo.
- Undo/redo (Ctrl+Z / Ctrl+Y), arrow-key nudging, double-click to edit text and badge numbers.
- **Suggested Redactions** previews automatically detected emails, names, IDs, and secrets from the page and converts them to redaction shapes in one click.
- Redactions are burned destructively into both the stored original and the exported image on save — redacted pixels do not survive anywhere. All other annotations remain editable.
- Saving writes the flattened PNG back into the run cache and (for new captures) inserts the Markdown tag at your cursor in the side panel; files land on disk when you save or export the run.

## Floating window mode

The side panel takes a fixed slice of the browser window, so the header has **Open as Floating Window**: it moves the
whole UI into a small popup window you can drag anywhere, resize, park on another monitor, or minimize when you want it
out of the way. Capture, auto-step recording, dictation, and exports all run from the floating window; the side panel
parks itself with a one-line notice (Focus / Use Side Panel Instead) so the two never fight over the same run. Closing
the floating window hands control back to the side panel automatically. Chrome does not offer always-on-top windows to
extensions, so the float window layers like any normal window.

## Voice dictation

Click **Dictate** in the Live Narration card (or press `Ctrl+Shift+3` / `Cmd+Shift+3`) and speak — finalized phrases are inserted at your cursor with smart spacing and capitalization, and an interim line previews what's being recognized. Spoken commands: "period", "comma", "question mark", "exclamation mark", "colon", "semicolon", "new line", "new paragraph".

Auto-Step Capture has its own voice mode (the **Capture my voice too** checkbox): dictation starts and stops with the recording, and instead of following your cursor, each spoken phrase is routed under the step you most recently clicked — replacing the drafted "Click **X**." line with your actual narration. Speech before the first click becomes an intro paragraph.

Engine details: dictation uses Chrome's built-in Web Speech API (audio is processed by Google's speech service — keep that in mind for sensitive environments). The first start opens a one-time microphone permission page. Chrome historically blocks the Speech API in some extension contexts, so if the side panel engine fails, the extension automatically falls back to running recognition inside the active page (Chrome may then ask for mic permission per site); the working engine is remembered.

## Keyboard shortcuts

- `Cmd+Shift+1` on macOS or `Ctrl+Shift+1` on Windows/Linux captures with the current mode and inserts the image.
- `Cmd+Shift+2` on macOS or `Ctrl+Shift+2` on Windows/Linux captures with the current mode and opens the editor.
- `Cmd+Shift+3` on macOS or `Ctrl+Shift+3` on Windows/Linux starts or stops voice dictation.

Shortcuts work even when the side panel is closed — the command is queued, the panel opens, and the capture runs.

## Step manager

Each capture becomes a step you can manage inside the side panel:

- thumbnail preview (click it to open the editor)
- rename the step title
- drag-and-drop reorder via the grip handle (Move Up/Down buttons still work)
- reinsert the image tag into the narration at the current cursor
- delete the step from the run

## Smart assist

- **Suggest Step Titles** refreshes titles from the captured page context.
- **Draft Narration from Steps** rebuilds the markdown body from the current step sequence and image order.

## Exports

- **Save Markdown** — the combined narration as a `.md` file in the run folder.
- **Export LMS Package** — a `.zip` with the Markdown, an `index.html` version, a `steps.json` manifest, and all screenshots.
- **Export SCORM 1.2** — a SCORM-conformant `.zip` (`imsmanifest.xml` at the root, an `index.html` SCO with a defensive SCORM API shim that reports completion, and all screenshots) for upload to any SCORM 1.2 LMS.
- **Save Single-File HTML** — one self-contained `.html` with every screenshot embedded as base64; nothing else to ship.

## How local saving works

Captures live in the extension's IndexedDB cache while you work — nothing touches the disk per click, which keeps
Dropbox-style synced folders from churning during a recording session. **Save Run to Folder** writes the Markdown
plus every screenshot in one pass; the export buttons each write a single artifact.

Chrome extensions should not have unrestricted access to the full local filesystem. The practical options are:

1. Preferred: use the File System Access API.
   The user picks an export folder once, and the extension writes files into that folder. Chrome does not allow
   the system folder picker to open inside side panel documents, so **Select Export Folder** opens a small
   extension tab (`folder-picker.html`) where the picker works; the chosen folder handle is shared back through
   IndexedDB. The same tab handles re-granting access when Chrome forgets it between sessions.

2. Fallback: use the Chrome Downloads API.
   The extension saves files into a subfolder under the browser's Downloads location.

3. For silent, unrestricted disk writes:
   add a native companion app and connect to it with Native Messaging. That is only necessary if you need behavior beyond the browser's normal security model.

This extension implements options 1 and 2.

## Architecture

- `manifest.json` — MV3, side panel, commands, icons.
- `service-worker.js` — side-panel behavior, capture relay, shortcut handling (with a `storage.session` handoff so shortcuts survive the panel not being open yet).
- `sidepanel.html` / `sidepanel.css` / `js/` — the side panel as ES modules: `main.js` (wiring), `state.js`, `constants.js`, `db.js` (IndexedDB), `capture.js` (visible/region/full-page with rate-limit throttling, lazy-load priming, and sticky-header hiding), `page-scripts.js` (self-contained injected functions), `autocapture.js`, `dictation.js` (voice input, panel engine with in-page fallback), `editor-launch.js` (editor-tab lifecycle), `steps-ui.js`, `export.js`, `export-formats.js` (SCORM + single-file HTML), `markdown.js`, `zip.js`, `image-utils.js`, `ui.js`.
- `permission.html` / `js/permission.js` — one-time microphone grant page for dictation.
- `editor.html` / `editor.css` / `editor.js` — the full-tab annotation editor. Open it as `editor.html?dev=1` outside the extension for standalone testing with any local image.
- Storage: capture metadata in `chrome.storage.local`; image blobs (flattened asset + un-annotated original) and annotation objects in IndexedDB, so steps remain re-editable across sessions.

## Load the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this project folder
5. Click the extension icon to open the side panel

## Suggested next step

Possible next iterations:

1. template-aware exports for a specific LMS target (SCORM 2004, xAPI)
2. DOCX/PDF export
3. collaborative review comments or approval states per step
4. spotlight/dim de-emphasis (darken everything except a focus region)
