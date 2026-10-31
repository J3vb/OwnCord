# Project status

The one place that says where OwnCord is now. It is short on purpose: details
live in the [changelog](../CHANGELOG.md) and the linked pages.

**A release cannot be tagged until its version has a row in the
[Releases](#releases) table below.** `release.yml` checks this before anything
builds (`scripts/release/verify-release-status.mjs`), so add the row in the release PR,
together with the changelog section.

_Last updated 2026-10-31._

## Current release

**v2.7.0**, published 2026-10-31. It is still a beta and a hobby project:
Windows and Linux desktop (x64 and ARM64), plus a sideloaded Android app (arm64). Update the server and the
desktop app together. From 2.5 on, version numbers drop the `-beta.N` suffix.

## Releases

Newest first, one line each. The full notes are the matching section of
[CHANGELOG.md](../CHANGELOG.md).

<!-- prettier-ignore -->
| Version | Date | What it brought |
| --- | --- | --- |
| v2.7.0 | 2026-10-31 | The first Android app (an APK that updates itself), a phone layout with a drawer, call bar, call screen and Push to Talk, a phone status dot, My uploads, an admin Storage page and health row, saved server logs and a voice gate in decibels. |
| v2.6.0 | 2026-10-30 | A server rail, a Media panel per channel, Discord channel import, voice channel passwords, custom CSS themes, smoother screen shares and a web client on par with desktop. |
| v2.5.0 | 2026-10-29 | Several devices at once, voice messages, stickers, videos that stream in chat, iPhone photos, animated avatars, game and music activity, zoom on streams and new role permissions. |
| v2.4.0-beta.1 | 2026-10-23 | Threads, forum channels, polls, forwarding, several roles per member, nicknames, real categories, an AFK channel, fuller group DMs, Discord-style chat and Linux on par with Windows. |
| v2.3.0-beta.1 | 2026-10-14 | A call view with tiles and pop-out, Input Mode and Push to Talk on modifier keys, a stream card with Change source, What's new after an update, faster channel switching. |
| v2.2.0-beta.3 | 2026-10-11 | Click-to-watch streams, GIF favorites, inline video, member actions behind a reverse proxy, steadier scrolling and speaking rings. |
| v2.2.0-beta.2 | 2026-10-10 | Clearer voice, steadier DM calls, a pop-out window for streams and cameras, a screen-share source picker, Linux voice fixes. |
| v2.2.0-beta.1 | 2026-10-07 | Channels open at the unread line, a Linux camera that survives a hidden window, call sounds, a fuller admin panel, one Docker container for chat and voice. |
| v2.1.0-beta.2 | 2026-10-02 | The full emoji set, server-wide search, unread count on the taskbar and tray, incoming calls noticed while hidden, a faster message list. (`v2.1.0-beta.1` was tagged but never published.) |
| v2.0.1-beta.1 | 2026-09-30 | Updates, restores and restarts no longer sign you out; voice recovers instead of dropping; rebindable global mute and deafen. |
| v2.0.0-beta.1 | 2026-09-26 | The first public beta. |

## Nightly health

- **Upgrade rehearsal and drills** (`upgrade-rehearsal.yml`): red every night
  from 2026-10-02 to 2026-10-11 in the restore drill, fixed on `dev` by #2290.
  Since #2307 every drill phase runs and a release is refused while the latest
  nightly is red or older than 72 hours.
- **Test depth** (`nightly-test-depth.yml`): fuzzing, the hub simulation, the
  long-session soak and permission mutation testing pass. The full-client
  mutation baseline does not complete yet; its `lib-rest` shard is marked
  informational until it is fixed.

## Roadmap

Work follows a phased roadmap set on 2026-10-10. In plain words:

| Phase | Goal                                                            | State                                             |
| ----- | --------------------------------------------------------------- | ------------------------------------------------- |
| 0     | Releases gated on real signals; small defects cleared           | Done (v2.4.0-beta.1)                              |
| 1     | Voice that feels like Discord, without state bugs               | Done (v2.3.0-beta.1)                              |
| 2     | Nothing disappears without an error; notifications that work    | Done (v2.4.0-beta.1)                              |
| 3     | Chat, DMs, members, navigation and settings on par with Discord | Done (v2.4.0-beta.1)                              |
| 4     | Larger servers and sturdier self-hosting                        | Done (v2.4.0-beta.1)                              |
| 5     | One owner for each piece of shared state                        | Done (v2.4.0-beta.1)                              |
| 6     | New features                                                    | Mostly done (v2.4.0-beta.1); browser client later |
| 7     | Docs that cannot drift; safe protocol changes                   | Ongoing                                           |

The older B0–B10 phase plans in [plans/](plans/README.md) are history: B9 was
the last of them, and the betas above shipped after it.
