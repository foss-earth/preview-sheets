import type { ParameterSpec } from "@foss-earth/ui/settings";
/** Optional contribution at its existing Scenes home; the host registers it once. */
export const PREVIEW_SHEETS_PARAMETERS: readonly ParameterSpec[] = [
  {
    id: "scene.panorama.previewSheets", label: "Orb previews in one file",
    description: "Where a scene has put its orbs' smallest previews into one image, load that image and show every orb from it: one request, not six for each orb. Off, each orb loads its own six files. Either way an orb drawn larger than that preview loads its own sharper one.",
    unit: "none", kind: "boolean", default: true,
    defaultReason: "One request shows a scene's orbs. On the UMN tour's build with every response held 100 ms, all 60 orbs were shown 1.5 s after the page opened from the sheet, as the app finished starting, and after 4.0 s from their 360 files sixteen at a time (docs/proposals/panorama-scenes.md, \"Loading once\").",
    home: { tab: "scenes", section: "loading", level: "main" }, appliesLive: true, source: "src/scenes/panoramaResources.ts",
  },
];
