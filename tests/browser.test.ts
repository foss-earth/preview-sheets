import { describe, expect, it, vi } from "vitest";
import { createImageSessionBroker, ResourceCapacityError, type ImageFile, type ImageOperationScope } from "@foss-earth/images";
import type { EncodedImageFile, HeldDecodedImage } from "@foss-earth/images/browser";
import { CUBE_FACE_NAMES } from "@foss-earth/sphere-cubemap/core";
import { createPreviewSheetSources, type CubeFaceSource, type PreviewSheetPorts } from "../src/browser.js";

const sheet = { id: "s", revision: "1", url: "https://example.invalid/s.jpg", mimeType: "image/jpeg" as const, width: 48, height: 16, encodedBytes: 10, x: 0, y: 0 };
function bitmap(width = 8, height = 8): ImageBitmap { return { width, height, close: vi.fn() } as unknown as ImageBitmap; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture() {
  const broker = createImageSessionBroker({ pools: { decoded: 1_000_000, encoded: 1_000_000, sourceGpu: 1_000_000, uploadOutstanding: 1_000_000, overlap: 1_000_000 }, requests: 2, decodes: 2 });
  const image = bitmap(48, 16), crops: ImageBitmap[] = [];
  const obtain = vi.fn(async (_file: ImageFile, bytes: number, scope: ImageOperationScope) => {
    const reserved = scope.reserve("encoded", bytes, "sheet");
    return { bytes: new Uint8Array(bytes), contentType: "image/jpeg", release: () => reserved.release() };
  });
  const decode = vi.fn(async (_file: EncodedImageFile, declared: ImageFile, scope: ImageOperationScope) => {
    const reservation = scope.reserve("decoded", 4 * declared.width * declared.height, "sheet"), pixels = reservation.retain();
    let closed = false, closing = false, users = 0;
    const finish = () => { if (closed || !closing || users) return; closed = true; try { image.close(); } finally { pixels(); reservation.release(); } };
    const close = (): void => { closing = true; finish(); };
    const retain = () => { if (closing) throw new Error("closed test sheet"); users += 1; let ended = false; return () => { if (ended) return; ended = true; users -= 1; finish(); }; };
    scope.adopt({ dispose: close }); return { image, retain, close };
  });
  const crop = vi.fn(async (_image: ImageBitmap, _x: number, _y: number, _width: number, _height: number) => { const value = bitmap(); crops.push(value); return value; });
  const ports: PreviewSheetPorts = { broker, obtain, decode, crop };
  const fallback = vi.fn(async (): Promise<CubeFaceSource> => ({ from: "faces", faces: Object.fromEntries(CUBE_FACE_NAMES.map(face => [face, bitmap()])) as CubeFaceSource["faces"], close: vi.fn() }));
  return { broker, image, crops, obtain, decode, crop, ports, fallback };
}
const tick = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)); };

describe("one host-owned preview sheet source registry", () => {
  it("uses the original faces when a legacy supplied decoder has no reliable native input hold", async () => {
    const f = fixture();
    f.ports.decode = async (_file, _declared, scope) => { const grant = scope.reserve("decoded", 4 * 48 * 16, "old sheet"); let closed = false; const held = { image: f.image, close() { if (closed) return; closed = true; f.image.close(); grant.release(); } }; scope.adopt({ dispose: held.close }); return held; };
    const sources = createPreviewSheetSources(f.ports), scope = f.broker.scope();
    expect((await sources.acquireCubeFaces({ sheet, faceSize: 8, label: "legacy", enabled: true, scope, fallback: f.fallback })).from).toBe("faces");
    expect(f.crop).not.toHaveBeenCalled(); expect(f.fallback).toHaveBeenCalledOnce(); expect(f.image.close).toHaveBeenCalledOnce();
    expect(sources.stats().failedSheets).toBe(0); expect(f.broker.pools.live()).toEqual([]); scope.dispose(); sources.dispose(); f.broker.dispose();
  });
  it("keeps crop output and its sheet input charged through nonabortable cancellation", async () => {
    const f = fixture(), late = deferred<ImageBitmap>(); f.ports.crop = vi.fn(() => late.promise);
    const sources = createPreviewSheetSources(f.ports), scope = f.broker.scope();
    const work = sources.acquireCubeFaces({ sheet, faceSize: 8, label: "late", enabled: true, scope, fallback: f.fallback });
    await tick(); const before = f.broker.pools.stats().decoded.reserved;
    expect(before).toBe(4 * 48 * 16 + 6 * 4 * 8 * 8);
    scope.dispose(); sources.dispose();
    // Scope abort must not uncharge a native crop or close its source bitmap.
    expect(f.broker.pools.stats().decoded.reserved).toBe(before);
    expect(f.image.close).not.toHaveBeenCalled();
    const output = bitmap(); late.resolve(output); await expect(work).rejects.toThrow();
    expect(output.close).toHaveBeenCalledOnce(); expect(f.image.close).toHaveBeenCalledOnce();
    expect(f.fallback).not.toHaveBeenCalled(); expect(f.broker.pools.live()).toEqual([]); f.broker.dispose();
  });
  it("does not poison a valid sheet after transient shared capacity refusal", async () => {
    const f = fixture(); f.decode.mockRejectedValueOnce(new ResourceCapacityError("decoded", "busy"));
    const sources = createPreviewSheetSources(f.ports), scope = f.broker.scope();
    expect((await sources.acquireCubeFaces({ sheet, faceSize: 8, label: "retry", enabled: true, scope, fallback: f.fallback })).from).toBe("faces");
    expect(sources.stats().failedSheets).toBe(0);
    const retried = await sources.acquireCubeFaces({ sheet, faceSize: 8, label: "retry", enabled: true, scope, fallback: f.fallback });
    expect(retried.from).toBe("sheet"); expect(f.obtain).toHaveBeenCalledTimes(2);
    retried.close(); scope.dispose(); sources.dispose(); f.broker.dispose(); expect(f.broker.pools.live()).toEqual([]);
  });
  it("closes every partial crop and falls back if a supplied codec returns the wrong dimensions", async () => {
    const f = fixture(), wrong = bitmap(7, 8); f.crop.mockResolvedValueOnce(wrong);
    const sources = createPreviewSheetSources(f.ports), scope = f.broker.scope();
    expect((await sources.acquireCubeFaces({ sheet, faceSize: 8, label: "dimensions", enabled: true, scope, fallback: f.fallback })).from).toBe("faces");
    expect(wrong.close).toHaveBeenCalledOnce(); expect(f.crop).toHaveBeenCalledOnce();
    expect(f.broker.pools.live()).toEqual([]); scope.dispose(); sources.dispose(); f.broker.dispose();
  });
  it("shares download/decode through both consumers' crops and closes exactly once", async () => {
    const f = fixture(), source = createPreviewSheetSources(f.ports);
    const a = f.broker.scope(), b = f.broker.scope();
    const [one, two] = await Promise.all([
      source.acquireCubeFaces({ sheet, faceSize: 8, label: "a", enabled: true, scope: a, fallback: f.fallback }),
      source.acquireCubeFaces({ sheet: { ...sheet, y: 8 }, faceSize: 8, label: "b", enabled: true, scope: b, fallback: f.fallback }),
    ]);
    expect(f.obtain).toHaveBeenCalledTimes(1); expect(f.decode).toHaveBeenCalledTimes(1); expect(f.crop).toHaveBeenCalledTimes(12);
    expect(f.obtain.mock.calls[0][0]).toMatchObject({ identity: { id: "s", revision: "1" }, mediaGroup: { id: "sheet s@1", label: "s · preview sheet" } });
    for (const y of [0, 8]) expect(f.crop.mock.calls.filter(call => call[2] === y).map(call => call.slice(1))).toEqual(Array.from({ length: 6 }, (_, i) => [i * 8, y, 8, 8]));
    expect(Object.keys(one.faces)).toEqual(CUBE_FACE_NAMES); expect(two.from).toBe("sheet");
    expect(f.image.close).toHaveBeenCalledTimes(1); expect(source.stats()).toEqual({ activeSheets: 0, users: 0, failedSheets: 0 });
    one.close(); one.close(); b.dispose(); two.close(); a.dispose(); source.dispose(); f.broker.dispose();
    for (const image of f.crops) expect(image.close).toHaveBeenCalledTimes(1);
    expect(f.broker.pools.live()).toEqual([]); expect(f.fallback).not.toHaveBeenCalled();
  });
  it("uses six original files when off, unsupported or a sheet failed earlier in the visit", async () => {
    const f = fixture(), source = createPreviewSheetSources(f.ports);
    const scope = f.broker.scope();
    await source.acquireCubeFaces({ sheet, faceSize: 8, label: "a", enabled: false, scope, fallback: f.fallback });
    expect(f.obtain).not.toHaveBeenCalled();
    f.decode.mockRejectedValueOnce(new Error("bad sheet"));
    expect((await source.acquireCubeFaces({ sheet, faceSize: 8, label: "a", enabled: true, scope, fallback: f.fallback })).from).toBe("faces");
    await source.acquireCubeFaces({ sheet, faceSize: 8, label: "a", enabled: true, scope, fallback: f.fallback });
    expect(f.obtain).toHaveBeenCalledTimes(1); expect(f.fallback).toHaveBeenCalledTimes(3); expect(source.stats().failedSheets).toBe(1);
    scope.dispose(); source.dispose(); f.broker.dispose(); expect(f.broker.pools.live()).toEqual([]);
    const g = fixture(), unsupported = createPreviewSheetSources({ ...g.ports, crop: undefined }), other = g.broker.scope();
    await unsupported.acquireCubeFaces({ sheet, faceSize: 8, label: "a", enabled: true, scope: other, fallback: g.fallback });
    expect(g.obtain).not.toHaveBeenCalled(); expect(g.fallback).toHaveBeenCalledTimes(1); other.dispose(); unsupported.dispose(); g.broker.dispose();
  });
  it("aborts the last user without fallback, then closes a late codec result", async () => {
    const f = fixture(), finish = deferred<{ image: ImageBitmap; close(): void }>();
    f.ports.decode = vi.fn(() => finish.promise);
    const source = createPreviewSheetSources(f.ports), scope = f.broker.scope();
    const result = source.acquireCubeFaces({ sheet, faceSize: 8, label: "a", enabled: true, scope, fallback: f.fallback });
    await tick(); scope.dispose(); await expect(result).rejects.toThrow();
    const close = vi.fn(); finish.resolve({ image: f.image, close }); await tick();
    expect(close).toHaveBeenCalledTimes(1); expect(f.crop).not.toHaveBeenCalled(); expect(f.fallback).not.toHaveBeenCalled();
    expect(source.stats().failedSheets).toBe(0); source.dispose(); f.broker.dispose(); expect(f.broker.pools.live()).toEqual([]);
  });
  it("a cancelled consumer leaves the shared operation for the other consumer", async () => {
    const f = fixture(), finish = deferred<HeldDecodedImage>(); f.ports.decode = vi.fn(() => finish.promise);
    const source = createPreviewSheetSources(f.ports), a = f.broker.scope(), b = f.broker.scope();
    const one = source.acquireCubeFaces({ sheet, faceSize: 8, label: "a", enabled: true, scope: a, fallback: f.fallback });
    const two = source.acquireCubeFaces({ sheet, faceSize: 8, label: "b", enabled: true, scope: b, fallback: f.fallback });
    await tick(); a.dispose(); await expect(one).rejects.toThrow(); expect(source.stats().users).toBe(1);
    const close = vi.fn(); finish.resolve({ image: f.image, close, retain: () => () => {} }); const faces = await two;
    expect(faces.from).toBe("sheet"); expect(f.crop).toHaveBeenCalledTimes(6);
    expect(f.obtain).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1); faces.close(); b.dispose(); source.dispose(); f.broker.dispose();
  });
  it("registry disposal stops pending consumers immediately and closes late decodes", async () => {
    const f = fixture(), finish = deferred<{ image: ImageBitmap; close(): void }>(); f.ports.decode = vi.fn(() => finish.promise);
    const source = createPreviewSheetSources(f.ports), scope = f.broker.scope();
    const loading = source.acquireCubeFaces({ sheet, faceSize: 8, label: "a", enabled: true, scope, fallback: f.fallback });
    await tick(); source.dispose(); await expect(loading).rejects.toThrow(/disposed/);
    const close = vi.fn(); finish.resolve({ image: f.image, close }); await tick();
    expect(close).toHaveBeenCalledTimes(1); expect(f.fallback).not.toHaveBeenCalled(); scope.dispose(); f.broker.dispose(); expect(f.broker.pools.live()).toEqual([]);
  });
  it("cleans partial crops before original-file fallback, and prevents late crops after registry disposal", async () => {
    const f = fixture(), late = deferred<ImageBitmap>();
    f.crop.mockRejectedValueOnce(new Error("crop failed"));
    const source = createPreviewSheetSources(f.ports), scope = f.broker.scope();
    expect((await source.acquireCubeFaces({ sheet, faceSize: 8, label: "a", enabled: true, scope, fallback: f.fallback })).from).toBe("faces");
    expect(f.broker.pools.live()).toEqual([]); source.dispose(); scope.dispose(); f.broker.dispose();
    const g = fixture(); g.ports.crop = vi.fn(() => late.promise);
    const second = createPreviewSheetSources(g.ports), cube = g.broker.scope();
    const loading = second.acquireCubeFaces({ sheet, faceSize: 8, label: "b", enabled: true, scope: cube, fallback: g.fallback });
    await tick(); second.dispose(); const crop = bitmap(); late.resolve(crop); await expect(loading).rejects.toThrow(/disposed/);
    expect(crop.close).toHaveBeenCalledTimes(1); expect(g.ports.crop).toHaveBeenCalledTimes(1); expect(g.fallback).not.toHaveBeenCalled(); cube.dispose(); g.broker.dispose(); expect(g.broker.pools.live()).toEqual([]);
  });
});
