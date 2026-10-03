import { describe, expect, it } from "vitest";
import { CUBE_FACE_NAMES, decodeJpeg, encodeJpeg } from "./panoramaImage.mjs";
import { addPreviewSheets, composeSheet, sheetColumns, verifyPreviewSheets } from "./previewSheet.mjs";

const SIZE = 16;
/** A face of one flat colour, as a JPEG. */
const face = ([r, g, b]) => {
  const rgb = Buffer.alloc(SIZE * SIZE * 3);
  for (let i = 0; i < SIZE * SIZE; i++) { rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b; }
  return encodeJpeg({ width: SIZE, height: SIZE, rgb }, 95);
};
/** Six colours a cube: its number in red, the face's in green and blue. */
const colourOf = (cube, at) => [30 + cube * 30, 30 + at * 40, 230 - at * 40];
const cubeFaces = cube => Object.fromEntries(CUBE_FACE_NAMES.map((name, at) => [name, face(colourOf(cube, at))]));
const pixel = (image, x, y) => [...image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];

function sceneOf(count) {
  const files = new Map();
  const assets = Array.from({ length: count }, (_, cube) => {
    const faces = cubeFaces(cube);
    const urls = Object.fromEntries(CUBE_FACE_NAMES.map(name => [name, `media/a${cube}/preview-16/${name}.jpg`]));
    for (const name of CUBE_FACE_NAMES) files.set(urls[name], faces[name]);
    return {
      id: `a${cube}`, revision: "1", type: "panorama-image",
      representations: [
        { id: "preview-16", role: "preview", projection: "cube", mimeType: "image/jpeg", faceSize: SIZE, encodedBytes: 1, faces: urls },
        { id: "whole", role: "immersion", projection: "equirectangular", mimeType: "image/jpeg", width: 64, height: 32, encodedBytes: 1, url: `media/a${cube}/whole.jpg` },
      ],
    };
  });
  return { document: { format: "foss-earth-scene", version: 1, id: "s", revision: "1", title: "S", assets, entities: [] }, files };
}

describe("a preview sheet", () => {
  it("is about square, in cells six faces wide", () => {
    expect([1, 6, 7, 24, 25, 60].map(sheetColumns)).toEqual([1, 1, 2, 2, 3, 4]);
  });

  it("puts each cube's faces px, nx, py, ny, pz, nz rightwards from its place, cube after cube in rows", () => {
    const cubes = [0, 1, 2, 3, 4, 5, 6];
    const sheet = composeSheet(cubes.map(cube => ({ key: `a${cube}`, faces: cubeFaces(cube) })), SIZE, 95);
    // Seven cubes: two columns, four rows; the last cell is empty.
    expect([sheet.width, sheet.height]).toEqual([2 * 6 * SIZE, 4 * SIZE]);
    expect(Object.fromEntries(sheet.places)).toMatchObject({ a0: { x: 0, y: 0 }, a1: { x: 6 * SIZE, y: 0 }, a2: { x: 0, y: SIZE }, a5: { x: 6 * SIZE, y: 2 * SIZE }, a6: { x: 0, y: 3 * SIZE } });
    const image = decodeJpeg(sheet.bytes);
    for (const [cube, place] of cubes.map(cube => [cube, sheet.places.get(`a${cube}`)])) {
      CUBE_FACE_NAMES.forEach((_name, at) => {
        const [r, g, b] = pixel(image, place.x + at * SIZE + SIZE / 2, place.y + SIZE / 2);
        const [er, eg, eb] = colourOf(cube, at);
        expect(Math.abs(r - er) + Math.abs(g - eg) + Math.abs(b - eb)).toBeLessThan(12);
      });
    }
    expect(sheet.revision).toMatch(/^[0-9a-f]{12}$/);
  });

  it("refuses faces of another size, and sizes a JPEG block would straddle", () => {
    expect(() => composeSheet([{ key: "a", faces: cubeFaces(0) }], 32)).toThrow(/is 16 × 16 px, not 32/);
    expect(() => composeSheet([{ key: "a", faces: cubeFaces(0) }], 20)).toThrow(/multiple of 8/);
  });
});

describe("adding sheets to a scene", () => {
  it("names a sheet in the scene and each cube's place in it, and leaves the face files", () => {
    const { document, files } = sceneOf(3);
    const added = addPreviewSheets(document, { read: url => files.get(url) ?? null, quality: 95 });
    expect(added.cubes).toBe(3);
    expect(added.files.map(file => file.url)).toEqual(["media/previews-16.jpg"]);
    // Three cubes are less than a row of a square sheet: one column.
    expect(added.document.sheets).toEqual([{ id: "previews-16", revision: expect.stringMatching(/^[0-9a-f]{12}$/), mimeType: "image/jpeg", width: 96, height: 48, encodedBytes: added.files[0].bytes.length, url: "media/previews-16.jpg" }]);
    expect(added.document.assets.map(asset => asset.representations[0].sheet)).toEqual([{ id: "previews-16", x: 0, y: 0 }, { id: "previews-16", x: 0, y: 16 }, { id: "previews-16", x: 0, y: 32 }]);
    expect(added.document.assets[0].representations[0].faces).toEqual(document.assets[0].representations[0].faces);
    expect(added.document.assets[0].representations[1].sheet).toBeUndefined();
    // Sheets come after the assets; the scene given is untouched.
    expect(Object.keys(added.document)).toEqual(["format", "version", "id", "revision", "title", "assets", "sheets", "entities"]);
    expect(document.sheets).toBeUndefined();
  });

  it("begins another sheet past the pixel limit, and replaces sheets the scene had", () => {
    const { document, files } = sceneOf(5);
    const read = url => files.get(url) ?? null;
    const twoEach = addPreviewSheets(document, { read, maxPixels: 2 * 6 * SIZE * SIZE });
    expect(twoEach.document.sheets.map(sheet => sheet.id)).toEqual(["previews-16", "previews-16-2", "previews-16-3"]);
    expect(twoEach.document.assets.map(asset => asset.representations[0].sheet.id)).toEqual(["previews-16", "previews-16", "previews-16-2", "previews-16-2", "previews-16-3"]);
    const again = addPreviewSheets(twoEach.document, { read });
    expect(again.document.sheets).toHaveLength(1);
    expect(again.document.assets.every(asset => asset.representations[0].sheet.id === "previews-16")).toBe(true);
  });

  it("checks that each face in a sheet is the picture in its file", () => {
    const { document, files } = sceneOf(3);
    const read = url => files.get(url) ?? null;
    const added = addPreviewSheets(document, { read, quality: 95 });
    const all = url => added.files.find(file => file.url === url)?.bytes ?? read(url);
    const good = verifyPreviewSheets(added.document, all);
    expect(good.problems).toEqual([]);
    expect(good.lowestPsnrDb).toBeGreaterThan(35);
    // A cube given another's place shows another's faces.
    const swapped = JSON.parse(JSON.stringify(added.document));
    swapped.assets[0].representations[0].sheet = { ...swapped.assets[1].representations[0].sheet };
    const bad = verifyPreviewSheets(swapped, all);
    expect(bad.problems).toHaveLength(6);
    expect(bad.problems[0]).toMatchObject({ path: "$.assets[a0].representations[preview-16].sheet", message: expect.stringMatching(/not the same picture$/) });
  });
});
