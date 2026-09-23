# Dependency patches

## `@tauri-apps/plugin-http` 2.5.9

The JavaScript SDK leaves request and response abort listeners attached after
their work finishes. Aborting an in-flight body read also lets its late completion
write to a terminated stream or drop the same Rust response resource again. Those
discarded cleanup promises can cause unhandled rejections during session changes
and connection-test cancellation.

The patch changes both published entry points (`dist-js/index.js` and
`dist-js/index.cjs`). It removes finished listeners, releases response resources
returned after cancellation, makes cancellation idempotent, and ignores late body
read results once the stream has terminated. Stream cancellation returns its
cleanup promise. Unexpected cleanup failures remain observable through that
promise or `console.error`; request and body-read errors retain their original
values.

The only ignored cleanup failure is the exact invalid-resource message for this
response's own resource ID when a read was pending at cancellation. Rust can
already have closed that resource at EOF while the JavaScript IPC reply is still
pending. Other resource IDs, permission failures, and transport failures are not
ignored. Normal null-body responses and response metadata retain upstream
behavior; general request-resource and normal null-body resource reclamation are
outside this cancellation patch.

The dependency is pinned to 2.5.9. `npm ci` runs
`patch-package --error-on-fail --error-on-warn`, so either a failed patch or a
package-version mismatch fails installation. After intentionally editing the two
installed entry points, regenerate from `Client/` with:

```sh
npm exec patch-package -- @tauri-apps/plugin-http
```

The SDK boundary regressions import the actual installed ESM and CommonJS entry
points and control only Tauri IPC replies. Keep those tests and the native HTTP
cancellation scenario when upgrading the plugin. Remove this patch when an
upstream npm release passes both without local modifications; update the npm and
Rust locks together. Remove the postinstall hook and `patch-package` dependency
when no patches remain.

## `livekit-client` 2.22.3

The E2EE worker acknowledges every `enable` message, and the manager then looks
the participant up by identity to report its encryption status. A remote
participant can leave between the post and the ack: a quick leave right after
publishing, or the room's own reconnect re-posting `enable` for every peer. The
SDK then threw `couldn't set encryption status, participant not found` from the
worker's `onmessage`, an uncaught error the app cannot catch. The patch skips
the status event for a participant who is gone; the local participant and
present peers are reported as before.

Only `dist/livekit-client.esm.mjs` is patched: Vite and vitest resolve the
package's `import` condition, and the `require` entry is not bundled. The
dependency is pinned to 2.22.3 for the same install check as above. After
editing the installed file, regenerate from `Client/` with:

```sh
npm exec patch-package -- livekit-client
```

`tests/unit/livekit-e2ee-enable-ack.test.ts` drives the installed SDK's real
`Room` and `E2EEManager` with a stand-in worker. Remove this patch when an
upstream release passes it unmodified.
