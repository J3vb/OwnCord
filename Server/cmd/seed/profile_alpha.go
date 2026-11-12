// The alpha-shaped profile.
//
// `go run ./cmd/seed -confirm-dev -profile alpha` fills an empty database with a deterministic dataset shaped
// like a real 1.2.0-alpha.4 server after a month of use. Scrubbed and vacuumed, it is the committed snapshot
// at Server/testdata/snapshots/v1.2.0-alpha.4.sqlite that the recovery drills, upgrade rehearsal and in-place
// upgrade consume (the schema has not changed since that tag).
//
// Determinism is the contract (TestAlphaProfileByteIdentical): fixed rng seed and clock, a constant bcrypt
// hash (live hashing salts every run), explicit ids and timestamps, one insert order, `VACUUM INTO` as the
// byte-canonical output. A number found unrepresentative is changed here, never silently. Two constants
// deliberately leave no rows: alphaVoiceSessions (voice is LiveKit-ephemeral and voice_states is live
// presence) and events (the replay log is empty, as on any upgraded server; fabricated frames would be
// replayed verbatim to real clients).
//
// The seeded accounts all use the password "alpha-dev-password" (constant hash below), which is why
// -confirm-dev stays mandatory.
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
	"github.com/J3vb/OwnCord/Server/dbtime"
)

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

	// alphaVoiceSessions is a shape parameter with no at-rest rows (see the package comment).
	alphaVoiceSessions = 200

	// alphaPasswordHash is bcrypt("alpha-dev-password"), fixed so two seed
	// runs produce identical bytes. Weak and public by design: -confirm-dev.
	//nolint:gosec // G101: a deliberately public dev-profile hash ("alpha-dev-password"); -confirm-dev gates every use
	alphaPasswordHash = "$2a$12$EBrRXmplT1ryU0o/HzELSePreo.gK5.z5Tjo4ec/ISchy5gKwxtQq"
)

var alphaWindowEnd = time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)

// alphaHourWeights shapes the diurnal curve as relative weights per UTC hour; largest-remainder allocation
// makes the per-bucket counts sum exactly to the day's total.
var alphaHourWeights = [24]int{
	1, 1, 1, 1, 1, 2, // 00–05
	3, 5, 7, 8, 8, 8, // 06–11
	9, 9, 8, 8, 9, 10, // 12–17
	11, 12, 11, 8, 5, 2, // 18–23
}

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

type alphaChannel struct {
	name, ctype, category, topic string
	position                     int
	archived                     bool
}

// Ten text and two voice channels; the overrides refer to them by id (index+1).
// Channel 10 is the archived one and carries only early-window history.
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

// seedAlpha fills an empty database and refuses a non-empty one: only "empty" is a state two runs can share.
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

// writeSnapshot applies the scrub script and writes the snapshot via VACUUM INTO, which refuses to overwrite,
// so a stale target is removed first.
func writeSnapshot(database *db.DB, scrubPath, outPath string) error {
	scrub, err := os.ReadFile(scrubPath)
	if err != nil {
		return fmt.Errorf("alpha: reading scrub script: %w", err)
	}
	// Strip comment lines first, then split on ";" so a ";" inside a comment
	// does not end a statement; the scrub script holds no string literal
	// containing ";".
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

func ts(t time.Time) string { return t.UTC().Format(dbtime.SQLiteLayout) }

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
