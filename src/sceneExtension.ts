import type { ImageDiagnostic, ImageRepresentation } from "@foss-earth/images";
import { PREVIEW_SHEETS_EXTENSION, type ResolvedSheetPlace, type SheetRecord } from "./core.js";
import { validatePreviewSheets, validateSheetPlace } from "./schema.js";

/** Structural optional-owner hook; no scene envelope/runtime import is needed. */
export interface PreviewSheetsExtensionHook {
  readonly name: typeof PREVIEW_SHEETS_EXTENSION;
  validateDocument(value: unknown, context: { path: string; baseUrl: string | null; maxAssets: number }): { data: ReadonlyMap<string, SheetRecord>; warnings: readonly ImageDiagnostic[] };
  resolveRepresentation<R extends ImageRepresentation>(representation: R, context: { path: string; baseUrl: string | null; documentData: unknown }): { representation: R & { sheet?: ResolvedSheetPlace }; warnings: readonly ImageDiagnostic[] };
}

export function createPreviewSheetsExtensionHook(): PreviewSheetsExtensionHook {
  return {
    name: PREVIEW_SHEETS_EXTENSION,
    validateDocument(value, context) {
      const result = validatePreviewSheets(value, { path: context.path, baseUrl: context.baseUrl, maxSheets: context.maxAssets });
      return { data: result.sheets, warnings: result.warnings };
    },
    resolveRepresentation(representation, context) {
      if (representation.projection !== "cube") return { representation, warnings: [] };
      const extension = representation.extensions?.[PREVIEW_SHEETS_EXTENSION];
      const copy = { ...representation } as typeof representation & { sheet?: ResolvedSheetPlace };
      delete copy.sheet;
      if (extension === undefined) return { representation: copy, warnings: [] };
      const faceSize = (representation as ImageRepresentation & { faceSize?: unknown }).faceSize;
      const sheets = context.documentData instanceof Map ? context.documentData as ReadonlyMap<string, SheetRecord> : new Map<string, SheetRecord>();
      const result = validateSheetPlace(extension, { path: context.path, faceSize: typeof faceSize === "number" ? faceSize : Number.NaN, sheets });
      return { representation: result.value ? { ...copy, sheet: result.value } : copy, warnings: result.warnings };
    },
  };
}
