# Native input lifetime

Status: source prepared on 2026-10-09. All new checks, installed consumers and
backend qualification remain unrun. No current app has adopted these bytes.

The host supplies the existing image broker, operation scope and uploader. Its
upload promise must settle only when that operation has stopped reading supplied
bitmaps, including rejection. Cancellation ends publication immediately; it does
not prove that a queued or submitted native operation has stopped reading pixels.

Returned sheet-crop sources implement `CubeFaceSource.retain?(): () => void`,
structurally matching the public Cubemap browser source. A hold retains all six
crop bitmaps and their existing direct decoded grants. `close` blocks new holds;
actual crop disposal waits for the final hold. The operation scope may request
closure during upload without freeing native input pixels or their grants.

The loader acquires the real input hold before invoking the upload callback. It
keeps that hold through upload settlement, readiness and disposal of any stale
texture. It then requests source closure and releases the input hold. A late
texture is disposed before the last input hold is released. Successful cleanup
also rechecks the operation generation before returning a visible source.

Input holds and decoded charges are retained if an uploader never settles. A
host that rejects on cancellation while its native work continues violates the
upload contract; these leaves cannot infer native completion or supply a second
GPU scheduler. Upload/staging completion tickets remain the Renderer owner's
responsibility and are separate from bitmap lifetime.

Each release is idempotent. Cleanup attempts every owned texture, face and input
hold, even when a disposer throws. Errors retain the primary operation failure,
then output disposal errors, then input disposal errors. Partial cube input-hold
acquisition releases every previously acquired hold before reporting failure.

The optional retain from a foreign six-file fallback passes through unchanged.
An absent retain remains unqualified for nonabortable native input use. Sheet
cropping still requires a reliable common decoded-input hold; an older decoder
without it uses the original six-file fallback. Registry disposal does not
invent a new broker, texture or completion clock.

The actual common-service cases in `tests/common-services.test.ts` exercise scope
cancellation, broker invalidation/disposal and synchronous cancellation inside
the upload callback, with both late upload resolution and rejection. Throwing
texture/bitmap disposers cover all-attempt cleanup and error order. The existing
`scripts/check-public-consumer.mjs` fixture composes the actual common service,
public preview source and public `uploadCubeSource`. Its face-handoff assertion
body is also retained in `scripts/check-installed-artifact.mjs`, called by the
actual `scripts/check-isolated-archive.mjs` route. There it uses the already
guarded isolated public imports from the six exact archive inputs. Synchronous
scope cancellation in the upload callback must leave all six crops and decoded
charges held; a throwing late texture disposal must precede the six throwing
face disposals, preserving primary/output/input error order and eventual empty
pools. The original public fixture, crop-cancellation matrix, dependency pins,
outside-workspace negative control and unrelated-peer guard remain unchanged.
`tests/consumer.ts` expresses the cross-package face-source retention type.
Existing sheet sharing, crop input retention and generation fixtures remain in
place.
These are source fixtures, not successful tests or backend evidence.

Original face order, representation geometry, GPU estimates, readiness,
replacement-overlap acknowledgement, source attribution and preparation remain
unchanged. There is one host renderer and resource broker. Rolling back keeps the
canonical original app and all prior receipts; no app source has been removed.

YOU CANNOT HAVE AI AS A CO-AUTHOR, OR YOUR CONTRIBUTIONS WILL BE REJECTED.
