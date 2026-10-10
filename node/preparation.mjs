/**
 * Preview sheets (docs/scenes/format.md, "Preview sheets"): one image that
 * holds the faces of several preview cubes, so a scene's orbs can all be
 * shown after one request. The faces are the cubes' own face files, decoded
 * and encoded again side by side; the files stay, for loaders that do not
 * read sheets and for when a sheet fails.
 */
import { createHash } from "node:crypto";
import { CUBE_FACE_NAMES } from "@foss-earth/cubemap/core";
import { decodeJpeg, decodePng, encodeJpeg, sniffImage, cropImage, inspectImageDecode, ImageDecodeLimitError } from "@foss-earth/images/node";
import { PREVIEW_SHEETS_EXTENSION } from "../dist/core.js";
export { PREVIEW_SHEETS_EXTENSION };

/** A JPEG block: faces at multiples of it share no block with a neighbour, so none bleeds into another. */
const JPEG_BLOCK = 8;
/** Pixels a sheet may hold unless the caller says otherwise: 16 MiB decoded, 162 cubes of 64 px faces. */
export const SHEET_PIXELS = 4_000_000;

/** A file's pixels as RGB, whatever it is. */
function decodeRgb(bytes, what) {
  bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = sniffImage(bytes);
  if (!kind) throw new Error(`${what} is neither a JPEG nor a PNG`);
  const { width, height, rgba } = kind === "image/png" ? decodePng(bytes) : decodeJpeg(bytes);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = rgba[i * 4];
    rgb[i * 3 + 1] = rgba[i * 4 + 1];
    rgb[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return { width, height, rgb };
}

/** Columns that make a sheet of `count` cubes, each six faces wide and one high, about square. */
export function sheetColumns(count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("A sheet's cube count must be a nonnegative whole number");
  return Math.max(1, Math.ceil(Math.sqrt(count / CUBE_FACE_NAMES.length)));
}

/**
 * One sheet of `cubes`, each `{ key, faces: { px: bytes, … } }` with faces of
 * `faceSize`. Cube i goes in column i mod columns, row ⌊i / columns⌋; its
 * faces px, nx, py, ny, pz and nz run rightwards from its place. Returns the
 * JPEG's bytes, its size, each key's place and a revision from its bytes.
 */
export function composeSheet(cubes, faceSize, quality = 80) {
  if (cubes.length === 0) throw new Error("A sheet needs at least one cube");
  if (!Number.isInteger(faceSize) || faceSize <= 0 || faceSize % JPEG_BLOCK !== 0) throw new Error(`A sheet's faces must be a multiple of ${JPEG_BLOCK} px, so no JPEG block spans two of them; got ${faceSize}`);
  if (!Number.isFinite(quality) || quality < 1 || quality > 100) throw new RangeError("JPEG quality must be from 1 to 100");
  if (new Set(cubes.map(cube => cube.key)).size !== cubes.length) throw new Error("A sheet cannot contain duplicate cube keys");
  const columns = sheetColumns(cubes.length);
  const rows = Math.ceil(cubes.length / columns);
  const cell = CUBE_FACE_NAMES.length * faceSize;
  const width = columns * cell;
  const height = rows * faceSize;
  // Cells no cube fills are mid grey.
  const rgb = new Uint8Array(width * height * 3).fill(128);
  const places = new Map();
  cubes.forEach((cube, index) => {
    const x = (index % columns) * cell;
    const y = Math.floor(index / columns) * faceSize;
    places.set(cube.key, { x, y });
    CUBE_FACE_NAMES.forEach((face, at) => {
      const image = decodeRgb(cube.faces[face], `${cube.key}'s ${face} face`);
      if (image.width !== faceSize || image.height !== faceSize) throw new Error(`${cube.key}'s ${face} face is ${image.width} × ${image.height} px, not ${faceSize}`);
      for (let row = 0; row < faceSize; row++) {
        rgb.set(image.rgb.subarray(row * faceSize * 3, (row + 1) * faceSize * 3), ((y + row) * width + x + at * faceSize) * 3);
      }
    });
  });
  const bytes = encodeJpeg({ width, height, rgb }, quality);
  return { bytes, width, height, places, revision: createHash("sha256").update(bytes).digest("hex").slice(0, 12) };
}

const previewCubes = asset => (asset.type === "panorama-image" ? asset.representations.filter(rep => rep.projection === "cube" && rep.role === "preview") : []);

/**
 * The extension a scene's sheets are written in, src/scenes/format.ts's
 * PREVIEW_SHEETS_EXTENSION: on the scene, `{ sheets }`; on a cube, its place
 * `{ id, x, y }`. A loader from before sheets refuses a property it does not
 * know and skips an extension it does not know, so it loads the cubes' files.
 */


/** The sheets a scene names, and those of a scene written on 2026-10-03, which had them as properties of its own. */
export const sheetsOf = document => [...(document.extensions?.[PREVIEW_SHEETS_EXTENSION]?.sheets ?? []), ...(document.sheets ?? [])];

/** Takes the extension off a record, and the record's `extensions` with it when nothing else is in them. */
function withoutSheets(record) {
  if (!record.extensions) return;
  delete record.extensions[PREVIEW_SHEETS_EXTENSION];
  if (Object.keys(record.extensions).length === 0) delete record.extensions;
}

/**
 * A copy of `document` with sheets for its preview cubes of `faceSize` (left
 * out, each asset's smallest, where they are all one size), and the sheets'
 * files. `read(url)` gives a face file's bytes by its URL as the manifest
 * writes it. Sheets and places the document already had are replaced.
 *
 * Returns `{ document, files: [{ url, bytes }], cubes }`.
 */
export function addPreviewSheets(document, { read, faceSize, quality = 80, maxPixels = SHEET_PIXELS, urlPrefix = "media/" }) {
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1) throw new RangeError("maxPixels must be a positive whole-number pixel limit");
  const copy = JSON.parse(JSON.stringify(document));
  withoutSheets(copy);
  delete copy.sheets;
  for (const asset of copy.assets) for (const representation of asset.representations ?? []) {
    withoutSheets(representation);
    delete representation.sheet;
  }
  const size = faceSize ?? Math.min(...copy.assets.flatMap(asset => previewCubes(asset).map(rep => rep.faceSize)));
  if (!Number.isFinite(size)) return { document: copy, files: [], cubes: 0 };
  const chosen = copy.assets.flatMap(asset => previewCubes(asset).filter(rep => rep.faceSize === size).slice(0, 1).map(representation => ({ asset, representation })));
  if (chosen.length === 0) return { document: copy, files: [], cubes: 0 };
  let perSheet = Math.floor(maxPixels / (CUBE_FACE_NAMES.length * size * size));
  if (perSheet < 1) throw new RangeError("The pixel limit cannot hold one preview cube");
  // Padded cells count too: the host's limit is the whole decoded sheet.
  const pixelsFor = count => sheetColumns(count) * CUBE_FACE_NAMES.length * size * Math.ceil(count / sheetColumns(count)) * size;
  while (pixelsFor(perSheet) > maxPixels) perSheet -= 1;
  const sheets = [];
  const files = [];
  for (let start = 0; start < chosen.length; start += perSheet) {
    const group = chosen.slice(start, start + perSheet);
    const sheet = composeSheet(group.map(({ asset, representation }) => ({
      key: asset.id,
      faces: Object.fromEntries(CUBE_FACE_NAMES.map(face => {
        const bytes = read(representation.faces[face]);
        if (!bytes) throw new Error(`${representation.faces[face]} does not exist`);
        return [face, bytes];
      })),
    })), size, quality);
    const id = `previews-${size}${sheets.length ? `-${sheets.length + 1}` : ""}`;
    const url = `${urlPrefix}${id}.jpg`;
    sheets.push({ id, revision: sheet.revision, mimeType: "image/jpeg", width: sheet.width, height: sheet.height, encodedBytes: sheet.bytes.length, url });
    files.push({ url, bytes: sheet.bytes });
    for (const { asset, representation } of group) representation.extensions = { ...representation.extensions, [PREVIEW_SHEETS_EXTENSION]: { id, ...sheet.places.get(asset.id) } };
  }
  if (copy.extensions) {
    copy.extensions[PREVIEW_SHEETS_EXTENSION] = { sheets };
    return { document: copy, files, cubes: chosen.length };
  }
  // Before the assets, as the format lists a scene's extensions; its other properties keep their order.
  const ordered = {};
  for (const [key, value] of Object.entries(copy)) {
    if (key === "assets") ordered.extensions = { [PREVIEW_SHEETS_EXTENSION]: { sheets } };
    ordered[key] = value;
  }
  return { document: ordered, files, cubes: chosen.length };
}

/**
 * Whether each sheet of a scene's document shows what its cubes' face files
 * show: every face in the sheet against the file, as PSNR over the face, which a second JPEG encoding
 * keeps above `minPsnrDb` and a face in the wrong place does not. Returns the
 * problems found, as `{ path, message }`, and the lowest PSNR seen.
 */
export const DEFAULT_PREVIEW_SHEET_VERIFICATION_LIMITS = Object.freeze({
  maxAssets: 2000, maxSheets: 128, maxRepresentations: 8000, maxFiles: 50000,
  maxEncodedBytes: 32 * 1024 * 1024, maxInputBytes: 512 * 1024 * 1024,
  maxMemoryBytes: 128 * 1024 * 1024, maxDecodedPixels: 64000000, maxWorkPixels: 128000000,
  maxMetadataBytes: 256 * 1024, maxChunks: 10000,
});
export class PreviewSheetVerificationLimitError extends RangeError {
  constructor(message) { super(message); this.name = "PreviewSheetVerificationLimitError"; }
}
/** Synchronous bounded jobs. Cancellation cannot interrupt an active native codec call. */
export function verifyPreviewSheets(document, read, minPsnrDb = 28, options = {}) {
  if (!Number.isFinite(minPsnrDb) || minPsnrDb < 0) throw new RangeError("The PSNR limit must be nonnegative finite dB");
  const limits = { ...DEFAULT_PREVIEW_SHEET_VERIFICATION_LIMITS, ...options };
  for (const key of Object.keys(DEFAULT_PREVIEW_SHEET_VERIFICATION_LIMITS)) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) throw new RangeError(`${key} must be a positive safe integer`);
  const abort = () => { if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Preview verification cancelled", "AbortError"); };
  const admit = (value, maximum, name) => { if (!Number.isSafeInteger(value) || value > maximum) throw new PreviewSheetVerificationLimitError(`Preview ${name} budget exceeded`); };
  const stats = { files: 0, inputBytes: 0, decodedPixels: 0, workPixels: 0, retainedSheetBytes: 0, peakWorkingBytes: 0, representations: 0 };
  const work = pixels => { admit(stats.workPixels + pixels, limits.maxWorkPixels, "work pixels"); stats.workPixels += pixels; };
  const decode = (url, expected) => {
    abort(); admit(++stats.files, limits.maxFiles, "files");
    const bytes = read(url); abort();
    if (!(bytes instanceof Uint8Array)) throw new Error(`${url} does not exist`);
    admit(bytes.length, limits.maxEncodedBytes, "encoded bytes");
    admit(stats.inputBytes + bytes.length, limits.maxInputBytes, "input bytes"); stats.inputBytes += bytes.length;
    if (expected && bytes.length !== expected.encodedBytes) throw new Error(`${url} byte length differs from sheet metadata`);
    const available = limits.maxMemoryBytes - stats.retainedSheetBytes, pixels = limits.maxDecodedPixels - stats.decodedPixels;
    if (available < 1 || pixels < 1) throw new PreviewSheetVerificationLimitError("Preview retained sheets/decoded pixels budget exceeded");
    const codecOptions = { maxEncodedBytes: limits.maxEncodedBytes, maxPixels: pixels, maxMemoryBytes: available, maxMetadataBytes: limits.maxMetadataBytes, maxChunks: limits.maxChunks, signal: options.signal };
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let plan;
    try { plan = inspectImageDecode(buffer, codecOptions); }
    catch (error) { if (error instanceof ImageDecodeLimitError) throw new PreviewSheetVerificationLimitError(error.message); throw error; }
    if (expected && (plan.width !== expected.width || plan.height !== expected.height || plan.mimeType !== expected.mimeType)) throw new Error(`${url} header differs from sheet metadata`);
    stats.decodedPixels += plan.pixels; work(plan.pixels);
    stats.peakWorkingBytes = Math.max(stats.peakWorkingBytes, stats.retainedSheetBytes + plan.workingBytes);
    let image;
    try { image = plan.mimeType === "image/png" ? decodePng(buffer, codecOptions) : decodeJpeg(buffer, codecOptions); }
    catch (error) { if (error instanceof ImageDecodeLimitError || /maxMemoryUsageInMB|maxResolutionInMP/.test(error.message)) throw new PreviewSheetVerificationLimitError(error.message); throw error; }
    abort(); return { width: image.width, height: image.height, rgba: image.rgba };
  };
  const problems = [], decoded = new Map(); let lowest = Number.POSITIVE_INFINITY;
  const report = (error, path) => { abort(); if (error instanceof PreviewSheetVerificationLimitError) throw error; problems.push({ path, message: error.message }); };
  const sheets = document.extensions?.[PREVIEW_SHEETS_EXTENSION]?.sheets ?? [];
  admit(sheets.length, limits.maxSheets, "sheets");
  for (const sheet of sheets) {
    abort(); const path = `$.extensions.${PREVIEW_SHEETS_EXTENSION}.sheets[${sheet.id}].url`;
    if (decoded.has(sheet.id)) { problems.push({ path, message: "duplicate sheet identity" }); continue; }
    try { const image = decode(sheet.url, sheet); decoded.set(sheet.id, image); stats.retainedSheetBytes += image.rgba.byteLength; }
    catch (error) { report(error, path); }
  }
  admit((document.assets ?? []).length, limits.maxAssets, "assets");
  for (const asset of document.assets ?? []) {
    abort();
    for (const representation of asset.representations ?? []) {
      abort(); admit(++stats.representations, limits.maxRepresentations, "representations");
      if (representation.projection !== "cube") continue;
      const place = representation.extensions?.[PREVIEW_SHEETS_EXTENSION];
      if (!place) continue;
      const sheet = decoded.get(place.id), size = representation.faceSize;
      const path = `$.assets[${asset.id}].representations[${representation.id}].extensions.${PREVIEW_SHEETS_EXTENSION}`;
      if (!sheet) { problems.push({ path, message: `sheet ${place.id} is unavailable for required equivalence verification` }); continue; }
      if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(place.x) || place.x < 0 || !Number.isSafeInteger(place.y) || place.y < 0 || place.x + CUBE_FACE_NAMES.length * size > sheet.width || place.y + size > sheet.height) { problems.push({ path, message: "the cube's six faces do not lie inside the decoded sheet" }); continue; }
      for (const [at, face] of CUBE_FACE_NAMES.entries()) {
        abort(); const url = representation.faces?.[face];
        if (typeof url !== "string") { problems.push({ path, message: `the cube has no ${face} original face file` }); continue; }
        let file;
        try { file = decode(url); } catch (error) { report(error, path); continue; }
        if (file.width !== size || file.height !== size) { problems.push({ path, message: `${url} is not ${size} × ${size} px` }); continue; }
        work(size * size); let squared = 0;
        for (let row = 0; row < size; row++) {
          abort();
          for (let column = 0; column < size; column++) for (let channel = 0; channel < 3; channel++) {
            const difference = file.rgba[(row * size + column) * 4 + channel] - sheet.rgba[((place.y + row) * sheet.width + place.x + at * size + column) * 4 + channel]; squared += difference * difference;
          }
        }
        const mean = squared / (size * size * 3), psnr = mean > 0 ? 10 * Math.log10((255 * 255) / mean) : Number.POSITIVE_INFINITY;
        lowest = Math.min(lowest, psnr);
        if (psnr < minPsnrDb) problems.push({ path, message: `the ${face} face in sheet "${place.id}" at (${place.x + at * size}, ${place.y}) is ${psnr.toFixed(1)} dB from ${url}, under ${minPsnrDb} dB: not the same picture` });
      }
    }
  }
  abort(); return { problems, lowestPsnrDb: lowest, stats };
}

/** Pure extraction of a decoded RGB sheet; no GPU upload or scene interpretation. */
export function extractSheetFaces(image, place, faceSize) {
  if (!Number.isSafeInteger(faceSize) || faceSize < 1 || !Number.isSafeInteger(place.x) || place.x < 0 || !Number.isSafeInteger(place.y) || place.y < 0 || place.x + CUBE_FACE_NAMES.length * faceSize > image.width || place.y + faceSize > image.height) throw new RangeError("The cube's six faces must lie inside the decoded sheet");
  return Object.fromEntries(CUBE_FACE_NAMES.map((face, index) => [face, cropImage(image, place.x + index * faceSize, place.y, faceSize, faceSize)]));
}
