import { describe, expect, it } from "vitest";
import { createImageSessionBroker, createMediaStore, type MediaGroupRecord, type MediaStoreBackend, type SavedFile } from "@foss-earth/images";
import { createImageFileService } from "@foss-earth/images/browser";
import { encodePng } from "@foss-earth/images/node";
import { uploadCubeSource } from "@foss-earth/cubemap/browser";
import type { WholeImageTexture } from "@foss-earth/images/browser";
import { createPreviewSheetSources, type PreviewSheetFile, type CubeFaceSource } from "../src/browser.js";

/** Exact metadata admission fixture, not a second production cache. */
function storage() {
  const records = new Map<string, MediaGroupRecord>(), data = new Map<string, { group: string; file: SavedFile }>();
  const backend: MediaStoreBackend = {
    groups: async () => [...records.values()], read: async keys => keys.map(key => data.get(key)?.file ?? null),
    readBounded: async requests => requests.map(({ key, group, admission }) => {
      const row = data.get(key);
      return row && row.group === group && row.file.bytes.length <= admission.maxBytes && admission.admit(row.file.bytes.length) ? { ...row.file, bytes: row.file.bytes.slice() } : null;
    }),
    async write(files, now) {
      let count = 0, bytes = 0;
      for (const file of files) {
        if (data.has(file.key)) continue;
        data.set(file.key, { group: file.group.id, file: { bytes: file.bytes.slice(), contentType: file.contentType } }); count += 1; bytes += file.bytes.length;
        const old = records.get(file.group.id) ?? { ...file.group, files: 0, bytes: 0, used: now };
        records.set(old.id, { ...old, files: old.files + 1, bytes: old.bytes + file.bytes.length });
      }
      return { files: count, bytes };
    },
    async touch(ids, now) { for (const id of ids) { const old = records.get(id); if (old) records.set(id, { ...old, used: now }); } },
    async drop(ids) { for (const id of ids) { records.delete(id); for (const [key, row] of data) if (row.group === id) data.delete(key); } },
    async remove(key, group) { const row = data.get(key), old = records.get(group); if (!row || !old) return; data.delete(key); records.set(group, { ...old, files: old.files - 1, bytes: old.bytes - row.file.bytes.length }); },
    async clear() { data.clear(); records.clear(); },
  };
  return backend;
}
const bitmap = (width: number, height: number): ImageBitmap => ({ width, height, close() {} }) as ImageBitmap;
const faceSource = () => ({ from: "faces" as const, faces: Object.fromEntries(["px", "nx", "py", "ny", "pz", "nz"].map(face => [face, bitmap(8, 8)])), close() {} });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

describe("actual common decoded input remains live through native crop work", () => {
  async function pendingCrop(end: "invalidate" | "dispose" | "registry", completion: "resolve" | "reject", throwingCleanup = false) {
    const bytes = encodePng({ width: 48, height: 8, rgb: new Uint8Array(48 * 8 * 3).fill(40) });
    const broker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { encoded: 100_000, decoded: 100_000, sourceGpu: 100_000, uploadOutstanding: 100_000, overlap: 100_000 } });
    const events: { resource: string; reserved: number }[] = [];
    let sourceClosed = 0, outputClosed = 0, fallback = 0;
    const input = { width: 48, height: 8, close() { sourceClosed += 1; events.push({ resource: "input", reserved: broker.pools.stats().decoded.reserved }); if (throwingCleanup) throw new Error("input close observer"); } } as ImageBitmap;
    const common = createImageFileService({ broker, priority: () => 1, limits: () => ({ responseBytes: 100_000, timeoutMs: 1000 }), fetch: async () => new Response(bytes as BodyInit, { headers: { "content-type": "image/png" } }), decode: async () => input });
    const native = deferred<ImageBitmap>(); let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const registry = createPreviewSheetSources({ broker, obtain: common.obtain, decode: common.decode, crop: image => { expect(image).toBe(input); began(); return native.promise; } });
    const scope = broker.scope();
    const work = registry.acquireCubeFaces({ sheet: { id: "pending", revision: "r", mimeType: "image/png", url: "https://example.invalid/sheet.png", encodedBytes: bytes.length, width: 48, height: 8, x: 0, y: 0 }, scope, faceSize: 8, enabled: true, label: "native input", fallback: async () => { fallback += 1; return faceSource() as Awaited<ReturnType<typeof registry.acquireCubeFaces>>; } });
    await started;
    const rejected = expect(work).rejects.toThrow();
    const failureDetails = work.catch((error: unknown) => error);
    if (end === "registry") registry.dispose(); else if (end === "invalidate") broker.invalidate(); else broker.dispose();
    expect(sourceClosed).toBe(0);
    expect(broker.pools.stats().encoded.reserved).toBe(0);
    expect(broker.pools.stats().decoded.reserved).toBe(48 * 8 * 4 + 6 * 8 * 8 * 4);
    // The native operation may still read its input now; no captured-pixel assumption.
    expect(input.width).toBe(48); expect(sourceClosed).toBe(0);
    if (completion === "reject") native.reject(new Error("native crop failed"));
    else native.resolve({ width: 8, height: 8, close() { outputClosed += 1; events.push({ resource: "output", reserved: broker.pools.stats().decoded.reserved }); if (throwingCleanup) throw new Error("output close observer"); } } as ImageBitmap);
    await rejected;
    if (throwingCleanup && completion === "resolve") {
      const messages = (error: unknown): string[] => error instanceof AggregateError
        ? error.errors.flatMap(messages) : error instanceof Error ? [error.message] : [String(error)];
      expect(messages(await failureDetails)).toEqual(expect.arrayContaining(["output close observer", "input close observer"]));
    }
    expect(fallback).toBe(0); expect(sourceClosed).toBe(1);
    expect(outputClosed).toBe(completion === "resolve" ? 1 : 0);
    expect(events.at(-1)).toEqual({ resource: "input", reserved: 48 * 8 * 4 });
    if (completion === "resolve") expect(events[0]).toEqual({ resource: "output", reserved: 48 * 8 * 4 + 6 * 8 * 8 * 4 });
    expect(broker.pools.live()).toEqual([]);
    scope.dispose(); registry.dispose(); broker.dispose(); expect(sourceClosed).toBe(1);
  }
  for (const end of ["invalidate", "dispose", "registry"] as const) for (const completion of ["resolve", "reject"] as const) {
    it(`${end}: keeps source open/charged until crop ${completion} and closes output first`, () => pendingCrop(end, completion));
  }
  for (const completion of ["resolve", "reject"] as const) {
    it(`session disposal: releases all charges despite throwing cleanup after crop ${completion}`, () => pendingCrop("dispose", completion, true));
  }
  it("closes all unpublished faces if the completed input sheet disposer throws", async () => {
    const bytes = encodePng({ width: 48, height: 8, rgb: new Uint8Array(48 * 8 * 3) });
    const broker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { encoded: 100_000, decoded: 100_000, sourceGpu: 100_000, uploadOutstanding: 100_000, overlap: 100_000 } });
    let inputClosed = 0, outputClosed = 0, originals = 0;
    const common = createImageFileService({ broker, priority: () => 1, limits: () => ({ responseBytes: 100_000, timeoutMs: 1000 }), fetch: async () => new Response(bytes as BodyInit, { headers: { "content-type": "image/png" } }), decode: async () => ({ width: 48, height: 8, close() { inputClosed += 1; throw new Error("input cleanup failed"); } }) as ImageBitmap });
    const registry = createPreviewSheetSources({ broker, obtain: common.obtain, decode: common.decode, crop: async () => ({ width: 8, height: 8, close() { outputClosed += 1; if (outputClosed === 1) throw new Error("output cleanup failed"); } }) as ImageBitmap });
    const scope = broker.scope();
    await expect(registry.acquireCubeFaces({ sheet: { id: "cleanup", revision: "r", mimeType: "image/png", url: "https://example.invalid/cleanup.png", encodedBytes: bytes.length, width: 48, height: 8, x: 0, y: 0 }, scope, faceSize: 8, enabled: true, label: "cleanup", fallback: async () => { originals += 1; return faceSource() as Awaited<ReturnType<typeof registry.acquireCubeFaces>>; } })).rejects.toThrow("input/output disposal failed");
    expect(inputClosed).toBe(1); expect(outputClosed).toBe(6); expect(originals).toBe(0); expect(broker.pools.live()).toEqual([]);
    scope.dispose(); registry.dispose(); broker.dispose(); expect(inputClosed).toBe(1); expect(outputClosed).toBe(6);
  });
});

describe("retained original sheet behavior through actual common services", () => {
  it("keeps one header-checked sheet across visits under its own revision, including the same URL", async () => {
    const bytes = encodePng({ width: 48, height: 8, rgb: new Uint8Array(48 * 8 * 3).fill(80) }), backend = storage();
    const sheet = { id: "previews", revision: "r1", mimeType: "image/png" as const, url: "https://example.invalid/s.png", encodedBytes: bytes.length, width: 48, height: 8, x: 0, y: 0 };
    let requests = 0;
    async function visit(revision: string) {
      const broker = createImageSessionBroker({ requests: 2, decodes: 1, pools: { encoded: 100_000, decoded: 100_000, sourceGpu: 100_000, uploadOutstanding: 100_000, overlap: 100_000 } });
      const media = createMediaStore({ open: async () => backend, maxBytes: 100_000 });
      const common = createImageFileService({ broker, priority: () => 1, limits: () => ({ responseBytes: 100_000, timeoutMs: 1000 }), fetch: async () => { requests += 1; return new Response(bytes as BodyInit, { headers: { "content-type": "image/png" } }); }, decode: async () => bitmap(48, 8), cache: { files: media.files({ id: `sheet previews@${revision}`, label: "previews · preview sheet" }), settled: () => media.settled() } });
      const sources = createPreviewSheetSources({ broker, obtain: (file, size, scope) => { expect(file.mediaGroup.id).toBe(`sheet previews@${revision}`); return common.obtain(file, size, scope); }, decode: common.decode, crop: async (_image, _x, _y, width, height) => bitmap(width, height) });
      const scope = broker.scope();
      const source = await sources.acquireCubeFaces({ sheet: { ...sheet, revision }, scope, faceSize: 8, enabled: true, label: "visit", fallback: async () => { throw new Error("unexpected original fallback"); } });
      expect(source.from).toBe("sheet"); source.close(); scope.dispose(); sources.dispose(); await media.settled(); broker.dispose(); expect(broker.pools.live()).toEqual([]);
      return media.inspect();
    }
    expect((await visit("r1")).groups.map(group => [group.id, group.files])).toEqual([["sheet previews@r1", 1]]);
    await visit("r1"); expect(requests).toBe(1);
    expect((await visit("r2")).groups.map(group => group.id).sort()).toEqual(["sheet previews@r1", "sheet previews@r2"]); expect(requests).toBe(2);
  });
  it("rejects a mismatched sheet header before decoding/cropping and acquires original faces once", async () => {
    const bytes = encodePng({ width: 8, height: 8, rgb: new Uint8Array(8 * 8 * 3) });
    const broker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { encoded: 100_000, decoded: 100_000, sourceGpu: 100_000, uploadOutstanding: 100_000, overlap: 100_000 } });
    let decoded = 0, cropped = 0, originals = 0;
    const common = createImageFileService({ broker, priority: () => 1, limits: () => ({ responseBytes: 100_000, timeoutMs: 1000 }), fetch: async () => new Response(bytes as BodyInit, { headers: { "content-type": "image/png" } }), decode: async () => { decoded += 1; return bitmap(8, 8); } });
    const sources = createPreviewSheetSources({ broker, obtain: common.obtain, decode: common.decode, crop: async () => { cropped += 1; return bitmap(8, 8); } });
    const scope = broker.scope();
    const loaded = await sources.acquireCubeFaces({ sheet: { id: "bad", revision: "r", mimeType: "image/png", url: "https://example.invalid/wrong.png", encodedBytes: bytes.length, width: 48, height: 8, x: 0, y: 0 }, scope, faceSize: 8, enabled: true, label: "wrong header", fallback: async () => { originals += 1; return faceSource() as Awaited<ReturnType<typeof sources.acquireCubeFaces>>; } });
    expect(loaded.from).toBe("faces"); expect(originals).toBe(1); expect(decoded).toBe(0); expect(cropped).toBe(0);
    loaded.close(); scope.dispose(); sources.dispose(); broker.dispose(); expect(broker.pools.live()).toEqual([]);
  });
});

// Preserve structural identity/media-group fields in the caller's acquisition API.
const identityFile = (file: PreviewSheetFile) => file.identity.revision;
void identityFile;

describe("cropped face ownership transfers to the supplied cube uploader", () => {
  async function pendingUpload(end: "scope" | "invalidate" | "dispose" | "callback", completion: "resolve" | "reject", throwingCleanup = false) {
    const bytes = encodePng({ width: 48, height: 8, rgb: new Uint8Array(48 * 8 * 3).fill(60) });
    const broker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { encoded: 100_000, decoded: 100_000, sourceGpu: 100_000, uploadOutstanding: 100_000, overlap: 100_000 } });
    const scope = broker.scope();
    let inputClosed = 0, facesClosed = 0, disposed = 0, ready = 0;
    const events: { resource: string; decoded: number; closed: number }[] = [];
    const common = createImageFileService({ broker, priority: () => 1, limits: () => ({ responseBytes: 100_000, timeoutMs: 1000 }),
      fetch: async () => new Response(bytes as BodyInit, { headers: { "content-type": "image/png" } }),
      decode: async () => ({ width: 48, height: 8, close() { inputClosed += 1; } }) as ImageBitmap });
    const registry = createPreviewSheetSources({ broker, obtain: common.obtain, decode: common.decode,
      crop: async () => ({ width: 8, height: 8, close() {
        facesClosed += 1; events.push({ resource: "face", decoded: broker.pools.stats().decoded.reserved, closed: facesClosed });
        if (throwingCleanup) throw new Error("face cleanup");
      } }) as ImageBitmap });
    const source = await registry.acquireCubeFaces({ sheet: { id: "handoff", revision: "r", mimeType: "image/png", url: "https://example.invalid/handoff.png", encodedBytes: bytes.length, width: 48, height: 8, x: 0, y: 0 }, scope, faceSize: 8, enabled: true, label: "handoff", fallback: async () => { throw new Error("unexpected fallback"); } });
    expect(source.from).toBe("sheet"); expect(typeof source.retain).toBe("function"); expect(inputClosed).toBe(1);
    const native = deferred<WholeImageTexture>(); let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const record = { id: "handoff", role: "preview" as const, projection: "cube" as const, mimeType: "image/png" as const, encodedBytes: bytes.length, faceSize: 8, faces: Object.fromEntries(["px", "nx", "py", "ny", "pz", "nz"].map(face => [face, `https://example.invalid/${face}.png`])) as Record<"px" | "nx" | "py" | "ny" | "pz" | "nz", string> };
    const work = uploadCubeSource(record, source, { broker, scope, label: "pending face upload", maxTextureSide: 4096, overlap: true,
      obtain: (file, size) => common.obtain(file, size, scope), decode: (body, file) => common.decode(body, file, scope),
      uploadCube(faces) { expect(faces).toBe(source.faces); if (end === "callback") { scope.dispose(); expect(facesClosed).toBe(0); expect(broker.pools.stats().decoded.reserved).toBe(6 * 8 * 8 * 4); } began(); return native.promise; },
      whenReady: async (_texture, signal) => { ready += 1; signal.throwIfAborted(); } });
    const failure = work.catch((error: unknown) => error);
    await started;
    if (end === "scope") scope.dispose(); else if (end === "invalidate") broker.invalidate(); else if (end === "dispose") broker.dispose();
    source.close(); source.close();
    expect(() => source.retain!()).toThrow("closing");
    expect(facesClosed).toBe(0); expect(broker.pools.stats().decoded.reserved).toBe(6 * 8 * 8 * 4);
    if (completion === "reject") native.reject(new Error("native upload failed"));
    else native.resolve({ dispose() {
      disposed += 1; events.push({ resource: "texture", decoded: broker.pools.stats().decoded.reserved, closed: facesClosed });
      if (throwingCleanup) throw new Error("texture cleanup");
    } });
    const error = await failure;
    expect(error).toBeInstanceOf(Error); expect(ready).toBe(0); expect(facesClosed).toBe(6);
    expect(disposed).toBe(completion === "resolve" ? 1 : 0); expect(inputClosed).toBe(1);
    if (completion === "resolve") expect(events[0]).toEqual({ resource: "texture", decoded: 6 * 8 * 8 * 4, closed: 0 });
    if (throwingCleanup) {
      const messages = (failure: unknown): string[] => failure instanceof AggregateError
        ? failure.errors.flatMap(messages) : failure instanceof Error ? [failure.message] : [String(failure)];
      expect(messages(error)).toEqual(completion === "resolve"
        ? ["The image operation ended.", "texture cleanup", ...Array(6).fill("face cleanup")]
        : ["native upload failed", ...Array(6).fill("face cleanup")]);
    }
    expect(broker.pools.live()).toEqual([]);
    source.close(); scope.dispose(); registry.dispose(); broker.dispose(); expect(facesClosed).toBe(6);
  }
  for (const end of ["scope", "invalidate", "dispose", "callback"] as const) for (const completion of ["resolve", "reject"] as const) {
    it(`${end}: retains published crops through native upload ${completion} and late texture cleanup`, () => pendingUpload(end, completion));
  }
  for (const completion of ["resolve", "reject"] as const) {
    it(`ends all face charges despite throwing cleanup after upload ${completion}`, () => pendingUpload("dispose", completion, true));
  }
});

describe("preview generation and publication through the actual common broker", () => {
  it("shares the initialized promise when obtain synchronously starts another acquisition", async () => {
    const bytes = encodePng({ width: 48, height: 8, rgb: new Uint8Array(48 * 8 * 3) });
    const broker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { encoded: 100_000, decoded: 100_000, sourceGpu: 100_000, uploadOutstanding: 100_000, overlap: 100_000 } });
    let obtained = 0, decoded = 0, requests = 0, originals = 0, inputClosed = 0;
    const common = createImageFileService({ broker, priority: () => 1, limits: () => ({ responseBytes: 100_000, timeoutMs: 1000 }), fetch: async () => { requests += 1; return new Response(bytes as BodyInit, { headers: { "content-type": "image/png" } }); }, decode: async () => { decoded += 1; return { width: 48, height: 8, close() { inputClosed += 1; } } as ImageBitmap; } });
    const firstScope = broker.scope(), secondScope = broker.scope();
    const sheet = { id: "reentry", revision: "same", mimeType: "image/png" as const, url: "https://example.invalid/reentry.png", encodedBytes: bytes.length, width: 48, height: 8, x: 0, y: 0 };
    let nested: Promise<CubeFaceSource> | undefined;
    const fallback = async (): Promise<CubeFaceSource> => { originals += 1; return faceSource() as CubeFaceSource; };
    const registry = createPreviewSheetSources({ broker, obtain(file, size, scope) {
      obtained += 1;
      nested = registry.acquireCubeFaces({ sheet, scope: secondScope, faceSize: 8, enabled: true, label: "reentrant", fallback });
      return common.obtain(file, size, scope);
    }, decode: common.decode, crop: async () => bitmap(8, 8) });
    const first = await registry.acquireCubeFaces({ sheet, scope: firstScope, faceSize: 8, enabled: true, label: "initial", fallback });
    expect(nested).toBeDefined(); const second = await nested!;
    expect(first.from).toBe("sheet"); expect(second.from).toBe("sheet");
    expect(obtained).toBe(1); expect(decoded).toBe(1); expect(requests).toBe(1); expect(originals).toBe(0); expect(inputClosed).toBe(1);
    first.close(); second.close(); firstScope.dispose(); secondScope.dispose(); registry.dispose(); broker.dispose(); expect(broker.pools.live()).toEqual([]);
  });
  for (const completion of ["resolve", "reject"] as const) {
    it(`acquires the same revision in a new generation while the old crop awaits ${completion}`, async () => {
      const bytes = encodePng({ width: 48, height: 8, rgb: new Uint8Array(48 * 8 * 3).fill(20) });
      const broker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { encoded: 100_000, decoded: 100_000, sourceGpu: 100_000, uploadOutstanding: 100_000, overlap: 100_000 } });
      const inputs: ImageBitmap[] = [], inputClosed: number[] = [];
      let originals = 0, oldOutputClosed = 0;
      const common = createImageFileService({ broker, priority: () => 1, limits: () => ({ responseBytes: 100_000, timeoutMs: 1000 }), fetch: async () => new Response(bytes as BodyInit, { headers: { "content-type": "image/png" } }), decode: async () => {
        const index = inputs.length;
        inputClosed.push(0);
        const image = { width: 48, height: 8, close() { inputClosed[index] = inputClosed[index]! + 1; } } as ImageBitmap;
        inputs.push(image); return image;
      } });
      const native = deferred<ImageBitmap>();
      let began!: () => void;
      const started = new Promise<void>(resolve => { began = resolve; });
      const registry = createPreviewSheetSources({ broker, obtain: common.obtain, decode: common.decode, crop: async image => {
        if (image === inputs[0]) { began(); return native.promise; }
        return bitmap(8, 8);
      } });
      const sheet = { id: "overlap", revision: "same", mimeType: "image/png" as const, url: "https://example.invalid/overlap.png", encodedBytes: bytes.length, width: 48, height: 8, x: 0, y: 0 };
      const fallback = async () => { originals += 1; return faceSource() as Awaited<ReturnType<typeof registry.acquireCubeFaces>>; };
      const oldScope = broker.scope();
      const oldWork = registry.acquireCubeFaces({ sheet, scope: oldScope, faceSize: 8, enabled: true, label: "old generation", fallback });
      const oldRejected = expect(oldWork).rejects.toThrow();
      await started;
      broker.invalidate();
      expect(inputClosed).toEqual([0]);
      const scope = broker.scope();
      const next = await registry.acquireCubeFaces({ sheet, scope, faceSize: 8, enabled: true, label: "new generation", fallback });
      expect(next.from).toBe("sheet"); expect(inputs).toHaveLength(2);
      expect(inputClosed).toEqual([0, 1]); expect(originals).toBe(0);
      expect(registry.stats().failedSheets).toBe(0);
      next.close(); scope.dispose();
      if (completion === "reject") native.reject(new Error("old native crop failed"));
      else native.resolve({ width: 8, height: 8, close() { oldOutputClosed += 1; } } as ImageBitmap);
      await oldRejected;
      expect(inputClosed).toEqual([1, 1]); expect(oldOutputClosed).toBe(completion === "resolve" ? 1 : 0);
      expect(registry.stats().failedSheets).toBe(0);
      const retryScope = broker.scope();
      const retry = await registry.acquireCubeFaces({ sheet, scope: retryScope, faceSize: 8, enabled: true, label: "same generation retry", fallback });
      expect(retry.from).toBe("sheet"); expect(inputs).toHaveLength(3); expect(originals).toBe(0);
      retry.close(); retryScope.dispose(); registry.dispose(); broker.dispose();
      expect(inputClosed).toEqual([1, 1, 1]); expect(broker.pools.live()).toEqual([]);
    });
  }
  it("retries generation-local sheet failure after broker invalidation", async () => {
    const bytes = encodePng({ width: 48, height: 8, rgb: new Uint8Array(48 * 8 * 3) });
    const broker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { encoded: 100_000, decoded: 100_000, sourceGpu: 100_000, uploadOutstanding: 100_000, overlap: 100_000 } });
    let decoded = 0, originals = 0;
    const common = createImageFileService({ broker, priority: () => 1, limits: () => ({ responseBytes: 100_000, timeoutMs: 1000 }), fetch: async () => new Response(bytes as BodyInit, { headers: { "content-type": "image/png" } }), decode: async () => { decoded += 1; if (decoded === 1) throw new Error("generation decoder unavailable"); return bitmap(48, 8); } });
    const registry = createPreviewSheetSources({ broker, obtain: common.obtain, decode: common.decode, crop: async () => bitmap(8, 8) });
    const sheet = { id: "retry", revision: "same", mimeType: "image/png" as const, url: "https://example.invalid/retry.png", encodedBytes: bytes.length, width: 48, height: 8, x: 0, y: 0 };
    const fallback = async () => { originals += 1; return faceSource() as Awaited<ReturnType<typeof registry.acquireCubeFaces>>; };
    const firstScope = broker.scope();
    expect((await registry.acquireCubeFaces({ sheet, scope: firstScope, faceSize: 8, enabled: true, label: "first", fallback })).from).toBe("faces");
    expect((await registry.acquireCubeFaces({ sheet, scope: firstScope, faceSize: 8, enabled: true, label: "same failure", fallback })).from).toBe("faces");
    expect(decoded).toBe(1); expect(registry.stats().failedSheets).toBe(1);
    broker.invalidate();
    const nextScope = broker.scope();
    const next = await registry.acquireCubeFaces({ sheet, scope: nextScope, faceSize: 8, enabled: true, label: "retry", fallback });
    expect(next.from).toBe("sheet"); expect(decoded).toBe(2); expect(originals).toBe(2); expect(registry.stats().failedSheets).toBe(0);
    next.close(); nextScope.dispose(); registry.dispose(); broker.dispose(); expect(broker.pools.live()).toEqual([]);
  });
  for (const end of ["scope", "broker"] as const) {
    it(`rejects unpublished faces when input closure synchronously ends the ${end}`, async () => {
      const bytes = encodePng({ width: 48, height: 8, rgb: new Uint8Array(48 * 8 * 3) });
      const broker = createImageSessionBroker({ requests: 1, decodes: 1, pools: { encoded: 100_000, decoded: 100_000, sourceGpu: 100_000, uploadOutstanding: 100_000, overlap: 100_000 } });
      const scope = broker.scope();
      let inputClosed = 0, outputClosed = 0, originals = 0;
      const common = createImageFileService({ broker, priority: () => 1, limits: () => ({ responseBytes: 100_000, timeoutMs: 1000 }), fetch: async () => new Response(bytes as BodyInit, { headers: { "content-type": "image/png" } }), decode: async () => ({ width: 48, height: 8, close() { inputClosed += 1; if (end === "scope") scope.dispose(); else broker.invalidate(); } }) as ImageBitmap });
      const registry = createPreviewSheetSources({ broker, obtain: common.obtain, decode: common.decode, crop: async () => ({ width: 8, height: 8, close() { outputClosed += 1; } }) as ImageBitmap });
      await expect(registry.acquireCubeFaces({ sheet: { id: "reentrant", revision: "same", mimeType: "image/png", url: "https://example.invalid/reentrant.png", encodedBytes: bytes.length, width: 48, height: 8, x: 0, y: 0 }, scope, faceSize: 8, enabled: true, label: "input observer", fallback: async () => { originals += 1; return faceSource() as Awaited<ReturnType<typeof registry.acquireCubeFaces>>; } })).rejects.toThrow();
      expect(inputClosed).toBe(1); expect(outputClosed).toBe(6); expect(originals).toBe(0); expect(registry.stats().failedSheets).toBe(0);
      expect(broker.pools.live()).toEqual([]); scope.dispose(); registry.dispose(); broker.dispose(); expect(outputClosed).toBe(6);
    });
  }
});
