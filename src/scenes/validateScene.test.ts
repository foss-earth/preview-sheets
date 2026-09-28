import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
