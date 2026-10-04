/**
 * Preview sheets (docs/scenes/format.md, "Preview sheets"): one image that
 * holds the faces of several preview cubes, so a scene's orbs can all be
 * shown after one request. The faces are the cubes' own face files, decoded
 * and encoded again side by side; the files stay, for loaders that do not
 * read sheets and for when a sheet fails.
 */
import { createHash } from "node:crypto";
import { CUBE_FACE_NAMES, decodeJpeg, decodePng, encodeJpeg, sniffImage } from "./panoramaImage.mjs";

/** A JPEG block: faces at multiples of it share no block with a neighbour, so none bleeds into another. */
const JPEG_BLOCK = 8;
/** Pixels a sheet may hold unless the caller says otherwise: 16 MiB decoded, 162 cubes of 64 px faces. */
export const SHEET_PIXELS = 4_000_000;

/** A file's pixels as RGB, whatever it is. */
function decodeRgb(bytes, what) {
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
export const PREVIEW_SHEETS_EXTENSION = "foss-earth.preview-sheets";

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
  const perSheet = Math.max(1, Math.floor(maxPixels / (CUBE_FACE_NAMES.length * size * size)));
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
export function verifyPreviewSheets(document, read, minPsnrDb = 28) {
  const problems = [];
  let lowest = Number.POSITIVE_INFINITY;
  const decoded = new Map();
  for (const sheet of document.extensions?.[PREVIEW_SHEETS_EXTENSION]?.sheets ?? []) {
    const path = `$.extensions.${PREVIEW_SHEETS_EXTENSION}.sheets[${sheet.id}].url`;
    const bytes = read(sheet.url);
    if (!bytes) { problems.push({ path, message: `${sheet.url} does not exist` }); continue; }
    try { decoded.set(sheet.id, decodeRgb(bytes, sheet.url)); } catch (error) { problems.push({ path, message: error.message }); }
  }
  for (const asset of document.assets ?? []) {
    for (const representation of asset.representations ?? []) {
      const place = representation.extensions?.[PREVIEW_SHEETS_EXTENSION];
      const sheet = place && decoded.get(place.id);
      if (!sheet) continue;
      const size = representation.faceSize;
      CUBE_FACE_NAMES.forEach((face, at) => {
        const path = `$.assets[${asset.id}].representations[${representation.id}].extensions.${PREVIEW_SHEETS_EXTENSION}`;
        const bytes = read(representation.faces[face]);
        if (!bytes) return;
        const file = decodeRgb(bytes, representation.faces[face]);
        let squared = 0;
        for (let row = 0; row < size; row++) {
          for (let column = 0; column < size * 3; column++) {
            const difference = file.rgb[row * size * 3 + column] - sheet.rgb[((place.y + row) * sheet.width + place.x + at * size) * 3 + column];
            squared += difference * difference;
          }
        }
        const mean = squared / (size * size * 3);
        const psnr = mean > 0 ? 10 * Math.log10((255 * 255) / mean) : Number.POSITIVE_INFINITY;
        lowest = Math.min(lowest, psnr);
        if (psnr < minPsnrDb) problems.push({ path, message: `the ${face} face in sheet "${place.id}" at (${place.x + at * size}, ${place.y}) is ${psnr.toFixed(1)} dB from ${representation.faces[face]}, under ${minPsnrDb} dB: not the same picture` });
      });
    }
  }
  return { problems, lowestPsnrDb: lowest };
}
