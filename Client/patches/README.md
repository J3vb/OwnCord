# Dependency patches

This folder holds local fixes to npm packages, applied by `patch-package`. Read
it before you upgrade a patched package or add a new patch.

## How the patches are applied

- `Client/package.json` runs `patch-package --error-on-fail --error-on-warn`
  as its `postinstall` step. So `npm ci` fails if a patch does not apply, or if
  the installed package version does not match the patch.
- That is why each patched package is pinned to an exact version.
- Remove the `postinstall` hook and the `patch-package` dependency when no
  patches remain.

## `@tauri-apps/plugin-http` 2.7.0

**The problem.** The JavaScript SDK leaves request and response abort
listeners attached after their work is done. Aborting a body read that is in
progress also lets its late completion write to a closed stream, or release
the same Rust response resource twice. Those dropped cleanup promises can
cause unhandled rejections when the session changes or a connection test is
cancelled.

Version 2.7.0 improved this. It swallows the request and body cancellation
rejections and makes `dropBody` safe to call twice. But it still fails the
boundary regressions: 28 of 34 fail against the unmodified release. So the
patch stays, ported onto 2.7.0's entry points.

**What the patch changes.** It edits both published entry points
(`dist-js/index.js` and `dist-js/index.cjs`). It:

- removes listeners once their work is finished;
- releases response resources that come back after cancellation;
- makes cancellation safe to call more than once;
- ignores late body-read results once the stream has closed.

Stream cancellation returns its cleanup promise. Unexpected cleanup failures
are still visible through that promise or `console.error`. Request and
body-read errors keep their original values.

**The one ignored failure.** The patch ignores only the exact
invalid-resource message, for this response's own resource ID, when a read was
pending at cancellation. Rust may already have closed that resource at the end
of the stream while the JavaScript IPC reply is still on its way. Other
resource IDs, permission failures and transport failures are not ignored.

Normal null-body responses and response metadata keep the upstream behavior.
General request-resource cleanup and normal null-body resource cleanup are
outside this cancellation patch.

**Regenerating.** After you intentionally edit the two installed entry points,
regenerate the patch from `Client/`:

```sh
npm exec patch-package -- @tauri-apps/plugin-http
```

**Tests and removal.** The SDK boundary regressions import the real installed
ESM and CommonJS entry points, and control only the Tauri IPC replies. Keep
those tests, and the native HTTP cancellation scenario, when you upgrade the
plugin. Remove this patch when an upstream npm release passes both without
local changes. Update the npm and Rust lockfiles together.

## `livekit-client` 2.23.0

**The problem.** The E2EE worker acknowledges every `enable` message. The
manager then looks up the participant by identity to report its encryption
status. A remote participant can leave between the message and the
acknowledgement. That happens with a quick leave right after publishing, or
when the room's own reconnect re-sends `enable` for every peer. The SDK then
threw `couldn't set encryption status, participant not found` from the
worker's `onmessage`. That is an uncaught error the app cannot catch.

**What the patch changes.** It skips the status event for a participant who
has left. The local participant and peers who are still present are reported
as before.

Only `dist/livekit-client.esm.mjs` is patched. Vite and vitest resolve the
package's `import` condition, and the `require` entry is not bundled. The
package is pinned to 2.23.0 for the same install check described above. 2.23.0
still throws there, so the patch was carried forward unchanged.

**Regenerating.** After you edit the installed file, regenerate the patch from
`Client/`:

```sh
npm exec patch-package -- livekit-client
```

**Tests and removal.** `tests/unit/livekit-e2ee-enable-ack.test.ts` drives the
installed SDK's real `Room` and `E2EEManager` with a stand-in worker. Remove
this patch when an upstream release passes that test unchanged.
