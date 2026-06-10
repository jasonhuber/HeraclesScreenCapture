import { normalizeInlineText } from "./markdown.js";

export function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("Unable to load the captured image into the editor.")));
    image.src = src;
  });
}

export async function getImageDimensions(dataUrl) {
  const image = await loadImage(dataUrl);
  return {
    width: image.naturalWidth || image.width,
    height: image.naturalHeight || image.height
  };
}

export async function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }

      reject(new Error("Chrome could not encode the edited image."));
    }, "image/png");
  });
}

export async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return response.blob();
}

export async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(blob);
  });
}

export async function cropDataUrl(dataUrl, cropRect, viewportWidth, viewportHeight) {
  const image = await loadImage(dataUrl);
  const scaleX = image.naturalWidth / viewportWidth;
  const scaleY = image.naturalHeight / viewportHeight;
  const sourceX = Math.round(cropRect.x * scaleX);
  const sourceY = Math.round(cropRect.y * scaleY);
  const sourceWidth = Math.round(cropRect.width * scaleX);
  const sourceHeight = Math.round(cropRect.height * scaleY);
  const canvas = document.createElement("canvas");

  canvas.width = Math.max(1, sourceWidth);
  canvas.height = Math.max(1, sourceHeight);

  const context = canvas.getContext("2d");
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight
  );

  return canvas.toDataURL("image/png");
}

export function clampNumber(value, min, max) {
  return Math.max(min, Math.min(value, max));
}

export function rectFromPoints(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y)
  };
}

export function isMeaningfulRect(rect) {
  return rect && rect.width >= 4 && rect.height >= 4;
}

export function cloneRects(rects) {
  return Array.isArray(rects) ? rects.map((rect) => ({ ...rect })) : [];
}

export function normalizeRect(rect) {
  if (!rect) {
    return null;
  }

  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);

  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }

  return {
    x,
    y,
    width,
    height,
    kind: normalizeInlineText(rect.kind || ""),
    label: normalizeInlineText(rect.label || "")
  };
}

export function intersectRects(rectA, rectB) {
  const x = Math.max(rectA.x, rectB.x);
  const y = Math.max(rectA.y, rectB.y);
  const right = Math.min(rectA.x + rectA.width, rectB.x + rectB.width);
  const bottom = Math.min(rectA.y + rectA.height, rectB.y + rectB.height);

  if (right - x < 2 || bottom - y < 2) {
    return null;
  }

  return {
    ...rectA,
    x,
    y,
    width: right - x,
    height: bottom - y
  };
}

export function remapRectsToRegion(rects, regionRect) {
  return rects
    .map((rect) => intersectRects(rect, regionRect))
    .filter(Boolean)
    .map((rect) => ({
      ...rect,
      x: rect.x - regionRect.x,
      y: rect.y - regionRect.y
    }));
}

export function scaleRectsToAsset(rects, sourceWidth, sourceHeight, assetWidth, assetHeight) {
  if (!sourceWidth || !sourceHeight || !assetWidth || !assetHeight) {
    return [];
  }

  const scaleX = assetWidth / sourceWidth;
  const scaleY = assetHeight / sourceHeight;

  return rects.map((rect) => ({
    ...rect,
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width: Math.max(1, Math.round(rect.width * scaleX)),
    height: Math.max(1, Math.round(rect.height * scaleY))
  }));
}

export function cropRectsWithinRect(rects, cropRect) {
  return rects
    .map((rect) => {
      const nextRect = intersectRects(rect, cropRect);

      if (!nextRect) {
        return null;
      }

      return {
        ...nextRect,
        x: nextRect.x - cropRect.x,
        y: nextRect.y - cropRect.y
      };
    })
    .filter(Boolean);
}
