import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const [consumerArg, artifactArg] = process.argv.slice(2);
if (!consumerArg || !artifactArg) throw new Error("Usage: check-installed-artifact.mjs <isolated installed consumer> <actual preview-sheets tgz>");
const consumer = path.resolve(consumerArg), artifact = path.resolve(artifactArg);
const resolver = path.join(consumer, "resolve-exports.mjs");
writeFileSync(resolver, "export const resolvePublic = name => import.meta.resolve(name);\n");
const { resolvePublic } = await import(pathToFileURL(resolver));
const workspace = realpathSync(consumer) + path.sep;
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (result.url.startsWith("file:")) {
    const resolved = realpathSync(fileURLToPath(result.url));
    if (!resolved.startsWith(workspace)) throw new Error("OUTSIDE_ISOLATED_WORKSPACE: " + resolved);
    if (/[/\\]node_modules[/\\](?:@babylonjs[/\\]core|@foss-earth[/\\]renderer|react(?:-dom)?)(?:[/\\]|$)/.test(resolved)) throw new Error("Preview source import initialized an unrelated runtime peer: " + resolved);
  }
  return result;
} });
const outside = path.join(path.dirname(consumer), "outside-negative-control.mjs");
writeFileSync(outside, "export const mustNeverLoad = true;\n");
await assert.rejects(import(pathToFileURL(outside)), /OUTSIDE_ISOLATED_WORKSPACE/);
for (const name of ["window", "document", "ImageBitmap", "createImageBitmap", "fetch"]) Object.defineProperty(globalThis, name, { configurable: true, get() { throw new Error(`Pure import read ${name}`); } });
const core = await import(resolvePublic("@foss-earth/preview-sheets"));
assert.equal((await import(resolvePublic("@foss-earth/preview-sheets/core"))).PREVIEW_SHEETS_EXTENSION, core.PREVIEW_SHEETS_EXTENSION);
const schema = await import(resolvePublic("@foss-earth/preview-sheets/schema"));
const browser = await import(resolvePublic("@foss-earth/preview-sheets/browser"));
const preparation = await import(resolvePublic("@foss-earth/preview-sheets/preparation"));
const extension = await import(resolvePublic("@foss-earth/preview-sheets/scene-extension"));
const settings = await import(resolvePublic("@foss-earth/preview-sheets/settings"));
assert.equal(settings.PREVIEW_SHEETS_PARAMETERS[0].id, "scene.panorama.previewSheets");
assert.deepEqual(settings.PREVIEW_SHEETS_PARAMETERS[0].home, { tab: "scenes", section: "loading", level: "main" });
const images = await import(resolvePublic("@foss-earth/images"));
const transport = await import(resolvePublic("@foss-earth/images/browser"));
const codecs = await import(resolvePublic("@foss-earth/images/node"));
const cubemap = await import(resolvePublic("@foss-earth/cubemap/core"));
const cubeBrowser = await import(resolvePublic("@foss-earth/cubemap/browser"));
for (const name of ["window", "document", "ImageBitmap", "createImageBitmap", "fetch"]) delete globalThis[name];
const faces = Object.fromEntries(cubemap.CUBE_FACE_NAMES.map((face, index) => [face, codecs.encodePng({ width: 8, height: 8, rgb: new Uint8Array(8 * 8 * 3).fill(20 + index * 30) })]));
const packed = preparation.composeSheet([{ key: "a", faces }, { key: "b", faces }], 8, 95);
const record = { id: "s", revision: packed.revision, mimeType: "image/jpeg", width: packed.width, height: packed.height, encodedBytes: packed.bytes.byteLength, url: "https://example.invalid/sheet.jpg" };
const validated = schema.validatePreviewSheets({ sheets: [record] }, { baseUrl: null, maxSheets: 2 });
assert.deepEqual(validated.warnings, []);
const first = schema.validateSheetPlace({ id: "s", x: 0, y: 0 }, { path: "cube", faceSize: 8, sheets: validated.sheets }).value;
const second = schema.validateSheetPlace({ id: "s", x: 0, y: 8 }, { path: "cube", faceSize: 8, sheets: validated.sheets }).value;
assert.ok(first && second);
const hookOwner = extension.createPreviewSheetsExtensionHook();
const extensionData = hookOwner.validateDocument({ sheets: [record] }, { path: "extension", baseUrl: null, maxAssets: 2 });
const ownerResolved = hookOwner.resolveRepresentation({ id: "preview", projection: "cube", role: "preview", mimeType: "image/png", faceSize: 8, encodedBytes: 1, extensions: { [core.PREVIEW_SHEETS_EXTENSION]: { id: "s", x: 0, y: 0 } } }, { path: "cube.extension", baseUrl: null, documentData: extensionData.data });
assert.equal(ownerResolved.representation.sheet.url, record.url); assert.deepEqual(ownerResolved.warnings, []);
assert.equal(core.sheetFaceRectangles(first, 8).length, 6);
const broker = images.createImageSessionBroker({ pools: { encoded: 1_000_000, decoded: 1_000_000, sourceGpu: 1_000_000, uploadOutstanding: 1_000_000, overlap: 1_000_000 }, requests: 2, decodes: 2 });
let requests = 0, decodes = 0, closedSheet = 0, closedFaces = 0, closedOriginals = 0, uploads = 0, ready = 0, texturesDisposed = 0;
const faceUrls = Object.fromEntries(cubemap.CUBE_FACE_NAMES.map(face => [face, `https://example.invalid/${face}.png`]));
const cubeRecord = { id: "preview", role: "preview", projection: "cube", faceSize: 8, mimeType: "image/png", encodedBytes: Object.values(faces).reduce((total, file) => total + file.byteLength, 0), faces: faceUrls };
const obtain = (file, declaredBytes, scope) => transport.fetchImageFile({ url: file.url, declaredBytes, priority: 1, scope, broker, limits: { responseBytes: 1_000_000, timeoutMs: 1000 }, fetch: async () => { requests += 1; const face = cubemap.CUBE_FACE_NAMES.find(name => faceUrls[name] === file.url); return new Response(face ? faces[face] : packed.bytes, { headers: { "content-type": face ? "image/png" : "image/jpeg" } }); } });
const decode = (file, declared, scope) => transport.decodeImageFile({ file, declared, scope, broker, priority: 1, decode: async () => { decodes += 1; return { width: declared.width, height: declared.height, close() { if (declared.width === record.width) closedSheet += 1; else closedOriginals += 1; } }; } });
const registry = browser.createPreviewSheetSources({
  broker,
  obtain,
  decode,
  crop: async (_image, _x, _y, width, height) => ({ width, height, close() { closedFaces += 1; } }),
});
const a = broker.scope(), b = broker.scope();
const cubePorts = (scope, sheet, enabled) => ({
  broker, scope, maxTextureSide: 1024, overlap: true, label: "installed fixture",
  obtain: (file, bytes) => obtain(file, bytes, scope), decode: (file, declared) => decode(file, declared, scope),
  uploadCube: async source => { uploads += 1; assert.deepEqual(Object.keys(source), cubemap.CUBE_FACE_NAMES); return { dispose() { texturesDisposed += 1; } }; },
  whenReady: async () => { ready += 1; },
  acquireFaces: (record, common) => registry.acquireCubeFaces({ sheet, faceSize: record.faceSize, enabled, scope: common.scope, label: "fixture", fallback: () => cubeBrowser.acquireCubeFaces(record, common) }),
});
const loaded = await Promise.all([cubeBrowser.loadCube(cubeRecord, cubePorts(a, first, true)), cubeBrowser.loadCube(cubeRecord, cubePorts(b, second, true))]);
assert.equal(requests, 1); assert.equal(decodes, 1); assert.equal(closedSheet, 1);
assert.ok(broker.pools.stats().overlap.reserved > 0, "readiness must not settle replacement overlap");
// Host fixture owns the atomic visibility swap and outgoing disposal; source
// adapters and readiness never take that authority.
const hostSwap = (incoming, outgoing) => { for (const image of outgoing) image.dispose(); for (const image of incoming) image.settleReplacement(); };
hostSwap(loaded, []); assert.equal(broker.pools.stats().overlap.reserved, 0);
const c = broker.scope(); const originalFiles = await cubeBrowser.loadCube(cubeRecord, cubePorts(c, first, false));
assert.ok(broker.pools.stats().overlap.reserved > 0);
hostSwap([originalFiles], loaded); assert.equal(texturesDisposed, 2); assert.equal(broker.pools.stats().overlap.reserved, 0);
loaded.push(originalFiles);
assert.equal(requests, 7); assert.equal(decodes, 7); assert.equal(closedOriginals, 6); assert.equal(uploads, 3); assert.equal(ready, 3);
for (const image of loaded) { image.dispose(); image.dispose(); }
a.dispose(); b.dispose(); c.dispose(); registry.dispose(); broker.dispose(); assert.equal(texturesDisposed, 3); assert.equal(closedFaces, 12); assert.deepEqual(broker.pools.live(), []);
for (const end of ["invalidate", "dispose"]) for (const completion of ["resolve", "reject"]) {
  const session = images.createImageSessionBroker({ pools: { encoded: 1_000_000, decoded: 1_000_000, sourceGpu: 1_000_000, uploadOutstanding: 1_000_000, overlap: 1_000_000 }, requests: 1, decodes: 1 });
  let inputClosed = 0, outputClosed = 0, finish, fail, began;
  const started = new Promise(resolve => { began = resolve; });
  const native = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const inputBytes = record.width * record.height * 4, outputBytes = 6 * 8 * 8 * 4;
  const common = transport.createImageFileService({ broker: session, priority: () => 1, limits: () => ({ responseBytes: 1_000_000, timeoutMs: 1000 }), fetch: async () => new Response(packed.bytes, { headers: { "content-type": "image/jpeg" } }), decode: async () => ({ width: record.width, height: record.height, close() { inputClosed += 1; assert.equal(session.pools.stats().decoded.reserved, inputBytes); } }) });
  const pending = browser.createPreviewSheetSources({ broker: session, obtain: common.obtain, decode: common.decode, crop: () => { began(); return native; } });
  const scope = session.scope();
  const work = pending.acquireCubeFaces({ sheet: first, faceSize: 8, enabled: true, scope, label: "retained native input", fallback: async () => { throw new Error("unexpected cancelled fallback"); } });
  await started; const rejected = assert.rejects(work);
  session[end](); assert.equal(inputClosed, 0); assert.equal(session.pools.stats().decoded.reserved, inputBytes + outputBytes);
  if (completion === "reject") fail(new Error("native crop rejected"));
  else finish({ width: 8, height: 8, close() { outputClosed += 1; assert.equal(session.pools.stats().decoded.reserved, inputBytes + outputBytes); } });
  await rejected; assert.equal(inputClosed, 1); assert.equal(outputClosed, completion === "resolve" ? 1 : 0); assert.deepEqual(session.pools.live(), []);
  pending.dispose(); scope.dispose(); session.dispose();
}

// Retained public face-handoff fixture, now inside the actual archive guard.
// All dependencies above resolve from the isolated consumer's public exports.
const { createImageSessionBroker } = images;
const { createImageFileService } = transport;
const { encodePng } = codecs;
const { uploadCubeSource } = cubeBrowser;
const nativeBytes = encodePng({ width: 48, height: 8, rgb: new Uint8Array(48 * 8 * 3).fill(80) });
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

const packageDirectory = path.dirname(path.dirname(fileURLToPath(resolvePublic("@foss-earth/preview-sheets"))));
const manifest = JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
for (const name of [".", "./core", "./schema", "./browser", "./preparation", "./scene-extension", "./settings"]) assert.ok(readFileSync(path.join(packageDirectory, manifest.exports[name].types), "utf8").length);
for (const name of ["extension", "place"]) assert.equal(JSON.parse(readFileSync(new URL(resolvePublic(`@foss-earth/preview-sheets/schema/${name}.json`)), "utf8")).additionalProperties, false);
hook.deregister();
const receipt = { package: manifest.name, version: manifest.version, artifact: path.basename(artifact), sha256: createHash("sha256").update(readFileSync(artifact)).digest("hex"), node: process.version, sourceRevision: manifest.fossEarthSplit.sourceRevision, installedEntries: [".", "./core", "./schema", "./browser", "./preparation", "./scene-extension", "./settings", "./schema/extension.json", "./schema/place.json"], pureImport: true, isolatedFileResolution: true, nodePacking: true, optionalExtensionOwnerHook: true, existingSettingsHome: true, commonBrokerTransportDecode: true, oneSharedDownloadDecode: true, sixOriginalFileFallback: true, decodedInputRetainedThroughNativeCompletion: true, cancelledLateOutputClosedBeforeRelease: true, publishedFaceSourceRetain: true, faceInputHeldThroughSynchronousUploadCancellation: true, faceInputHeldThroughThrowingLateTextureCleanup: true, orderedPrimaryOutputFaceCleanupErrors: true, cubemapUploadReadinessAuthority: true, hostReplacementSettlement: true, overlapHeldThroughReadiness: true, exactCleanup: true, declarations: true, publication: "unaccepted local staging candidate; no destination commit or remote admission asserted" };
writeFileSync(path.join(consumer, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
process.stdout.write(JSON.stringify(receipt) + "\n");
