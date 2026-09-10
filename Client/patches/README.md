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
