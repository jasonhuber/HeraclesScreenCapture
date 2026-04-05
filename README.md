# Heracles Screen Capture Coach

This project is a Chrome extension MVP for documenting a web application as LMS-ready Markdown with inline screenshots.

## What it does

- Opens in a Chrome side panel so you can keep it visible while navigating your app.
- Gives you one live narration box where you type the walkthrough yourself.
- Captures the current tab as a `.png`.
- Inserts a Markdown image tag at the current cursor position in your narration.
- Saves screenshots into a run folder like `onboarding-flow/screenshots/001-dashboard.png`
- Saves the combined narration as a single Markdown file like `onboarding-flow/onboarding-flow.md`

## Authoring flow

1. Type your narration into the live script box.
2. Place the cursor where the next image should appear.
3. Click **Quick Capture & Insert**.
4. Keep moving through the app and repeat.
5. Click **Save Markdown** when you want the latest `.md` file written to disk.

## Crop and edit mode

If you need only part of the screen or want to mark up the image before saving it:

1. Click **Capture, Crop & Edit**
2. Use the editor tools:
   - `Crop` to keep only a portion of the screenshot
   - `Box` to draw a rectangular callout
   - `Pen` to freehand annotate
3. Click **Save & Insert Edited Image**

The edited image is saved into the same `screenshots/` folder and the Markdown tag is inserted at your cursor position.

## How local saving works

Chrome extensions should not have unrestricted access to the full local filesystem. The practical options are:

1. Preferred: use the File System Access API.
   The user picks an export folder from the side panel, and the extension writes files into that folder.

2. Fallback: use the Chrome Downloads API.
   The extension saves files into a subfolder under the browser's Downloads location.

3. For silent, unrestricted disk writes:
   add a native companion app and connect to it with Native Messaging. That is only necessary if you need behavior beyond the browser's normal security model.

This MVP implements options 1 and 2.

## Load the extension

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this folder:
   `path-to-this-project`
5. Click the extension icon to open the side panel

## Suggested next step

If you want, the next iteration can add one of these:

1. full-page scrolling screenshots instead of visible-viewport only
2. keyboard shortcuts for capture-and-insert while you are narrating
3. direct export packaging for your LMS builder's preferred format
