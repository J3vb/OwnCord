// The alpha-shaped profile (B3-7, roadmap workstream 12).
//
// `go run ./cmd/seed -confirm-dev -profile alpha` fills an EMPTY database with
// a deterministic dataset shaped like a real 1.2.0-alpha.4 server after a
// month of use. The same profile, scrubbed and vacuumed, is the committed
// snapshot at Server/testdata/snapshots/v1.2.0-alpha.4.sqlite that B4's HP-4
// drills, B6's upgrade rehearsal and B10's in-place upgrade consume — the
// schema has not changed since the v1.2.0-alpha.4 tag (zero migrations added),
// so a database seeded on today's migrations IS an alpha.4-schema database.
//
// Determinism is the contract: fixed rng seed, fixed clock, a constant bcrypt
// hash (live hashing salts every run), explicit ids and timestamps on every
// row, one insert order, and `VACUUM INTO` as the byte-canonical output.
// TestAlphaProfileByteIdentical holds it: two runs, two files, bytes.Equal.
//
// The numbers below are the plan's (b3-server-architecture-guardrails
// §B3-7). A number found unrepresentative is changed HERE with the reason in
// the B3-7 evidence block — never silently. Two constants deliberately leave
// no rows, recorded rather than hidden:
//
//   - alphaVoiceSessions: voice is LiveKit-ephemeral. A finished session
//     leaves no at-rest row in this schema (voice_states is live presence and
//     empties on disconnect), so a cold snapshot of a quiescent server
//     carries none. The constant stays because the load harness and any
//     future voice-history feature consume the same shape.
//   - events: the replay log is empty, as on any server restarted for an
//     upgrade — exactly the state the snapshot's consumers rehearse.
//     Fabricated frames would be replayed verbatim to real clients.
//
// The seeded accounts all use the password "alpha-dev-password" (constant
// hash below), which is why -confirm-dev stays mandatory.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"math/rand"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// ─── The profile, as constants ──────────────────────────────────────────────

const (
	alphaSeed = 20260831 // fixed rng seed; changing it is changing the dataset

	alphaUsers      = 100 // 1 owner + 2 admins + 5 moderators + 92 members
	alphaOwners     = 1
	alphaAdmins     = 2
	alphaModerators = 5

	alphaChannels     = 12 // 10 text + 2 voice; 3 role-override, 2 user-override, 1 archived
	alphaMessages     = 20000
	alphaWindowDays   = 30
	alphaDMShare      = 0.15 // exactly 3,000 of the 20,000 land in DMs
	alphaDMPairs      = 40
	alphaAttachments  = 300 // image/audio/video/other 60/10/10/20 %
	alphaReactions    = 500
	alphaInvites      = 30 // 10 of them revoked
	alphaInvitesRevkd = 10
	alphaPluginRows   = 1 // disabled

	// alphaVoiceSessions is a shape parameter with no at-rest rows — see the
	// package comment. 1–45 min, 2–6 participants when a live harness uses it.
	alphaVoiceSessions = 200

	// alphaPasswordHash is bcrypt("alpha-dev-password"), fixed so two seed
	// runs produce identical bytes. Weak and public by design: -confirm-dev.
	//nolint:gosec // G101: a deliberately public dev-profile hash ("alpha-dev-password"); -confirm-dev gates every use
	alphaPasswordHash = "$2a$12$EBrRXmplT1ryU0o/HzELSePreo.gK5.z5Tjo4ec/ISchy5gKwxtQq"
)

// alphaWindowEnd is the fixed clock: the last instant of the simulated month.
var alphaWindowEnd = time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)

// alphaHourWeights shapes the diurnal curve — quiet nights, an evening peak.
// Relative weights per UTC hour; largest-remainder allocation makes the
// per-bucket counts sum exactly to the day's total.
var alphaHourWeights = [24]int{
	1, 1, 1, 1, 1, 2, // 00–05
	3, 5, 7, 8, 8, 8, // 06–11
	9, 9, 8, 8, 9, 10, // 12–17
	11, 12, 11, 8, 5, 2, // 18–23
}

// alphaLexicon feeds the message generator. Plain words only: the content is
// synthetic on purpose and never pretends to be a real person's text.
var alphaLexicon = []string{
	"the", "a", "we", "you", "it", "that", "this", "just", "really", "pretty",
	"server", "channel", "voice", "call", "message", "update", "build", "bug",
	"fix", "release", "game", "night", "stream", "clip", "map", "round",
	"team", "later", "today", "tomorrow", "tonight", "morning", "again",
	"works", "broke", "fixed", "joined", "left", "restarted", "uploaded",
	"good", "great", "weird", "slow", "fast", "new", "old", "same",
	"anyone", "someone", "everyone", "nobody", "who", "what", "when", "why",
	"up", "down", "in", "out", "on", "off", "for", "with", "about", "after",
	"lol", "nice", "thanks", "ok", "sure", "maybe", "yes", "no", "brb", "gg",
}

// ─── Channel definitions ────────────────────────────────────────────────────

type alphaChannel struct {
	name, ctype, category, topic string
	position                     int
	archived                     bool
}

// Ten text and two voice channels. Indices are ids-1; the overrides below
// refer to them by id. Channel 10 is the archived one and only carries
// early-window history.
var alphaChannelDefs = []alphaChannel{
	{"welcome", "text", "Information", "Start here — rules and invites", 0, false},
	{"announcements", "text", "Information", "Server news; staff post, everyone reads", 1, false},
	{"general", "text", "Text Channels", "General chat", 2, false},
	{"random", "text", "Text Channels", "Off-topic", 3, false},
	{"gaming", "text", "Text Channels", "What are we playing", 4, false},
	{"media", "text", "Text Channels", "Clips, screenshots, links", 5, false},
	{"dev", "text", "Text Channels", "Server tinkering and self-hosting", 6, false},
	{"support", "text", "Text Channels", "Ask for help here", 7, false},
	{"staff", "text", "Staff", "Staff-only coordination", 8, false},
	{"archive-2026-06", "text", "Archive", "June history, read-only", 9, true},
	{"Lounge", "voice", "Voice", "", 10, false},
	{"Game Night", "voice", "Voice", "", 11, false},
}

// ─── Entry point ────────────────────────────────────────────────────────────

// runAlpha is the -profile alpha path: migrate, seed, optionally scrub and
// write the byte-canonical snapshot.
func runAlpha(database *db.DB, snapshotPath, scrubPath string) int {
	if err := db.Migrate(database); err != nil {
		log.Printf("failed to run migrations: %v", err)
		return 1
	}
	if err := seedAlpha(database); err != nil {
		log.Printf("%v", err)
		return 1
	}
	fmt.Println("--- Alpha profile seeded ---")
	fmt.Printf("  Users:       %d\n", alphaUsers)
	fmt.Printf("  Channels:    %d (+%d DM channels)\n", alphaChannels, alphaDMPairs)
	fmt.Printf("  Messages:    %d over %d days (%.0f%% in DMs)\n", alphaMessages, alphaWindowDays, alphaDMShare*100)
	fmt.Printf("  Attachments: %d · Reactions: %d · Invites: %d (%d revoked) · Plugins: %d\n",
		alphaAttachments, alphaReactions, alphaInvites, alphaInvitesRevkd, alphaPluginRows)
	fmt.Printf("  Voice sessions: %d — a shape parameter; a finished session leaves no at-rest row (package comment)\n", alphaVoiceSessions)
	fmt.Println("  Password for every account: alpha-dev-password")
	if snapshotPath != "" {
		if scrubPath == "" {
			log.Printf("-snapshot requires -scrub (the committed scrub script)")
			return 1
		}
		if err := writeSnapshot(database, scrubPath, snapshotPath); err != nil {
			log.Printf("%v", err)
			return 1
		}
		fmt.Printf("  Snapshot:    %s\n", snapshotPath)
	}
	return 0
}

// seedAlpha fills an empty database with the profile. It refuses a non-empty
// one: determinism is per-database-lifetime, and "empty" is the only state
// two runs can share.
func seedAlpha(database *db.DB) error {
	var users int
	if err := database.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM users`).Scan(&users); err != nil {
		return fmt.Errorf("alpha: counting users: %w", err)
	}
	if users > 0 {
		return fmt.Errorf("alpha: the profile seeds only an empty database (found %d users); point -db at a fresh file", users)
	}

	//nolint:gosec // G404: byte-for-byte determinism is this profile's contract; nothing here is cryptographic
	rng := rand.New(rand.NewSource(alphaSeed))
	windowStart := alphaWindowEnd.AddDate(0, 0, -alphaWindowDays)
	joined := alphaJoinTimes(rng, windowStart)

	tx, err := database.BeginTx(context.Background(), &sql.TxOptions{})
	if err != nil {
		return fmt.Errorf("alpha: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if err := alphaInsertUsers(tx, rng, joined); err != nil {
		return err
	}
	if err := alphaInsertChannels(tx, windowStart); err != nil {
		return err
	}
	pairs, err := alphaInsertDMs(tx, rng, joined)
	if err != nil {
		return err
	}
	messageTimes, messageAuthors, err := alphaInsertMessages(tx, rng, windowStart, joined, pairs)
	if err != nil {
		return err
	}
	if err := alphaInsertAttachments(tx, rng, messageTimes, messageAuthors); err != nil {
		return err
	}
	if err := alphaInsertReactions(tx, rng); err != nil {
		return err
	}
	if err := alphaInsertInvites(tx, rng, windowStart); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO plugins (id, name, version, enabled, manifest_json, installed_at) VALUES (1, ?, ?, 0, ?, ?)`,
		"example-echo", "0.1.0",
		`{"name":"example-echo","version":"0.1.0","description":"seed profile placeholder; never enabled"}`,
		ts(windowStart.Add(24*time.Hour)),
	); err != nil {
		return fmt.Errorf("alpha: plugin row: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("alpha: commit: %w", err)
	}
	return nil
}

// writeSnapshot applies the scrub script and writes the byte-canonical
// snapshot via VACUUM INTO (which refuses to overwrite; remove a stale
// target first so regeneration is one command).
func writeSnapshot(database *db.DB, scrubPath, outPath string) error {
	scrub, err := os.ReadFile(scrubPath)
	if err != nil {
		return fmt.Errorf("alpha: reading scrub script: %w", err)
	}
	// Strip comment lines first, then split on ";" — a ";" inside a comment
	// must not end a statement. The scrub script holds no string literal
	// containing ";", which is the simplicity this parser is allowed.
	var sqlOnly []string
	for line := range strings.SplitSeq(string(scrub), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		sqlOnly = append(sqlOnly, line)
	}
	for stmt := range strings.SplitSeq(strings.Join(sqlOnly, "\n"), ";") {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		if _, err := database.ExecContext(context.Background(), stmt); err != nil {
			return fmt.Errorf("alpha: scrub statement %q: %w", stmt[:min(40, len(stmt))], err)
		}
	}
	if err := os.Remove(outPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("alpha: removing stale snapshot: %w", err)
	}
	quoted := strings.ReplaceAll(outPath, "'", "''")
	if _, err := database.ExecContext(context.Background(), "VACUUM INTO '"+quoted+"'"); err != nil {
		return fmt.Errorf("alpha: VACUUM INTO %s: %w", outPath, err)
	}
	return nil
}

// ─── Users ──────────────────────────────────────────────────────────────────

// alphaJoinTimes computes every user's created_at once — the message and DM
// generators consult it so nothing is authored before its author joined (a
// fixture with time-travelling rows would poison the retention and
// account-age rehearsals that consume it; Codex on #1469, P2). Monotonic in
// the user id — the first forty accounts predate the window (an established
// server; all staff are among them), the remaining sixty join during it in
// id order — so "who exists at time t" is always the prefix 1..N.
func alphaJoinTimes(rng *rand.Rand, windowStart time.Time) []time.Time {
	joined := make([]time.Time, alphaUsers+1)
	for i := 1; i <= alphaUsers; i++ {
		if i <= 40 {
			joined[i] = windowStart.AddDate(0, 0, -60).Add(time.Duration(i) * 26 * time.Hour)
			continue
		}
		// Spacing is 12h, jitter under 1h: monotonicity holds by construction.
		into := time.Duration(i-41) * (time.Duration(alphaWindowDays) * 24 * time.Hour) / 60
		joined[i] = windowStart.Add(into).Add(time.Duration(rng.Intn(3599)) * time.Second)
	}
	return joined
}

func alphaInsertUsers(tx *sql.Tx, rng *rand.Rand, joined []time.Time) error {
	roleOf := func(i int) int { // i is 1-based user number
		switch {
		case i <= alphaOwners:
			return 1
		case i <= alphaOwners+alphaAdmins:
			return 2
		case i <= alphaOwners+alphaAdmins+alphaModerators:
			return 3
		default:
			return 4
		}
	}

	const cols = 7
	var b strings.Builder
	args := make([]any, 0, alphaUsers*cols)
	for i := 1; i <= alphaUsers; i++ {
		if i > 1 {
			b.WriteString(",")
		}
		b.WriteString("(?,?,?,?,?,?,?)")
		created := joined[i]
		lastSeen := alphaWindowEnd.Add(-time.Duration(rng.Intn(72*3600)) * time.Second)
		if lastSeen.Before(created) {
			// A user who joined in the window's final days was last seen at
			// the join, not before it.
			lastSeen = created
		}
		args = append(args,
			i, fmt.Sprintf("user%03d", i), alphaPasswordHash, roleOf(i),
			"offline", ts(created), ts(lastSeen),
		)
	}
	_, err := tx.Exec(
		//nolint:gosec // G202: the concatenation is a builder of "(?,…)" placeholder groups; every value is bound
		`INSERT INTO users (id, username, password, role_id, status, created_at, last_seen) VALUES `+b.String(),
		args...,
	)
	if err != nil {
		return fmt.Errorf("alpha: users: %w", err)
	}
	return nil
}

// ─── Channels and overrides ─────────────────────────────────────────────────

func alphaInsertChannels(tx *sql.Tx, windowStart time.Time) error {
	created := windowStart.AddDate(0, 0, -60)
	for i, c := range alphaChannelDefs {
		archived := 0
		if c.archived {
			archived = 1
		}
		if _, err := tx.Exec(
			`INSERT INTO channels (id, name, type, category, topic, position, archived, is_group, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
			i+1, c.name, c.ctype, c.category, c.topic, c.position, archived, ts(created.Add(time.Duration(i)*time.Minute)),
		); err != nil {
			return fmt.Errorf("alpha: channel %q: %w", c.name, err)
		}
	}

	// Three channels carry role overrides (ids 1, 2, 9), two carry user
	// overrides (ids 9 and 4) — the plan's 3/2 split, with the layered case
	// (channel 9 has both) included deliberately.
	roleOverrides := []struct {
		channel, role int64
		allow, deny   int64
	}{
		{1, 4, 0, permissions.SendMessages},                            // #welcome: members read-only
		{2, 4, 0, permissions.SendMessages},                            // #announcements: members read-only
		{2, 3, permissions.MentionEveryone, 0},                         // …and moderators may @everyone there
		{9, 4, 0, permissions.ReadMessages | permissions.SendMessages}, // #staff hidden from members
	}
	for _, o := range roleOverrides {
		if _, err := tx.Exec(
			`INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)`,
			o.channel, o.role, o.allow, o.deny,
		); err != nil {
			return fmt.Errorf("alpha: role override ch=%d role=%d: %w", o.channel, o.role, err)
		}
	}
	userOverrides := []struct {
		channel, user int64
		allow, deny   int64
	}{
		{9, 9, permissions.ReadMessages | permissions.SendMessages, 0}, // a trusted member sees #staff
		{4, 42, 0, permissions.SendMessages},                           // user042 is channel-muted in #random
	}
	for _, o := range userOverrides {
		if _, err := tx.Exec(
			`INSERT INTO channel_user_overrides (channel_id, user_id, allow, deny) VALUES (?, ?, ?, ?)`,
			o.channel, o.user, o.allow, o.deny,
		); err != nil {
			return fmt.Errorf("alpha: user override ch=%d user=%d: %w", o.channel, o.user, err)
		}
	}
	return nil
}

// ─── DMs ────────────────────────────────────────────────────────────────────

type dmPair struct {
	channelID int64
	a, b      int64
	// ready is when both members exist — no message in the pair may precede
	// it, and it is the channel's created_at / opened_at, matching
	// GetOrCreateDMChannel's create-on-first-contact shape.
	ready time.Time
}

// alphaInsertDMs creates the 40 DM channels exactly as GetOrCreateDMChannel
// would (type 'dm', empty name, both participants, both open). The first
// twelve pairs are drawn from the pre-window accounts so DM traffic exists
// from the window's first hour; the rest may involve joiners and only carry
// messages once both members exist.
func alphaInsertDMs(tx *sql.Tx, rng *rand.Rand, joined []time.Time) ([]dmPair, error) {
	seen := map[[2]int64]bool{}
	pairs := make([]dmPair, 0, alphaDMPairs)
	for len(pairs) < alphaDMPairs {
		pool := alphaUsers
		if len(pairs) < 12 {
			pool = 40 // both members pre-window
		}
		a := int64(rng.Intn(pool) + 1)
		b := int64(rng.Intn(pool) + 1)
		if a == b {
			continue
		}
		if a > b {
			a, b = b, a
		}
		if seen[[2]int64{a, b}] {
			continue
		}
		seen[[2]int64{a, b}] = true
		id := int64(alphaChannels + len(pairs) + 1) // 13..52
		ready := joined[a]
		if joined[b].After(ready) {
			ready = joined[b]
		}
		if _, err := tx.Exec(
			`INSERT INTO channels (id, name, type, is_group, created_at) VALUES (?, '', 'dm', 0, ?)`,
			id, ts(ready),
		); err != nil {
			return nil, fmt.Errorf("alpha: dm channel %d: %w", id, err)
		}
		for _, u := range []int64{a, b} {
			if _, err := tx.Exec(
				`INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?)`, id, u,
			); err != nil {
				return nil, fmt.Errorf("alpha: dm participant: %w", err)
			}
			if _, err := tx.Exec(
				`INSERT INTO dm_open_state (user_id, channel_id, opened_at) VALUES (?, ?, ?)`, u, id, ts(ready),
			); err != nil {
				return nil, fmt.Errorf("alpha: dm open state: %w", err)
			}
		}
		pairs = append(pairs, dmPair{channelID: id, a: a, b: b, ready: ready})
	}
	return pairs, nil
}

// ─── Messages ───────────────────────────────────────────────────────────────

// alphaChannelWeights is the relative traffic per text channel (ids 1..10):
// #announcements and #welcome are quiet, #general and #gaming busy, #staff
// small, the archive early-only.
var alphaChannelWeights = []int{2, 1, 30, 18, 22, 10, 8, 6, 3, 8}

// alphaChannelFor picks a text channel for one message on the given day; the
// archived channel's history ends on day 10.
func alphaChannelFor(rng *rand.Rand, day int) int64 {
	w := make([]int, len(alphaChannelWeights))
	copy(w, alphaChannelWeights)
	if day >= 10 {
		w[9] = 0
	}
	total := 0
	for _, x := range w {
		total += x
	}
	n := rng.Intn(total)
	for i, x := range w {
		if n < x {
			return int64(i + 1)
		}
	}
	return 3
}

// alphaAuthorFor picks a message author. Staff channels (#welcome,
// #announcements) are staff-posted; #staff adds the override-listed user009;
// everywhere else, anyone who has joined by the message's time — maxUser is
// the eligibility prefix (staff and user009 are all pre-window).
func alphaAuthorFor(rng *rand.Rand, ch int64, maxUser int) int64 {
	switch ch {
	case 1, 2:
		return int64(rng.Intn(alphaOwners+alphaAdmins+alphaModerators) + 1)
	case 9:
		staff := []int64{1, 2, 3, 4, 5, 6, 7, 8, 9}
		return staff[rng.Intn(len(staff))]
	default:
		return int64(rng.Intn(maxUser) + 1)
	}
}

// sqlBatch accumulates multi-row VALUES groups and flushes them in chunks —
// one statement per chunk instead of one per row, inside the caller's
// transaction.
type sqlBatch struct {
	b    strings.Builder
	args []any
}

func (sb *sqlBatch) add(row string, vals ...any) {
	if len(sb.args) > 0 {
		sb.b.WriteString(",")
	}
	sb.b.WriteString(row)
	sb.args = append(sb.args, vals...)
}

func (sb *sqlBatch) flush(tx *sql.Tx, prefix string) error {
	if sb.b.Len() == 0 {
		return nil
	}
	//nolint:gosec // G202: the concatenation is a builder of "(?,…)" placeholder groups; every value is bound
	_, err := tx.Exec(prefix+sb.b.String(), sb.args...)
	sb.b.Reset()
	sb.args = sb.args[:0]
	return err
}

// alphaInsertMessages writes all 20,000 messages in chronological order —
// per-bucket second offsets are sorted before ids are assigned, so ascending
// ids follow ascending timestamps exactly as insertion order does on a live
// server (Codex on #1469, P2) — and returns each message's timestamp and
// author (indexed by id-1) for the attachment rows. Authors are drawn only
// from users who exist at the message's time: the eligible set is always the
// prefix 1..maxUser because alphaJoinTimes is monotonic, and a DM pair
// carries traffic only from its ready time.
func alphaInsertMessages(tx *sql.Tx, rng *rand.Rand, windowStart time.Time, joined []time.Time, pairs []dmPair) ([]time.Time, []int64, error) {
	// Exactly 15% of message ids are DM messages.
	dmCount := int(float64(alphaMessages) * alphaDMShare)
	isDM := make([]bool, alphaMessages)
	for _, idx := range rng.Perm(alphaMessages)[:dmCount] {
		isDM[idx] = true
	}

	perDay := largestRemainder(onesSlice(alphaWindowDays), alphaMessages)

	// Pairs sorted by readiness, so the eligible set at any time is a prefix;
	// skewedIndex over that prefix keeps the earliest (all-pre-window) pairs
	// the chattiest, which is also the realistic shape.
	byReady := make([]dmPair, len(pairs))
	copy(byReady, pairs)
	sort.Slice(byReady, func(i, j int) bool { return byReady[i].ready.Before(byReady[j].ready) })

	times := make([]time.Time, 0, alphaMessages)
	authors := make([]int64, 0, alphaMessages)
	maxUser := 40
	readyPairs := 0

	const chunkArgs = 500 * 5
	var batch sqlBatch
	const insertPrefix = `INSERT INTO messages (id, channel_id, user_id, content, timestamp) VALUES `

	id := 0
	for day := range alphaWindowDays {
		perHour := largestRemainder(alphaHourWeights[:], perDay[day])
		for hour := range 24 {
			offsets := make([]int, perHour[hour])
			for k := range offsets {
				offsets[k] = rng.Intn(3600)
			}
			sort.Ints(offsets)
			base := windowStart.AddDate(0, 0, day).Add(time.Duration(hour) * time.Hour)
			for _, off := range offsets {
				at := base.Add(time.Duration(off) * time.Second)
				for maxUser < alphaUsers && !joined[maxUser+1].After(at) {
					maxUser++
				}
				for readyPairs < len(byReady) && !byReady[readyPairs].ready.After(at) {
					readyPairs++
				}
				var ch, author int64
				if isDM[id] && readyPairs > 0 {
					p := byReady[skewedIndex(rng, readyPairs)]
					ch = p.channelID
					if rng.Intn(2) == 0 {
						author = p.a
					} else {
						author = p.b
					}
				} else {
					ch = alphaChannelFor(rng, day)
					author = alphaAuthorFor(rng, ch, maxUser)
				}
				id++
				times = append(times, at)
				authors = append(authors, author)
				batch.add("(?,?,?,?,?)", id, ch, author, sentence(rng), ts(at))
				if len(batch.args) >= chunkArgs {
					if err := batch.flush(tx, insertPrefix); err != nil {
						return nil, nil, fmt.Errorf("alpha: messages: %w", err)
					}
				}
			}
		}
	}
	if err := batch.flush(tx, insertPrefix); err != nil {
		return nil, nil, fmt.Errorf("alpha: messages: %w", err)
	}
	return times, authors, nil
}

// ─── Attachments, reactions, invites ────────────────────────────────────────

func alphaInsertAttachments(tx *sql.Tx, rng *rand.Rand, messageTimes []time.Time, messageAuthors []int64) error {
	type class struct {
		count        int
		mime, ext    string
		minKB, maxKB int
		namePrefix   string
	}
	classes := []class{
		{alphaAttachments * 60 / 100, "image/png", "png", 10, 900, "screenshot"},
		{alphaAttachments * 10 / 100, "audio/ogg", "ogg", 50, 2000, "voice-note"},
		{alphaAttachments * 10 / 100, "video/mp4", "mp4", 500, 5000, "clip"},
		{alphaAttachments * 20 / 100, "application/pdf", "pdf", 10, 1500, "doc"},
	}
	n := 0
	for _, c := range classes {
		for k := 0; k < c.count; k++ {
			n++
			msgID := rng.Intn(alphaMessages) + 1
			id := fmt.Sprintf("%08x%08x%08x%08x", rng.Uint32(), rng.Uint32(), rng.Uint32(), rng.Uint32())
			size := (c.minKB + rng.Intn(c.maxKB-c.minKB+1)) * 1024
			// The uploader is the message's author — CreateAttachment always
			// records one on the current schema (Codex on #1469, P2).
			if _, err := tx.Exec(
				`INSERT INTO attachments (id, message_id, filename, stored_as, mime_type, size, uploaded_at, uploader_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				id, msgID,
				fmt.Sprintf("%s-%03d.%s", c.namePrefix, n, c.ext),
				id+"."+c.ext, c.mime, size, ts(messageTimes[msgID-1]), messageAuthors[msgID-1],
			); err != nil {
				return fmt.Errorf("alpha: attachment %d: %w", n, err)
			}
		}
	}
	return nil
}

func alphaInsertReactions(tx *sql.Tx, rng *rand.Rand) error {
	emojis := []string{"👍", "😂", "🎉", "❤️", "🔥", "😮"}
	type key struct {
		m, u int64
		e    string
	}
	seen := map[key]bool{}
	id := 0
	for id < alphaReactions {
		k := key{
			m: int64(rng.Intn(alphaMessages) + 1),
			u: int64(rng.Intn(alphaUsers) + 1),
			e: emojis[rng.Intn(len(emojis))],
		}
		if seen[k] {
			continue
		}
		seen[k] = true
		id++
		if _, err := tx.Exec(
			`INSERT INTO reactions (id, message_id, user_id, emoji) VALUES (?, ?, ?, ?)`,
			id, k.m, k.u, k.e,
		); err != nil {
			return fmt.Errorf("alpha: reaction %d: %w", id, err)
		}
	}
	return nil
}

func alphaInsertInvites(tx *sql.Tx, rng *rand.Rand, windowStart time.Time) error {
	staffCount := alphaOwners + alphaAdmins + alphaModerators
	for i := 1; i <= alphaInvites; i++ {
		revoked := 0
		if i <= alphaInvitesRevkd {
			revoked = 1
		}
		var maxUses any
		if i%3 == 0 {
			maxUses = 10
		}
		var expires any
		if i%4 == 0 {
			expires = ts(alphaWindowEnd.AddDate(0, 0, 7))
		}
		if _, err := tx.Exec(
			`INSERT INTO invites (id, code, created_by, max_uses, use_count, expires_at, created_at, revoked)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			i, fmt.Sprintf("ALPHA-INV-%02d", i), rng.Intn(staffCount)+1,
			maxUses, rng.Intn(8), expires,
			ts(windowStart.Add(time.Duration(i)*13*time.Hour)), revoked,
		); err != nil {
			return fmt.Errorf("alpha: invite %d: %w", i, err)
		}
	}
	return nil
}

// ─── Small helpers ──────────────────────────────────────────────────────────

// ts renders a time the way the schema's datetime('now') defaults do.
func ts(t time.Time) string { return t.UTC().Format("2006-01-02 15:04:05") }

// sentence builds 3–14 lexicon words; median chat-message length.
func sentence(rng *rand.Rand) string {
	n := 3 + rng.Intn(12)
	words := make([]string, n)
	for i := range words {
		words[i] = alphaLexicon[rng.Intn(len(alphaLexicon))]
	}
	return strings.Join(words, " ")
}

// skewedIndex prefers low indexes (min of two uniforms), so a few DM pairs
// are chatty and the tail is sparse — the shape real DM traffic has.
func skewedIndex(rng *rand.Rand, n int) int {
	a, b := rng.Intn(n), rng.Intn(n)
	if b < a {
		return b
	}
	return a
}

// largestRemainder allocates total across weights, summing exactly to total.
func largestRemainder(weights []int, total int) []int {
	sum := 0
	for _, w := range weights {
		sum += w
	}
	out := make([]int, len(weights))
	type rem struct {
		i    int
		frac float64
	}
	rems := make([]rem, len(weights))
	assigned := 0
	for i, w := range weights {
		exact := float64(total) * float64(w) / float64(sum)
		out[i] = int(exact)
		assigned += out[i]
		rems[i] = rem{i, exact - float64(out[i])}
	}
	// Stable selection sort by remainder — deterministic, n is tiny.
	for assigned < total {
		best := 0
		for j := 1; j < len(rems); j++ {
			if rems[j].frac > rems[best].frac {
				best = j
			}
		}
		out[rems[best].i]++
		rems[best].frac = -1
		assigned++
	}
	return out
}

func onesSlice(n int) []int {
	s := make([]int, n)
	for i := range s {
		s[i] = 1
	}
	return s
}
