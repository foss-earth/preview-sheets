import { describe, expect, it } from "vitest";
import { CUBE_FACE_NAMES } from "@foss-earth/cubemap/core";
import { PREVIEW_SHEETS_EXTENSION, sheetFaceRectangles, validatePreviewSheets, validateSheetPlace, validateSheetRecord } from "../src/index.js";

const sheet = { id: "sheet", revision: "r1", mimeType: "image/jpeg", width: 96, height: 32, encodedBytes: 100, url: "media/sheet.jpg" };
describe("optional preview sheet extension", () => {
  it("resolves source URLs with no ownership of the scene envelope", () => {
    const result = validatePreviewSheets({ sheets: [sheet] }, { baseUrl: "https://example.invalid/tour/scene.json", maxSheets: 2 });
    expect(PREVIEW_SHEETS_EXTENSION).toBe("foss-earth.preview-sheets");
    expect(result.warnings).toEqual([]);
    expect(result.sheets.get("sheet")?.url).toBe("https://example.invalid/tour/media/sheet.jpg");
    const place = validateSheetPlace({ id: "sheet", x: 0, y: 16 }, { path: "cube.extensions", faceSize: 16, sheets: result.sheets });
    expect(place.warnings).toEqual([]);
    expect(place.value).toMatchObject({ id: "sheet", x: 0, y: 16 });
    expect(sheetFaceRectangles(place.value!, 16).map(rect => [rect.face, rect.x, rect.y])).toEqual(CUBE_FACE_NAMES.map((face, i) => [face, i * 16, 16]));
  });
  it.each([
    { ...sheet, url: "https://token@example.invalid/sheet.jpg" },
    { ...sheet, url: "file:///local/sheet.jpg" },
    { ...sheet, width: 0 },
    { ...sheet, encodedBytes: -1 },
    { ...sheet, layout: "future" },
  ])("warns and skips a malformed sheet without failing the parent document", candidate => {
    const result = validateSheetRecord(candidate, { path: "sheet", baseUrl: "https://example.invalid/" });
    expect(result.value).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.every(problem => problem.message.endsWith("this preview sheet is not used"))).toBe(true);
  });
  it("retains the first duplicate and refuses a list beyond the injected host limit", () => {
    const result = validatePreviewSheets({ sheets: [sheet, sheet] }, { baseUrl: "https://example.invalid/", maxSheets: 2 });
    expect(result.sheets.size).toBe(1); expect(result.warnings).toHaveLength(1);
    const bounded = validatePreviewSheets({ sheets: [sheet, sheet] }, { baseUrl: "https://example.invalid/", maxSheets: 1 });
    expect(bounded.sheets.size).toBe(0); expect(bounded.warnings).toHaveLength(1);
  });
  it.each([{ id: "missing", x: 0, y: 0 }, { id: "sheet", x: 1, y: 0 }, { id: "sheet", x: 0, y: 17 }, { id: "sheet", x: 0, y: 0, rotation: 90 }])("makes a bad place fall back to all original files", candidate => {
    const sheets = validatePreviewSheets({ sheets: [sheet] }, { baseUrl: "https://example.invalid/", maxSheets: 1 }).sheets;
    const result = validateSheetPlace(candidate, { path: "cube.place", faceSize: 16, sheets });
    expect(result.value).toBeNull(); expect(result.warnings.length).toBeGreaterThan(0);
  });
});
