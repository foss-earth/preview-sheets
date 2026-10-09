import { expect, it } from "vitest";
import { PREVIEW_SHEETS_PARAMETERS } from "../src/settings.js";
it("retains the optional sheet choice at its one existing home without registry calls", () => {
  expect(PREVIEW_SHEETS_PARAMETERS).toHaveLength(1);
  expect(PREVIEW_SHEETS_PARAMETERS[0]).toMatchObject({ id: "scene.panorama.previewSheets", kind: "boolean", default: true, unit: "none", home: { tab: "scenes", section: "loading", level: "main" }, source: "src/scenes/panoramaResources.ts" });
  expect(PREVIEW_SHEETS_PARAMETERS[0].description).toContain("Off, each orb loads its own six files.");
});
