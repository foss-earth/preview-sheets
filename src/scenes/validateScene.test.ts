import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PREVIEW_SHEETS_EXTENSION, type ValidatedScene } from "./format";
import { validateScene } from "./validateScene";

const EXAMPLE_TEXT = readFileSync(new URL("./fixtures/proposal-example.scene.json", import.meta.url), "utf8");
const BASE = "https://scenes.example/neutral/scene.json";

function example(): unknown {
  return JSON.parse(EXAMPLE_TEXT);
}

const REMOVE = Symbol("remove");

/** The value at a dotted path such as "entities.0.marker"; array indices are keys too. */
function get(doc: unknown, path: string): unknown {
  if (path === "") return doc;
  return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], doc);
}

/** Sets, or with REMOVE deletes, the value at a dotted path: documents are edited into invalid shapes on purpose. */
function edit(doc: unknown, path: string, value: unknown): void {
  const keys = path.split(".");
  const parent = get(doc, keys.slice(0, -1).join(".")) as Record<string, unknown>;
  const key = keys.at(-1)!;
  if (value === REMOVE) delete parent[key];
  else parent[key] = value;
}

function push(doc: unknown, path: string, value: unknown): void {
  (get(doc, path) as unknown[]).push(value);
}

function errorsOf(input: unknown, baseUrl: string | null = BASE): string[] {
  const result = validateScene(input, { baseUrl });
  return result.ok ? [] : result.errors.map(error => `${error.path}: ${error.message}`);
}

/** A preview sheet, and the proposal's example with it in the scene's extension and a place in its first cube's. */
const SHEET = { id: "previews", revision: "s1", mimeType: "image/jpeg", width: 768, height: 256, encodedBytes: 5000, url: "media/previews.jpg" };
const SHEET_CUBE = (get(example(), "assets.0.representations") as { projection: string }[]).findIndex(rep => rep.projection === "cube");
const CUBE_SIZE = (get(example(), `assets.0.representations.${SHEET_CUBE}`) as { faceSize: number }).faceSize;

function withSheet(place: unknown, sheets: unknown = [SHEET]): unknown {
  const doc = example();
  edit(doc, "extensions", { [PREVIEW_SHEETS_EXTENSION]: { sheets } });
  edit(doc, `assets.0.representations.${SHEET_CUBE}.extensions`, { [PREVIEW_SHEETS_EXTENSION]: place });
  return doc;
}

function sheetScene(place: unknown, sheets?: unknown): { scene: ValidatedScene } {
  const result = validateScene(withSheet(place, sheets), { baseUrl: BASE });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return { scene: result.scene };
}

const sheetCube = (scene: ValidatedScene) => [...scene.assets.values()][0].representations.find(rep => rep.projection === "cube")!;

describe("validateScene", () => {
  it("accepts the proposal's two-panorama example and resolves its media against the manifest", () => {
    const result = validateScene(EXAMPLE_TEXT, { baseUrl: BASE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { scene } = result;
    expect([...scene.panoramas.keys()]).toEqual(["garden", "courtyard"]);
    expect(scene.initialPanorama).toBe("garden");
    const garden = scene.assets.get("garden-image")!;
    const preview = garden.representations.find(entry => entry.role === "preview");
    expect(preview?.projection === "cube" && preview.faces.px).toBe("https://scenes.example/neutral/media/garden/128/px.jpg");
    expect(scene.panoramas.get("garden")!.capture.height).toBeNull();
    expect(scene.panoramas.get("courtyard")!.capture.height).toEqual({ meters: 2, datum: "WGS84-ellipsoid", source: "synthetic fixture" });
    expect(scene.groups[0].members).toEqual(["garden", "courtyard"]);
  });

  it("keeps whether an image's north is set, and leaves it out when the scene does not say", () => {
    const doc = example();
    edit(doc, "entities.0.imagePose.aligned", false);
    const result = validateScene(doc, { baseUrl: BASE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.panoramas.get("garden")!.imagePose.aligned).toBe(false);
    expect("aligned" in result.scene.panoramas.get("courtyard")!.imagePose).toBe(false);
  });

  it("fails an unknown version before reading anything else", () => {
    const doc = example();
    edit(doc, "version", 2);
    edit(doc, "assets", "not even an array");
    expect(errorsOf(doc)).toEqual([expect.stringContaining("$.version: version 2 is not supported")]);
  });

  it("fails unknown properties of known records with their paths", () => {
    const doc = example();
    edit(doc, "entities.0.marker.height", 4);
    edit(doc, "assets.1.representations.1.tiles", []);
    const errors = errorsOf(doc);
    expect(errors).toContainEqual(expect.stringContaining("$.entities[0].marker.height"));
    expect(errors).toContainEqual(expect.stringContaining("$.assets[1].representations[1].tiles"));
  });

  it("checks ranges, ids, dimensions and faces", () => {
    const doc = example();
    edit(doc, "entities.0.capture.latitudeDeg", 91);
    edit(doc, "entities.0.capture.longitudeDeg", 180);
    edit(doc, "entities.1.imagePose.rollDeg", -180);
    edit(doc, "entities.0.imagePose.aligned", "yes");
    edit(doc, "entities.1.initialView.verticalFovDeg", 180);
    edit(doc, "assets.0.representations.1.width", 4000);
    edit(doc, "assets.1.representations.0.faces.nz", REMOVE);
    edit(doc, "assets.1.id", "bad id");
    const errors = errorsOf(doc).join("\n");
    expect(errors).toContain("$.entities[0].capture.latitudeDeg: must be in [-90, 90]");
    expect(errors).toContain("$.entities[0].capture.longitudeDeg: must be in [-180, 180)");
    expect(errors).toContain("$.entities[1].imagePose.rollDeg: must be in (-180, 180]");
    expect(errors).toContain("$.entities[0].imagePose.aligned: must be true or false");
    expect(errors).toContain("$.entities[1].initialView.verticalFovDeg: must be in (0, 180)");
    expect(errors).toContain("$.assets[0].representations[1].width: must be twice the height");
    expect(errors).toContain("$.assets[1].representations[0].faces.nz: is missing");
    expect(errors).toContain("$.assets[1].id: must be a nonempty ASCII id");
  });

  it("reads a tiled cube, resolving its folder against the manifest", () => {
    const doc = example();
    const tiled = { id: "eac-tiles", role: "immersion", projection: "tiled-cube", warp: "equi-angular", mimeType: "image/jpeg", encodedBytes: 600, faceSize: 768, tileSize: 192, gutter: 1, levelBytes: [100, 200, 300], url: "media/garden/eac-tiles/" };
    push(doc, "assets.0.representations", tiled);
    const result = validateScene(doc, { baseUrl: BASE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const representation = result.scene.assets.get("garden-image")!.representations.find(entry => entry.id === "eac-tiles");
    expect(representation).toEqual({ ...tiled, url: "https://scenes.example/neutral/media/garden/eac-tiles/" });
  });

  it("checks a tiled cube's levels, sizes, folder and role", () => {
    const tiled = (changes: Record<string, unknown>) => {
      const doc = example();
      push(doc, "assets.0.representations", { id: "tiles", role: "immersion", projection: "tiled-cube", warp: "gnomonic", mimeType: "image/jpeg", encodedBytes: 600, faceSize: 768, tileSize: 192, gutter: 1, levelBytes: [100, 200, 300], url: "tiles/", ...changes });
      return errorsOf(doc);
    };
    const path = "$.assets[0].representations[2]";
    expect(tiled({})).toEqual([]);
    expect(tiled({ faceSize: 1536 })).toEqual([`${path}.faceSize: must be the tile size times 2 to the number of levels less one: 768`]);
    expect(tiled({ levelBytes: [100, 200, 299] })).toEqual([`${path}.levelBytes: must add up to encodedBytes`]);
    expect(tiled({ url: "tiles" })).toEqual([`${path}.url: must name the tiles' folder, ending with "/"`]);
    expect(tiled({ gutter: 96 })).toEqual([`${path}.gutter: must be a whole number of texels, at least 0 and less than half the tile size`]);
    expect(tiled({ role: "preview" })).toContain(`${path}.role: must be "immersion": a tiled cube shows over its asset's preview cube, so it cannot be one`);
    expect(tiled({ warp: "fisheye" })).toEqual([`${path}.warp: must be one of "equi-angular", "gnomonic"`]);
    expect(tiled({ faces: {} })).toEqual([`${path}.faces: is not a property of this record; namespaced additions belong in "extensions"`]);
  });

  it("skips a representation of a later projection with a warning, so the asset's others still show", () => {
    const doc = example();
    push(doc, "assets.0.representations", { id: "octahedral", role: "immersion", projection: "octahedral", mimeType: "image/jpeg", encodedBytes: 5, url: "o.jpg", side: 1024 });
    const result = validateScene(doc, { baseUrl: BASE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.assets.get("garden-image")!.representations.map(entry => entry.id)).not.toContain("octahedral");
    expect(result.scene.warnings).toContainEqual({ path: "$.assets[0].representations[2].projection", message: "projection \"octahedral\" is not supported by this loader; this representation is skipped" });
  });

  it("resolves a preview sheet into each cube that names its place in it", () => {
    const { scene } = sheetScene({ id: "previews", x: 0, y: 256 - CUBE_SIZE });
    expect([...scene.sheets.values()]).toEqual([{ ...SHEET, url: "https://scenes.example/neutral/media/previews.jpg" }]);
    expect(sheetCube(scene)).toMatchObject({ sheet: { id: "previews", revision: "s1", url: "https://scenes.example/neutral/media/previews.jpg", width: 768, height: 256, x: 0, y: 256 - CUBE_SIZE } });
    expect(scene.warnings).toEqual([]);
    // A scene may say a loader has to read sheets, though its cubes' own files make that needless.
    const required = withSheet({ id: "previews", x: 0, y: 0 });
    edit(required, "requiredExtensions", [PREVIEW_SHEETS_EXTENSION]);
    expect(errorsOf(required)).toEqual([]);
    // A scene with no sheets has none, and its cubes no place.
    const plain = validateScene(EXAMPLE_TEXT, { baseUrl: BASE });
    expect(plain.ok && plain.scene.sheets.size).toBe(0);
  });

  it("leaves a sheet or a place that is wrong unused, with a warning, and loads the scene: the cube's own files are there", () => {
    const place = `$.assets[0].representations[${SHEET_CUBE}].extensions.${PREVIEW_SHEETS_EXTENSION}`;
    const sheets = `$.extensions.${PREVIEW_SHEETS_EXTENSION}.sheets`;
    const unusedPlace = (given: unknown, listed: unknown = [SHEET]): string[] => {
      const { scene } = sheetScene(given, listed);
      expect(sheetCube(scene)).not.toHaveProperty("sheet");
      expect(sheetCube(scene)).toMatchObject({ faces: { px: expect.stringMatching(/px\.jpg$/) } });
      return scene.warnings.map(warning => `${warning.path}: ${warning.message}`);
    };
    const files = "; this cube loads from its own files";
    expect(unusedPlace({ id: "other", x: 0, y: 0 })).toEqual([`${place}.id: names "other", which is not a sheet of this scene${files}`]);
    expect(unusedPlace({ id: "previews", x: 768 - 6 * CUBE_SIZE + 1, y: 0 })).toEqual([`${place}: puts six ${CUBE_SIZE} px faces at (${768 - 6 * CUBE_SIZE + 1}, 0), outside the 768 × 256 px sheet "previews"${files}`]);
    expect(unusedPlace({ id: "previews", x: 0, y: 256 - CUBE_SIZE + 1 })).toHaveLength(1);
    expect(unusedPlace({ id: "previews", x: 0.5, y: -1 })).toEqual([`${place}.x: must be a whole number, 0 or more${files}`, `${place}.y: must be a whole number, 0 or more${files}`]);
    // A place written for a later loader: this one cannot tell what the property changes, so it does not guess.
    expect(unusedPlace({ id: "previews", x: 0, y: 0, face: "px" })).toEqual([expect.stringMatching(/\.face: is not a property of this record.*; this cube loads from its own files$/)]);
    // A sheet that is wrong is not one of the scene's, and the cube that names it says so.
    expect(unusedPlace({ id: "previews", x: 0, y: 0 }, [{ ...SHEET, width: 0, revision: "" }])).toEqual([
      expect.stringMatching(/sheets\[0\]\.revision: .*; this preview sheet is not used$/),
      `${sheets}[0].width: must be a positive whole number; this preview sheet is not used`,
      `${place}.id: names "previews", which is not a sheet of this scene${files}`,
    ]);
    expect(unusedPlace({ id: "previews", x: 0, y: 0 }, "previews.jpg")).toEqual([`${sheets}: must be an array; this preview sheet is not used`, expect.stringContaining("which is not a sheet of this scene")]);

    // The second sheet of one id is left out; the first serves the cube.
    const twice = sheetScene({ id: "previews", x: 0, y: 0 }, [SHEET, { ...SHEET, url: "media/other.jpg" }]).scene;
    expect(twice.warnings).toEqual([{ path: `${sheets}[1].id`, message: "repeats sheet id \"previews\"; this preview sheet is not used" }]);
    expect(sheetCube(twice)).toMatchObject({ sheet: { url: "https://scenes.example/neutral/media/previews.jpg" } });
  });

  it("refuses sheets written as the scene's and the cube's own properties, as scenes of 2026-10-03 had them", () => {
    const doc = example();
    edit(doc, "sheets", [SHEET]);
    edit(doc, `assets.0.representations.${SHEET_CUBE}.sheet`, { id: "previews", x: 0, y: 0 });
    expect(errorsOf(doc)).toEqual([
      "$.sheets: is not a property of this record; namespaced additions belong in \"extensions\"",
      `$.assets[0].representations[${SHEET_CUBE}].sheet: is not a property of this record; namespaced additions belong in "extensions"`,
    ]);
  });

  it("needs a preview cube, unique ids and existing references", () => {
    const doc = example();
    edit(doc, "assets.0.representations", [get(doc, "assets.0.representations.1")]);
    edit(doc, "entities.1.id", "garden");
    edit(doc, "groups.0.members", ["garden", "nowhere"]);
    edit(doc, "initialPanorama", "nowhere");
    const errors = errorsOf(doc).join("\n");
    expect(errors).toContain("$.assets[0].representations: needs at least one complete preview cube");
    expect(errors).toContain("$.entities[1].id: repeats entity id \"garden\"");
    expect(errors).toContain("$.groups[0].members[1]: refers to \"nowhere\"");
    expect(errors).toContain("$.initialPanorama: names \"nowhere\"");
  });

  it("refuses capture-relative placement without a known height", () => {
    const doc = example();
    edit(doc, "entities.0.marker.mode", "capture-relative");
    expect(errorsOf(doc).join("\n")).toContain("capture-relative placement needs a known capture height");
  });

  it("needs a base URL for relative media, and refuses other schemes and credentials", () => {
    expect(errorsOf(example(), null).join("\n")).toContain("is relative, and the scene has no base URL");
    const doc = example();
    edit(doc, "assets.0.representations.1.url", "file:///Users/someone/garden.jpg");
    edit(doc, "assets.1.representations.1.url", "https://user:secret@example.com/pano.jpg");
    const errors = errorsOf(doc).join("\n");
    expect(errors).toContain("must resolve to an http or https URL");
    expect(errors).toContain("must not carry credentials");
  });

  it("keeps unknown entity types as unsupported list items, and fails required ones", () => {
    const doc = example();
    push(doc, "entities", { id: "statue", type: "model", required: false });
    push(doc, "entities.0.links", { id: "to-statue", target: "statue", label: "Statue" });
    const result = validateScene(doc, { baseUrl: BASE });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scene.unsupported.get("statue")?.type).toBe("model");
      expect(result.scene.entityOrder).toContain("statue");
      expect(result.scene.warnings.map(warning => warning.path)).toContain("$.entities[0].links[1].target");
    }
    edit(doc, "entities.2.required", true);
    expect(errorsOf(doc).join("\n")).toContain("entity type \"model\" is required but not supported");
  });

  it("gives each orb the scene's marker style, which its own overrides one property at a time", () => {
    const doc = example();
    edit(doc, "markerStyle", { outline: { color: "#FFcc00", widthPx: 2 }, hover: { scale: 1.5 } });
    edit(doc, "entities.1.marker.style", { outline: { color: "#00000080", widthPx: 3 }, hover: null });
    const result = validateScene(doc, { baseUrl: BASE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.scene.panoramas.get("garden")!.markerStyle).toEqual({ outline: { color: [1, 0.8, 0, 1], widthPx: 2 }, hoverScale: 1.5 });
    expect(result.scene.panoramas.get("courtyard")!.markerStyle).toEqual({ outline: { color: [0, 0, 0, 128 / 255], widthPx: 3 }, hoverScale: 1 });

    edit(doc, "entities.1.marker.style", { outline: null });
    const off = validateScene(doc, { baseUrl: BASE });
    expect(off.ok && off.scene.panoramas.get("courtyard")!.markerStyle).toEqual({ outline: null, hoverScale: 1.5 });
    // Without a style anywhere, orbs are drawn as before.
    const plain = validateScene(example(), { baseUrl: BASE });
    expect(plain.ok && plain.scene.panoramas.get("garden")!.markerStyle).toEqual({ outline: null, hoverScale: 1 });
  });

  it("checks marker styles with their paths", () => {
    const doc = example();
    edit(doc, "markerStyle", { outline: { color: "gold", widthPx: 40 }, hover: { scale: 0.5 }, glow: true });
    edit(doc, "entities.0.marker.style", { outline: { color: "#abc", widthPx: 1 } });
    expect(errorsOf(doc)).toEqual([
      "$.markerStyle.glow: is not a property of this record; namespaced additions belong in \"extensions\"",
      "$.markerStyle.outline.color: must be a hex colour, #rrggbb or #rrggbbaa",
      "$.markerStyle.outline.widthPx: must be in [0, 32]",
      "$.markerStyle.hover.scale: must be in [1, 4]",
      "$.entities[0].marker.style.outline.color: must be a hex colour, #rrggbb or #rrggbbaa",
    ]);
  });

  it("fails links to panoramas that do not exist", () => {
    const doc = example();
    edit(doc, "entities.0.links.0.target", "nowhere");
    expect(errorsOf(doc).join("\n")).toContain("$.entities[0].links[0].target: leads to \"nowhere\"");
  });

  it("fails unsupported required extensions and unnamespaced ones", () => {
    const doc = example();
    edit(doc, "extensions", { "example.tour": { stops: 3 }, plain: {} });
    edit(doc, "requiredExtensions", ["example.tour", "missing.one"]);
    const errors = errorsOf(doc).join("\n");
    expect(errors).toContain("requires the extension \"example.tour\", which this loader does not support");
    expect(errors).toContain("names \"missing.one\", which is not a key of \"extensions\"");
    expect(errors).toContain("$.extensions.plain: must be a namespaced key");
    expect(validateScene(doc, { baseUrl: BASE, supportedExtensions: ["example.tour"] }).ok).toBe(false);
    edit(doc, "requiredExtensions", ["example.tour"]);
    edit(doc, "extensions.plain", REMOVE);
    expect(validateScene(doc, { baseUrl: BASE, supportedExtensions: ["example.tour"] }).ok).toBe(true);
  });

  it("applies the scene limits before building anything", () => {
    expect(errorsOf(example()).length).toBe(0);
    const tooMany = validateScene(example(), { baseUrl: BASE, limits: { entities: 1 } });
    expect(tooMany.ok).toBe(false);
    const tooBig = validateScene(EXAMPLE_TEXT, { baseUrl: BASE, limits: { manifestBytes: 100 } });
    expect(!tooBig.ok && tooBig.errors[0].message).toContain("over the 100-byte limit");
    const tooLinked = validateScene(example(), { baseUrl: BASE, limits: { links: 1 } });
    expect(!tooLinked.ok && tooLinked.errors[0].message).toContain("2 links, over the limit of 1");
  });

  it("does not accept text that is not JSON or not the format", () => {
    expect(errorsOf("{").join()).toContain("is not JSON");
    expect(errorsOf({ format: "other" }).join()).toContain("$.format");
  });
});
