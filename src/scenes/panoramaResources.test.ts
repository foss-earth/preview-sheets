import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MIB, representationGpuBytes } from "./budget";
import type { ResolvedAsset, ResolvedRepresentation } from "./format";
import { createMediaStore, mediaGroup } from "./mediaStore";
import { createPanoramaResources, ResourceRefusal, type GpuSource, type ResourceBackend, type ResourceProgress, type ResourceSettings } from "./panoramaResources";
import { memoryBackend } from "../test/memoryMediaBackend";
import { validateScene } from "./validateScene";

const BASE = "https://foss-earth.test/examples/panorama-scenes/";
const scene = (() => {
  const result = validateScene(readFileSync(new URL("../../public/examples/panorama-scenes/campus-pair.scene.json", import.meta.url), "utf8"), { baseUrl: `${BASE}campus-pair.scene.json` });
  if (!result.ok) throw new Error("fixture invalid");
  return result.scene;
})();
const photo = scene.assets.get("buikslotermeerplein-512")!;
const grid = scene.assets.get("cardinal-grid")!;
const rep = (asset: ResolvedAsset, id: string): ResolvedRepresentation => asset.representations.find(entry => entry.id === id)!;

const SETTINGS: ResourceSettings = {
  limits: { sourceGpu: 128 * MIB, overlap: 48 * MIB, decoded: 64 * MIB, encoded: 32 * MIB, uploadOutstanding: 16 * MIB },
  responseBytes: 16 * MIB, requests: 4, decodes: 1, timeoutMs: 30_000, immersionWidth: Number.POSITIVE_INFINITY,
};

interface FakeTexture extends GpuSource { disposed: boolean }

function backend(overrides: Partial<ResourceBackend<FakeTexture>> = {}) {
  const fetched: string[] = [];
  const closed: number[] = [];
  let open = 0;
  const textures: FakeTexture[] = [];
  const value: ResourceBackend<FakeTexture> = {
    async fetch(url, init) {
      fetched.push(url);
      expect(init.credentials).toBe("omit");
      const file = new URL(`../../public/${new URL(url).pathname.replace(/^\//, "")}`, import.meta.url);
      return new Response(readFileSync(file), { headers: { "content-type": "image/jpeg" } });
    },
    async decode(bytes) {
      open += 1;
      const size = bytes.length;
      return { width: 0, height: 0, close: () => { open -= 1; closed.push(size); } } as unknown as ImageBitmap;
    },
    async uploadCube(_faces, label) {
      const texture: FakeTexture = { kind: "cube", gpuBytes: 0, disposed: false, dispose() { texture.disposed = true; } };
      textures.push(texture);
      void label;
      return texture;
    },
    async uploadEquirect() {
      const texture: FakeTexture = { kind: "equirectangular", gpuBytes: 0, disposed: false, dispose() { texture.disposed = true; } };
      textures.push(texture);
      return texture;
    },
    maxTextureSide: () => 8192,
    ...overrides,
  };
  return { value, fetched, closed, textures, open: () => open };
}

describe("panorama resources", () => {
  it("reports bytes while an image is still arriving, with completion after decoding and upload", async () => {
    const representation = rep(grid, "whole-2048");
    if (representation.projection !== "equirectangular") throw new Error("Expected image fixture");
    const bytes = readFileSync(new URL(`../../public/${new URL(representation.url).pathname.replace(/^\//, "")}`, import.meta.url));
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const updates: ResourceProgress[] = [];
    const b = backend({ fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "content-type": "image/jpeg" } }) });
    const resources = createPanoramaResources(b.value, SETTINGS, update => updates.push(update));
    const loading = resources.acquire(grid, representation);
    await vi.waitFor(() => expect(stream).toBeDefined());
    const split = Math.floor(bytes.length / 2);
    stream.enqueue(bytes.subarray(0, split));
    await vi.waitFor(() => expect(updates.at(-1)?.receivedBytes).toBe(split));
    expect(updates.at(-1)).toMatchObject({ assetId: grid.id, state: "loading", totalBytes: representation.encodedBytes });
    expect(b.textures).toHaveLength(0);
    stream.enqueue(bytes.subarray(split));
    stream.close();
    const handle = await loading;
    expect(updates.at(-1)).toMatchObject({ receivedBytes: bytes.length, state: "ready" });
    expect(resources.stats().transferredBytes).toBe(bytes.length);
    handle.release();
    resources.dispose();
  });

  it("does not leave queued cube faces or reservations behind when one request fails", async () => {
    let requests = 0;
    const b = backend({ fetch: async () => { requests += 1; throw new Error("Offline"); } });
    const updates: ResourceProgress[] = [];
    const resources = createPanoramaResources(b.value, { ...SETTINGS, requests: 1 }, update => updates.push(update));
    await expect(resources.acquire(grid, rep(grid, "preview-64"))).rejects.toThrow("Offline");
    expect(requests).toBeLessThan(6);
    expect(resources.stats()).toMatchObject({ activeRequests: 0, queuedRequests: 0 });
    expect(resources.stats().pools.encoded.reserved).toBe(0);
    expect(updates.at(-1)?.state).toBe("failed");
    resources.dispose();
  });

  it("loads a preview cube within its reservations, then keeps only the GPU bytes, and shares it", async () => {
    const b = backend();
    const resources = createPanoramaResources(b.value, SETTINGS);
    const preview = rep(grid, "preview-128");
    const [first, second] = await Promise.all([resources.acquire(grid, preview), resources.acquire(grid, preview)]);
    expect(first.texture).toBe(second.texture);
    expect(b.fetched).toHaveLength(6);
    expect(b.open()).toBe(0);
    const pools = resources.stats().pools;
    expect(pools.sourceGpu.reserved).toBe(representationGpuBytes(preview));
    expect(pools.encoded.reserved).toBe(0);
    expect(pools.decoded.reserved).toBe(0);
    expect(pools.overlap.reserved).toBe(0);
    first.release();
    second.release();
    second.release();
    expect(resources.stats().referencedSources).toBe(0);
    expect(resources.stats().cachedSources).toBe(1);
    resources.dispose();
    expect(resources.stats().pools.sourceGpu.reserved).toBe(0);
    expect(b.textures[0].disposed).toBe(true);
  });

  it("refuses what the GPU budget cannot hold, naming it, and makes room by evicting idle sources first", async () => {
    const b = backend();
    const preview = rep(grid, "preview-256");
    const bytes = representationGpuBytes(preview);
    const resources = createPanoramaResources(b.value, { ...SETTINGS, limits: { ...SETTINGS.limits, sourceGpu: bytes + 1024 } });
    const held = await resources.acquire(grid, preview);
    const refused = await resources.acquire(photo, rep(photo, "preview-128")).catch(error => error);
    expect(refused).toBeInstanceOf(ResourceRefusal);
    expect(refused.limiter).toBe("sourceGpu");
    held.release();
    const other = await resources.acquire(photo, rep(photo, "preview-128"));
    expect(b.textures[0].disposed).toBe(true);
    other.release();
  });

  it("cancels a load nobody wants any more and releases everything, and a late upload cannot come back", async () => {
    let finishUpload: (() => void) | null = null;
    const b = backend({
      uploadCube: () => new Promise(resolve => {
        finishUpload = () => resolve({ kind: "cube", gpuBytes: 0, disposed: false, dispose() { this.disposed = true; } } as FakeTexture);
      }),
    });
    const resources = createPanoramaResources(b.value, SETTINGS);
    const controller = new AbortController();
    const pending = resources.acquire(grid, rep(grid, "preview-64"), { signal: controller.signal });
    await vi.waitFor(() => expect(finishUpload).not.toBeNull());
    controller.abort();
    await expect(pending).rejects.toThrow();
    finishUpload!();
    await new Promise(resolve => setTimeout(resolve, 0));
    const stats = resources.stats();
    expect(stats.pools.sourceGpu.reserved).toBe(0);
    expect(stats.pools.decoded.reserved).toBe(0);
    expect(stats.pools.encoded.reserved).toBe(0);
    expect(stats.cachedSources).toBe(0);
    expect(b.open()).toBe(0);
  });

  it("stops a response over the response limit and refuses a file whose header differs from its declaration", async () => {
    const small = createPanoramaResources(backend().value, { ...SETTINGS, responseBytes: 1000 });
    const tooBig = await small.acquire(grid, rep(grid, "whole-2048")).catch(error => error);
    expect(tooBig).toBeInstanceOf(ResourceRefusal);
    expect(tooBig.limiter).toBe("response");
    expect(small.stats().rejectedResponses).toBeGreaterThan(0);

    const lying = createPanoramaResources(backend().value, SETTINGS);
    const wrong = { ...rep(grid, "preview-64"), faceSize: 32 } as ResolvedRepresentation;
    const refused = await lying.acquire(grid, wrong).catch(error => error);
    expect(refused.limiter).toBe("file");
    expect(refused.message).toContain("is 64×64 pixels, declared 32×32");
    expect(lying.stats().pools.sourceGpu.reserved).toBe(0);
  });

  it("refuses an immersion image wider than the image detail, and one the device cannot hold", async () => {
    const limited = createPanoramaResources(backend().value, { ...SETTINGS, immersionWidth: 1024 });
    await expect(limited.acquire(grid, rep(grid, "whole-2048"))).rejects.toMatchObject({ limiter: "immersionWidth" });
    const device = createPanoramaResources(backend({ maxTextureSide: () => 1024 }).value, SETTINGS);
    await expect(device.acquire(grid, rep(grid, "whole-2048"))).rejects.toMatchObject({ limiter: "device" });
  });

  it("drops every GPU source on device loss and loads again afresh", async () => {
    const b = backend();
    const resources = createPanoramaResources(b.value, SETTINGS);
    const before = await resources.acquire(grid, rep(grid, "preview-32"));
    resources.invalidateDevice();
    expect(b.textures[0].disposed).toBe(true);
    expect(resources.stats().pools.sourceGpu.reserved).toBe(0);
    const after = await resources.acquire(grid, rep(grid, "preview-32"));
    expect(after.key).not.toBe(before.key);
    expect(b.fetched).toHaveLength(12);
  });
});

describe("panorama resources with saved images", () => {
  const preview = rep(photo, "preview-64");
  const faces = preview.projection === "cube" ? Object.values(preview.faces) : [];

  it("keeps each header-checked file once and loads from what is kept without asking the network", async () => {
    const memory = memoryBackend();
    const media = createMediaStore({ open: async () => memory.backend, maxBytes: 8 * MIB });
    const first = backend({ media });
    const resources = createPanoramaResources(first.value, SETTINGS);
    (await resources.acquire(photo, preview)).release();
    await media.settled();
    expect(first.fetched).toHaveLength(6);
    expect(await media.inspect()).toMatchObject({ files: 6, bytes: preview.encodedBytes, added: { files: 6 } });
    expect(resources.stats()).toMatchObject({ reusedFiles: 0, transferredBytes: preview.encodedBytes });

    // A later visit: a new manager and a new store on the same storage.
    const later = createMediaStore({ open: async () => memory.backend, maxBytes: 8 * MIB });
    const second = backend({ media: later });
    const updates: ResourceProgress[] = [];
    const again = createPanoramaResources(second.value, SETTINGS, update => updates.push(update));
    const handle = await again.acquire(photo, preview);
    expect(second.fetched).toEqual([]);
    expect(second.textures).toHaveLength(1);
    expect(again.stats()).toMatchObject({ reusedFiles: 6, reusedBytes: preview.encodedBytes, transferredBytes: 0 });
    // Progress still reaches the whole, so the list's bar completes.
    expect(updates.at(-1)).toMatchObject({ state: "ready", receivedBytes: preview.encodedBytes });
    handle.release();
  });

  it("keeps another revision of the image apart, so a changed image is downloaded again", async () => {
    const memory = memoryBackend();
    const media = createMediaStore({ open: async () => memory.backend, maxBytes: 8 * MIB });
    const b = backend({ media });
    const resources = createPanoramaResources(b.value, SETTINGS);
    (await resources.acquire(photo, preview)).release();
    await media.settled();
    const changed: ResolvedAsset = { ...photo, revision: `${photo.revision}-next` };
    (await resources.acquire(changed, preview)).release();
    await media.settled();
    expect(b.fetched).toHaveLength(12);
    expect((await media.inspect()).groups.map(group => group.id).sort()).toEqual([mediaGroup(photo, preview).id, mediaGroup(changed, preview).id].sort());
  });

  it("forgets a kept file that is not the image and asks the network for it", async () => {
    const memory = memoryBackend();
    const media = createMediaStore({ open: async () => memory.backend, maxBytes: 8 * MIB });
    // Something else was kept under one face's name.
    media.put(mediaGroup(photo, preview), faces[0], new Uint8Array(64).fill(1), "image/jpeg");
    await media.settled();
    const b = backend({ media });
    const resources = createPanoramaResources(b.value, SETTINGS);
    (await resources.acquire(photo, preview)).release();
    await media.settled();
    expect(b.fetched).toHaveLength(6);
    expect(resources.stats().reusedFiles).toBe(0);
    // The good copy took its place.
    const kept = await media.get(mediaGroup(photo, preview), faces[0]);
    expect(kept?.bytes.byteLength).toBeGreaterThan(64);
  });

  it("forgets a kept file the browser cannot decode, so the next load asks the network", async () => {
    const memory = memoryBackend();
    const media = createMediaStore({ open: async () => memory.backend, maxBytes: 8 * MIB });
    const filling = backend({ media });
    (await createPanoramaResources(filling.value, SETTINGS).acquire(photo, preview)).release();
    await media.settled();
    let failing = true;
    const b = backend({ media, decode: async () => { if (failing) throw new Error("The source image could not be decoded."); return { close() {} } as unknown as ImageBitmap; } });
    const resources = createPanoramaResources(b.value, SETTINGS);
    await expect(resources.acquire(photo, preview)).rejects.toThrow(/could not be decoded/);
    await media.settled();
    expect(b.fetched).toEqual([]);
    expect((await media.inspect()).files).toBe(5);
    failing = false;
    (await resources.acquire(photo, preview)).release();
    expect(b.fetched).toHaveLength(1);
  });

  it("does not keep a file whose header is wrong", async () => {
    const memory = memoryBackend();
    const media = createMediaStore({ open: async () => memory.backend, maxBytes: 8 * MIB });
    const b = backend({ media, fetch: async () => new Response(new Uint8Array(256), { headers: { "content-type": "image/jpeg" } }) });
    await expect(createPanoramaResources(b.value, SETTINGS).acquire(photo, preview)).rejects.toBeInstanceOf(ResourceRefusal);
    await media.settled();
    expect((await media.inspect()).files).toBe(0);
  });
});
