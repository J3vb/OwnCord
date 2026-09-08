# Tests that detect broken behavior

A regression test must fail when the behavior is broken. Prefer observable outcomes over implementation details: a second user receives a message once, permissions actually deny a request, remote audio/video decodes, and an updated executable serves the same database.

## Local and CI lanes

Run client commands from `Client/`, after `npm ci`. Real-server suites need Go on PATH. Desktop builds run in Windows CI only.

| Lane                           | Command                                                                             | Boundary and evidence                                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit, integration and contract | `npm test`                                                                          | Fast edge cases and protocol contracts                                                                                                                               |
| Mocked browser                 | `npm run test:e2e`                                                                  | Explicit desktop IPC mock, UI behavior and protocol events; unexpected IPC and page errors fail                                                                      |
| Production browser             | `npm run test:e2e:prod`                                                             | Same UI suite against built assets, including bundled workers; retains the historical parity check name for branch protection                                        |
| Admin                          | `npm run test:e2e:admin`                                                            | Fresh real server/database on every attempt; setup, channel mutations, audit and login. Release discovery is stubbed here; packaged-update tests cover it separately |
| Real server, chat only         | `npm run test:e2e:fullstack -- --grep chat`                                         | Two isolated users, real HTTP/WS, durable history, transport loss and permission revocation                                                                          |
| Full stack                     | `npm run test:e2e:fullstack`                                                        | Above plus actual LiveKit, decoded encrypted audio/video, browser API faults and signed server replacement                                                           |
| Windows native                 | `npx playwright test --config playwright.config.native.ts --project native-core`    | Release executable, WebView2, first-use TLS trust, severed Rust sockets, durable messages and voice controls                                                         |
| Windows installer              | `npx playwright test --config playwright.config.native.ts --project native-updater` | Real signed NSIS archive, corrupt/interrupted downloads, installation, relaunch, new app version and persisted session                                               |
| Mutation                       | `npx stryker run stryker.ci.config.mjs`                                             | Permission mutations; 90% minimum for the measured target                                                                                                            |
| Generated fuzzing              | `node scripts/fuzz-ci.mjs` from the root                                            | Every discovered target in WS, database, permissions and storage gets generated inputs, not just seed replay                                                         |

For media, run `node tests/e2e/scripts/install-livekit.mjs` and set `OWNCORD_E2E_LIVEKIT_BINARY` to `tests/e2e/.bin/livekit-server` (`.exe` on Windows). Missing prerequisites fail the suite. The installer pins the release and archive digest. Native packaged tests consume artifacts built by `tests/e2e/scripts/build-native-updates.mjs` in CI.

Browser full-stack tests replace desktop IPC only: HTTP, WebSocket, authentication, storage and key exchange go through the real server. Browser API probes observe peer connections and inject microphone, device, RTT and worker-key faults. These tests must not add badges, toasts or CSS classes to manufacture their expected result. Native tests separately cover Rust IPC and certificate validation.

Server update tests build two real main packages using a Go overlay for the ephemeral signing key, upstream HTTP destination and PID journal. Production signature verification, staging, atomic replacement and restart code remain intact. Tests check that a broken download reaches the artifact, fails, leaves the installed hash unchanged and clears staging. A valid signed release is applied through the admin UI; the successor must serve the new version, preserve messages, accept new traffic and, in the media variant, resume decoded audio.

Native builds use `native-test-config.mjs` for a separate application identifier, a serial CDP port and WebView settings passed through Tauri’s API (elevated WebView2 ignores environment overrides). Each fresh native process clears only the `com.owncord.e2e` profile; an installer relaunch retains it.

Desktop installer tests use a separate application identifier and ephemeral signing key. They never need production signing secrets. Their TLS gateway proxies real OwnCord traffic and supplies only release metadata and signed installer bytes.

## Failure policy

- CI retries once to collect diagnostic evidence, and `failOnFlakyTests` rejects a pass that required that retry.
- Tests own their database, ports and profiles. Persistent native fixtures have worker scope; Playwright replaces the worker after failure. Cleanup joins owned process trees and captures traces before CDP teardown.
- Screenshots, traces, process logs and JUnit reports have separate output directories for each lane. Investigate the first failing assertion before increasing timeouts.
- Scheduled fuzzing and long race-detector simulations run on `dev`. Public CI never uploads generated fuzz reproducers. Reproduce failures locally and land the corpus entry with its fix, following `Server/Makefile`.
- A schedule starts only after its workflow reaches the default branch. The checked-in required-check list is in `docs/plans/b0-dev-branch-protection.sh`; changing that file does not itself apply GitHub repository settings.

For each escaped bug, add the regression at the lowest layer that can reproduce it, demonstrate that it fails with the broken behavior, then retain a small browser journey when the failure crosses UI, network or process boundaries. Expand mutation targets only after measuring their baseline; do not lower thresholds to make new tests green.
