import { ImageRecordChecker, resolveImageUrl, type ImageDiagnostic } from "@foss-earth/images";
import { CUBE_FACE_NAMES } from "@foss-earth/cubemap/core";
import { PREVIEW_SHEETS_EXTENSION, type ResolvedSheetPlace, type SheetRecord } from "./core.js";

export interface OptionalSheetValidation<T> { value: T | null; warnings: readonly ImageDiagnostic[] }
const warningsOf = (checker: ImageRecordChecker, unused: string): readonly ImageDiagnostic[] => checker.errors.map(problem => ({ ...problem, message: `${problem.message}; ${unused}` }));

/** Invalid optional records warn and disappear, leaving the cube's files usable. */
export function validateSheetRecord(value: unknown, options: { path: string; baseUrl: string | null }): OptionalSheetValidation<SheetRecord> {
  const checker = new ImageRecordChecker();
  const { path } = options;
  const record = checker.record(value, path);
  let base: URL | null = null;
  try { base = options.baseUrl === null ? null : new URL(options.baseUrl); }
  catch { checker.fail(path, "base URL must be absolute"); }
  if (!record) return { value: null, warnings: warningsOf(checker, "this preview sheet is not used") };
  checker.keys(record, path, ["id", "revision", "mimeType", "width", "height", "encodedBytes", "url"]);
  const id = checker.id(record.id, `${path}.id`);
  const revision = checker.text(record.revision, `${path}.revision`);
  const mimeType = checker.oneOf(record.mimeType, `${path}.mimeType`, ["image/jpeg", "image/png"]);
  const width = checker.positiveInteger(record.width, `${path}.width`);
  const height = checker.positiveInteger(record.height, `${path}.height`);
  const encodedBytes = checker.positiveInteger(record.encodedBytes, `${path}.encodedBytes`);
  const url = resolveImageUrl(checker, record.url, `${path}.url`, base);
  if (checker.errors.length || !id || !revision || !mimeType || !width || !height || !encodedBytes || !url) return { value: null, warnings: warningsOf(checker, "this preview sheet is not used") };
  return { value: { id, revision, mimeType, width, height, encodedBytes, url }, warnings: [] };
}

export function validatePreviewSheets(value: unknown, options: { baseUrl: string | null; maxSheets: number; path?: string }): { sheets: ReadonlyMap<string, SheetRecord>; warnings: readonly ImageDiagnostic[] } {
  const path = options.path ?? `$.extensions.${PREVIEW_SHEETS_EXTENSION}`;
  const sheets = new Map<string, SheetRecord>();
  if (value === undefined) return { sheets, warnings: [] };
  if (!Number.isSafeInteger(options.maxSheets) || options.maxSheets < 0) throw new RangeError("maxSheets must be a nonnegative whole-number host limit.");
  const checker = new ImageRecordChecker();
  const extension = checker.record(value, path);
  if (!extension) return { sheets, warnings: warningsOf(checker, "this preview sheet is not used") };
  checker.keys(extension, path, ["sheets"]);
  const listed = checker.array(extension.sheets, `${path}.sheets`) ?? [];
  if (listed.length > options.maxSheets) checker.fail(`${path}.sheets`, `has ${listed.length} sheets, over the limit of ${options.maxSheets}`);
  // Unknown extension semantics or excess counts invalidate its whole list.
  if (checker.errors.length) return { sheets, warnings: warningsOf(checker, "this preview sheet is not used") };
  const warnings: ImageDiagnostic[] = [];
  listed.forEach((entry, index) => {
    const result = validateSheetRecord(entry, { path: `${path}.sheets[${index}]`, baseUrl: options.baseUrl });
    warnings.push(...result.warnings);
    if (!result.value) return;
    if (sheets.has(result.value.id)) warnings.push({ path: `${path}.sheets[${index}].id`, message: `repeats sheet id "${result.value.id}"; this preview sheet is not used` });
    else sheets.set(result.value.id, result.value);
  });
  return { sheets, warnings };
}

export function validateSheetPlace(value: unknown, options: { path: string; faceSize: number; sheets: ReadonlyMap<string, SheetRecord> }): OptionalSheetValidation<ResolvedSheetPlace> {
  const checker = new ImageRecordChecker();
  const { path } = options;
  const record = checker.record(value, path);
  if (!record) return { value: null, warnings: warningsOf(checker, "this cube loads from its own face files") };
  checker.keys(record, path, ["id", "x", "y"]);
  const id = checker.id(record.id, `${path}.id`);
  const x = checker.nonNegativeInteger(record.x, `${path}.x`);
  const y = checker.nonNegativeInteger(record.y, `${path}.y`);
  const sheet = id ? options.sheets.get(id) : undefined;
  if (id && !sheet) checker.fail(`${path}.id`, `names "${id}", which is not a sheet of this scene`);
  if (!Number.isSafeInteger(options.faceSize) || options.faceSize < 1) checker.fail(path, "the cube's face size must be a positive whole number");
  if (sheet && x !== null && y !== null && (x + CUBE_FACE_NAMES.length * options.faceSize > sheet.width || y + options.faceSize > sheet.height)) checker.fail(path, `puts six ${options.faceSize} px faces at (${x}, ${y}), outside the ${sheet.width} × ${sheet.height} px sheet "${sheet.id}"`);
  return { value: !checker.errors.length && sheet && x !== null && y !== null ? { ...sheet, x, y } : null, warnings: warningsOf(checker, "this cube loads from its own face files") };
}
