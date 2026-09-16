# Plan: B6-13 — Operator documentation

**Source PRD**: `docs/plans/b6-server-deployment-operations-capacity.prd.md`
**Selected Milestone**: B6-13 — Operator documentation (roadmap workstream 12)
**Satisfies**: the PRD row "Local logs, support-bundle generation, capacity limits, ports, storage growth, certificate trust, recovery, updates and safe failure are all documented for a stranger", and the HP-6 evidence line "operator usability record" — an owner "with ordinary sysadmin skill and no access to the codebase or its authors" (PRD, Users) completes every HP-6 task from the docs alone
**Complexity**: Medium
**Drafted**: 2026-09-15 at `dev` `96258158`; B6-10 is in flight on `feat/b6-10-operational-measurements` (touches `docs/api.md`, `docs/deployment.md:738-756` and the PRD — not `docs/capacity.md`), B6-11's plan is drafted but unmerged (it will touch `docs/deployment.md` Restore and Health), and B6-12 adds "Verifying a download" after Auto-Update. All three boundaries are handled in Task 0. `docs/deployment.md` lines are cited from the B6-10 working tree (dev + 5 lines after `:738`)

## Summary

Almost everything the row names is already written down **somewhere** — but a
stranger reads `docs/deployment.md`, not `docs/architecture/diagnostics.md`,
and does not know that the support bundle is finished, that the server keeps no
log file, or that thirteen sweeps run every fifteen minutes when the Deployment
Guide lists three. B6-13 is a documentation milestone with **no server code**:
it moves the operator-facing facts to where an operator looks, corrects the
sentences the code contradicts, and writes the four things nobody has written
(where logs actually go per supervisor, what grows on disk and what prunes it,
how to rotate a self-signed certificate, and how to read a failure).

The row's nine requirements, what is written and where:

| #   | Row says                  | What is written                                                                                                                                                                                                                     | Where                                                                          |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | local logs                | stdout only, no file; where each supervisor puts stdout (journal, Docker json-file 10 MB, NSSM discards it unless told); `logging.level`; what is redacted by construction; the admin panel live view                               | `docs/deployment.md` new "Logs" under Monitoring; NSSM block gains `AppStdout` |
| 2   | support-bundle generation | the panel flow (Diagnostics → preview → confirm), what the ZIP holds and what it never holds, that nothing uploads; pointer to the contract                                                                                         | `docs/deployment.md` new "Support bundle" under Monitoring                     |
| 3   | capacity limits           | the qualified profile, the configured ceilings an owner hits first (`max_ws_connections`, `max_readers`, upload size/quota, disk floor, rate-limit multiplier), and which metric says which one is near                             | `docs/deployment.md` new "Capacity limits" pointing at `docs/capacity.md`      |
| 4   | ports                     | one canonical table; `port-forwarding.md` gains the missing port 80 row; the other two tables point at the canonical one                                                                                                            | `docs/deployment.md` Firewall and Ports; `docs/port-forwarding.md`             |
| 5   | storage growth            | every file under `data/`, who writes it, what bounds it, what prunes it, and what is never pruned (`audit_log`)                                                                                                                     | `docs/deployment.md` new "Storage growth" after Backup Strategy                |
| 6   | certificate trust         | per mode: who trusts what, the 2-year self-signed lifetime and that nothing renews or reloads it, how to rotate it and what every client then sees; the deferred-TLS boundary stated where a stranger reads TLS Setup, not Firewall | `docs/deployment.md` TLS Setup                                                 |
| 7   | recovery                  | the backup **set** (database + uploads + three keys + marker file + config), restore vs rollback, what a restore cannot bring back; extends, never duplicates, B6-11's paragraphs                                                   | `docs/deployment.md` Backup Strategy / Restore                                 |
| 8   | updates                   | already complete; adds the failure half (`update_failed`, `.old`, what a half-applied update looks like) and the pre-check list                                                                                                     | `docs/deployment.md` Auto-Update                                               |
| 9   | safe failure              | a symptom-first table: what the operator sees (health `reason`, a startup refusal, an SFU that is down, a full disk, a refused update) → what it means → what to do                                                                 | `docs/deployment.md` new "When it fails"; `docs/README.md` Start-here row      |

**No sentence is written that the code does not back.** Every paragraph cites
the source it was read from in the PR description, and the two claims this plan
could not settle from source (rows marked Unknown below) are measured before
they are written.

## Verify before you implement

Facts established from source at `96258158`. Rows marked **Refuted**,
**Corrected** or **Unknown** contradict something the roadmap, the PRD, the
existing docs or an obvious first design would assume, and the plan is built on
the correction.

| Claim                                                                  | Status        | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Support-bundle generation must be built for the row to hold            | **Refuted**   | Implemented: `Server/admin/api.go:234-235` mounts `/support-bundles/preview` and `/download` behind `ADMINISTRATOR`; `Server/admin/support_bundle.go:146,176,220` preview/download/collect; six fixed ZIP files, 256 KiB cap, 5-minute preview TTL (`docs/architecture/diagnostics.md:197-233`). Tests named at `:242-250`. **No guidance doc mentions it** — grep of `docs/*.md` finds only `security.md:231` calling it "a future support bundle" |
| The server writes a log file                                           | **Refuted**   | `Server/main.go:45-49`: `slog.NewTextHandler(os.Stdout)` wrapped by `admin.NewMultiHandler` into the ring buffer; `LoggingConfig` has one field, `Level` (`Server/config/config.go:62-67`). No file, no rotation, no `logging.file` key. Where stdout lands is the supervisor's business, and the docs say so nowhere                                                                                                                               |
| Each supported supervisor captures stdout                              | **Corrected** | systemd: journal (`deploy/owncord.service:11` `journalctl -u owncord -f`). Docker: `json-file`, `max-size: "10m"` (`Server/docker-compose.yml:15-18,55`). **NSSM: the documented install sets no `AppStdout`/`AppStderr`** (`docs/deployment.md:243-253`), so a Windows service discards every log line. Task Scheduler (`:261-272`) likewise                                                                                                       |
| Secrets can appear in the log if a call site is careless               | **Confirmed** | Redaction is by construction: `Server/config/logvalue.go:5-15,23,38` — `slog.LogValuer` on `VoiceConfig` and `GitHubConfig`; `Server/logctx/logctx.go:24-36` adds `req_id` to every record. Usernames, ids and client addresses **do** appear at `info` (`diagnostics.md:34-36`; data-lifecycle class 22 at `data-lifecycle.md:415`) — the doc says so rather than implying the log is clean                                                        |
| `owncord --healthcheck` is the container probe                         | **Corrected** | `diagnostics.md:33` says `owncord --healthcheck`; the binary is `chatserver healthcheck` — `Server/main.go:22-25`, `Server/Dockerfile:58-59`, and `docs/deployment.md:73-76` already has it right. One line in the architecture doc is fixed in passing                                                                                                                                                                                             |
| `/health` names the failing subsystem                                  | **Confirmed** | `Server/api/router.go:585-592` `reason` ∈ `hub`/`database`/`disk`, first failure wins (`:697-714`); 5 s cache, 1 s DB ping (`:611-618`); `docs/deployment.md:687-711` already documents it. Voice is **not** on `/health` — it is `livekit_healthy` on `/api/v1/metrics` (`deployment.md:727`) and `GET /api/v1/livekit/health` (`:764-766`)                                                                                                        |
| The Deployment Guide's "Background Maintenance" list is current        | **Refuted**   | `docs/deployment.md:852-858` lists three things. `Server/internal/app/maintenance.go:161-179` runs **thirteen** steps per 15-minute tick: sessions, delivery receipts, second-factor state, push subscriptions, backups, orphans, retention, report content, moderation actions, voice mutes, erasure resume, file reconciliation, storage recount. The section is rewritten from `steps()`                                                         |
| Backup retention is a config key                                       | **Confirmed** | It is an admin-panel **setting**, not a key: `backup_schedule` / `backup_retention` read from `settings` (`Server/admin/backup_maintenance.go:25,40,121-128`); `BackupConfig` has only `Dir` (`config.go:378-380`). `deployment.md:400-410` already says so; the storage-growth section cites it rather than inventing a key                                                                                                                        |
| The built-in backup is the whole recovery set                          | **Refuted**   | Database only (`deployment.md:364-366`; `data-lifecycle.md:224-226`). The set is `data/uploads/`, `totp.key`, `erasure.key`, `erasure/markers.sqlite`, `push_vapid.key`, `config.yaml` — each with its loss cost already written at `deployment.md:500-553` under **Upgrade**, where a stranger doing a routine backup never reads it. Task 4 moves the list to Backup Strategy and leaves a pointer                                                |
| `audit_log` is pruned                                                  | **Refuted**   | No maintenance step touches it (`maintenance.go:161-179`); no `audit_log` delete outside erasure unlinking (`security.md:244-252`). It grows for the life of the server. The storage-growth table says "never pruned" rather than omitting the row                                                                                                                                                                                                  |
| A full `data/` inventory exists in one place                           | **Refuted**   | Scattered: `chatserver.db` `config.go:423`; `backups/` `:426`; `cert.pem`/`key.pem` `:430-431`; `acme_certs/` `:432`; `uploads/` `:436`; `plugins/` `:467`; `livekit/` `:573` and `Server/ws/livekit_download.go:8,82`; `totp.key`/`erasure.key`/`push_vapid.key` `Server/internal/app/lifecycle.go:198-202`; `erasure/markers.sqlite` `Server/internal/app/erasure.go:21`. Task 3 writes the table                                                 |
| What grows, and what bounds it                                         | **Confirmed** | uploads: `upload.max_size_mb` 100, `user_quota_mb` 0 = unlimited (`server-configuration.md:81-88`), orphans swept after 1 h (`data-lifecycle.md:196-206`), reconciliation ≤ 500 files/tick (`:210`), retention sweep 5 000 msg/tick (`:324-335`); `events` 24 h / pruner 60 min / ring 1000 / cold 5000 (`server-configuration.md:163-172`); report content 180 d, actions 90 d (`:226-236`); disk floor 256 MB (`config.go:255-257`)               |
| The self-signed certificate renews itself                              | **Refuted**   | `Server/auth/tls.go:62` `NotAfter: now + 2 years`; `:124-134` generates **only when a file is absent** and never checks expiry; `:138-148` `loadCertPair` loads once — no reload. `acme` alone has `GetCertificate` (`:223`). An expired self-signed certificate is served until the operator deletes the pair; `deployment.md:540-546` already states the load-if-present rule                                                                     |
| A desktop client rejects an expired-but-pinned self-signed certificate | **Unknown**   | The pin is the SHA-256 of the leaf (`docs/trust-model.md:164`) and "the desktop does not validate a public-CA certificate against the CA list" (`:172-181`). Whether `tofu.rs` also skips the validity window is not stated. Task 5 measures with a certificate generated with `NotAfter` in the past before the sentence is written; a browser client is out of scope (B7)                                                                         |
| Rotating a self-signed certificate is documented                       | **Refuted**   | Only the consequence is: "clients lose their pinned certificate" (`deployment.md:544-546`), the mismatch modal (`trust-model.md:164-171`), and the out-of-band fingerprint rule (`:27-33`). No procedure. HP-6 says the owner "rotates trust" (`roadmap:857-861`) — Task 5 writes it                                                                                                                                                                |
| The deferred-TLS boundary is stated where TLS is configured            | **Corrected** | It is stated under **Firewall and Ports** (`deployment.md:828-834`) and in `port-forwarding.md:164-181`; the TLS Setup section (`deployment.md:274-318`) that a stranger reads to choose a mode says nothing about it. Task 5 puts one paragraph there; the PRD's wording rule is "implemented, not exercised at release quality" for domain ACME and "do not claim a public-IP or offline TLS story" (PRD `:186-190`)                              |
| The three port tables agree                                            | **Corrected** | `deployment.md:816-826` (5 rows incl. port 80 for ACME), `port-forwarding.md:50-64` (4 rows, **no port 80**), `livekit-setup.md:112-118` (3 LiveKit rows), `security.md:329` (prose). Numbers agree; the port-forwarding guide — the one a stranger opens to open ports — omits the ACME port. One row added; the others keep their tables and gain a "canonical table" pointer                                                                     |
| Update failure is documented                                           | **Corrected** | Success path is complete (`deployment.md:772-807`, `:554-570`). The audit rows `update_apply`/`update_applied`/`update_failed` exist (`security.md:241-242`), `.old` rotation and its deletion (`:596-598`, `:787-789,795-796`), Docker refusal `503 CONTAINER_DEPLOYMENT` (`:150-157`). What a **failed** apply looks like from the outside is written nowhere. Task 6 adds it from those sources                                                  |
| B6-11 owns the disk-stage and backup-set paragraphs in `deployment.md` | **Confirmed** | `.claude/plans/b6-11-failure-recovery-drills.plan.md:121,397-400`: "one paragraph under Restore … under Health: what disk-full looks like. B6-13 owns the full operator docs". B6-11 is unmerged (`git status`: `??`). Task 0 decides the order; this plan writes around those two paragraphs, never over them                                                                                                                                      |
| `npm run check:docs` checks links                                      | **Refuted**   | `scripts/run.mjs:150-160`: `check-doc-counts.mjs`, `check-migrations`, ledger render. No link checker. Prettier is `check:hygiene` (`:179`); gendocs drift is `DOCS_VERIFY` inside `check:server` (`:74-80,129`). Anchors this plan adds are verified by hand (Task 7), and no `gendocs:` block is hand-edited (`.claude/rules/gendocs.md`)                                                                                                         |
| `docs/README.md` must list every document                              | **Confirmed** | `docs/README.md:3-4` "If it is not on this page it is not current guidance"; the Start-here table (`:14-24`) has no "something is wrong" row. This plan creates **no new document**, so only that row changes                                                                                                                                                                                                                                       |
| `.claude/plans/` is tracked and Prettier-gated                         | **Confirmed** | `.gitignore` whitelist; PRD decision 2026-09-08                                                                                                                                                                                                                                                                                                                                                                                                     |

### What the corrections change

- **This milestone forces no code.** The support bundle exists, the health
  verdict is honest, the maintenance sweeps exist, the redaction is by
  construction. Every gap is a sentence in the wrong document or a sentence
  never written. The only file outside `docs/` this plan touches is
  `CHANGELOG.md`.
- **"Local logs" is a per-supervisor answer, not a server feature.** The doc
  says "the server writes to stdout and keeps the last N lines in memory for
  the admin panel; here is where each supervisor puts stdout" — and the NSSM
  block gains the two `nssm set` lines without which a Windows service has no
  logs at all.
- **The recovery set moves to where recovery is read.** The loss-cost list at
  `deployment.md:500-553` is the best paragraph in the guide and is filed
  under "Before upgrading". Backup Strategy gets the list; Upgrade keeps a
  one-line pointer. Nothing is written twice.
- **Certificate trust documents what exists and names what is unqualified**,
  in the TLS Setup section, using the PRD's own wording. It does not describe
  the ACME renewal or the LAN/offline install that B6-3–B6-5 will build.
- **"Safe failure" is written symptom-first.** The stranger has a 503, a
  refused start, or silence in a voice channel; the table starts from that,
  not from the subsystem.

## Patterns to Mirror

| Category                        | Source                                     | Pattern                                                                                                                        |
| ------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Loss-cost list                  | `docs/deployment.md:500-553`               | one bullet per file: the file, what breaks without it, why, and the way back — no bullet without a consequence                 |
| Honest boundary paragraph       | `docs/port-forwarding.md:164-181`          | "Stated plainly so it is not discovered at the worst moment" — a bold negative, then what to do instead                        |
| Symptom → cause → action        | `docs/port-forwarding.md:101-162`          | one `###` per symptom ("Blocked ports", "CGNAT"), how to tell, what to do; the shape for "When it fails"                       |
| Metric → what it means → action | `docs/deployment.md:748-762`               | "`broadcast_drops` growing at all → … alert on any growth"; the capacity-limits list uses the same arrow shape                 |
| Cite the code, not the belief   | `docs/trust-model.md:157-181`              | every claim carries `file:line` and the test that proves it; the PR description for this milestone does the same per paragraph |
| Rules for a generated block     | `.claude/rules/gendocs.md`                 | never edit inside `gendocs:*`; the config key index is regenerated, not hand-written                                           |
| Reference stays reference       | `docs/architecture/diagnostics.md:149-250` | the bundle **contract** lives there; the guide says what an operator does and links down — it does not copy the table          |
| Changelog entry                 | `CHANGELOG.md:16-35`                       | grouped, one line per change, "what was wrong, what it does now"                                                               |
| Plan-row handoff                | B6-11 plan Task 6                          | the PRD row flips `in-progress` → `complete` with the plan linked, and the next milestone is told what already exists          |

## Files to Change

| File                                  | Action | Why                                                                                                                                                                                                                             |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/deployment.md`                  | UPDATE | Logs, Support bundle, Capacity limits, Storage growth, When it fails (new sections); TLS Setup, Backup Strategy, Restore, Auto-Update, Background Maintenance, NSSM block, Firewall and Ports, See Also (extended or corrected) |
| `docs/port-forwarding.md`             | UPDATE | port 80 row under Required Ports; one sentence naming `deployment.md` as the canonical table                                                                                                                                    |
| `docs/livekit-setup.md`               | UPDATE | one sentence under "3. Ports and Firewall" pointing at the canonical table (its own three rows stay)                                                                                                                            |
| `docs/security.md`                    | UPDATE | `:231` "a future support bundle" → "the support bundle" with the guide link; the operator checklist (`:320-335`) gains "capture stdout" and "back up the set, not the database"                                                 |
| `docs/architecture/diagnostics.md`    | UPDATE | `:33` `owncord --healthcheck` → `chatserver healthcheck`; a one-line link from the implemented-bundle section to the guide                                                                                                      |
| `docs/README.md`                      | UPDATE | Start-here row "Something is wrong → deployment.md#when-it-fails"; the deployment.md "Covers" cell names operations                                                                                                             |
| `CHANGELOG.md`, `docs/plans/b6-*.prd` | UPDATE | unreleased entry; B6-13 row → `in-progress` now, `complete` + this link at the end                                                                                                                                              |

No new document, no new script, no server change, no `gendocs:` block touched.
`docs/deployment.md` grows from 878 lines (B6-10 tree; 873 on `dev`) to roughly 1 100; that is the cost of
one guide over two, and the See Also plus the README row keep it navigable.

## Tasks

### Task 0: Branch, PRD row, and the two in-flight boundaries

- **Action**: branch `feat/b6-13-operator-documentation` from `dev`. Flip the
  PRD row to `in-progress` with this plan linked. Then:
  - `git diff --stat dev...feat/b6-10-operational-measurements -- docs/` —
    B6-10 edits `docs/api.md`, `docs/deployment.md:738-756` (the
    reader-pool metric rows) and the PRD; it does **not** edit
    `docs/capacity.md`. This plan does not edit `capacity.md` either; the
    Capacity-limits section links to it by heading. Task 2's
    `db_reader_wait_seconds` row exists **only on the B6-10 branch**
    (`metrics_handler.go`): this plan lands after B6-10, or that one metric
    row is written as "once B6-10 lands" and filled by the rebase — never a
    metric name the tree does not export.
  - B6-11 is unmerged. Its plan reserves two paragraphs in `deployment.md`
    (Restore: "a backup **set** is …"; Health: "the three disk stages"). If
    B6-11 lands first, Task 4 and Task 6 **extend** those paragraphs; if this
    branch lands first, Task 4 writes the backup-set paragraph from the
    sources cited here and B6-11 adds only its drill result to it. Either
    way the sentence is written once — record which order happened in the PR.
  - B6-12 adds "Verifying a download" as a new section **after** Auto-Update
    (`:772-815`); Task 6's "If the update fails" block goes **inside**
    Auto-Update, after the five-step apply. Adjacent, not overlapping;
    whichever lands second rebases and re-reads the section once.
- **Why**: the same file, two branches, one month.
- **Validate**: `npm run format` clean; PRD row renders.

### Task 1: Logs — where they are, what is in them, what is not

- **Action**: `docs/deployment.md`, a new `### Logs` under Monitoring, before
  Health Endpoint:
  - The server writes its log to **stdout** as `slog` text and keeps the most
    recent lines in memory for the admin panel's live view; there is **no
    log file and no rotation in the server** (`main.go:45-49`). One key,
    `logging.level` (`debug`/`info`/`warn`/`error`, default `info`,
    `OWNCORD_LOGGING_LEVEL` overrides without editing the file —
    `server-configuration.md:217-224`).
  - A three-row table, one per supervisor: **systemd** → `journalctl -u
owncord -f`, retention is journald's (`deploy/owncord.service:11`);
    **Docker** → `docker compose logs -f owncord`, the shipped compose file
    caps the json-file driver at 10 MB per file (`docker-compose.yml:15-18`);
    **NSSM** → nothing, unless `AppStdout`/`AppStderr` are set — and the NSSM
    block at `:240-258` gains the two lines:
    ```powershell
    nssm set OwnCord AppStdout "C:\OwnCord\logs\server.log"
    nssm set OwnCord AppStderr "C:\OwnCord\logs\server.log"
    nssm set OwnCord AppRotateFiles 1
    ```
    Task Scheduler (`:261-272`) gets one sentence: redirect stdout in the
    action or the log is gone.
  - What is in a log line: `time level msg key=value…`, `req_id` on every
    request-scoped record (`logctx.go:24-36`). What is **never** in it by
    construction: the LiveKit key/secret and the GitHub token
    (`logvalue.go:23,38`). What **is** in it at `info`: usernames, ids and
    client addresses (`diagnostics.md:34-36`) — so a log excerpt is personal
    data and the support bundle deliberately omits raw lines.
  - The admin panel live view is the same stream at the same level, through
    a single-use SSE ticket (`diagnostics.md:28`).
- **Why**: row item 1. A stranger on Windows following the current NSSM
  block has no logs and no way to know it.
- **Gotcha**: do not promise a log file path for systemd or Docker; those are
  the supervisor's defaults and the doc says "where your supervisor puts
  stdout", then gives the command that reads it.
- **Validate**: each command in the table run once locally on the platform it
  names (journalctl on WSL is not systemd — run the NSSM lines on Windows,
  the compose line on Linux/WSL with Docker, and cite the systemd line from
  the unit file).

### Task 2: Support bundle and capacity limits

- **Action**:
  - `docs/deployment.md`, new `### Support bundle` under Monitoring after
    Diagnostics. The panel flow in the operator's words: Admin panel →
    Diagnostics → **Create support bundle preview** → review the item list,
    sizes and hashes → **Confirm download**. The six files and one line
    each on what is in them (from `diagnostics.md:213-222`), then the
    negative list that matters to the person deciding whether to send it to
    a stranger on GitHub: no messages, no usernames, no addresses, no
    configuration strings, no raw log lines, no uploads, no backups
    (`:224-233`). It never uploads; a `support_bundle_create` audit row is
    written with the item list only (`:239-240`). Requires a logged-in
    `ADMINISTRATOR` session — an API token is refused (`:210-211`). One
    link to `architecture/diagnostics.md#support-bundle-data-contract` for
    the contract; the table is not copied.
  - `docs/security.md:231` reworded from "a future support bundle" to the
    present tense with the guide link. `diagnostics.md:33` corrected to
    `chatserver healthcheck`.
  - `docs/deployment.md`, new `## Capacity limits` before Monitoring:
    - the qualified profile in one sentence with the link to
      `capacity.md#the-profile` and `#reference-hardware` (250 / 100 / 25 on
      2 vCPU / 4 GB — `capacity.md:12-18`, PRD `:70`);
    - the ceilings an owner configures, each with its default, its symptom
      and its metric: `server.max_ws_connections` (0 = unlimited,
      `config.go:265-271`; refusal is a 503 before the upgrade;
      `ws_conn_rejects`), `database.max_readers` (0 = max(4, CPUs),
      `server-configuration.md:66`; `db_reader_wait_seconds` — B6-10's
      metric, written only once that branch is under this one, Task 0),
      `upload.max_size_mb` 100 and `upload.user_quota_mb` 0
      (`:81-88`; `507 STORAGE_QUOTA_EXCEEDED`; `upload_storage_used_mb`),
      `server.min_free_disk_mb` 256 (`config.go:255-257`; `disk_low`,
      `507 STORAGE_LOW_DISK`, health `degraded/disk`),
      `security.auth_rate_limit_multiplier` for communities behind one NAT
      (`server-configuration.md:78`; `429 RATE_LIMITED`);
    - the metric-reading list already at `:748-762` is referenced, not
      repeated.
- **Why**: row items 2 and 3. The bundle is finished and invisible; the
  limits exist as config keys and nobody has said which one a growing
  community hits first.
- **Mirror**: `deployment.md:748-762` for the arrow shape.
- **Validate**: run the bundle flow once on a local server and confirm the
  six file names in the ZIP match the list written; every config key named
  exists in the generated key index at `server-configuration.md:239-313`
  (the index is generated — read it, never edit it).

### Task 3: Storage growth

- **Action**: `docs/deployment.md`, new `## Storage growth` after Backup
  Strategy. One table of everything under `server.data_dir` (`config.go:225,406`):

  | Path                                        | Written by                                       | Bounded by                                                         | Pruned by                                                                                         |
  | ------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
  | `chatserver.db` + `-wal`                    | everything                                       | messages: server/channel retention (`0` = forever); `events`: 24 h | retention sweep ≤ 5 000 msg/tick; events pruner every 60 min; WAL truncated after an erasure      |
  | `uploads/`                                  | attachments, avatars, emoji                      | `upload.max_size_mb`, `upload.user_quota_mb` (0 = unlimited)       | orphan sweep (unlinked > 1 h), retention sweep, erasure, reconciliation ≤ 500 files/tick          |
  | `backups/`                                  | manual and scheduled backups, `pre_restore_*.db` | `backup_retention` days (panel setting)                            | keeps the newest always; `pre_restore_*` copies are **not** distinguished — they age out the same |
  | `acme_certs/`                               | ACME mode only                                   | one certificate                                                    | autocert                                                                                          |
  | `livekit/`                                  | `voice.auto_download_livekit`                    | one pinned release                                                 | never (delete by hand to force a re-download)                                                     |
  | `plugins/`                                  | `-tags wazero` builds only                       | —                                                                  | never                                                                                             |
  | `cert.pem`, `key.pem`                       | first run, `self_signed`                         | —                                                                  | never (Task 5 rotation)                                                                           |
  | `totp.key`, `erasure.key`, `push_vapid.key` | first run                                        | 3 small files                                                      | never — and must never be                                                                         |
  | `erasure/markers.sqlite`                    | every erasure and every swept channel            | one row per erased account / swept channel                         | never; small by construction                                                                      |

  Then three paragraphs the table cannot carry:
  - **`audit_log` is never pruned.** No maintenance step touches it
    (`maintenance.go:161-179`); it is the trail. On a busy server it is the
    slowest-growing large table, not the fastest, but it is unbounded and
    the doc says so.
  - **Retention is off by default** (`data-lifecycle.md:326-328`
    `settings.retention_days = 0`); message growth is unbounded until the
    owner sets a window in the panel, and `GET /admin/api/retention/preview`
    shows the effect before it runs (`:362-363`). Pinned messages and DMs
    are never swept (`:398`).
  - **Report content 180 d, moderation actions 90 d** (`server-configuration.md:226-236`).
  - **The disk floor.** All of the above shares one volume with the WAL; the
    server stops accepting uploads at `min_free_disk_mb` and reports
    `degraded/disk`, and messages keep flowing (`router.go:603-608`). What
    happens below that is B6-11's paragraph under Health — linked, not
    rewritten.
  - **Background Maintenance** (`:852-858`) is rewritten as the thirteen
    steps from `maintenance.go:161-179` in the order they run, one line
    each, with "every 15 minutes; a failing step is logged and the rest of
    the pass still runs; five consecutive failures open a circuit breaker
    that skips one tick" (`:16-19,138-147`).

- **Why**: row item 5. The inventory exists only as nine scattered defaults
  in `config.go`; the growth rules only in an architecture document.
- **Gotcha**: the `pre_restore_*` copies age out under `backup_retention`
  like any other backup — a fact, not a guess: `pruneExpiredBackups`
  (`backup_maintenance.go:142-155`) iterates `scanBackups()` by mtime, keeps
  only the newest, and applies no name filter, so a `pre_restore_*` file older
  than the window is removed like any other. Write "not distinguished";
  whether they **should** be exempt is question 1.
- **Validate**: every default in the table matches `server-configuration.md`'s
  generated index; every "pruned by" names a `steps()` entry or a config key.

### Task 4: Recovery — the set, the restore, the rollback

- **Action**: `docs/deployment.md` Backup Strategy (`:362-428`):
  - the opening paragraph (`:364-366`) becomes the **backup set**: the
    database backup plus `data/uploads/`, `data/totp.key`,
    `data/erasure.key`, `data/erasure/markers.sqlite`, `data/push_vapid.key`
    and `config.yaml`. The loss-cost bullets move here from `:500-553`
    verbatim (they are correct and cite their sources); the Upgrade section
    keeps "Copy `data/` wholesale" and a one-line pointer up. If B6-11
    landed first, its "backup set" paragraph under Restore is the anchor and
    this list attaches to it.
  - **Restore** (`:426-428`) grows from two sentences to what actually
    happens, in the operator's order: integrity check of the file → audit
    row → `pre_restore_<ts>.db` safety copy → clients told to reconnect →
    the server exits and the supervisor relaunches it (or it relaunches
    itself under `restart_mode: spawn`) → on the first boot every deletion
    marker recorded after the backup is replayed before anything serves
    (`data-lifecycle.md:228-235`, `security.md:169-172`). Then what a
    restore **cannot** bring back: uploads (never in it), and anything
    after the backup's `VACUUM INTO` — accounts, messages, settings, bans
    (`data-lifecycle.md` O4 A5). And the two refusals the marker file can
    produce at boot, by pointer to `security.md#erasure-marker-key`
    (`:182-220`) — the SQL is there, not copied.
  - **Restore is not rollback**: the sentence at `:640-644` is right and
    stays; Backup Strategy gains the same one line pointing at Rolling back.
- **Why**: row item 7, and HP-6 "recover a backup". The information exists;
  it is filed under Upgrade and split across three documents.
- **Validate**: the moved bullets are byte-identical (diff the two
  revisions); the restore sequence matches `handlers_backup.go:188-341` as
  B6-11's plan read it (this plan does not re-verify the code — it cites
  B6-11's Confirmed row and `data-lifecycle.md:228-235`).

### Task 5: Certificate trust — what exists, how to rotate it, what is not qualified

- **Action**: `docs/deployment.md` TLS Setup (`:274-318`):
  - One paragraph before the four modes: the deferred boundary, in the PRD's
    words — self-signed is qualified and the default; domain ACME is
    implemented but not exercised at release quality; there is no HTTPS on a
    bare public IP and no guided LAN/offline device-trust install; the
    certificate lifecycle (renewal state across restart, hot reload,
    rotation with margin) is not qualified (PRD `:180-190`;
    `port-forwarding.md:164-181`). The duplicate paragraph under Firewall
    (`:828-834`) shrinks to one line pointing here.
  - **Self-Signed** (`:280-287`) gains: generated on first run, valid **two
    years** (`tls.go:62`), loaded as-is on every later start and never
    checked for expiry or reloaded while running (`:124-148`). The desktop
    client pins the leaf fingerprint on first connect and shows a mismatch
    modal if it changes (`trust-model.md:157-171`). A `#### Rotating the
self-signed certificate` procedure: stop; move `data/cert.pem` and
    `data/key.pem` aside; start (a fresh pair is generated, `:128-132`);
    read the new fingerprint from the startup banner; **every desktop
    client sees the mismatch modal and must accept the new fingerprint**,
    which they should compare with the one you publish out of band
    (`trust-model.md:27-33`); there is no server-side push of a new pin.
    Plus the Unknown row: **measure** whether a desktop client connects to
    an expired-but-pinned certificate (generate a pair with `NotAfter` in
    the past using the same `GenerateSelfSigned` shape, point a client at
    it) and write the measured sentence — "the desktop keeps connecting
    past expiry because the pin is the fingerprint, not the validity" or
    "the desktop refuses at expiry; rotate before the two years are up" —
    never the guess.
  - **ACME** (`:289-298`): add the facts a stranger needs and nothing about
    renewal quality: port 80 must be reachable from the internet
    (`:820`, HTTP-01), the hostname must resolve to this server, an IP
    address is rejected (`port-forwarding.md:168-172`), certificates live
    in `acme_cache_dir`, and the desktop pins this certificate too — so a
    Let's Encrypt renewal changes the fingerprint and **also** triggers the
    mismatch modal (`trust-model.md:172-181`, "the first-use prompt is the
    same in every `tls.mode`"). That last sentence is the one the owner will
    not expect; it is written because the trust model states it.
  - **Manual** (`:300-308`): the same pinning sentence; the file is loaded
    once, so replacing it needs a restart (`:138-148`); file mode 0600 on
    the key.
  - **Off** (`:311-318`): unchanged except the pointer to
    `trust-model.md#transport` for "every connection is plaintext".
- **Why**: row item 6; HP-6 "rotates trust" and "understands the network
  and trust limits". Nothing here claims what B6-3–B6-5 will build.
- **Gotcha**: the ACME-renewal-triggers-the-modal sentence is derived from
  `trust-model.md:172-181`, not measured. If a reviewer doubts it, the test
  is the same as the expiry one (two different valid certificates, one
  client) and takes ten minutes; do it rather than argue.
- **Validate**: the expiry measurement recorded in the PR with the command;
  `tls.mode` values named match `config.go:337-349` and
  `server-configuration.md:50-58`.

### Task 6: Updates, ports, and "When it fails"

- **Action**:
  - **Auto-Update** (`:772-807`): after the five-step apply, a
    `#### If the update fails` block: the audit log carries `update_apply`,
    then `update_applied` or `update_failed` (`security.md:241-242`); a
    verification failure (signature, manifest version, checksum —
    `Server/updater/verify.go:74-95`) leaves the installed binary untouched
    and the panel says why; a failure **after** the rotation leaves the old
    binary as `chatserver.old` beside the new one until the replacement
    boots and deletes it (`:795-796`) — if the new one never boots, rename
    `.old` back and start; Docker refuses the whole flow
    (`503 CONTAINER_DEPLOYMENT`, `:150-157`) and the way back is the image
    tag. And the pre-check list the guide already implies but never
    collects: take the archive (`:440-470`), update the systemd unit first
    (`:212-218`), NSSM must have `restart_mode: supervised` (`:249-253`).
  - **Firewall and Ports** (`:816-826`): the table is named the canonical
    one in a sentence; `port-forwarding.md:52-56` gains the row
    `80 | TCP | ACME HTTP-01 challenge (only if tls.mode: acme)` and
    `livekit-setup.md:112-118` gains "the complete list is in
    deployment.md#firewall-and-ports". The tables themselves stay.
  - **`## When it fails`** — new, after Monitoring, symptom-first, one `###`
    per symptom in the `port-forwarding.md:101-162` shape:
    - **`/health` returns 503** — `reason` is `hub` (the dispatch loop died;
      the server exits nonzero on its own and the supervisor relaunches it,
      `:210-213`), `database` (the 1 s ping failed: disk, lock, or a wedged
      writer — read the log's last `database` lines), `disk` (below the
      floor — free space or raise nothing; uploads refuse first, messages
      keep flowing; B6-11's paragraph for what "full" looks like).
    - **The server refuses to start** — the three named refusals: a bad
      `config.yaml` (the message names the file), an erasure-key
      fingerprint that does not match the marker file (`security.md:182-220`,
      the log prints both fingerprints), an unsupported `database.type`
      (`server-configuration.md:64`). Each with the one thing to do.
    - **Voice joins but nobody hears anything** — the UDP range or
      `voice.node_ip` (`port-forwarding.md:66-80`), the one failure the
      server cannot see.
    - **Voice cannot join at all** — the supervised SFU is down:
      `livekit_healthy: false` on metrics, `GET /api/v1/livekit/health`,
      the supervisor restarts it with backoff and gives up after ten tries
      (B6-11 Confirmed row; `livekit-setup.md:179-193` troubleshooting).
    - **Clients see a certificate mismatch** — you rotated, renewed or
      restored a config that changed `tls.mode` (Task 5; `:544-546`); they
      must accept the new fingerprint you publish.
    - **Every 2FA user is locked out after a restore** — `totp.key` was not
      in the set (`:518-527`).
    - **Uploads refused with 507** — quota vs headroom, by the error code
      (`STORAGE_QUOTA_EXCEEDED` vs `STORAGE_LOW_DISK`, Task 2).
    - **An update did not come back** — the block above.
    - **What to send when asking for help** — the support bundle (Task 2)
      and the last 200 lines of the supervisor's log with usernames and
      addresses in it, which the bundle deliberately lacks.
  - **`docs/README.md`**: Start-here row "Something is wrong →
    deployment.md#when-it-fails"; the deployment.md "Covers" cell becomes
    "Production deployment on Windows and Linux, and day-2 operation: logs,
    storage, failure, recovery, updates."
  - **`docs/security.md:320-335`** operator checklist: two new boxes —
    "Capture stdout (journal, Docker log driver, NSSM `AppStdout`)" and
    "Back up the set, not just the database".
- **Why**: row items 4, 8, 9. Every fact is already in the tree; the
  stranger with a 503 has no page that starts from the 503.
- **Gotcha**: "When it fails" lists only failures a documented surface
  reports. The external-SFU token-minting question and the corrupt-file boot
  behaviour are B6-11 Unknowns — they are **not** written here until B6-11
  measures them; the section says "see the failure drills" for those two
  and nothing more.
- **Validate**: each symptom's "how to tell" is a command or a screen the
  operator has (curl `/health`, the panel, the supervisor log); no symptom
  cites a test name — tests are evidence for reviewers, not for operators.

### Task 7: Reconcile, link-check by hand, hand off

- **Action**:
  - Walk every anchor this branch adds or moves (`#logs`, `#support-bundle`,
    `#capacity-limits`, `#storage-growth`, `#when-it-fails`,
    `#rotating-the-self-signed-certificate`, `#firewall-and-ports`,
    `#backup-strategy`, `#restore`) from every document that links it —
    `check:docs` does not (run.mjs `:150-160`). One grep per anchor.
  - See Also (`:870-878`) gains nothing: the new sections are in this file.
  - `CHANGELOG.md` unreleased, "Accounts & admin / Operators" group, one
    line per corrected fact (NSSM logs, thirteen sweeps, backup set,
    support bundle, cert rotation, port 80).
  - PRD row → `complete` with this plan linked, or `in-progress` naming the
    measurement still owed (Task 5's expiry test); HP-6's row is told the
    operator-usability record can now be attempted against these headings,
    and lists the two facts written from measurement rather than source.
  - B6-15's row is told nothing in `trust-model.md` changed (this plan
    reads it and links it; it does not edit it).
- **Validate**: `npm run format && npm run check:docs && npm run check:hygiene`;
  `cd Server && go run -tags otel,wazero ./cmd/gendocs && git diff --exit-code docs/`
  proves no generated block moved; `ci-check` skill.

## Validation

```bash
# formatting and the docs gates that exist
npm run format && npm run check:docs && npm run check:hygiene
# generated blocks untouched
cd Server && go run -tags otel,wazero ./cmd/gendocs && git diff --exit-code ../docs/api.md ../docs/schema.md ../docs/server-configuration.md
# anchors, by hand (no link checker in the tree)
grep -rn "deployment.md#" docs/ README.md | sed 's/.*deployment.md#//; s/[)>].*//' | sort -u   # each must be a heading in deployment.md
# the moved loss-cost bullets are byte-identical
git diff dev -- docs/deployment.md | grep '^[-+]- \*\*`data/' | sort | uniq -c | awk '$1!=2'   # empty output
# facts that were measured, not read
#   Task 1: journalctl / docker compose logs / nssm AppStdout — one run each on its platform
#   Task 2: one support-bundle download; unzip -l lists build/configuration/database/health/events/manifest.json
#   Task 5: expired self-signed pair against a desktop client — result recorded in the PR
# everything
# → ci-check skill
```

## Risks

| Risk                                                                                     | Likelihood | Impact | Mitigation                                                                                                                                                         |
| ---------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B6-11 and this branch both write the Restore / Health paragraphs                         | High       | Low    | Task 0 fixes the order; whichever lands second extends the other's paragraph; the PR states which happened                                                         |
| A sentence is written from a code read that is wrong (the Unknown rows)                  | Medium     | High   | The two Unknowns are measured, not inferred, and the PR carries the command; everything else cites `file:line` per paragraph in the PR description                 |
| `deployment.md` at ~1 100 lines stops being read                                         | Medium     | Medium | Symptom-first "When it fails" plus the README Start-here row give the stranger an entry point that is not the top of the file; See Also and anchors carry the rest |
| The moved loss-cost list drifts from its original while moving                           | Low        | Medium | Moved verbatim; the validation diff proves it                                                                                                                      |
| A config key or default named in prose disagrees with the generated index                | Medium     | Medium | Task 2 and 3 validate every key against `server-configuration.md:239-313`, which `gendocs` regenerates; prose never restates a default the index already carries   |
| The ACME-renewal-triggers-mismatch sentence is read as a bug report against the client   | Low        | Low    | It is stated as the trust model states it (`:172-181`) with the link; the fix, if any, is B7's browser/desktop pinning work, out of scope here                     |
| An operator reads "not qualified" as "does not work" for domain ACME                     | Medium     | Low    | The PRD's exact phrase is used: "implemented, not exercised at release quality"; `deployment.md:289-298` keeps its working configuration                           |
| The NSSM `AppStdout` lines are wrong for the NSSM version in the doc                     | Low        | Medium | Run on Windows in Task 1; `AppRotateFiles` exists in NSSM 2.24 (the version `:251` names)                                                                          |
| The doc-counts check trips on a number this plan writes ("thirteen sweeps", "six files") | Low        | Low    | `check-doc-counts.mjs:2-9` compares **finding** counts only; no ledger count is written here                                                                       |

## Out of scope

- **Any server change.** No log file, no rotation, no `logging.file` key, no
  expiry check on the self-signed certificate, no audit-log pruning, no
  distinguishing `pre_restore_*` from retention. Each is a product decision;
  the doc states the current behaviour and an owner question below asks
  whether one should change.
- **The TLS work** — ACME renewal qualification, public-IP certificates, the
  LAN/offline device-trust install, hot reload (B6-3–B6-5, deferred).
- **Failure measurements** — disk-full, corrupt files, the external SFU
  (B6-11). This plan links to their paragraphs and writes none of them.
- **Client-side logs** (`Client/src/lib/logPersistence.ts:12-13`, the app
  log dir, `credential-storage.md:189`) — B7's client platform work; the
  guide points at the client doc and stops.
- **The HP-6 usability record itself.** This plan makes it attemptable; the
  record is HP-6's artifact.
- **A link checker in CI.** Wanted, not this milestone; the anchors are
  walked by hand in Task 7 and the gap is noted for the roadmap's hygiene
  workstream.
- **Rewriting `trust-model.md` or `data-lifecycle.md`.** Both are reference
  documents that are right; the guide links down to them.

## Open questions for the owner

1. **Should `pre_restore_*` safety copies be exempt from `backup_retention`?**
   Today they age out like any backup (`pruneExpiredBackups`,
   `backup_maintenance.go:142-155`, no name filter — Task 3). The doc states
   that; exempting them is a one-line code change with its own PR, if wanted.
2. **Should the server warn when the self-signed certificate is within 30
   days of expiry?** It serves an expired one silently today
   (`tls.go:124-134`). The doc will say "rotate before two years"; a startup
   warning is small and would belong to B6-5's lifecycle work, but the owner
   may want it sooner given B6-5 is deferred.
3. **Is `audit_log` growing unbounded acceptable for beta?** The doc will
   state it. A retention window for audit rows is a privacy-policy decision
   (BPR-053 territory, B6-15), not a docs decision.

## Acceptance

Ticked only when the sentence in the guide has a `file:line` source in the PR
description or a recorded measurement.

- [ ] Logs: stdout-only stated; one row per supervisor with the command that
      reads it; NSSM block captures stdout; redaction-by-construction and
      what `info` still contains both stated
- [ ] Support bundle: the panel flow, the six files, the negative list, and
      "never uploads" in the guide; `security.md:231` no longer says "future";
      `diagnostics.md:33` says `chatserver healthcheck`
- [ ] Capacity limits: profile linked, every configurable ceiling named with
      its default, symptom and metric, all keys present in the generated index
- [ ] Ports: `port-forwarding.md` has the port 80 row; the three tables agree
      and two point at the canonical one
- [ ] Storage growth: the full `data/` table with bound and pruner per path;
      `audit_log` "never pruned"; retention off by default; Background
      Maintenance lists the thirteen steps in order
- [ ] Certificate trust: the deferred boundary in TLS Setup in the PRD's
      words; two-year lifetime, no renewal, no reload; the rotation procedure
      with the client-side consequence; the expiry behaviour **measured** and
      written; ACME and manual carry the pinning sentence
- [ ] Recovery: the backup set in Backup Strategy with the loss-cost bullets
      moved verbatim; Restore describes the real sequence and the marker
      replay; restore-is-not-rollback stated in both places; B6-11's
      paragraphs extended, not duplicated
- [ ] Updates: the failure block (audit rows, `.old`, verification refusal,
      Docker refusal) and the pre-check list
- [ ] When it fails: symptom-first section covering every failure a
      documented surface reports; README Start-here row; nothing written for
      the two B6-11 Unknowns beyond a pointer
- [ ] No `gendocs:` block changed; `check:docs`, `check:hygiene`, `format`
      and `ci-check` green; every added anchor resolves
- [ ] PRD row, changelog, and the B6-11 / HP-6 handoff notes written
