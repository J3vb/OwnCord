# Client diagnostics: event codes and privacy contract

This page is the contract for the client's diagnostic event log: which events
the app may record, which fields each event may carry, how much is kept, and
what must never be in it. It is written before the recorder exists, so every
piece that records an event later builds against the same rules.

The source of truth is the catalogue in
[`Client/src/lib/diagnostics/eventCodes.ts`](../../Client/src/lib/diagnostics/eventCodes.ts).
The tables below copy it, and `eventCodes.test.ts` fails when they differ.

## Why it exists

When a webcam freezes for a few seconds or a call drops, the support bundle
today has free-text log lines and nothing that says what the camera, tracks and
connections did, in order. The event log is a short, structured timeline of
those facts. It goes into the existing support bundle
([Desktop client support bundle](diagnostics.md#desktop-client-support-bundle)),
saved through the same **Export Support Bundle** button. There is no other way
out: nothing is uploaded, and there is no separate report.

## How an event looks

An event is a code, a time and a few fields:

```json
{
  "t": 1762185600123,
  "code": "camera.stalled",
  "frames_sent": 18402,
  "encoder": "libvpx",
  "quality_limitation": "cpu",
  "width": 1280,
  "height": 720
}
```

- **Code**: `area.event`, lower case. The dot keeps client codes apart from the
  server's `snake_case` codes in `Server/admin/support_event_codes*.go`; the
  test fails if a client code, with its dot turned into an underscore, matches
  a server code.
- **Label**: a short plain sentence, for people reading the bundle.
- **Fields**: only the ones listed for that code. The recorder drops any other
  field, and drops a value that does not pass its type check.

## Field types

No field type holds free text.

| Type        | What it holds                                                                                 | Check                              |
| ----------- | --------------------------------------------------------------------------------------------- | ---------------------------------- |
| `enum`      | one word from the list on the field                                                           | value is in the list               |
| `int`       | a count, a size in pixels, frames per second, a close code                                    | whole number                       |
| `ms`        | a duration in milliseconds                                                                    | whole number, not negative         |
| `bool`      | yes or no                                                                                     | boolean                            |
| `hash`      | a per-report hash of something that may hold a name, such as a camera label ("Alex's iPhone") | 8 hex characters                   |
| `pseudonym` | a per-report stand-in for a user or channel id (`u1`, `c2`), never the name                   | a letter and up to 4 digits        |
| `host`      | the server host name only                                                                     | no scheme, port, path or query     |
| `version`   | an app or webview version                                                                     | dotted numbers                     |
| `token`     | a short word the browser or OS defines: codec, encoder, exception code, module name           | letters, digits, `_ . -`, up to 48 |
| `code`      | another code from this catalogue                                                              | a known code                       |

Hashes and pseudonyms are made with a key that is new for each saved bundle,
so the same camera or user cannot be matched across two bundles.

## Never recorded

Tokens, keys, passwords, cookies, `Authorization` headers, call encryption
material, invite codes, message or DM text, upload file names, full URLs
(only the host), IP addresses (ICE events give the route type, never the
candidate), email addresses, OS user names (a home folder is written as `~`),
device labels (hashed), user and channel names (pseudonyms).

The catalogue test enforces this in two ways: the types above are the only
ones allowed, and a field whose name contains a word such as `label`, `name`,
`url`, `path`, `email`, `ip`, `token`, `key`, `password`, `text` or `message`
is rejected whatever its type.

## Privacy classes

Each code lists the data-lifecycle classes
([data-lifecycle.md](data-lifecycle.md)) its fields touch, the same numbers
the server's bundle manifest uses. Most codes touch none: they are technical
facts. A pseudonym may only be a `participant` (a user: class 1, identity,
as a pseudonym only) or a `channel` (only on voice join and leave: class 19,
voice state). The test checks that a code lists class 1 exactly when it has a
`participant` field and class 19 exactly when it has a `channel` field.

## Caps

The log keeps at most **2,000 events**, **512 KB** and the **last 30 minutes**,
whichever is reached first; the oldest events go first. Each code may record
at most 30 events a minute; the rest are counted and written once as
`events.dropped` with the code and count, so a reconnect loop or a flapping
device cannot push the start of an incident out of the log.

On the desktop and Android the log is also written to a rotating
`events-*.jsonl` file in the log folder, so it survives a crash, with the same
retention as the other log files. The browser client keeps it in memory only.
A setting, **Keep a diagnostic event log** (on by default), clears and stops
it.

## Camera stall threshold

The camera counts as **stalled** when `framesSent` stays flat for **2 s** or
more on every active camera layer while the camera track is live and not
muted. It **resumes** when `framesSent` grows again, and `camera.resumed`
records the gap.

- The check reads the stats the voice code already polls every 2 s
  (`Client/src/lib/voice/connectionStats.ts`); it starts no timer of its own.
- Layers the server paused because nobody is watching (dynacast is on for the
  camera, `roomLifecycle.ts`) are not active and do not count. Without that
  rule, sitting alone in a call with the camera on would look like a stall.
- The reported freeze on Windows lasts about 5 s, so 2 s catches it with room
  to spare, while a single slow encoder frame does not.
- The events carry raw facts only (frames sent, encoder, whether it is the
  GPU encoder, the limitation reason, the size). Deciding what caused a stall
  and warning the user belongs to the capture-health work, which writes its
  results into this same log.

## Who emits what

Owners push events; the log never reads app state. Camera and microphone
events come from the camera owner, WebSocket events from `ws.ts` (each tagged
with its connection-attempt generation, so an event from an old attempt is
recorded as such and never touches the live connection), voice events from the
room event handlers. Native crash and exit facts are written to the native log
by the Rust or Android code on the next start, and the client copies the
newest one into the log as `native.crash` or `native.exit`.

### Android lines

On Android the app writes these lines into the same native log
(`owncord-client.log`), in the log plugin's format with the target
`owncord_client::android`. Every value is a code, a number or a class name:
never an exception message or Android's own description text, which can hold
a link or message text.

| Line starts with                                        | When                                                                                                                                                         | Values                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `[exit] the previous run ended:`                        | Each start, for every earlier exit not reported yet (newest 3 at most). Android 11 and newer keep these; older versions get one "not available" line instead | `kind` (as `native.exit`), `reason` (Android's exit reason), `code` (signal, for `kind=signal`), `importance`, `age_ms`, `memory_mb`, `at` |
| `[crash] the previous run crashed:`                     | The same, for a crash                                                                                                                                        | `kind` (`jvm` / `native`), `code` (`exception`, or the signal of a native crash), `importance`, `age_ms`, `memory_mb`, `at`                |
| `[crash] uncaught exception:`                           | An exception nothing caught, just before Android ends the app                                                                                                | `kind=jvm`, `code` (exception class), `cause` (root cause class), `thread`, `module` (top app frame)                                       |
| `[webview] render process gone:`                        | The web view's page process crashed or Android killed it                                                                                                     | `process=renderer`, `reason` (`crashed` / `killed`), `priority`                                                                            |
| `[call] call service …`                                 | The background call service starts, is refused or stops                                                                                                      | `mic`, `camera`, or the refusal's exception class                                                                                          |
| `[app] moved to the background` / `[app] back in front` | The app leaves the screen or comes back                                                                                                                      | none                                                                                                                                       |

The newest reported exit's time is remembered, so an exit is never reported
twice across two starts.

## Event codes

### `app`

| Code             | Label                          | Fields                                                                                                                       | Emitted by    |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `app.started`    | App started                    | `app_version` (version)<br>`platform` (windows / linux / macos / android / browser / unknown)<br>`webview_version` (version) | `src/main.ts` |
| `app.suspended`  | Computer went to sleep         | none                                                                                                                         | `src/main.ts` |
| `app.resumed`    | Computer woke up               | `asleep_ms` (ms)                                                                                                             | `src/main.ts` |
| `app.visibility` | Window shown or hidden         | `state` (visible / hidden / minimized / restored)                                                                            | `src/main.ts` |
| `app.network`    | Network went online or offline | `state` (online / offline)                                                                                                   | `src/main.ts` |

### `native`

| Code                            | Label                           | Fields                                                                                                                                                                                                                                  | Emitted by                                                                                                                          |
| ------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `native.crash`                  | App crashed last time           | `platform` (windows / linux / macos / android / browser / unknown)<br>`kind` (signal / exception / panic / x_error / jvm / native / unknown)<br>`code` (token)<br>`module` (token)<br>`age_ms` (ms)                                     | `src-tauri/src/crash_log.rs`<br>`src-tauri/src/system_crash_report.rs`<br>`android …/NativeLog.kt`<br>`android …/ExitInfoPlugin.kt` |
| `native.exit`                   | How the last run ended          | `platform` (windows / linux / macos / android / browser / unknown)<br>`kind` (normal / signal / unclean / anr / low_memory / killed_by_user / killed_by_system / unknown)<br>`last_seen_ms` (ms)<br>`memory_mb` (int)<br>`hang_ms` (ms) | `src-tauri/src/exit_watch.rs`<br>`android …/ExitInfoPlugin.kt`                                                                      |
| `native.hang`                   | App stopped answering           | `thread` (main / webview)<br>`duration_ms` (ms)                                                                                                                                                                                         | `src-tauri/src/exit_watch.rs`                                                                                                       |
| `native.hang_recovered`         | App answered again              | `thread` (main / webview)<br>`duration_ms` (ms)                                                                                                                                                                                         | `src-tauri/src/exit_watch.rs`                                                                                                       |
| `native.webview_process_failed` | A webview helper process failed | `process` (browser / renderer / gpu / utility / unknown)<br>`reason` (exited / crashed / unresponsive / killed / out_of_memory / unknown)                                                                                               | `src-tauri/src/exit_watch.rs`<br>`android …/RenderGoneClient.kt`                                                                    |

### `camera`

| Code                      | Label                          | Fields                                                                                                                                                                                                                               | Emitted by                           |
| ------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `camera.started`          | Camera started                 | `device` (hash)<br>`width` (int)<br>`height` (int)<br>`fps` (int)<br>`requested_width` (int)<br>`requested_height` (int)<br>`requested_fps` (int)<br>`facing` (user / environment / unknown)                                         | `src/features/voice/mediaControl.ts` |
| `camera.stopped`          | Camera stopped                 | `reason` (user / ended / error / left_voice / replaced / unknown)                                                                                                                                                                    | `src/features/voice/mediaControl.ts` |
| `camera.device_changed`   | Camera device changed          | `device` (hash)                                                                                                                                                                                                                      | `src/lib/voice/deviceManager.ts`     |
| `camera.ended`            | Browser ended the camera track | none                                                                                                                                                                                                                                 | `src/features/voice/mediaControl.ts` |
| `camera.muted`            | Camera track muted             | `by` (browser / user)                                                                                                                                                                                                                | `src/features/voice/mediaControl.ts` |
| `camera.unmuted`          | Camera track unmuted           | `by` (browser / user)                                                                                                                                                                                                                | `src/features/voice/mediaControl.ts` |
| `camera.permission_error` | Camera could not open          | `error` (not_allowed / not_found / not_readable / overconstrained / abort / security / type / unknown)                                                                                                                               | `src/features/voice/mediaControl.ts` |
| `camera.stalled`          | Camera stopped sending frames  | `frames_sent` (int)<br>`encoder` (token)<br>`hardware_encoder` (bool)<br>`quality_limitation` (none / cpu / bandwidth / other / unknown)<br>`width` (int)<br>`height` (int)<br>`fps` (int)<br>`active_layers` (int)                  | `src/features/voice/mediaControl.ts` |
| `camera.resumed`          | Camera sends frames again      | `frames_sent` (int)<br>`encoder` (token)<br>`hardware_encoder` (bool)<br>`quality_limitation` (none / cpu / bandwidth / other / unknown)<br>`width` (int)<br>`height` (int)<br>`fps` (int)<br>`active_layers` (int)<br>`gap_ms` (ms) | `src/features/voice/mediaControl.ts` |

### `mic`

| Code                   | Label                              | Fields                                                                                                 | Emitted by                           |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| `mic.started`          | Microphone started                 | `device` (hash)<br>`sample_rate` (int)                                                                 | `src/features/voice/mediaControl.ts` |
| `mic.stopped`          | Microphone stopped                 | `reason` (user / ended / error / left_voice / replaced / unknown)                                      | `src/features/voice/mediaControl.ts` |
| `mic.device_changed`   | Microphone device changed          | `device` (hash)                                                                                        | `src/lib/voice/deviceManager.ts`     |
| `mic.ended`            | Browser ended the microphone track | none                                                                                                   | `src/features/voice/mediaControl.ts` |
| `mic.permission_error` | Microphone could not open          | `error` (not_allowed / not_found / not_readable / overconstrained / abort / security / type / unknown) | `src/features/voice/mediaControl.ts` |

### `track`

| Code                        | Label                             | Fields                                                                                                                                            | Emitted by                            |
| --------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `track.published`           | Track published                   | `source` (camera / microphone / screen_share / screen_share_audio / unknown)<br>`codec` (token)<br>`simulcast` (bool)                             | `src/features/voice/roomLifecycle.ts` |
| `track.unpublished`         | Track unpublished                 | `source` (camera / microphone / screen_share / screen_share_audio / unknown)<br>`reason` (user / ended / error / left_voice / replaced / unknown) | `src/features/voice/roomLifecycle.ts` |
| `track.replaced`            | Track replaced                    | `source` (camera / microphone / screen_share / screen_share_audio / unknown)                                                                      | `src/features/voice/mediaControl.ts`  |
| `track.layers_changed`      | Simulcast layers turned on or off | `source` (camera / microphone / screen_share / screen_share_audio / unknown)<br>`active_layers` (int)                                             | `src/lib/voice/roomEventHandlers.ts`  |
| `track.subscribed`          | Started receiving a track         | `source` (camera / microphone / screen_share / screen_share_audio / unknown)<br>`participant` (pseudonym)                                         | `src/lib/voice/roomEventHandlers.ts`  |
| `track.unsubscribed`        | Stopped receiving a track         | `source` (camera / microphone / screen_share / screen_share_audio / unknown)<br>`participant` (pseudonym)                                         | `src/lib/voice/roomEventHandlers.ts`  |
| `track.subscription_failed` | Could not receive a track         | `participant` (pseudonym)                                                                                                                         | `src/lib/voice/roomEventHandlers.ts`  |

### `share`

| Code                   | Label                          | Fields                                                                                                                | Emitted by                     |
| ---------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `share.started`        | Screen share started           | `surface` (monitor / window / browser / unknown)<br>`width` (int)<br>`height` (int)<br>`fps` (int)<br>`native` (bool) | `src/lib/voice/screenShare.ts` |
| `share.stopped`        | Screen share stopped           | `reason` (user / ended / error / left_voice / replaced / unknown)                                                     | `src/lib/voice/screenShare.ts` |
| `share.ended`          | Browser ended the screen share | none                                                                                                                  | `src/lib/voice/screenShare.ts` |
| `share.source_changed` | Screen share source changed    | `surface` (monitor / window / browser / unknown)                                                                      | `src/lib/voice/screenShare.ts` |

### `voice`

| Code                 | Label                   | Fields                                                                                                                                                                                                                                                                                                               | Emitted by                                                                  |
| -------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `voice.joined`       | Joined a voice channel  | `channel` (pseudonym)<br>`native` (bool)<br>`after_ms` (ms)                                                                                                                                                                                                                                                          | `src/features/voice/roomLifecycle.ts`                                       |
| `voice.left`         | Left the voice channel  | `channel` (pseudonym)                                                                                                                                                                                                                                                                                                | `src/features/voice/roomLifecycle.ts`                                       |
| `voice.reconnecting` | Voice is reconnecting   | `attempt` (int)<br>`kind` (signal / media / full)                                                                                                                                                                                                                                                                    | `src/lib/voice/roomEventHandlers.ts`<br>`src/lib/voice/livekitReconnect.ts` |
| `voice.reconnected`  | Voice reconnected       | `after_ms` (ms)                                                                                                                                                                                                                                                                                                      | `src/lib/voice/roomEventHandlers.ts`<br>`src/lib/voice/livekitReconnect.ts` |
| `voice.disconnected` | Voice disconnected      | `reason` (unknown_reason / client_initiated / duplicate_identity / server_shutdown / participant_removed / room_deleted / state_mismatch / join_failure / migration / signal_close / room_closed / user_unavailable / user_rejected / sip_trunk_failure / connection_timeout / media_failure)<br>`unexpected` (bool) | `src/lib/voice/roomEventHandlers.ts`                                        |
| `voice.encryption`   | Call encryption changed | `state` (on / off / error)                                                                                                                                                                                                                                                                                           | `src/lib/voice/livekitE2EE.ts`                                              |

### `ice`

| Code        | Label                          | Fields                                                                                                                                                    | Emitted by                           |
| ----------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `ice.state` | Media connection state changed | `transport` (publisher / subscriber)<br>`state` (new / checking / connected / completed / failed / disconnected / closed)                                 | `src/lib/voice/roomEventHandlers.ts` |
| `ice.route` | Media route chosen             | `local_type` (host / srflx / prflx / relay / unknown)<br>`remote_type` (host / srflx / prflx / relay / unknown)<br>`protocol` (udp / tcp / tls / unknown) | `src/lib/voice/roomEventHandlers.ts` |

### `ws`

| Code                     | Label                                       | Fields                                                                                                                                       | Emitted by      |
| ------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `ws.connecting`          | Connecting to the server                    | `generation` (int)<br>`attempt` (int)<br>`host` (host)                                                                                       | `src/lib/ws.ts` |
| `ws.open`                | Server connection open                      | `generation` (int)                                                                                                                           | `src/lib/ws.ts` |
| `ws.ready`               | Server connection ready                     | `generation` (int)<br>`after_ms` (ms)                                                                                                        | `src/lib/ws.ts` |
| `ws.closed`              | Server connection closed                    | `generation` (int)<br>`close_code` (int)<br>`close_class` (normal / going_away / protocol / auth / policy / server_error / abnormal / other) | `src/lib/ws.ts` |
| `ws.reconnect_scheduled` | Reconnect to the server scheduled           | `generation` (int)<br>`attempt` (int)<br>`delay_ms` (ms)                                                                                     | `src/lib/ws.ts` |
| `ws.superseded`          | A newer server connection replaced this one | `generation` (int)<br>`by_generation` (int)                                                                                                  | `src/lib/ws.ts` |
| `ws.stale_event`         | Event from an old server connection ignored | `generation` (int)<br>`live_generation` (int)                                                                                                | `src/lib/ws.ts` |

### `events`

| Code             | Label                   | Fields                                 | Emitted by                        |
| ---------------- | ----------------------- | -------------------------------------- | --------------------------------- |
| `events.dropped` | Similar events left out | `dropped_code` (code)<br>`count` (int) | `src/lib/diagnostics/eventLog.ts` |

## Adding a code

1. Add it to `EVENT_CODES` in `eventCodes.ts` with a label, the file that
   emits it and its fields.
2. Add its row to the table above.
3. Run `npx vitest run src/lib/diagnostics/eventCodes.test.ts` from `Client/`.

A new field that needs a type not listed here, or free text, is a change to
this contract: write down why in this page first.
