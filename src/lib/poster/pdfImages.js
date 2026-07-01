// Extract usable travel photos from PDFs.
// Normal PDFs may contain real embedded JPEG photos. Some client PDFs are flattened
// page scans, so we crop photo-like rectangles from those scans instead of using
// the whole PDF page as a "photo".

import crypto from "crypto";
import jpeg from "jpeg-js";
import zlib from "zlib";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";

const MIN_BYTES = 5_000;
const MIN_DIM = 90;
const MAX_PHOTO_ASPECT = 2.6;
const MIN_PHOTO_ASPECT = 0.35;
const FULL_PAGE_ASPECT_TOLERANCE = 0.08;
const MAX_CROPS_PER_PAGE = 12;
const MIN_COMPRESSED_BYTES_PER_PIXEL = 0.08;
const MIN_JPEG_BYTES_PER_PIXEL = 0.06;
const SIMILAR_HASH_MAX_DISTANCE = 6;

function getImageInfo(stream) {
  const dict = stream.dict;
  const subtype = dict.get(PDFName.of("Subtype"));
  if (!subtype || subtype.toString() !== "/Image") return null;

  const bytes = Buffer.from(stream.contents || []);
  const width = Number(dict.get(PDFName.of("Width"))?.toString() || 0);
  const height = Number(dict.get(PDFName.of("Height"))?.toString() || 0);
  const filter = dict.get(PDFName.of("Filter"))?.toString() || "";
  const colorSpace = dict.get(PDFName.of("ColorSpace"))?.toString() || "";

  return { bytes, width, height, filter, colorSpace };
}

function isJpegLike(filter) {
  return filter.includes("DCTDecode") || filter.includes("JPXDecode");
}

function isFlate(filter) {
  return filter.includes("FlateDecode");
}

function isUsablePhotoShape(width, height) {
  if (width < MIN_DIM || height < MIN_DIM) return false;
  const aspect = width / Math.max(1, height);
  return aspect >= MIN_PHOTO_ASPECT && aspect <= MAX_PHOTO_ASPECT;
}

function isFullPageScan(image, pageSize, imageCountOnPage) {
  if (!pageSize || !image.width || !image.height) return false;
  const imageAspect = image.width / Math.max(1, image.height);
  const pageAspect = pageSize.width / Math.max(1, pageSize.height);
  const sameAspect = Math.abs(imageAspect - pageAspect) <= FULL_PAGE_ASPECT_TOLERANCE;
  const pageSized = image.width >= 700 && image.height >= 900;

  return pageSized && sameAspect && imageCountOnPage <= 2;
}

function isLikelyPageRender(width, height) {
  const aspect = width / Math.max(1, height);
  return width >= 700 && height >= 900 && aspect >= 0.55 && aspect <= 0.85;
}

function sha1(bytes) {
  return crypto.createHash("sha1").update(bytes).digest("hex");
}

function dataUrlFromJpeg(bytes) {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

function bytesFromDataUrl(dataUrl) {
  return Buffer.from(dataUrl.split(",")[1] || "", "base64");
}

function componentCount(colorSpace) {
  if (colorSpace.includes("DeviceGray")) return 1;
  if (colorSpace.includes("DeviceCMYK")) return 4;
  return 3;
}

function rawToRgba(raw, width, height, components) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const source = i * components;
    const target = i * 4;
    if (components === 1) {
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source];
      rgba[target + 2] = raw[source];
    } else if (components === 4) {
      const c = raw[source];
      const m = raw[source + 1];
      const y = raw[source + 2];
      const k = raw[source + 3];
      rgba[target] = 255 - Math.min(255, c + k);
      rgba[target + 1] = 255 - Math.min(255, m + k);
      rgba[target + 2] = 255 - Math.min(255, y + k);
    } else {
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source + 1];
      rgba[target + 2] = raw[source + 2];
    }
    rgba[target + 3] = 255;
  }
  return rgba;
}

function encodeJpegFromRgba(data, width, height) {
  return jpeg.encode({ data, width, height }, 88).data;
}

function decodeJpegBytes(bytes) {
  try {
    return jpeg.decode(bytes, { useTArray: true });
  } catch {
    return null;
  }
}

function averageHash(decoded) {
  const values = [];
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const x0 = Math.floor((gx * decoded.width) / 8);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * decoded.width) / 8));
      const y0 = Math.floor((gy * decoded.height) / 8);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * decoded.height) / 8));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 4));
      const stepY = Math.max(1, Math.floor((y1 - y0) / 4));
      let sum = 0;
      let count = 0;

      for (let y = y0; y < y1; y += stepY) {
        for (let x = x0; x < x1; x += stepX) {
          const index = (y * decoded.width + x) * 4;
          sum += 0.299 * decoded.data[index] + 0.587 * decoded.data[index + 1] + 0.114 * decoded.data[index + 2];
          count += 1;
        }
      }

      values.push(sum / Math.max(1, count));
    }
  }

  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.map((value) => (value > average ? "1" : "0")).join("");
}

function hammingDistance(a, b) {
  let distance = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) distance += 1;
  }
  return distance + Math.abs(a.length - b.length);
}

function decodeDataUrl(dataUrl) {
  try {
    const bytes = bytesFromDataUrl(dataUrl);
    const decoded = jpeg.decode(bytes, { useTArray: true });
    return { bytes, decoded, hash: averageHash(decoded), score: decoded.width * decoded.height };
  } catch {
    return null;
  }
}

function dedupeSimilarImages(dataUrls) {
  const kept = [];

  for (const dataUrl of dataUrls) {
    const current = decodeDataUrl(dataUrl);
    if (!current) continue;

    const duplicateIndex = kept.findIndex(
      (item) => hammingDistance(item.hash, current.hash) <= SIMILAR_HASH_MAX_DISTANCE
    );

    if (duplicateIndex === -1) {
      kept.push({ ...current, dataUrl });
    } else if (current.score > kept[duplicateIndex].score) {
      kept[duplicateIndex] = { ...current, dataUrl };
    }
  }

  return kept.map((item) => item.dataUrl);
}

function decodeFlateImage(image) {
  const components = componentCount(image.colorSpace || "");
  if (components === 1) return null;

  let raw;
  try {
    raw = zlib.inflateSync(image.bytes);
  } catch {
    return null;
  }

  const expected = image.width * image.height * components;
  if (raw.length < expected) return null;

  return {
    data: rawToRgba(raw.subarray(0, expected), image.width, image.height, components),
    width: image.width,
    height: image.height,
  };
}

function averageLogoBlueRatio(decoded) {
  const step = Math.max(1, Math.floor(Math.min(decoded.width, decoded.height) / 80));
  let blue = 0;
  let total = 0;

  for (let y = 0; y < decoded.height; y += step) {
    for (let x = 0; x < decoded.width; x += step) {
      const index = (y * decoded.width + x) * 4;
      const r = decoded.data[index];
      const g = decoded.data[index + 1];
      const b = decoded.data[index + 2];
      if (b > r + 20 && b > g + 5 && r < 80 && g < 120) blue += 1;
      total += 1;
    }
  }

  return total ? blue / total : 0;
}

function isLikelyLogo(decoded) {
  const aspect = decoded.width / Math.max(1, decoded.height);
  return aspect >= 0.75 && aspect <= 3.1 && averageLogoBlueRatio(decoded) > 0.42;
}

function darkBlueGraphicRatio(decoded) {
  const step = Math.max(1, Math.floor(Math.min(decoded.width, decoded.height) / 90));
  let darkOrBlue = 0;
  let total = 0;

  for (let y = 0; y < decoded.height; y += step) {
    for (let x = 0; x < decoded.width; x += step) {
      const index = (y * decoded.width + x) * 4;
      const r = decoded.data[index];
      const g = decoded.data[index + 1];
      const b = decoded.data[index + 2];
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      const isDark = luminance < 28;
      const isNavyLine = b > r + 20 && b > g + 8 && r < 65 && g < 105;
      if (isDark || isNavyLine) darkOrBlue += 1;
      total += 1;
    }
  }

  return total ? darkOrBlue / total : 0;
}

function isLikelyDecorativeGraphic(decoded) {
  return darkBlueGraphicRatio(decoded) > 0.78;
}

function flatIllustrationStats(decoded) {
  const step = Math.max(1, Math.floor(Math.min(decoded.width, decoded.height) / 90));
  const colors = new Set();
  let edge = 0;
  let edgeCount = 0;

  for (let y = 0; y < decoded.height; y += step) {
    for (let x = 0; x < decoded.width; x += step) {
      const index = (y * decoded.width + x) * 4;
      const r = decoded.data[index];
      const g = decoded.data[index + 1];
      const b = decoded.data[index + 2];
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      colors.add(`${r >> 4},${g >> 4},${b >> 4}`);

      if (x >= step) {
        const left = (y * decoded.width + x - step) * 4;
        const leftLuminance = 0.299 * decoded.data[left] + 0.587 * decoded.data[left + 1] + 0.114 * decoded.data[left + 2];
        edge += Math.abs(luminance - leftLuminance);
        edgeCount += 1;
      }

      if (y >= step) {
        const up = ((y - step) * decoded.width + x) * 4;
        const upLuminance = 0.299 * decoded.data[up] + 0.587 * decoded.data[up + 1] + 0.114 * decoded.data[up + 2];
        edge += Math.abs(luminance - upLuminance);
        edgeCount += 1;
      }
    }
  }

  return { edge: edge / Math.max(1, edgeCount), colors: colors.size };
}

function isLikelyFlatIllustration(decoded) {
  const aspect = decoded.width / Math.max(1, decoded.height);
  if (decoded.width < 500 || decoded.height < 180 || aspect < 1.8) return false;

  const stats = flatIllustrationStats(decoded);
  return stats.edge < 4 && stats.colors < 140;
}

function isMaskPixel(data, index) {
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max - min;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;

  if (luminance > 248) return false;
  if (luminance > 235 && saturation < 16) return false;
  return true;
}

function cropJpeg(decoded, box) {
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const width = Math.min(decoded.width - x, Math.ceil(box.width));
  const height = Math.min(decoded.height - y, Math.ceil(box.height));
  const data = Buffer.alloc(width * height * 4);

  for (let row = 0; row < height; row++) {
    const sourceStart = ((y + row) * decoded.width + x) * 4;
    const sourceEnd = sourceStart + width * 4;
    data.set(decoded.data.subarray(sourceStart, sourceEnd), row * width * 4);
  }

  return jpeg.encode({ data, width, height }, 88).data;
}

function cropDecoded(decoded, box) {
  return {
    bytes: cropJpeg(decoded, box),
    width: Math.ceil(box.width),
    height: Math.ceil(box.height),
  };
}

function luminanceAt(decoded, x, y) {
  const index = (y * decoded.width + x) * 4;
  return 0.299 * decoded.data[index] + 0.587 * decoded.data[index + 1] + 0.114 * decoded.data[index + 2];
}

function columnEdgeEnergy(decoded, x) {
  const step = Math.max(1, Math.floor(decoded.height / 180));
  let sum = 0;
  let count = 0;

  for (let y = 0; y < decoded.height; y += step) {
    sum += Math.abs(luminanceAt(decoded, x, y) - luminanceAt(decoded, x - 1, y));
    count += 1;
  }

  return sum / Math.max(1, count);
}

function rowEdgeEnergy(decoded, y) {
  const step = Math.max(1, Math.floor(decoded.width / 180));
  let sum = 0;
  let count = 0;

  for (let x = 0; x < decoded.width; x += step) {
    sum += Math.abs(luminanceAt(decoded, x, y) - luminanceAt(decoded, x, y - 1));
    count += 1;
  }

  return sum / Math.max(1, count);
}

function strongestCenterSeam(size, radius, scoreAt) {
  const center = Math.floor(size / 2);
  let best = { position: center, score: -1 };

  for (let position = center - radius; position <= center + radius; position++) {
    const score = scoreAt(position);
    if (score > best.score) best = { position, score };
  }

  return best;
}

function baselineSeamScore(size, scoreAt) {
  const positions = [0.2, 0.3, 0.4, 0.6, 0.7, 0.8].map((ratio) => Math.round(size * ratio));
  return positions.reduce((sum, position) => sum + scoreAt(position), 0) / positions.length;
}

function isLikelyTwoByTwoCollage(decoded) {
  const aspect = decoded.width / Math.max(1, decoded.height);
  if (decoded.width < 560 || decoded.height < 330 || aspect < 1.2 || aspect > 1.9) return false;

  const vertical = strongestCenterSeam(
    decoded.width,
    Math.round(decoded.width * 0.06),
    (position) => columnEdgeEnergy(decoded, Math.min(decoded.width - 1, Math.max(1, position)))
  );
  const horizontal = strongestCenterSeam(
    decoded.height,
    Math.round(decoded.height * 0.06),
    (position) => rowEdgeEnergy(decoded, Math.min(decoded.height - 1, Math.max(1, position)))
  );
  const verticalBaseline = baselineSeamScore(
    decoded.width,
    (position) => columnEdgeEnergy(decoded, Math.min(decoded.width - 1, Math.max(1, position)))
  );
  const horizontalBaseline = baselineSeamScore(
    decoded.height,
    (position) => rowEdgeEnergy(decoded, Math.min(decoded.height - 1, Math.max(1, position)))
  );

  return (
    vertical.score >= 24 &&
    horizontal.score >= 24 &&
    vertical.score >= verticalBaseline * 2.2 &&
    horizontal.score >= horizontalBaseline * 2.2
  );
}

function splitTwoByTwoCollage(decoded) {
  const tileWidth = decoded.width / 2;
  const tileHeight = decoded.height / 2;
  const gutterX = Math.min(16, Math.round(tileWidth * 0.04));
  const gutterY = Math.min(12, Math.round(tileHeight * 0.04));

  return [
    { x: 0, y: 0, width: tileWidth - gutterX, height: tileHeight - gutterY },
    { x: tileWidth + gutterX, y: 0, width: tileWidth - gutterX, height: tileHeight - gutterY },
    { x: 0, y: tileHeight + gutterY, width: tileWidth - gutterX, height: tileHeight - gutterY },
    { x: tileWidth + gutterX, y: tileHeight + gutterY, width: tileWidth - gutterX, height: tileHeight - gutterY },
  ].map((box) => cropDecoded(decoded, box));
}

function splitDecodedIntoPhotoTiles(decoded) {
  const aspect = decoded.width / Math.max(1, decoded.height);
  if (isLikelyTwoByTwoCollage(decoded)) {
    return splitTwoByTwoCollage(decoded);
  }

  if (aspect <= MAX_PHOTO_ASPECT) {
    return [{ bytes: encodeJpegFromRgba(decoded.data, decoded.width, decoded.height), width: decoded.width, height: decoded.height }];
  }

  const tileCount = aspect >= 3.8 ? 3 : 2;
  const tileWidth = decoded.width / tileCount;
  const gutter = Math.min(24, Math.round(tileWidth * 0.07));
  return Array.from({ length: tileCount }, (_, index) => {
    const trimLeft = index === 0 ? 0 : gutter;
    const trimRight = index === tileCount - 1 ? 0 : gutter;
    return cropDecoded(decoded, {
      x: index * tileWidth + trimLeft,
      y: 0,
      width: tileWidth - trimLeft - trimRight,
      height: decoded.height,
    });
  });
}

function sortBoxesTopToBottomLeftToRight(boxes) {
  const rowTolerance = 40;
  return boxes.sort((a, b) => {
    if (Math.abs(a.y - b.y) <= rowTolerance) return a.x - b.x;
    return a.y - b.y;
  });
}

function cropPhotoRectsFromScan(scan) {
  let decoded;
  try {
    decoded = jpeg.decode(scan.bytes, { useTArray: true });
  } catch {
    return [];
  }

  const step = Math.max(2, Math.round(Math.min(decoded.width, decoded.height) / 360));
  const gridWidth = Math.ceil(decoded.width / step);
  const gridHeight = Math.ceil(decoded.height / step);
  const mask = new Uint8Array(gridWidth * gridHeight);

  for (let gy = 0; gy < gridHeight; gy++) {
    for (let gx = 0; gx < gridWidth; gx++) {
      const x = Math.min(decoded.width - 1, gx * step);
      const y = Math.min(decoded.height - 1, gy * step);
      const index = (y * decoded.width + x) * 4;
      if (isMaskPixel(decoded.data, index)) mask[gy * gridWidth + gx] = 1;
    }
  }

  const visited = new Uint8Array(mask.length);
  const components = [];
  const queue = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;

    let minX = gridWidth;
    let minY = gridHeight;
    let maxX = 0;
    let maxY = 0;
    let count = 0;
    queue.length = 0;
    queue.push(start);
    visited[start] = 1;

    for (let qi = 0; qi < queue.length; qi++) {
      const current = queue[qi];
      const x = current % gridWidth;
      const y = Math.floor(current / gridWidth);
      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const neighbors = [
        x > 0 ? current - 1 : -1,
        x + 1 < gridWidth ? current + 1 : -1,
        y > 0 ? current - gridWidth : -1,
        y + 1 < gridHeight ? current + gridWidth : -1,
      ];

      for (const next of neighbors) {
        if (next < 0 || visited[next] || !mask[next]) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }

    const width = (maxX - minX + 1) * step;
    const height = (maxY - minY + 1) * step;
    const aspect = width / Math.max(1, height);
    const density = count / Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));

    if (
      width >= decoded.width * 0.18 &&
      height >= decoded.height * 0.08 &&
      aspect >= 1.05 &&
      aspect <= 2.4 &&
      density >= 0.32
    ) {
      components.push({
        x: minX * step,
        y: minY * step,
        width: Math.min(decoded.width - minX * step, width),
        height: Math.min(decoded.height - minY * step, height),
        density,
      });
    }
  }

  return sortBoxesTopToBottomLeftToRight(components)
    .slice(0, MAX_CROPS_PER_PAGE)
    .map((box) => cropJpeg(decoded, box));
}

export async function extractPdfImages(buffer) {
  try {
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const images = [];
    const pageScans = [];
    const seen = new Set();

    for (const page of pdfDoc.getPages()) {
      const pageSize = page.getSize();
      const resources = page.node.Resources();
      const xObjects = resources?.lookup(PDFName.of("XObject"));
      if (!xObjects || typeof xObjects.keys !== "function") continue;

      const pageImages = [];
      for (const key of xObjects.keys()) {
        const ref = xObjects.get(key);
        const xobj = pdfDoc.context.lookup(ref) ?? ref;
        if (!(xobj instanceof PDFRawStream)) continue;

        const info = getImageInfo(xobj);
        if (!info || info.bytes.length < MIN_BYTES || !isJpegLike(info.filter)) continue;
        pageImages.push(info);
      }

      for (const image of pageImages) {
        if (isFullPageScan(image, pageSize, pageImages.length)) {
          pageScans.push(image);
          continue;
        }

        if (!isUsablePhotoShape(image.width, image.height)) continue;
        const decoded = decodeJpegBytes(image.bytes);
        if (decoded && (isLikelyLogo(decoded) || isLikelyDecorativeGraphic(decoded) || isLikelyFlatIllustration(decoded))) continue;
        const key = sha1(image.bytes);
        if (seen.has(key)) continue;
        seen.add(key);
        images.push(dataUrlFromJpeg(image.bytes));
      }
    }

    for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;

      const image = getImageInfo(obj);
      if (!image || image.bytes.length < MIN_BYTES) continue;

      if (isJpegLike(image.filter)) {
        if (isLikelyPageRender(image.width, image.height)) continue;
        if (!isUsablePhotoShape(image.width, image.height)) continue;
        if (image.bytes.length / Math.max(1, image.width * image.height) < MIN_JPEG_BYTES_PER_PIXEL) continue;
        const decoded = decodeJpegBytes(image.bytes);
        if (!decoded || isLikelyLogo(decoded) || isLikelyDecorativeGraphic(decoded) || isLikelyFlatIllustration(decoded)) continue;
        const key = sha1(image.bytes);
        if (seen.has(key)) continue;
        seen.add(key);
        images.push(dataUrlFromJpeg(image.bytes));
        continue;
      }

      if (!isFlate(image.filter)) continue;
      if (!isUsablePhotoShape(image.width, image.height) && image.width / Math.max(1, image.height) <= MAX_PHOTO_ASPECT) continue;
      if (image.bytes.length / Math.max(1, image.width * image.height) < MIN_COMPRESSED_BYTES_PER_PIXEL) continue;

      const decoded = decodeFlateImage(image);
      if (!decoded || isLikelyLogo(decoded) || isLikelyDecorativeGraphic(decoded) || isLikelyFlatIllustration(decoded)) continue;

      for (const tile of splitDecodedIntoPhotoTiles(decoded)) {
        if (!isUsablePhotoShape(tile.width, tile.height)) continue;
        const key = sha1(tile.bytes);
        if (seen.has(key)) continue;
        seen.add(key);
        images.push(dataUrlFromJpeg(tile.bytes));
      }
    }

    if (images.length === 0 && pageScans.length > 0) {
      for (const scan of pageScans) {
        const crops = cropPhotoRectsFromScan(scan);
        for (const crop of crops) {
          const key = sha1(crop);
          if (seen.has(key)) continue;
          seen.add(key);
          images.push(dataUrlFromJpeg(crop));
        }
      }
    }

    const uniqueImages = dedupeSimilarImages(images);
    console.log(`[pdfImages] found ${uniqueImages.length} usable images`);
    return uniqueImages;
  } catch (e) {
    console.warn("[pdfImages] extraction failed:", e.message);
    return [];
  }
}
