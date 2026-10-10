import type { ImageDiagnostic } from "@foss-earth/images";
import type { PreviewCompositionScene, PreviewSheetsCompositionOptions, PreviewSheetsCompositionOwner } from "../dist/composition.js";
import type { PreviewSheetVerificationLimits } from "./preparation.mjs";
export interface NodePreviewSheetsCompositionOptions extends PreviewSheetsCompositionOptions { minPsnrDb?: number; verificationLimits?: Partial<PreviewSheetVerificationLimits> }
export interface NodePreviewSheetsCompositionOwner extends PreviewSheetsCompositionOwner {
  verifyFiles(scene: PreviewCompositionScene & { assets: ReadonlyMap<string, unknown> }, read: (url: string) => Uint8Array | null, context: { signal?: AbortSignal }): Iterable<ImageDiagnostic>;
}
export function createNodePreviewSheetsCompositionOwner(options?: NodePreviewSheetsCompositionOptions): NodePreviewSheetsCompositionOwner;
