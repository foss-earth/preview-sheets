import type { ImageDiagnostic } from "@foss-earth/images";
import { PREVIEW_SHEETS_EXTENSION, type SheetRecord } from "./core.js";
import { validatePreviewSheets, validateSheetPlace, validateSheetRecord } from "./schema.js";
import { createPreviewSheetsExtensionHook, type PreviewSheetsExtensionHook } from "./sceneExtension.js";

/** Structural ports: the leaf owner never imports a scene envelope or runtime. */
export interface PreviewCompositionChild { key: string; baseUrl: string }
export interface PreviewCompositionEntry { value: Readonly<Record<string, unknown>>; path: string; child: PreviewCompositionChild }
export interface PreviewCompositionScene { extensionData: ReadonlyMap<string, unknown> }
export interface PreviewSheetsCompositionOptions {
  /** Child key -> original sheet ID -> output sheet ID. Explicit and reversible per child. */
  aliases?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  maxSheets?: number;
}
export interface PreviewSheetsCompositionOwner {
  readonly name: typeof PREVIEW_SHEETS_EXTENSION;
  readonly validation: PreviewSheetsExtensionHook;
  composeDocument(entries: readonly PreviewCompositionEntry[], context: { limits: Readonly<{ assets: number; children?: number }>; signal?: AbortSignal }): { document: Readonly<Record<string, unknown>>; state: unknown };
  rewrite(value: Readonly<Record<string, unknown>>, context: { scope: "asset" | "representation" | "entity" | "link" | "group"; path: string; child: PreviewCompositionChild; state: unknown; record: Readonly<Record<string, unknown>> }): Readonly<Record<string, unknown>>;
  files(scene: PreviewCompositionScene): Iterable<{ path: string; file: SheetRecord; encodedBytes: number }>;
}
export class PreviewSheetsCompositionError extends Error {
  readonly path: string;
  constructor(path: string, message: string) { super(`${path}: ${message}`); this.path = path; this.name = "PreviewSheetsCompositionError"; }
}
interface CompositionState { sheets: Map<string, SheetRecord>; mappings: Map<string, Map<string, string>> }
const abort = (signal?: AbortSignal): void => { if (signal?.aborted) throw signal.reason ?? new DOMException("Preview composition cancelled", "AbortError"); };
function required(warnings: readonly ImageDiagnostic[]): void { if (warnings.length) throw new PreviewSheetsCompositionError(warnings[0].path, warnings.map(problem => problem.message).join("; ")); }
const same = (a: SheetRecord, b: SheetRecord): boolean => a.id === b.id && a.revision === b.revision && a.mimeType === b.mimeType && a.width === b.width && a.height === b.height && a.encodedBytes === b.encodedBytes && a.url === b.url;

/** Required build-time semantics, unlike the runtime's optional fallback warnings. */
export function createPreviewSheetsCompositionOwner(options: PreviewSheetsCompositionOptions = {}): PreviewSheetsCompositionOwner {
  return {
    name: PREVIEW_SHEETS_EXTENSION,
    validation: createPreviewSheetsExtensionHook(),
    composeDocument(entries, context) {
      abort(context.signal);
      const maximum = options.maxSheets ?? context.limits.assets;
      if (!Number.isSafeInteger(maximum) || maximum < 1) throw new RangeError("maxSheets must be a positive safe integer");
      if (entries.length > (context.limits.children ?? 32)) throw new RangeError("Preview composition child limit exceeded");
      const state: CompositionState = { sheets: new Map(), mappings: new Map() };
      for (const entry of entries) {
        abort(context.signal);
        if (state.mappings.has(entry.child.key)) throw new PreviewSheetsCompositionError(entry.path, "Duplicate child key");
        const result = validatePreviewSheets(entry.value, { path: entry.path, baseUrl: entry.child.baseUrl, maxSheets: maximum });
        required(result.warnings);
        const aliases = options.aliases?.[entry.child.key] ?? {}, mapping = new Map<string, string>(), reversed = new Map<string, string>();
        for (const id of Object.keys(aliases)) if (!result.sheets.has(id)) throw new PreviewSheetsCompositionError(entry.path, `Alias names unknown sheet ${id}`);
        for (const sheet of result.sheets.values()) {
          abort(context.signal);
          const id = aliases[sheet.id] ?? sheet.id;
          const checked = validateSheetRecord({ ...sheet, id }, { path: entry.path, baseUrl: entry.child.baseUrl }); required(checked.warnings);
          if (!checked.value) throw new PreviewSheetsCompositionError(entry.path, "Invalid output sheet identity");
          if (reversed.has(id)) throw new PreviewSheetsCompositionError(entry.path, "Sheet aliases must be reversible within each child");
          reversed.set(id, sheet.id); mapping.set(sheet.id, id);
          const prior = state.sheets.get(id);
          if (prior && !same(prior, checked.value)) throw new PreviewSheetsCompositionError(entry.path, `Sheet identity collision ${id}; supply explicit reversible aliases`);
          if (!prior) { if (state.sheets.size >= maximum) throw new RangeError("Preview composition sheet limit exceeded"); state.sheets.set(id, checked.value); }
        }
        state.mappings.set(entry.child.key, mapping);
      }
      for (const child of Object.keys(options.aliases ?? {})) if (!state.mappings.has(child)) throw new PreviewSheetsCompositionError("$.aliases", `Alias names unknown child ${child}`);
      // Only validator-authored publishable records; private maps never enter JSON.
      return { document: { sheets: [...state.sheets.values()] }, state };
    },
    rewrite(value, context) {
      if (context.scope !== "representation" || context.record.projection !== "cube") throw new PreviewSheetsCompositionError(context.path, "A preview sheet place belongs to a cube representation");
      const state = context.state as CompositionState;
      if (!(state?.sheets instanceof Map) || !(state.mappings instanceof Map)) throw new PreviewSheetsCompositionError(context.path, "Missing composition state");
      // Validate the original optional metadata before constructing a smaller record.
      const mapping = state.mappings.get(context.child.key);
      const originalSheets = new Map<string, SheetRecord>();
      for (const [oldId, newId] of mapping ?? []) { const sheet = state.sheets.get(newId)!; originalSheets.set(oldId, { ...sheet, id: oldId }); }
      const result = validateSheetPlace(value, { path: context.path, faceSize: typeof context.record.faceSize === "number" ? context.record.faceSize : NaN, sheets: originalSheets });
      required(result.warnings);
      if (!result.value || !mapping) throw new PreviewSheetsCompositionError(context.path, "Sheet place is not declared by this child");
      return { id: mapping.get(result.value.id)!, x: result.value.x, y: result.value.y };
    },
    *files(scene) {
      const data = scene.extensionData.get(PREVIEW_SHEETS_EXTENSION);
      if (data === undefined) return;
      if (!(data instanceof Map)) throw new PreviewSheetsCompositionError("$.extensions", "Expected validated sheet records");
      for (const sheet of (data as ReadonlyMap<string, SheetRecord>).values()) yield { path: `$.extensions.${PREVIEW_SHEETS_EXTENSION}.sheets[${sheet.id}].url`, file: sheet, encodedBytes: sheet.encodedBytes };
    },
  };
}
