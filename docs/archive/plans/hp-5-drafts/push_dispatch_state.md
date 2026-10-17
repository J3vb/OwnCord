# B5-11 draft: push dispatch persists no state

Not SQL, because there is nothing to migrate. B5-11 (Web Push dispatch, plan
decision 9) persists **no** dispatch state.

An attempt succeeds, fails transiently (retried in-process, bounded
attempts, dropped on restart -- a push is a hint and the client fetches the
truth from the server on wake), or answers `404`/`410`, which deletes the
subscription row. That deletion is the authoritative staleness signal S7
names, and it is the only durable effect a dispatch attempt has on the
database.

No per-user delivery history is written, because S7-c says keeping it "turns
a queue into a log of when someone was online." The only durable trace of
dispatch activity is the aggregate counter on the metrics surface -- a
count, not a per-subscription or per-user row.

B5-4's `push_subscriptions` table (migration `045`) already carries
everything dispatch reads: `endpoint`, `p256dh`, `auth`, `vapid_key_id`.
Dispatch adds no column to it and no table of its own.
