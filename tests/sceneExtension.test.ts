import { describe, expect, it } from "vitest";
import { createPreviewSheetsExtensionHook } from "../src/sceneExtension.js";
import { PREVIEW_SHEETS_EXTENSION } from "../src/core.js";

describe("optional owner hook without a scene import", () => {
  it("resolves its own sheet addition while leaving the cube's originals intact", () => {
    const hook = createPreviewSheetsExtensionHook();
    const document = hook.validateDocument({ sheets: [{ id: "s", revision: "1", url: "sheet.jpg", width: 96, height: 16, encodedBytes: 1, mimeType: "image/jpeg" }] }, { path: "extension", baseUrl: "https://example.invalid/", maxAssets: 1 });
    const original = { id: "cube", role: "preview" as const, projection: "cube", mimeType: "image/jpeg" as const, encodedBytes: 6, faceSize: 16, faces: { unchanged: "six original file records belong to cubemap" }, extensions: { [PREVIEW_SHEETS_EXTENSION]: { id: "s", x: 0, y: 0 } } };
    const result = hook.resolveRepresentation(original, { path: "cube.extension", baseUrl: "https://example.invalid/", documentData: document.data });
    expect(result.warnings).toEqual([]); expect(result.representation.sheet?.url).toBe("https://example.invalid/sheet.jpg"); expect(result.representation.faces).toBe(original.faces); expect("sheet" in original).toBe(false);
    const fallback = hook.resolveRepresentation({ ...original, extensions: { [PREVIEW_SHEETS_EXTENSION]: { id: "s", x: 1, y: 0 } } }, { path: "cube.extension", baseUrl: null, documentData: document.data });
    expect(fallback.representation.sheet).toBeUndefined(); expect(fallback.warnings).toHaveLength(1); expect(fallback.representation.faces).toBe(original.faces);
  });
});
