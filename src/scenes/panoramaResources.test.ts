import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { MIB, representationGpuBytes } from "./budget";
import type { ResolvedAsset, ResolvedRepresentation } from "./format";
import { createPanoramaResources, ResourceRefusal, type GpuSource, type ResourceBackend, type ResourceSettings } from "./panoramaResources";
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
  responseBytes: 16 * MIB, requests: 4, decodes: 1, timeoutMs: 30_000, immersionMaxSide: 8192,
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

  it("refuses an immersion side over the limit and one the device cannot hold", async () => {
    const limited = createPanoramaResources(backend().value, { ...SETTINGS, immersionMaxSide: 1024 });
    await expect(limited.acquire(grid, rep(grid, "whole-2048"))).rejects.toMatchObject({ limiter: "immersionMaxSide" });
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
