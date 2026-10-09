import type { ImageFile, ImageOperationScope, ImageSessionBroker, MediaGroup } from "@foss-earth/images";
import { ResourceCapacityError } from "@foss-earth/images";
import type { EncodedImageFile, HeldDecodedImage } from "@foss-earth/images/browser";
import { type CubeFaceName } from "@foss-earth/cubemap/core";
import { sheetFaceRectangles, sheetMediaGroup, sheetSourceKey, type ResolvedSheetPlace, type SheetRecord } from "./core.js";

/** Sources only. Cubemap's uploader owns textures; the host owns rendering. */
export interface CubeFaceSource {
  readonly faces: Readonly<Record<CubeFaceName, ImageBitmap>>;
  readonly from: "sheet" | "faces";
  /** Optional for foreign fallback sources. Sheet crops implement a reliable
   * bitmap/decoded-charge hold: acquire before upload, release after native input
   * use and late-output cleanup. Closing blocks new holds and waits for old ones. */
  retain?(): () => void;
  /** Idempotent. Releases all decoded crop allocations. */
  close(): void;
}
export interface PreviewSheetFile extends ImageFile {
  readonly identity: { readonly id: string; readonly revision: string };
  readonly mediaGroup: MediaGroup;
}
export interface PreviewSheetPorts {
  /** The host's existing session broker, shared with every representation. */
  broker: ImageSessionBroker;
  /** Supply common cache/transport here; never construct a sheet-only cache. */
  obtain(file: PreviewSheetFile, declaredBytes: number, scope: ImageOperationScope): Promise<EncodedImageFile>;
  /** Supply common validation/accounting/queue plus reliable HeldDecodedImage.retain; legacy absence falls back to original faces. */
  decode(file: EncodedImageFile, declared: ImageFile, scope: ImageOperationScope): Promise<HeldDecodedImage>;
  /** Optional existing browser codec; no crop support means original-face fallback. */
  crop?(image: ImageBitmap, x: number, y: number, width: number, height: number): Promise<ImageBitmap>;
}
export interface AcquireCubeFacesOptions {
  sheet?: ResolvedSheetPlace;
  faceSize: number;
  label: string;
  enabled: boolean;
  /** The dedicated cube operation, from the same host broker. */
  scope: ImageOperationScope;
  /** Cubemap's six-original-file acquisition, with the same operation scope. */
  fallback(): Promise<CubeFaceSource>;
}
export interface PreviewSheetSources {
  acquireCubeFaces(options: AcquireCubeFacesOptions): Promise<CubeFaceSource>;
  stats(): { activeSheets: number; users: number; failedSheets: number };
  dispose(): void;
}
interface SheetUse {
  key: string;
  scope: ImageOperationScope;
  users: number;
  image: Promise<ImageBitmap>;
  held: HeldDecodedImage | null;
  closed: boolean;
  ended: boolean;
}

/** One explicit registry per host image session; sharing lasts through crop work. */
export function createPreviewSheetSources(ports: PreviewSheetPorts): PreviewSheetSources {
  const uses = new Map<string, SheetUse>();
  const failed = new Set<string>();
  let failedGeneration = ports.broker.generation();
  const controller = new AbortController();
  let disposed = false;
  function currentFailures(): Set<string> {
    const generation = ports.broker.generation();
    if (generation !== failedGeneration) { failed.clear(); failedGeneration = generation; }
    return failed;
  }
  function failSheet(key: string, generation: number): void {
    const failures = currentFailures();
    if (generation === failedGeneration) failures.add(key);
  }
  function closeUse(use: SheetUse): void {
    use.closed = true;
    if (uses.get(use.key) === use) uses.delete(use.key);
    // A browser crop is not abortable. Keep its input sheet and charge until
    // every crop user has actually returned, including registry disposal.
    if (use.ended || (use.held && use.users > 0)) return;
    use.ended = true;
    const image = use.held; use.held = null;
    const errors: unknown[] = [];
    try { image?.close(); } catch (error) { errors.push(error); }
    try { use.scope.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Preview sheet source disposal failed.");
  }
  async function load(sheet: SheetRecord, use: SheetUse): Promise<ImageBitmap> {
    const file: PreviewSheetFile = { url: sheet.url, mimeType: sheet.mimeType, width: sheet.width, height: sheet.height, identity: { id: sheet.id, revision: sheet.revision }, mediaGroup: sheetMediaGroup(sheet) };
    let encoded: EncodedImageFile | null = null;
    let primary: { error: unknown } | undefined;
    let result: { image: ImageBitmap } | { error: unknown };
    try {
      try {
        use.scope.signal.throwIfAborted();
        encoded = await ports.obtain(file, sheet.encodedBytes, use.scope);
        use.scope.signal.throwIfAborted();
        const decoded = await ports.decode(encoded, file, use.scope);
        // A codec that completes after the last user leaves is still closed.
        if (use.closed || !use.scope.isCurrent()) {
          let stale: unknown = new Error("Stale preview sheet decode.");
          try { use.scope.signal.throwIfAborted(); } catch (error) { stale = error; }
          try { decoded.close(); }
          catch (cleanup) { throw new AggregateError([stale, cleanup], "Stale preview sheet decode and disposal failed."); }
          throw stale;
        }
        use.held = decoded;
        result = { image: decoded.image };
      } catch (error) {
        const cancelled = use.closed || !use.scope.isCurrent();
        if (!cancelled && !(error instanceof ResourceCapacityError)) failSheet(use.key, use.scope.generation);
        primary = { error };
        try { closeUse(use); }
        catch (cleanup) { primary.error = new AggregateError([error, cleanup], "Preview sheet load and disposal failed."); }
        throw primary.error;
      }
    } catch (error) {
      result = { error };
    }
    // Resolve the operation only after releasing encoded input. A cleanup
    // failure retains the operation error rather than replacing it in finally.
    try { encoded?.release(); }
    catch (cleanup) {
      if (primary) throw new AggregateError([primary.error, cleanup], "Preview sheet load and encoded input disposal failed.");
      throw cleanup;
    }
    if ("error" in result) throw result.error;
    return result.image;
  }
  function hold(sheet: SheetRecord): { image: Promise<ImageBitmap>; retainInput(): (() => void) | null; release(): void } {
    const key = sheetSourceKey(sheet);
    let use = uses.get(key);
    // A prior native crop may still hold the old generation's input. Retire
    // sharing without closing those pixels; its last crop releases them later.
    if (use && (use.closed || !use.scope.isCurrent())) { closeUse(use); use = undefined; }
    if (!use) {
      const created: SheetUse = { key, scope: ports.broker.scope(), users: 0, image: null as unknown as Promise<ImageBitmap>, held: null, closed: false, ended: false };
      // Install the real shared promise before invoking even a synchronous
      // supplied port: that port may reenter acquisition for this same sheet.
      uses.set(key, created);
      created.image = Promise.resolve().then(() => load(sheet, created));
      void created.image.catch(() => {});
      use = created;
    }
    const held = use;
    held.users += 1;
    let released = false;
    return { image: held.image, retainInput: () => held.held?.retain?.() ?? null, release() { if (released) return; released = true; held.users -= 1; if (held.users === 0) closeUse(held); } };
  }
  async function acquireCubeFaces(options: AcquireCubeFacesOptions): Promise<CubeFaceSource> {
    if (disposed) throw new Error("The preview sheet registry is disposed.");
    const { scope, sheet } = options;
    function requireCurrent(): void {
      if (disposed) throw new Error("The preview sheet registry is disposed.");
      scope.signal.throwIfAborted();
      if (!scope.isCurrent()) throw new Error("Stale preview sheet acquisition.");
    }
    requireCurrent();
    async function originalFaces(): Promise<CubeFaceSource> {
      requireCurrent();
      const source = await options.fallback();
      if (disposed || !scope.isCurrent()) {
        let stale: unknown = new Error("Stale original cube faces.");
        try { scope.signal.throwIfAborted(); } catch (error) { stale = error; }
        try { source.close(); }
        catch (cleanup) { throw new AggregateError([stale, cleanup], "Stale original cube faces and disposal failed."); }
        throw stale;
      }
      if (!scope.adopt({ dispose: () => source.close() })) { scope.signal.throwIfAborted(); throw new Error("Stale original cube faces."); }
      if (disposed || !scope.isCurrent()) { source.close(); requireCurrent(); }
      return source;
    }
    if (!options.enabled || !sheet || !ports.crop || currentFailures().has(sheetSourceKey(sheet))) return originalFaces();
    if (!Number.isSafeInteger(options.faceSize) || options.faceSize < 1) throw new RangeError("A preview face size must be a positive whole number.");
    const rectangles = sheetFaceRectangles(sheet, options.faceSize);
    if (rectangles.some(rect => rect.x + rect.width > sheet.width || rect.y + rect.height > sheet.height)) throw new RangeError("The cube lies outside its preview sheet; validate the optional place first.");
    const held = hold(sheet);
    const faces: Partial<Record<CubeFaceName, ImageBitmap>> = {};
    const reservations: ReturnType<ImageOperationScope["reserve"]>[] = [];
    let releaseInput: (() => void) | null = null;
    let sheetReleased = false;
    const releaseSheet = (): void => {
      if (sheetReleased) return;
      sheetReleased = true;
      const retained = releaseInput; releaseInput = null;
      const errors: unknown[] = [];
      try { held.release(); } catch (error) { errors.push(error); }
      try { retained?.(); } catch (error) { errors.push(error); }
      if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, "Preview sheet retained input disposal failed.");
    };
    let closed = false, closing = false, inputUsers = 0;
    function finishClose(): void {
      if (closed || !closing || inputUsers > 0) return;
      closed = true;
      const errors: unknown[] = [];
      for (const face of Object.values(faces)) { try { face.close(); } catch (error) { errors.push(error); } }
      for (const reservation of reservations) { try { reservation.release(); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, "Preview sheet crop disposal failed.");
    }
    function close(): void { closing = true; finishClose(); }
    function retain(): () => void {
      if (closing || closed) throw new Error("Cannot retain closing preview sheet crops.");
      inputUsers += 1;
      let released = false;
      return () => { if (released) return; released = true; inputUsers -= 1; finishClose(); };
    }
    function finishInput(): void {
      try { releaseSheet(); }
      catch (error) {
        // Cleanup failure cannot publish faces prepared from this input.
        try { close(); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Preview sheet input/output disposal failed."); }
        throw error;
      }
    }
    let publishing = false;
    let priorFailure: { error: unknown } | undefined;
    let result: { value: CubeFaceSource | Promise<CubeFaceSource> } | { error: unknown };
    try {
      try {
        const image = await awaitCurrent(held.image, AbortSignal.any([scope.signal, controller.signal]));
        if (disposed) throw new Error("The preview sheet registry is disposed.");
        scope.signal.throwIfAborted();
        // Promise completion does not prove native input capture. The explicit
        // common hold keeps pixels/bitmap alive even when the entire broker ends.
        releaseInput = held.retainInput();
        if (!releaseInput) {
          releaseSheet();
          result = { value: originalFaces() };
        } else {
          // Direct grants outlive scope abort while an unabortable native crop is
          // running. They transfer to the returned face source, never to a timer.
          for (const rect of rectangles) {
            const grant = ports.broker.pools.reserve("decoded", 4 * rect.width * rect.height, `${options.label} ${rect.face} decoded`);
            if (!grant.ok) throw new ResourceCapacityError(grant.pool, grant.reason);
            reservations.push(grant.reservation);
          }
          for (const rect of rectangles) {
            faces[rect.face] = await ports.crop(image, rect.x, rect.y, rect.width, rect.height);
            requireCurrent();
            if (faces[rect.face]!.width !== rect.width || faces[rect.face]!.height !== rect.height) throw new Error("Preview crop dimensions do not match the face.");
          }
          // Input closure and pool-availability observers can synchronously end the
          // operation. Finish that work before transferring any face ownership.
          publishing = true;
          finishInput();
          requireCurrent();
          if (!scope.adopt({ dispose: close })) { scope.signal.throwIfAborted(); throw new Error("Stale preview sheet crops."); }
          requireCurrent();
          result = { value: { faces: faces as Record<CubeFaceName, ImageBitmap>, from: "sheet", retain, close } };
        }
      } catch (error) {
        priorFailure = { error };
        try { close(); }
        catch (cleanup) { priorFailure.error = new AggregateError([error, cleanup], "Preview sheet acquisition/output disposal failed."); throw priorFailure.error; }
        if (publishing || !scope.isCurrent() || disposed) throw error;
        if (!(error instanceof ResourceCapacityError)) failSheet(sheetSourceKey(sheet), scope.generation);
        // Original-face work may reserve synchronously; return sheet room first.
        releaseSheet();
        result = { value: originalFaces() };
      }
    } catch (error) {
      result = { error };
    }
    // Native input and crop cleanup finishes before the result transfers.
    // Keep fallback promises unawaited here, as in the original return path.
    try { finishInput(); }
    catch (error) {
      if (priorFailure) throw new AggregateError([priorFailure.error, error], "Preview sheet acquisition/input disposal failed.");
      throw error;
    }
    if ("error" in result) throw result.error;
    return result.value;
  }

  return {
    acquireCubeFaces,
    stats: () => ({ activeSheets: uses.size, users: [...uses.values()].reduce((total, use) => total + use.users, 0), failedSheets: currentFailures().size }),
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort(new Error("The preview sheet registry is disposed."));
      const errors: unknown[] = [];
      for (const use of [...uses.values()]) { try { closeUse(use); } catch (error) { errors.push(error); } }
      if (errors.length) throw new AggregateError(errors, "Preview sheet registry disposal failed.");
    },
  };
}

/** One cancelled cube stops waiting immediately, while another keeps the shared decode alive. */
async function awaitCurrent<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
