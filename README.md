# Preview sheets

`@foss-earth/preview-sheets` 0.1.0 provides the optional `foss-earth.preview-sheets` extension for FOSS Earth cube images: its schema and validators, a packing and verification tool, and shared acquisition of the sheet images. A preview sheet is one small JPEG that holds all six faces of a cube, so a viewer can show a low-resolution preview from a single download before the full faces load.

## Exports

| Export | Contents |
| --- | --- |
| `.`, `/core`, `/schema` | Pure sheet and place records and validators. |
| `/preparation` | Node-only packing and verification tools. |
| `/scene-extension` | `createPreviewSheetsExtensionHook`. |
| `/browser` | `createPreviewSheetSources`. |
| `/settings` | `PREVIEW_SHEETS_PARAMETERS`. |
| `/composition`, `/composition-node` | Merging sheets from several child scenes. |
| `/schema/extension.json`, `/schema/place.json` | JSON schemas. |

### Records and validation

The pure entries export the sheet and place records, `sheetFaceRectangles`, `sheetSourceKey`, `sheetMediaGroup`, `validateSheetRecord`, `validatePreviewSheets` and `validateSheetPlace`.

- Invalid optional data produces warnings and no resolved place.
- The caller still needs the cube's six original face files.
- Relative URLs resolve against the caller's manifest URL. HTTP(S) source URLs cannot carry credentials.
- The scene envelope, asset references, navigation and the scene-writing CLI belong to other repositories.

### Packing and verification (`/preparation`)

`composeSheet`, `sheetColumns`, `addPreviewSheets`, `sheetsOf`, `extractSheetFaces` and `verifyPreviewSheets`.

- A cube is one horizontal strip in the order `px nx py ny pz nz`. No face is rotated.
- Packing takes already prepared opaque sRGB JPEG or PNG face files, keeps the originals, and writes a JPEG whose face sizes are divisible by eight pixels.
- The default limit is 4,000,000 pixels, exported as `SHEET_PIXELS` and overridable. Padding cells count toward it.
- Verification compares every sheet face with its original using a PSNR threshold (28 dB by default). It reports missing files, bad decodes, wrong dimensions, out-of-bounds places and mismatched pictures.
- `sheetsOf` and `addPreviewSheets` also read and migrate legacy preparation records. The runtime validator accepts only the namespaced extension.

### Scene extension hook

`createPreviewSheetsExtensionHook` returns a structural hook with `name`, `validateDocument` and `resolveRepresentation`. Pass it to the scene envelope's extension registration. It validates the document's sheet list and adds the resolved `sheet` place to a validated cube. A bad optional place produces a warning and keeps the original faces. It imports no scene code or types.

### Browser acquisition

`createPreviewSheetSources` takes the host's `ImageSessionBroker`, the common cached `obtain` port and the common header-checked `decode` port. Cropping is injected. For each cube, call `acquireCubeFaces` with its scope, the enabled setting, the resolved place, the face size, a label, and a `fallback` callback that loads the six original files. The returned source holds six `ImageBitmap` faces and an idempotent `close`. Pass the faces to cubemap's `uploadCubeSource`, or inject the acquisition into its `loadCube`.

```ts
import { acquireCubeFaces, loadCube } from "@foss-earth/sphere-cubemap/browser";

const image = await loadCube(record, {
  ...cubePorts,
  acquireFaces(record, common) {
    return sources.acquireCubeFaces({
      sheet: resolvedPlace,
      faceSize: record.faceSize,
      scope: common.scope,
      label: cubePorts.label,
      enabled: hostPreviewSheetsSetting,
      fallback: () => acquireCubeFaces(record, common),
    });
  },
});
// The host attaches the ready texture through its existing renderer.
// After its atomic visibility swap and disposal of the outgoing source:
image.settleReplacement();
// Ending this operation releases that texture and every remaining reservation.
image.dispose();
```

The adapter allocates no texture, creates no renderer or scheduler, requests no frames and creates no persistent cache. Cache policy, request and decode limits, and the encoded and decoded budgets come from the host's image services.

Behavior:

- The `obtain` request includes the sheet id, revision and the media-store group `sheet <id>@<revision>`, so a changed revision at the same URL is cached separately.
- Concurrent cubes share one download and decode, keyed by sheet id, revision and URL. The last crop user releases the decoded sheet.
- A cancelled consumer does not stop the others. Late decode or crop results are closed.
- Crop work that cannot be aborted keeps its decoded-pool grants and a `HeldDecodedImage.retain()` hold on its input until the native call settles, even after cancellation or broker invalidation or disposal. The last hold closes the sheet and frees its decoded charge. If input cleanup fails after all six crops succeed, the unpublished faces are closed before acquisition rejects.
- A damaged sheet falls back to the original files for the rest of the current broker generation. Invalidating the broker allows a fresh attempt at the same revision.
- A temporary capacity refusal from the common services falls back without marking an intact sheet as failed. Wrong crop dimensions close the partial output and fall back.
- Turning sheets off, or omitting cropping, uses the original files immediately.
- The common decoder implements the optional retain port. A custom decoder without it takes the original-face fallback and is not marked damaged, so older custom decoders must implement the hold to use sheets.

Call `dispose` when the host session or scene ends, and dispose cube operation scopes through the same broker. For how sources keep native input alive across host uploads, see [native input lifetime](docs/native-input-lifetime.md).

### Settings

`PREVIEW_SHEETS_PARAMETERS` is the `scene.panorama.previewSheets` boolean (default true) under Scenes, Loading and memory. It registers nothing itself; the host registers it. It uses the type-only `@foss-earth/ui/settings` contract, so the host supplies `@foss-earth/ui` when consuming these declarations.

### Composition

`createPreviewSheetsCompositionOwner` (also exported from the root) and the Node variant `createNodePreviewSheetsCompositionOwner` from `/composition-node` merge the sheets of child scenes through injected scene composition ports. The Node variant adds required face and cell equivalence verification. See [scene composition](docs/scene-composition.md).

## Limits

Only the opaque sRGB JPEG and PNG path is supported. There is no progressive JPEG, HDR, video or stereo support, and no scene-document orchestration.

## Development

This package depends on `@foss-earth/sphere-cubemap` and `@foss-earth/images`, and has `@foss-earth/ui` as an optional peer, all at versions that are not published yet. Its own `npm install`, tests and build therefore do not work on their own. Develop it through the app, which uses libraries straight from their checkouts: see [Local source](https://github.com/foss-earth/app#local-source).

Scripts in `package.json`: `build`, `typecheck`, `lint`, `test`, `typecheck:consumer`, `check:implementation` and `ci`.

## Project policies

- [Code of conduct](https://github.com/foss-earth/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/foss-earth/.github/blob/main/CONTRIBUTING.md)
- [AGPL-3.0 license](LICENSE)
- [Security](https://github.com/foss-earth/.github/blob/main/SECURITY.md)
