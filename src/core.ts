import { CUBE_FACE_NAMES, type CubeFaceName } from "@foss-earth/sphere-cubemap/core";
import type { MediaGroup } from "@foss-earth/images";

/** Optional extension: original six face files remain required and usable. */
export const PREVIEW_SHEETS_EXTENSION = "foss-earth.preview-sheets";
export interface SheetRecord {
  id: string;
  revision: string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  encodedBytes: number;
  url: string;
}
export interface PreviewSheetsExtension { sheets: readonly SheetRecord[] }
export interface SheetPlaceRecord { id: string; x: number; y: number }
export interface ResolvedSheetPlace extends SheetRecord { x: number; y: number }
export interface FaceRectangle { face: CubeFaceName; x: number; y: number; width: number; height: number }

/** Top-row-first, source convention order px nx py ny pz nz, no rotation. */
export function sheetFaceRectangles(place: Pick<SheetPlaceRecord, "x" | "y">, faceSize: number): readonly FaceRectangle[] {
  if (!Number.isSafeInteger(faceSize) || faceSize < 1 || !Number.isSafeInteger(place.x) || place.x < 0 || !Number.isSafeInteger(place.y) || place.y < 0) throw new RangeError("Sheet rectangles require a positive face size and nonnegative whole-number place.");
  return CUBE_FACE_NAMES.map((face, index) => ({ face, x: place.x + index * faceSize, y: place.y, width: faceSize, height: faceSize }));
}

export function sheetSourceKey(sheet: SheetRecord): string {
  return `${sheet.id}@${sheet.revision} ${sheet.url}`;
}

/** Common media-store grouping preserves a changed revision at the same URL. */
export function sheetMediaGroup(sheet: Pick<SheetRecord, "id" | "revision">): MediaGroup {
  return { id: `sheet ${sheet.id}@${sheet.revision}`, label: `${sheet.id} · preview sheet` };
}
