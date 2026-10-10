import { createPreviewSheetsCompositionOwner } from "../dist/composition.js";
import { PREVIEW_SHEETS_EXTENSION } from "../dist/core.js";
import { verifyPreviewSheets } from "./preparation.mjs";

/** Adds finite content verification to the structural public composition owner. */
export function createNodePreviewSheetsCompositionOwner(options = {}) {
  return {
    ...createPreviewSheetsCompositionOwner(options),
    verifyFiles(scene, read, context) {
      const sheets = scene.extensionData.get(PREVIEW_SHEETS_EXTENSION);
      return verifyPreviewSheets({
        extensions: { [PREVIEW_SHEETS_EXTENSION]: { sheets: [...(sheets?.values() ?? [])] } },
        assets: [...scene.assets.values()],
      }, read, options.minPsnrDb ?? 28, { ...options.verificationLimits, signal: context.signal }).problems;
    },
  };
}
