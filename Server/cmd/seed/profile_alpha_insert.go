package main

import (
	"database/sql"
	"fmt"
	"math/rand"
	"sort"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/permissions"
)

// alphaJoinTimes computes every user's created_at once so generators never author a message before its author
// joined (time-travelling rows would poison the retention and account-age rehearsals). Monotonic in the user
// id: the first forty accounts (all staff) predate the window and the other sixty join during it in id order,
// so "who exists at time t" is always the prefix 1..N.
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

func alphaInsertChannels(tx *sql.Tx, windowStart time.Time) error {
	created := windowStart.AddDate(0, 0, -60)
	// One category row per distinct name, in order of first appearance, so ids
	// and positions are deterministic.
	categoryIDs := map[string]int64{}
	for _, c := range alphaChannelDefs {
		if _, seen := categoryIDs[c.category]; seen || c.category == "" {
			continue
		}
		pos := len(categoryIDs)
		res, err := tx.Exec(`INSERT INTO channel_categories (name, position, created_at) VALUES (?, ?, ?)`,
			c.category, pos, ts(created.Add(time.Duration(pos)*time.Minute)))
		if err != nil {
			return fmt.Errorf("alpha: category %q: %w", c.category, err)
		}
		id, err := res.LastInsertId()
		if err != nil {
			return fmt.Errorf("alpha: category %q id: %w", c.category, err)
		}
		categoryIDs[c.category] = id
	}
	for i, c := range alphaChannelDefs {
		archived := 0
		if c.archived {
			archived = 1
		}
		var categoryID any
		if id, ok := categoryIDs[c.category]; ok {
			categoryID = id
		}
		if _, err := tx.Exec(
			`INSERT INTO channels (id, name, type, category_id, topic, position, archived, is_group, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
			i+1, c.name, c.ctype, categoryID, c.topic, c.position, archived, ts(created.Add(time.Duration(i)*time.Minute)),
		); err != nil {
			return fmt.Errorf("alpha: channel %q: %w", c.name, err)
		}
	}

	// Three channels carry role overrides (ids 1, 2, 9) and two user overrides
	// (ids 9 and 4); channel 9 has both, deliberately layered.
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

type dmPair struct {
	channelID int64
	a, b      int64
	// ready is when both members exist: no message in the pair may precede it, and it is the channel's
	// created_at / opened_at, as GetOrCreateDMChannel would set.
	ready time.Time
}

// alphaInsertDMs creates the 40 DM channels as GetOrCreateDMChannel would. The first twelve pairs are drawn
// from pre-window accounts so DM traffic exists from the first hour; the rest carry messages only once both
// members exist.
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

// alphaChannelWeights is the relative traffic per text channel (ids 1..10): announcements and welcome quiet,
// general and gaming busy, staff small, the archive early-only.
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

// alphaAuthorFor picks a message author: #welcome and #announcements are staff-posted, #staff adds the
// override-listed user009, elsewhere anyone joined by the message's time (maxUser is the eligibility prefix).
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

// alphaInsertMessages writes all 20,000 messages in chronological order (per-bucket second offsets are sorted
// before ids are assigned, so ascending ids follow ascending timestamps as on a live server) and returns each
// message's timestamp and author (indexed by id-1) for the attachment rows. Authors come only from users
// existing at that time (the prefix 1..maxUser, as alphaJoinTimes is monotonic); a DM pair carries traffic
// only from its ready time.
func alphaInsertMessages(tx *sql.Tx, rng *rand.Rand, windowStart time.Time, joined []time.Time, pairs []dmPair) ([]time.Time, []int64, error) {
	dmCount := int(float64(alphaMessages) * alphaDMShare)
	isDM := make([]bool, alphaMessages)
	for _, idx := range rng.Perm(alphaMessages)[:dmCount] {
		isDM[idx] = true
	}

	perDay := largestRemainder(onesSlice(alphaWindowDays), alphaMessages)

	// Pairs sorted by readiness so the eligible set at any time is a prefix;
	// skewedIndex keeps the earliest pairs the chattiest, the realistic shape.
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
			// The uploader is the message's author; CreateAttachment always
			// records one.
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
