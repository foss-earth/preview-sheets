import type { CubeFaceName } from "@foss-earth/cubemap/core";
import type { RgbImage, ImageDiagnostic } from "@foss-earth/images";
import type { SheetPlaceRecord, SheetRecord } from "../dist/core.js";
export { PREVIEW_SHEETS_EXTENSION } from "../dist/core.js";
export const SHEET_PIXELS: number;
export interface PackingCube { key: string; faces: Readonly<Record<CubeFaceName, Uint8Array>> }
export interface ComposedSheet { bytes: Uint8Array; width: number; height: number; places: ReadonlyMap<string, { x: number; y: number }>; revision: string }
export function sheetColumns(count: number): number;
export function composeSheet(cubes: readonly PackingCube[], faceSize: number, quality?: number): ComposedSheet;
export interface PreparationRepresentation {
  id: string; projection: string; role: string; faceSize?: number;
  faces?: Readonly<Record<CubeFaceName, string>>;
  extensions?: Record<string, Record<string, unknown>>;
  sheet?: SheetPlaceRecord;
  [key: string]: unknown;
}
export interface PreparationAsset { id: string; type: string; representations: readonly PreparationRepresentation[]; [key: string]: unknown }
/** Minimal record container supplied by the caller; this library imports no scene owner. */
export interface PreparationDocument { assets: readonly PreparationAsset[]; extensions?: Record<string, Record<string, unknown>>; sheets?: readonly SheetRecord[]; [key: string]: unknown }
export interface AddPreviewSheetsOptions {
  read(url: string): Uint8Array | null | undefined;
  faceSize?: number; quality?: number; maxPixels?: number; urlPrefix?: string;
}
/** Copy-on-write extension adaptation; original face records/files remain intact. */
export function addPreviewSheets<T extends PreparationDocument>(document: T, options: AddPreviewSheetsOptions): { document: T; files: readonly { url: string; bytes: Uint8Array }[]; cubes: number };
/** Legacy top-level records are read only for explicit preparation migration. */
export function sheetsOf(document: Pick<PreparationDocument, "extensions" | "sheets">): readonly SheetRecord[];
export function verifyPreviewSheets(document: PreparationDocument, read: AddPreviewSheetsOptions["read"], minPsnrDb?: number): { problems: readonly ImageDiagnostic[]; lowestPsnrDb: number };
export function extractSheetFaces(image: RgbImage, place: Pick<SheetPlaceRecord, "x" | "y">, faceSize: number): Readonly<Record<CubeFaceName, RgbImage>>;
