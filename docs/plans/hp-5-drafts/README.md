# HP-5 schema drafts

The data contracts for the five B5 services that sit behind HP-5's abuse and
privacy review, as migration drafts with their rollbacks. They are **not**
applied migrations: `Server/migrations/` gains them only when B5-6 through
B5-10 land. Migration numbers 046-050 are reserved for them in the B5 plan
(`docs/plans/b5-community-content-moderation-2026-09-04.md`); B5-11 (push
dispatch) needs no migration at all, which is why it gets a short note
instead of a `.sql` pair. Each `up` file is what the step's `db-change`
migration will contain; each `down` file is the rollback an operator runs by
hand (SQLite migrations here are forward-only), kept beside it so the
reversal was written when the shape was, not improvised later.

| Draft                                 | Step  | Migration | Contract                                                                                                                                              |
| ------------------------------------- | ----- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message_requests.{up,down}.sql`      | B5-6  | 046       | first-contact staging for one-to-one DMs: one row per (sender, recipient) pair ever, a trusted-sender allow-list, and a grandfathering backfill       |
| `nsfw_acknowledgements.{up,down}.sql` | B5-7  | 047       | the per-user, per-channel consent row that gates every content path a labelled channel can be read through                                            |
| `reports.{up,down}.sql`               | B5-8  | 048       | report intake, the moderator queue, an evidence snapshot by reference, and the unlinkable outcome row that survives the subject's erasure             |
| `moderation_actions.{up,down}.sql`    | B5-9  | 049       | the action ledger every moderator action writes to, including warning and timeout, the two kinds this repository does not yet implement               |
| `appeals.{up,down}.sql`               | B5-10 | 050       | one appeal per moderation action, enforced by a `UNIQUE` constraint rather than by a check at write time                                              |
| `push_dispatch_state.md`              | B5-11 | none      | a note, not a draft: B5-11 persists no dispatch state, because `push_subscriptions` (B5-4, migration `045`) already carries everything dispatch reads |

The decisions each shape encodes are settled in "Decisions -- settled
2026-09-04" in the B5 plan; the abuse cases and data-ownership tables that
motivate them are `docs/architecture/community-services.md` sections S1
(message requests), S4 (NSFW), S5 (reports), S6 (moderator actions and
appeals) and S7 (push). The scorecard is
[hp-5-scorecard-2026-09-05.md](../hp-5-scorecard-2026-09-05.md).

## Notes on the shapes

`reports`, `moderation_actions` and `appeals` all use the bare-id-plus-token
pattern `audit_log` established across migrations `038` and `041`: a
principal who may later erase their account is referenced by a plain integer
with `DEFAULT 0` and no foreign key, alongside a nullable token column an
erasure fills in. This is deliberate everywhere it appears here -- a foreign
key with `ON DELETE CASCADE` on any of those columns would delete rows that
decision 7 (reports) or S6's lifecycle table (moderator actions, appeals)
requires to survive the subject's erasure. `target_id` on
`moderation_actions` and `appellant_id` on `appeals` are the opposite case
and do cascade, because those two classes are the ones B5 has decided to
delete outright rather than unlink.

## Changes the steps apply on top of the drafts

- **046 (B5-6)** added `message_requests.first_message_id` (nullable,
  `ON DELETE SET NULL`), so the socket frame and the REST inbox preview the
  same message under concurrent first sends -- without it, two racing first
  messages could leave the two surfaces pointing at different rows.
- **047 (B5-7)** shipped verbatim -- no deviation from the draft.
- **048 (B5-8)** carries one statement the draft did not: the new permission
  bit `MODERATE_MEMBERS` (bit 22, `0x400000`) granted to the default
  Moderator role, because the report queue is the first consumer of the bit
  and B5-8 lands before B5-9. The grant is guarded
  `WHERE id = 3 AND name = 'Moderator' AND permissions = 3145727` -- not
  `id = 3 OR name = 'Moderator'` -- so it touches only the untouched seed row
  (whose value already includes migration 022's bit 21), never a role an
  operator renamed or repurposed. The bit's four-file edit (permissions,
  admin panel grid, client enum, schema bit map) lands in B5-8 as well.
- **048 (B5-8)** added `reports.public_id`, 16 random bytes as hex: it is the
  only id a response, route or frame ever names, closing the sequential-id
  inference the bare `reports.id` would otherwise leak.
- **048 (B5-8)** added `idx_reports_active_unique`, a partial unique index
  over (reporter, target) for `open`/`assigned` reports -- the race-proof
  half of the duplicate-report `409`; a check at write time alone cannot
  close the race two concurrent inserts create.
- **048 (B5-8)** added a fourth table, `report_events` (`id`, `report_id`
  cascading, `actor_id`, `actor_token`, `action`, `detail`, `created_at`,
  indexed on `report_id`): a report's history lives there, never in
  `audit_log`, so a `VIEW_AUDIT_LOG` holder cannot count filings by reading
  the audit trail. `report_create` writes no `audit_log` row at all.
- **048 (B5-8)** guarded `InsertReport` and `InsertReportEvidence` as
  `INSERT ... SELECT ... WHERE EXISTS (...)` against `users`, re-validating
  both principals inside the intake transaction rather than trusting a check
  made before it opened.
- **048 (B5-8)** made `InsertReportNote` re-check that the report is still
  `open`/`assigned` at write time, and made forced re-assignment
  (`AssignReportForced`) read the current assignee's rank inside the same
  transaction as the write -- both close a race between the read that
  justified the write and the write itself.
- **049 (B5-9)** added `moderation_actions.voice_muted`, recording whether
  the timeout action itself applied the server mute, so lifting that timeout
  cannot undo a mute a different moderator set independently.
- **049 (B5-9)** adds no `CHECK` on `actor_id` -- a constraint requiring
  `actor_id > 0` would forbid the erasure transition that sets it to 0.
  Instead B5-9 refuses a non-human actor (a plugin, a system job with no
  moderator behind it) at the service boundary, and tests that refusal --
  half of workstream 10's absence proof lives in code, not in the schema.

## When each `down` file moves

`Server/rollback/` is the applied set once a migration lands: one reversal
per migration, in the order to run them. Following the HP-4 precedent, the
`down` file here stays as the historical record of the design once its `up`
file is copied into `Server/migrations/`, and the maintained copy moves to
`Server/rollback/`.
