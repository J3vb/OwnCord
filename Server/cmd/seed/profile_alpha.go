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

	rng := rand.New(rand.NewSource(alphaSeed))
	windowStart := alphaWindowEnd.AddDate(0, 0, -alphaWindowDays)

	tx, err := database.BeginTx(context.Background(), &sql.TxOptions{})
	if err != nil {
		return fmt.Errorf("alpha: begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if err := alphaInsertUsers(tx, rng, windowStart); err != nil {
		return err
	}
	if err := alphaInsertChannels(tx, windowStart); err != nil {
		return err
	}
	pairs, err := alphaInsertDMs(tx, rng, windowStart)
	if err != nil {
		return err
	}
	messageTimes, err := alphaInsertMessages(tx, rng, windowStart, pairs)
	if err != nil {
		return err
	}
	if err := alphaInsertAttachments(tx, rng, messageTimes); err != nil {
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
	for _, line := range strings.Split(string(scrub), "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		sqlOnly = append(sqlOnly, line)
	}
	for _, stmt := range strings.Split(strings.Join(sqlOnly, "\n"), ";") {
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

func alphaInsertUsers(tx *sql.Tx, rng *rand.Rand, windowStart time.Time) error {
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
	// The first forty accounts predate the window (an established server);
	// the remaining sixty joined during it, spread evenly with jitter.
	joinedAt := func(i int) time.Time {
		if i <= 40 {
			return windowStart.AddDate(0, 0, -60).Add(time.Duration(i) * 26 * time.Hour)
		}
		into := time.Duration(i-41) * (time.Duration(alphaWindowDays) * 24 * time.Hour) / 60
		return windowStart.Add(into).Add(time.Duration(rng.Intn(3600)) * time.Second)
	}

	const cols = 7
	var b strings.Builder
	args := make([]any, 0, alphaUsers*cols)
	for i := 1; i <= alphaUsers; i++ {
		if i > 1 {
			b.WriteString(",")
		}
		b.WriteString("(?,?,?,?,?,?,?)")
		created := joinedAt(i)
		lastSeen := alphaWindowEnd.Add(-time.Duration(rng.Intn(72*3600)) * time.Second)
		args = append(args,
			i, fmt.Sprintf("user%03d", i), alphaPasswordHash, roleOf(i),
			"offline", ts(created), ts(lastSeen),
		)
	}
	_, err := tx.Exec(
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
}

// alphaInsertDMs creates the 40 DM channels exactly as GetOrCreateDMChannel
// would (type 'dm', empty name, both participants, both open).
func alphaInsertDMs(tx *sql.Tx, rng *rand.Rand, windowStart time.Time) ([]dmPair, error) {
	seen := map[[2]int64]bool{}
	pairs := make([]dmPair, 0, alphaDMPairs)
	for len(pairs) < alphaDMPairs {
		a := int64(rng.Intn(alphaUsers) + 1)
		b := int64(rng.Intn(alphaUsers) + 1)
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
		opened := windowStart.Add(time.Duration(len(pairs)) * 17 * time.Hour)
		if _, err := tx.Exec(
			`INSERT INTO channels (id, name, type, is_group, created_at) VALUES (?, '', 'dm', 0, ?)`,
			id, ts(opened),
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
				`INSERT INTO dm_open_state (user_id, channel_id, opened_at) VALUES (?, ?, ?)`, u, id, ts(opened),
			); err != nil {
				return nil, fmt.Errorf("alpha: dm open state: %w", err)
			}
		}
		pairs = append(pairs, dmPair{channelID: id, a: a, b: b})
	}
	return pairs, nil
}

// ─── Messages ───────────────────────────────────────────────────────────────

// alphaInsertMessages writes all 20,000 messages in chronological order —
// ascending ids follow ascending time, as they would on a live server — and
// returns each message's timestamp (indexed by id-1) for the attachment rows.
func alphaInsertMessages(tx *sql.Tx, rng *rand.Rand, windowStart time.Time, pairs []dmPair) ([]time.Time, error) {
	// Exactly 15% of message ids are DM messages.
	dmCount := int(float64(alphaMessages) * alphaDMShare)
	isDM := make([]bool, alphaMessages)
	for _, idx := range rng.Perm(alphaMessages)[:dmCount] {
		isDM[idx] = true
	}

	perDay := largestRemainder(onesSlice(alphaWindowDays), alphaMessages)
	weights := alphaHourWeights[:]

	textChannels := []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	// Relative traffic per text channel; #announcements and #welcome are
	// quiet, #general and #gaming busy, #staff small, archive early-only.
	chanWeight := []int{2, 1, 30, 18, 22, 10, 8, 6, 3, 8}

	pickChannel := func(day int) int64 {
		w := make([]int, len(chanWeight))
		copy(w, chanWeight)
		if day >= 10 {
			w[9] = 0 // the archived channel's history ends on day 10
		}
		total := 0
		for _, x := range w {
			total += x
		}
		n := rng.Intn(total)
		for i, x := range w {
			if n < x {
				return textChannels[i]
			}
		}
		return 3
	}
	// Staff channel posters are staff (+ the override-listed user009);
	// announcement channels are staff-posted; everywhere else, anyone.
	pickAuthor := func(ch int64) int64 {
		switch ch {
		case 1, 2:
			return int64(rng.Intn(alphaOwners+alphaAdmins+alphaModerators) + 1)
		case 9:
			staff := []int64{1, 2, 3, 4, 5, 6, 7, 8, 9}
			return staff[rng.Intn(len(staff))]
		default:
			return int64(rng.Intn(alphaUsers) + 1)
		}
	}

	times := make([]time.Time, 0, alphaMessages)
	const cols = 5
	const chunk = 500
	var b strings.Builder
	args := make([]any, 0, chunk*cols)
	flush := func() error {
		if b.Len() == 0 {
			return nil
		}
		_, err := tx.Exec(
			`INSERT INTO messages (id, channel_id, user_id, content, timestamp) VALUES `+b.String(),
			args...,
		)
		b.Reset()
		args = args[:0]
		return err
	}

	id := 0
	for day := 0; day < alphaWindowDays; day++ {
		perHour := largestRemainder(weights, perDay[day])
		for hour := 0; hour < 24; hour++ {
			for k := 0; k < perHour[hour]; k++ {
				at := windowStart.AddDate(0, 0, day).
					Add(time.Duration(hour) * time.Hour).
					Add(time.Duration(rng.Intn(3600)) * time.Second)
				var ch, author int64
				if isDM[id] {
					p := pairs[skewedIndex(rng, len(pairs))]
					ch = p.channelID
					if rng.Intn(2) == 0 {
						author = p.a
					} else {
						author = p.b
					}
				} else {
					ch = pickChannel(day)
					author = pickAuthor(ch)
				}
				id++
				times = append(times, at)
				if len(args) > 0 {
					b.WriteString(",")
				}
				b.WriteString("(?,?,?,?,?)")
				args = append(args, id, ch, author, sentence(rng), ts(at))
				if len(args) >= chunk*cols {
					if err := flush(); err != nil {
						return nil, fmt.Errorf("alpha: messages: %w", err)
					}
				}
			}
		}
	}
	if err := flush(); err != nil {
		return nil, fmt.Errorf("alpha: messages: %w", err)
	}
	return times, nil
}

// ─── Attachments, reactions, invites ────────────────────────────────────────

func alphaInsertAttachments(tx *sql.Tx, rng *rand.Rand, messageTimes []time.Time) error {
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
			if _, err := tx.Exec(
				`INSERT INTO attachments (id, message_id, filename, stored_as, mime_type, size, uploaded_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				id, msgID,
				fmt.Sprintf("%s-%03d.%s", c.namePrefix, n, c.ext),
				id+"."+c.ext, c.mime, size, ts(messageTimes[msgID-1]),
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
