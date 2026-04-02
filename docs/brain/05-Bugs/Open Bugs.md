# Open Bugs

## Active — Security Audit (2026-04-01)

### CRITICAL

- ~~[[BUG-092-unauthenticated-attachment-access]]~~ — **FIXED 2026-04-02** — File serving now requires auth + channel ACL

### HIGH

- ~~[[BUG-093-dm-channel-metadata-leak]]~~ — **FIXED 2026-04-02** — DM channels excluded from guild channel list
- ~~[[BUG-094-ready-flow-fails-open]]~~ — **FIXED 2026-04-02** — Role lookup failure now disconnects instead of exposing all channels
- ~~[[BUG-095-voice-state-leak-hidden-channels]]~~ — **FIXED 2026-04-02** — Voice states now filtered by visible channels
- ~~[[BUG-096-unsafe-backup-restore]]~~ — **FIXED 2026-04-02** — DB closed before restore, restart broadcast added
- ~~[[BUG-097-setup-csrf]]~~ — **FIXED 2026-04-02** — Setup endpoint now validates Origin header

## Active — Copilot Full Codebase Audit (2026-04-02)

### HIGH

- ~~[[BUG-108-password-2fa-no-session-revoke]]~~ — **FIXED 2026-04-02** — Sessions now revoked on password/2FA change
- ~~[[BUG-109-ws-revocation-delay]]~~ — **FIXED 2026-04-02** — 30s session sweep kicks revoked/expired/banned WS clients
- ~~[[BUG-116-admin-ip-proxy-collapse]]~~ — **FIXED 2026-04-02** — AdminIPRestrict uses trusted_proxies to resolve real client IP
- ~~[[BUG-122-unfocused-client-receives-all-broadcasts]]~~ — **FIXED 2026-04-02** — Unfocused client broadcast leak
- ~~[[BUG-123-reconnect-race-loses-events]]~~ — **FIXED 2026-04-02** — Register before replay closes event gap window
- ~~[[BUG-124-lossy-queues-permanent-divergence]]~~ — **FIXED 2026-04-02** — Buffer overflow disconnects client instead of silent drop
- ~~[[BUG-127-livekit-token-replay-bypass]]~~ — **FIXED 2026-04-02** — 5min token TTL + webhook validates voice_states membership
- ~~[[BUG-128-livekit-publish-permission-bypass]]~~ — **FIXED 2026-04-02** — CanPublishSources restricts track types per permission
- ~~[[BUG-133-tofu-silent-first-trust]]~~ — **FIXED 2026-04-02** — First-use cert trust shows visible notification banner
- ~~[[BUG-134-updater-disables-tls-validation]]~~ — **FIXED 2026-04-02** — Updater uses TOFU-pinned cert validation instead of disabling TLS

### MEDIUM

- [[BUG-110-login-throttle-ip-only]] — Login throttling is IP-only, distributed brute force bypasses it
- [[BUG-111-password-confirm-no-user-lockout]] — Password-confirmation endpoints have no per-user lockout
- [[BUG-112-proxy-ip-header-spoofable]] — Trusted proxy IP headers spoofable, bypasses rate limits
- [[BUG-113-ban-ws-enforcement-delay]] — Banned users retain WS access until periodic recheck triggers
- [[BUG-118-uploads-unrestricted-inline-content]] — Uploads serve unrestricted inline content, no throttle
- ~~[[BUG-119-setup-race-multiple-owners]]~~ — **FIXED 2026-04-02** — Atomic CreateOwnerIfEmpty prevents TOCTOU race
- [[BUG-125-dm-traffic-bypasses-sequencing]] — DM traffic bypasses seq stamping and ring-buffer replay
- ~~[[BUG-126-deleted-messages-remain-mutable]]~~ — **FIXED 2026-04-02** — Deleted messages no longer editable/reactable
- [[BUG-131-upload-no-quota-disk-exhaust]] — No upload rate limit/quota, temp disk exhaustion
- [[BUG-135-token-persisted-without-remember]] — Session token persisted even when "Remember password" unchecked
- [[BUG-136-ptt-global-key-capture]] — ptt_listen_for_key is a global key-capture primitive
- [[BUG-137-renderer-broad-native-blast-radius]] — Renderer compromise has broad native blast radius
- [[BUG-138-selfsigned-cert-is-ca]] — Self-signed certs generated as CA with IsCA:true
- [[BUG-139-ci-supply-chain-hardening]] — CI supply-chain: mutable tool installs, tag-pinned actions

### LOW

- [[BUG-121-diagnostics-info-leak-no-throttle]] — Diagnostics leaks internal topology, missing documented throttle
- [[BUG-132-orphan-cleanup-race-deletes-linked-file]] — Orphan cleanup race can delete linked file

## Active — Client Voice Audit (2026-04-01)

### HIGH

- ~~[[BUG-098-reconnect-leaks-video-tracks]]~~ — **FIXED 2026-04-02** — teardownForReconnect now stops camera/screen tracks before room is nulled

### MEDIUM

- [[BUG-099-reconnect-skips-saved-devices]] — Auto-reconnect never reapplies saved audio input/output devices
- [[BUG-100-video-track-leak-on-publish-fail]] — Camera/screenshare track keeps capturing if publishTrack fails
- [[BUG-101-no-screen-track-ended-handler]] — OS "Stop sharing" doesn't trigger app disable path, state stuck
- [[BUG-102-screenshare-volume-slider-broken]] — Screenshare tile volume slider only toggles mute, ignores intermediate values
- [[BUG-103-retry-mic-ignores-deafened]] — retryMicPermission publishes mic even when user is deafened
- [[BUG-104-scroll-collapse-listener-accumulation]] — VoiceChannel scroll listeners accumulate on every re-render
- [[BUG-105-video-grid-no-auto-open]] — Video grid never auto-opens when local camera/screenshare starts

### LOW

- [[BUG-106-replacetrack-race-on-rebuild]] — replaceTrack() fire-and-forget race on rapid pipeline rebuild
- [[BUG-107-cleanup-audio-no-srcobject-null]] — Emergency audio cleanup doesn't clear srcObject/pause elements

## Resolved — Server Deep Review (2026-04-01)

### HIGH

- ~~[[BUG-084-broadcast-filter-drops-messages]]~~ — **FIXED 2026-04-01** — T-404
- ~~[[BUG-085-ringbuffer-off-by-one]]~~ — **FIXED 2026-04-01** — T-405
- ~~[[BUG-086-voice-leave-goroutine-leak]]~~ — **FIXED 2026-04-01** — T-406
- ~~[[BUG-087-gracefulstop-not-idempotent]]~~ — **FIXED 2026-04-01** — T-407
- ~~[[BUG-088-voice-capacity-bypass]]~~ — **FIXED 2026-04-01** — T-408
- ~~[[BUG-089-removeparticipant-race]]~~ — **FIXED 2026-04-01** — T-409

## Resolved — Client Voice Pipeline (2026-04-01)

- ~~[[BUG-071-voice-pipeline-cleanup-leaks]]~~ — **FIXED 2026-04-01**
- ~~[[BUG-059-native-e2e-reliability]]~~ — **FIXED 2026-04-01**

## Resolved — Testing Quality (2026-03-28)

- ~~[[BUG-058-prod-build-e2e-blocked]]~~ — **FIXED 2026-04-01**
- ~~[[BUG-060-rust-zero-test-coverage]]~~ — **FIXED 2026-04-01**
- ~~[[BUG-061-low-signal-test-remediation]]~~ — **FIXED 2026-04-01**
- ~~[[BUG-064-client-integration-thin]]~~ — **FIXED 2026-04-01**

## Resolved — Earlier

- BUG-001 through BUG-014 — resolved 2026-03-17 through 2026-03-21
- BUG-046 through BUG-057 — resolved 2026-03-28
- BUG-062, BUG-063, BUG-065–BUG-067, BUG-072, BUG-073 — merged 2026-04-01
- BUG-074 — DevTools in prod (open, merged audit details from BUG-140)
- BUG-084–BUG-091 — fixed 2026-04-01 (server bug fix phases 1 & 2)

## Merged Duplicates (2026-04-02)

Audit duplicates merged into originals — files deleted:
- ~~BUG-114~~ → merged into BUG-093 (DM metadata leak)
- ~~BUG-115~~ → merged into BUG-097 (setup CSRF, upgraded to HIGH)
- ~~BUG-117~~ → merged into BUG-112 (proxy IP spoofing, added LiveKit endpoint)
- ~~BUG-120~~ → merged into BUG-096 (backup restore, added line numbers)
- ~~BUG-129~~ → merged into BUG-092 (attachment access, added no-ACL detail)
- ~~BUG-130~~ → merged into BUG-118 (upload inline, added SVG/XML/PDF detail)
- ~~BUG-140~~ → merged into BUG-074 (devtools, added affected file list)
