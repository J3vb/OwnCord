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
appeals) and S7 (push). The scorecard,
[hp-5-scorecard-2026-09-05.md](../hp-5-scorecard-2026-09-05.md), is written
with this directory and does not exist as of this commit.

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

## Deviations recorded as the steps are built

- **048 (B5-8)** carries one statement the draft did not: the new permission bit
  `MODERATE_MEMBERS` (bit 22, `0x400000`) granted to the default Moderator role,
  because the report queue is the first consumer of the bit and B5-8 lands
  before B5-9. The bit's four-file edit (permissions, admin panel grid, client
  enum, schema bit map) lands in B5-8 as well.
- **049 (B5-9)** adds `CHECK (actor_id > 0)` on `moderation_actions`, so a row
  with no human actor cannot be written — half of workstream 10's absence proof.

## When each `down` file moves

`Server/rollback/` is the applied set once a migration lands: one reversal
per migration, in the order to run them. Following the HP-4 precedent, the
`down` file here stays as the historical record of the design once its `up`
file is copied into `Server/migrations/`, and the maintained copy moves to
`Server/rollback/`.
