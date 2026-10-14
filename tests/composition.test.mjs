import { describe, it, expect } from "vitest";
import { createPreviewSheetsCompositionOwner } from "../src/composition.ts";
import { createNodePreviewSheetsCompositionOwner } from "../node/composition.mjs";
import { verifyPreviewSheets, PreviewSheetVerificationLimitError } from "../node/preparation.mjs";
import { encodePng } from "@foss-earth/images/node";
import { CUBE_FACE_NAMES } from "@foss-earth/sphere-cubemap/core";
import { PREVIEW_SHEETS_EXTENSION } from "../src/core.ts";
const base = "https://fixture.invalid/final/media-r1/";
const sheetBytes = encodePng({ width: 12, height: 2, rgb: new Uint8Array(12 * 2 * 3).fill(80) });
const faceBytes = encodePng({ width: 2, height: 2, rgb: new Uint8Array(12).fill(80) });
const sheet = { id: "s", revision: "immutable-r1", mimeType: "image/png", width: 12, height: 2, encodedBytes: sheetBytes.length, url: "sheet.png" };
const entry = key => ({ value: { sheets: [{ ...sheet }] }, path: `$.children.${key}`, child: { key, baseUrl: base } });
const context = { limits: { assets: 4, children: 3 } };
function verificationFixture() {
  const record = { ...sheet, url: new URL(sheet.url, base).href }, files = new Map([[record.url, sheetBytes]]);
  const faces = Object.fromEntries(CUBE_FACE_NAMES.map(face => { const url = new URL(`${face}.png`, base).href; files.set(url, faceBytes); return [face, url]; }));
  const document = { extensions: { [PREVIEW_SHEETS_EXTENSION]: { sheets: [record] } }, assets: [{ id: "a", type: "panorama-image", representations: [{ id: "preview", projection: "cube", role: "preview", faceSize: 2, faces, extensions: { [PREVIEW_SHEETS_EXTENSION]: { id: "s", x: 0, y: 0 } } }] }] };
  return { record, files, document, read: url => files.get(url) ?? null };
}
describe("production structural preview composition", () => {
  it("deduplicates shared immutable sheets and resolves each final base", () => {
    const owner = createPreviewSheetsCompositionOwner(), merged = owner.composeDocument([entry("west"), entry("east")], context);
    expect(merged.document.sheets).toEqual([{ ...sheet, url: new URL(sheet.url, base).href }]);
    const output = owner.rewrite({ id: "s", x: 0, y: 0 }, { scope: "representation", path: "$.place", child: entry("east").child, state: merged.state, record: { projection: "cube", faceSize: 2, sheet: { runtime: true } } });
    expect(output).toEqual({ id: "s", x: 0, y: 0 }); expect(JSON.stringify(merged.document)).not.toMatch(/runtime|mappings/);
    expect([...owner.files({ extensionData: new Map([[PREVIEW_SHEETS_EXTENSION, new Map([["s", merged.document.sheets[0]]])]]) })]).toHaveLength(1);
  });
  it("fails identity conflicts and honors explicit reversible aliases", () => {
    const other = entry("east"); other.value.sheets[0].revision = "other";
    expect(() => createPreviewSheetsCompositionOwner().composeDocument([entry("west"), other], context)).toThrow(/collision/);
    const owner = createPreviewSheetsCompositionOwner({ aliases: { east: { s: "east-s" } } }), merged = owner.composeDocument([entry("west"), other], context);
    expect(merged.document.sheets.map(sheet => sheet.id)).toEqual(["s", "east-s"]);
    expect(owner.rewrite({ id: "s", x: 0, y: 0 }, { scope: "representation", path: "$.place", child: other.child, state: merged.state, record: { projection: "cube", faceSize: 2 } })).toEqual({ id: "east-s", x: 0, y: 0 });
    expect(() => createPreviewSheetsCompositionOwner({ aliases: { absent: { s: "new" } } }).composeDocument([entry("west")], context)).toThrow(/unknown child/);
    expect(() => createPreviewSheetsCompositionOwner({ aliases: { west: { absent: "new" } } }).composeDocument([entry("west")], context)).toThrow(/unknown sheet/);
  });
  it("rejects non-reversible aliases, dropped optional fields and missing/invalid places", () => {
    const two = entry("west"); two.value.sheets.push({ ...sheet, id: "other" });
    expect(() => createPreviewSheetsCompositionOwner({ aliases: { west: { other: "s" } } }).composeDocument([two], context)).toThrow(/reversible/);
    const invalid = entry("west"); invalid.value.sheets[0].future = 1;
    expect(() => createPreviewSheetsCompositionOwner().composeDocument([invalid], context)).toThrow(/not a property/);
    const owner = createPreviewSheetsCompositionOwner(), merged = owner.composeDocument([entry("west")], context), rewriteContext = { scope: "representation", path: "$.place", child: entry("west").child, state: merged.state, record: { projection: "cube", faceSize: 2 } };
    expect(() => owner.rewrite({ id: "s", x: 0, y: 0, discarded: true }, rewriteContext)).toThrow(/not a property/);
    expect(() => owner.rewrite({ id: "s", x: 1, y: 0 }, rewriteContext)).toThrow(/outside/);
    expect(() => owner.rewrite({ id: "missing", x: 0, y: 0 }, rewriteContext)).toThrow(/not a sheet/);
  });
  it("bounds sheets/children and cancels before composition", () => {
    expect(() => createPreviewSheetsCompositionOwner().composeDocument([entry("west"), entry("east")], { limits: { assets: 4, children: 1 } })).toThrow(/child limit/);
    const other = entry("east"); other.value.sheets[0].id = "other";
    expect(() => createPreviewSheetsCompositionOwner({ maxSheets: 1 }).composeDocument([entry("west"), other], context)).toThrow(/sheet limit/);
    const cancel = new AbortController(); cancel.abort(new Error("cancel composition"));
    expect(() => createPreviewSheetsCompositionOwner().composeDocument([entry("west")], { ...context, signal: cancel.signal })).toThrow(/cancel composition/);
  });
});
describe("production finite preview content verification", () => {
  it("uses actual public Node owner with unchanged original six files", () => {
    const fixture = verificationFixture(), owner = createNodePreviewSheetsCompositionOwner();
    const scene = { assets: new Map([["a", fixture.document.assets[0]]]), extensionData: new Map([[PREVIEW_SHEETS_EXTENSION, new Map([["s", fixture.record]])]]) };
    expect([...owner.verifyFiles(scene, fixture.read, {})]).toEqual([]);
    const verified = verifyPreviewSheets(fixture.document, fixture.read);
    expect(verified.stats.files).toBe(7); expect(verified.stats.decodedPixels).toBe(48); expect(verified.stats.workPixels).toBe(72);
    expect(verified.stats.retainedSheetBytes).toBe(96); expect(verified.stats.peakWorkingBytes).toBeGreaterThan(96);
    expect(Object.keys(fixture.document.assets[0].representations[0].faces)).toEqual(CUBE_FACE_NAMES);
  });
  it("rejects wrong faces/cells, byte drift and unavailable sheets", () => {
    const fixture = verificationFixture(), rep = fixture.document.assets[0].representations[0];
    fixture.files.set(rep.faces.px, encodePng({ width: 2, height: 2, rgb: new Uint8Array(12).fill(250) }));
    expect(verifyPreviewSheets(fixture.document, fixture.read).problems[0].message).toMatch(/not the same picture/);
    rep.extensions[PREVIEW_SHEETS_EXTENSION].x = 1;
    expect(verifyPreviewSheets(fixture.document, fixture.read).problems[0].message).toMatch(/inside/);
    fixture.record.encodedBytes++;
    expect(verifyPreviewSheets(fixture.document, fixture.read).problems[0].message).toMatch(/byte length/);
    expect(verifyPreviewSheets(fixture.document, () => null).problems.map(p => p.message).join()).toMatch(/unavailable/);
  });
  it.each(["maxMemoryBytes", "maxDecodedPixels", "maxWorkPixels", "maxFiles", "maxInputBytes", "maxEncodedBytes"])("stops rather than reporting success at %s admission", key => {
    const fixture = verificationFixture(); expect(() => verifyPreviewSheets(fixture.document, fixture.read, 28, { [key]: 1 })).toThrow(PreviewSheetVerificationLimitError);
  });
  it("charges all retained sheets plus the current decoder and temporary face", () => {
    const fixture = verificationFixture(); fixture.document.extensions[PREVIEW_SHEETS_EXTENSION].sheets.push({ ...fixture.record, id: "second" });
    const good = verifyPreviewSheets(fixture.document, fixture.read); expect(good.stats.retainedSheetBytes).toBe(192);
    expect(() => verifyPreviewSheets(fixture.document, fixture.read, 28, { maxMemoryBytes: good.stats.peakWorkingBytes - 1 })).toThrow(PreviewSheetVerificationLimitError);
  });
  it("checks cancellation after a host read and before the next decode", () => {
    const fixture = verificationFixture(), cancel = new AbortController(); let reads = 0;
    expect(() => verifyPreviewSheets(fixture.document, url => { reads++; cancel.abort(new Error("cancel verification")); return fixture.read(url); }, 28, { signal: cancel.signal })).toThrow(/cancel verification/);
    expect(reads).toBe(1);
  });
});
