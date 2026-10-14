import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
for (const name of ["document", "window", "ImageBitmap", "createImageBitmap", "fetch"]) Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(`Pure import read ${name}`); } });
const core = await import("@foss-earth/preview-sheets");
const browser = await import("@foss-earth/preview-sheets/browser");
const preparation = await import("@foss-earth/preview-sheets/preparation");
const extension = await import("@foss-earth/preview-sheets/scene-extension");
const composition = await import("@foss-earth/preview-sheets/composition");
const nodeComposition = await import("@foss-earth/preview-sheets/composition-node");
const settings = await import("@foss-earth/preview-sheets/settings");
for (const name of ["document", "window", "ImageBitmap", "createImageBitmap", "fetch"]) delete globalThis[name];
assert.equal(core.PREVIEW_SHEETS_EXTENSION, "foss-earth.preview-sheets");
assert.equal(preparation.sheetColumns(7), 2);
assert.equal(typeof browser.createPreviewSheetSources, "function");
assert.equal(extension.createPreviewSheetsExtensionHook().name, core.PREVIEW_SHEETS_EXTENSION);
assert.equal(settings.PREVIEW_SHEETS_PARAMETERS[0].id, "scene.panorama.previewSheets");
assert.deepEqual(settings.PREVIEW_SHEETS_PARAMETERS[0].home, { tab: "scenes", section: "loading", level: "main" });
assert.deepEqual(core.sheetFaceRectangles({ x: 0, y: 8 }, 8).map(rect => rect.face), ["px", "nx", "py", "ny", "pz", "nz"]);
assert.equal(JSON.parse(readFileSync(new URL(import.meta.resolve("@foss-earth/preview-sheets/schema/place.json")), "utf8")).additionalProperties, false);
for (const name of ["index", "core", "schema", "browser", "sceneExtension", "settings", "composition"]) {
  assert.ok(readFileSync(new URL(`../dist/${name}.d.ts`, import.meta.url), "utf8").length);
  const code = readFileSync(new URL(`../dist/${name}.js`, import.meta.url), "utf8");
  assert.doesNotMatch(code, /from ["']\.[^"']+(?<!\.js)["']/);
}
assert.ok(readFileSync(new URL("../node/preparation.d.mts", import.meta.url), "utf8").length);
assert.ok(readFileSync(new URL("../node/composition.d.mts", import.meta.url), "utf8").length);
process.stdout.write("Public core/schema/browser/preparation imported without browser globals; declarations, source face order and JSON schema present.\n");

// Public-only composition with actual installed common input accounting.
const { createImageSessionBroker } = await import("@foss-earth/images");
const { createImageFileService } = await import("@foss-earth/images/browser");
const { encodePng } = await import("@foss-earth/images/node");
const { uploadCubeSource } = await import("@foss-earth/sphere-cubemap/browser");
const nativeBytes = encodePng({ width: 48, height: 8, rgb: new Uint8Array(48 * 8 * 3).fill(80) });
const sheetRecord = { id: "shared", revision: "immutable-r1", mimeType: "image/png", width: 48, height: 8, encodedBytes: nativeBytes.length, url: "https://example.invalid/shared.png" };
const entries = ["west", "east"].map(key => ({ value: { sheets: [sheetRecord] }, path: `$.${key}`, child: { key, baseUrl: "https://example.invalid/final/" } }));
const owner = composition.createPreviewSheetsCompositionOwner(), merged = owner.composeDocument(entries, { limits: { assets: 2 } });
assert.equal(merged.document.sheets.length, 1);
assert.throws(() => owner.composeDocument([entries[0], { ...entries[1], value: { sheets: [{ ...sheetRecord, revision: "drift" }] } }], { limits: { assets: 2 } }), /collision/);
const authoredFaces = Object.fromEntries(["px", "nx", "py", "ny", "pz", "nz"].map(face => [face, `https://example.invalid/${face}.png`]));
const verificationAsset = { id: "a", type: "panorama-image", representations: [{ id: "preview", role: "preview", projection: "cube", faceSize: 8, faces: authoredFaces, extensions: { [core.PREVIEW_SHEETS_EXTENSION]: { id: "shared", x: 0, y: 0 } } }] };
const faceBytes = encodePng({ width: 8, height: 8, rgb: new Uint8Array(8 * 8 * 3).fill(80) });
const verificationScene = { assets: new Map([["a", verificationAsset]]), extensionData: new Map([[core.PREVIEW_SHEETS_EXTENSION, new Map([["shared", sheetRecord]])]]) };
const nodeOwner = nodeComposition.createNodePreviewSheetsCompositionOwner();
assert.deepEqual([...nodeOwner.verifyFiles(verificationScene, url => url === sheetRecord.url ? nativeBytes : faceBytes, {})], []);
assert.throws(() => nodeComposition.createNodePreviewSheetsCompositionOwner({ verificationLimits: { maxMemoryBytes: 1 } }).verifyFiles(verificationScene, () => nativeBytes, {}), /budget/);
assert.throws(() => nodeComposition.createNodePreviewSheetsCompositionOwner({ verificationLimits: { maxDecodedPixels: 1 } }).verifyFiles(verificationScene, () => nativeBytes, {}), /budget/);
const nativeBroker = createImageSessionBroker({ pools: { encoded: 100000, decoded: 100000, sourceGpu: 100000, uploadOutstanding: 100000, overlap: 100000 }, requests: 1, decodes: 1 });
const nativeScope = nativeBroker.scope();
let nativeSheetClosed = 0, nativeFacesClosed = 0, nativeDisposed = 0, nativeReady = 0;
const nativeCommon = createImageFileService({ broker: nativeBroker, priority: () => 1, limits: () => ({ responseBytes: 100000, timeoutMs: 1000 }),
  fetch: async () => new Response(nativeBytes, { headers: { "content-type": "image/png" } }),
  decode: async () => ({ width: 48, height: 8, close() { nativeSheetClosed++; } }) });
const nativeRegistry = browser.createPreviewSheetSources({ broker: nativeBroker, obtain: nativeCommon.obtain, decode: nativeCommon.decode,
  crop: async () => ({ width: 8, height: 8, close() { nativeFacesClosed++; throw new Error("native face cleanup"); } }) });
const nativeSource = await nativeRegistry.acquireCubeFaces({ sheet: { id: "public-handoff", revision: "r", mimeType: "image/png", url: "https://example.invalid/sheet.png", encodedBytes: nativeBytes.length, width: 48, height: 8, x: 0, y: 0 }, scope: nativeScope, faceSize: 8, label: "public handoff", enabled: true, fallback: async () => { throw new Error("Unexpected fallback"); } });
assert.equal(typeof nativeSource.retain, "function"); assert.equal(nativeSheetClosed, 1);
let nativeResolve, nativeBegan;
const nativeStarted = new Promise(resolve => { nativeBegan = resolve; });
const nativeCompletion = new Promise(resolve => { nativeResolve = resolve; });
const nativeRecord = { id: "public-handoff", role: "preview", projection: "cube", mimeType: "image/png", encodedBytes: nativeBytes.length, faceSize: 8, faces: Object.fromEntries(["px", "nx", "py", "ny", "pz", "nz"].map(face => [face, `https://example.invalid/${face}.png`])) };
const nativeWork = uploadCubeSource(nativeRecord, nativeSource, { broker: nativeBroker, scope: nativeScope, label: "public native handoff", maxTextureSide: 4096,
  obtain: (file, size) => nativeCommon.obtain(file, size, nativeScope), decode: (body, file) => nativeCommon.decode(body, file, nativeScope),
  uploadCube() {
    nativeScope.dispose(); assert.equal(nativeFacesClosed, 0); assert.equal(nativeBroker.pools.stats().decoded.reserved, 6 * 8 * 8 * 4);
    nativeBegan(); return nativeCompletion;
  }, whenReady: async () => { nativeReady++; } });
const nativeFailure = nativeWork.catch(error => error);
await nativeStarted;
nativeResolve({ dispose() {
  nativeDisposed++; assert.equal(nativeFacesClosed, 0); assert.equal(nativeBroker.pools.stats().decoded.reserved, 6 * 8 * 8 * 4);
  throw new Error("native texture cleanup");
} });
const nativeError = await nativeFailure;
const nativeMessages = error => error instanceof AggregateError ? error.errors.flatMap(nativeMessages) : error.message;
assert.deepEqual(nativeMessages(nativeError), ["The image operation ended.", "native texture cleanup", ...Array(6).fill("native face cleanup")]);
assert.equal(nativeFacesClosed, 6); assert.equal(nativeDisposed, 1); assert.equal(nativeReady, 0); assert.equal(nativeSheetClosed, 1);
assert.deepEqual(nativeBroker.pools.live(), []); nativeSource.close(); nativeScope.dispose(); nativeRegistry.dispose(); nativeBroker.dispose();
process.stdout.write("Public preview/cubemap composition retains crops through callback cancellation and late texture cleanup.\n");
