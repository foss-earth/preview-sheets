# Preview sheets

`@foss-earth/preview-sheets` 0.1.0 is a private staging extraction from Earth
commit `90e23b3ee96f53ec5900afc5991a21fffa58649d`. It owns the optional
`foss-earth.preview-sheets` extension, packing and verification, and shared
sheet acquisition. Source lineage and remote admission remain pending.


The pure root, `/core` and `/schema` entries expose sheet/place records,
`sheetFaceRectangles`, `sheetSourceKey`, `sheetMediaGroup`, `validateSheetRecord`,
`validatePreviewSheets` and `validateSheetPlace`. Optional invalid data produces
warnings and no resolved place. The caller still requires the cube's six face
files. Relative URLs resolve against the caller's manifest URL; HTTP(S) source
URLs cannot carry credentials. JSON schemas are exported at
`/schema/extension.json` and `/schema/place.json`. The scene envelope, asset
references, navigation and scene-writing CLI belong to their respective owners.

`/preparation` is the optional Node entry. `composeSheet`, `sheetColumns`,
`addPreviewSheets`, `sheetsOf`, `extractSheetFaces` and `verifyPreviewSheets`
preserve the original packing/extension tools. A cube is one horizontal strip
in source order `px nx py ny pz nz`; no face is rotated. Packing consumes already
prepared opaque sRGB JPEG/PNG face files, keeps the originals, and produces JPEG
with face sizes divisible by eight pixels. The default 4,000,000-pixel limit is
exported as `SHEET_PIXELS` and can be overridden explicitly. Padding cells count
toward that limit. Verification compares every sheet face against its original
using the caller's PSNR threshold (28 dB by default), and reports missing files,
bad decodes, wrong dimensions, out-of-bounds places and mismatched pictures.
`sheetsOf` and `addPreviewSheets` read/migrate legacy preparation records; the
runtime validator accepts only the namespaced extension.

`/scene-extension` exports `createPreviewSheetsExtensionHook`, a structural
optional owner hook with `name`, `validateDocument` and `resolveRepresentation`.
Pass it explicitly to the scene envelope's extension registration. It validates
the document's sheet list and augments a validated cube with its resolved
`sheet` place; a bad optional place warns and retains the original faces.
It imports no scene implementation or scene types.

The optional `/browser` entry exposes `createPreviewSheetSources`. Create one
instance with the host's existing `ImageSessionBroker`, common cached `obtain`
and common header-checked `decode` ports. Cropping is injected. For each cube,
pass its dedicated scope, enabled setting, resolved place, face size, label and
six-original-file `fallback` callback to `acquireCubeFaces`. A returned source
contains six `ImageBitmap` faces and an idempotent `close`; pass those faces to
cubemap's `uploadCubeSource`, or inject acquisition into its `loadCube`; the
uploader closes the source after upload/readiness. The adapter
allocates no texture, creates no renderer or scheduler, and requests no frames.
The `obtain` file includes explicit sheet id/revision and the original common
media-store group (`sheet <id>@<revision>`), so the caller's existing cache can
keep a changed revision at the same URL separately. No persistent cache is
created by this adapter.

```ts
import { acquireCubeFaces, loadCube } from "@foss-earth/cubemap/browser";

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

Concurrent cubes share one download/decode keyed by sheet id, revision and URL.
The last crop user releases the decoded sheet. Nonabortable crop work keeps its
direct decoded-pool grants and an explicit common `HeldDecodedImage.retain()`
input hold until the native call settles, even after cube/registry cancellation
or whole-broker invalidation/disposal. Late output closes before output charges
free, then the last native input hold closes the sheet and releases its existing
decoded charge. Throwing bitmap cleanup still releases every reservation. If
input cleanup fails after all six crops succeed, the unpublished faces also
close and free their charges before acquisition rejects.
A cancelled consumer lets other
consumers finish; late decode/crop completions are closed. Damaged sheets use
the original files for the remainder of the current broker generation. Broker
invalidation permits a fresh attempt at the same revision. A still-running old
crop retains its old input; a new generation never shares that closing input or
inherits its cancellation as a content failure. Input closure and reservation
release happen before face ownership transfers, followed by a current-operation
check, so a cleanup observer ending the scope cannot publish closed faces.
Temporary common capacity refusal falls back without marking an intact sheet
failed for the visit. Wrong crop dimensions close partial output and fall back.
Turning sheets off or omitting cropping uses the original files immediately.
The common decoder implements the optional retain port; a supplied legacy
decoder without it takes original-face fallback and is not marked damaged.
This is an explicit compatibility change: old custom decoders must implement
the reliable hold to use sheets. The adapter never assumes that a started crop
has already captured input pixels, and it creates no second broker or cache.
Call `dispose` when ending the host session/scene, and dispose cube operation
scopes through the same broker. Cache policy, request/decode limits, encoded and
decoded budgets come from the host's common image services.

This package adds no image formats beyond the extracted opaque sRGB JPEG/PNG
path. It provides no progressive JPEG, HDR, video, stereo, GPU validation or
scene-document orchestration. Public source contracts are ready; package checks,
installed artifact pins and consumer adoption are pending their reserved turn.

`npm run ci` runs cached lint, incremental types/build, retained original packing
tests, optional-validation/lifecycle tests, and a public consumer. Each run's
logs belong under this owner's `build/checks/`. No server or GPU check starts.
The package carries the original AGPL license and immutable source mappings in
`SOURCE_PROVENANCE.json`; the shared CI caller and shared conformance fixtures
are preserved from the reviewed local CI9e046dd scaffold. Actual installed
shared conformance, full-ref audit, public caller availability and remote admission
remain pending. Metadata checks cannot skip documentation/schema/assets changes.

`scripts/check-isolated-archive.mjs` creates a fresh owner-local offline consumer
from mandatory exact archive/digest pairs for preview-sheets, images, cubemap,
UI, jpeg-js and TypeScript. It runs the installed public fixture with realpath
guards and an outside negative control, then pure/browser declaration
checks. The fixture preserves one shared download/decode, native input retention
through broker invalidation/disposal and crop resolve/reject, six-original fallback,
cubemap upload/readiness authority and host overlap settlement. The retained
public face-handoff body also runs through this installed/archive route: it
asserts six cropped inputs and their decoded grants survive synchronous scope
cancellation inside upload and throwing late texture disposal, followed by
ordered primary/output/face errors and eventual complete cleanup. All imports
for that body use the same guarded isolated public packages. It has not run;
no runtime range, hardware qualification or accepted artifact is inferred.
The outer archive harness also verifies every installed physical package name,
exact version and confined package/manifest realpath before imports. Both pure
and public declaration passes require `skipLibCheck: false`; the existing DOM
and DOM.Iterable type-library distinction and empty ambient `types` remain.
Declaration resolution traces are checked with physical realpaths. The retained
runtime bodies, face-handoff assertions and exact archive dependency set are
unchanged; this stricter qualification remains source-only and unrun.
Six additional generation/publication regression cases use the actual common
file service and broker, including an old crop still pending while a new sheet
loads, generation-local failures, reentrant input cleanup and synchronous obtain
callbacks starting another acquisition. Independent cleanup attempts preserve
input and output errors together. These cases are prepared
source only and have not run.
Declaration fixtures include DOM typings for the common standard `AbortSignal`
contract; the runtime guard still forbids browser initialization.

Optional `./settings` exports `PREVIEW_SHEETS_PARAMETERS` with the unchanged `scene.panorama.previewSheets` boolean record at Scenes → Loading and memory. It uses a type-only `@foss-earth/ui/settings` contract, registers nothing and preserves the source description, true default, reason and provenance. The host supplies the exact UI artifact when consuming these declarations.

## Native input lifetime source increment

The actual common decoded inputs and sheet-crop face sources now provide retained
pixel ownership across awaited host uploads and stale texture cleanup. See
[the exact lifetime and legacy compatibility contract](docs/native-input-lifetime.md).
All new source fixtures and installed-consumer changes remain unrun; no current
app adoption or backend qualification is claimed.

## Project policies

- [Code of conduct](https://github.com/foss-earth/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/foss-earth/.github/blob/main/CONTRIBUTING.md)
- [AGPL-3.0 license](LICENSE)
- [Security](https://github.com/foss-earth/.github/blob/main/SECURITY.md)

The current contribution rule uses sentence case and lives in CONTRIBUTING's
later Commit attribution section. The retained shared CI9e046dd descriptor still
pins the earlier uppercase policy. Its actual prior19-case conformance pass is
retained with that scope; Platform's next checked sentence-case shared pin and
new owner conformance are required before final acceptance. No policy checker
or digest is bypassed.
