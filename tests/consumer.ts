import { PREVIEW_SHEETS_EXTENSION, validatePreviewSheets, validateSheetPlace } from "@foss-earth/preview-sheets";
import { createPreviewSheetSources, type PreviewSheetPorts, type PreviewSheetSources, type CubeFaceSource as PreviewCubeFaceSource } from "@foss-earth/preview-sheets/browser";
import type { ResolvedSheetPlace } from "@foss-earth/preview-sheets/core";
import { addPreviewSheets, composeSheet, extractSheetFaces, type PreparationDocument } from "@foss-earth/preview-sheets/preparation";
import { CUBE_FACE_NAMES } from "@foss-earth/cubemap/core";
import { acquireCubeFaces, type CubeFaceSource, type CubeLoadPorts, type CubeUploadPorts } from "@foss-earth/cubemap/browser";
import type { WholeImageTexture } from "@foss-earth/images/browser";

const document: PreparationDocument = { assets: [] };
const adapted = addPreviewSheets(document, { read: () => null, maxPixels: 4_000_000 });
const extension = validatePreviewSheets(adapted.document.extensions?.[PREVIEW_SHEETS_EXTENSION], { baseUrl: "https://example.invalid/", maxSheets: 100 });
validateSheetPlace({ id: "preview", x: 0, y: 0 }, { faceSize: 8, sheets: extension.sheets, path: "cube" });
const cube = { key: "preview", faces: Object.fromEntries(CUBE_FACE_NAMES.map(face => [face, new Uint8Array()])) as Record<(typeof CUBE_FACE_NAMES)[number], Uint8Array> };
const composed = composeSheet([cube], 8);
const faces = extractSheetFaces({ width: composed.width, height: composed.height, rgb: new Uint8Array(composed.width * composed.height * 3) }, { x: 0, y: 0 }, 8);
const face: Uint8Array = faces.px.rgb;
export function mountSources(ports: PreviewSheetPorts) { return createPreviewSheetSources(ports); }
/** Sheet source retains are structurally accepted by the public cube uploader. */
export function retainSheetInput(source: PreviewCubeFaceSource): (() => void) | null {
  const cube: CubeFaceSource = source;
  return cube.retain?.() ?? null;
}
/** Consumer composition only: preview-sheets does not import cubemap's GPU adapter. */
export function composeCubePorts<T extends WholeImageTexture>(sources: PreviewSheetSources, ports: CubeUploadPorts<T>, sheet: ResolvedSheetPlace | undefined, enabled: boolean): CubeLoadPorts<T> {
  return { ...ports, acquireFaces(record, common) { return sources.acquireCubeFaces({ sheet, faceSize: record.faceSize, scope: common.scope, label: ports.label, enabled, fallback: () => acquireCubeFaces(record, common) }); } };
}
export { face };
import { PREVIEW_SHEETS_PARAMETERS } from "@foss-earth/preview-sheets/settings";
void PREVIEW_SHEETS_PARAMETERS;

import { createPreviewSheetsCompositionOwner, type PreviewSheetsCompositionOwner } from "@foss-earth/preview-sheets/composition";
import { createNodePreviewSheetsCompositionOwner, type NodePreviewSheetsCompositionOwner } from "@foss-earth/preview-sheets/composition-node";
import { verifyPreviewSheets, type PreviewSheetVerificationStats } from "@foss-earth/preview-sheets/preparation";
export const compositionOwner: PreviewSheetsCompositionOwner = createPreviewSheetsCompositionOwner({ aliases: { child: { old: "new" } } });
export const nodeCompositionOwner: NodePreviewSheetsCompositionOwner = createNodePreviewSheetsCompositionOwner({ verificationLimits: { maxMemoryBytes: 2000000, maxDecodedPixels: 1000 } });
export const verificationStats: PreviewSheetVerificationStats = verifyPreviewSheets(document, () => null, 28, { signal: new AbortController().signal }).stats;
