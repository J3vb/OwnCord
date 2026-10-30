package db_test

import (
	"context"
	"database/sql"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// The read-path benchmarks below run on one synthetic database shaped like a
// large server: 400k messages, 500 users, 40 text channels, 150k reactions,
// 30k attachments and 20k mentions. Building it takes about a minute, so it is
// built once per run and copied into each benchmark's temp dir. The nightly
// job compares the numbers with benchstat against the stored baseline in
// Server/testdata/bench/.
const (
	perfUsers       = 500
	perfChannels    = 40
	perfMessages    = 400_000
	perfReactions   = 150_000
	perfAttachments = 30_000
	perfMentions    = 20_000
	perfSeed        = 20261029
	// perfUnreadGap leaves the bench user this many messages behind in every
	// channel, past the 100-row cap the unread query stops at.
	perfUnreadGap = 150
)

var perfLexicon = strings.Fields(`the a we you it that this just really pretty
server channel voice call message update build bug fix release game night
stream clip map round team later today tomorrow tonight morning again works
broke fixed joined left restarted uploaded good great weird slow fast new old
same anyone someone everyone nobody who what when why up down in out on off for
with about after lol nice thanks ok sure maybe yes no brb gg`)

var perfEmoji = []string{"👍", "😂", "🎉", "❤️", "🔥", "👀"}

var (
	perfOnce sync.Once
	perfPath string
	perfErr  error
)

// perfDB opens a private copy of the synthetic database.
func perfDB(b *testing.B) *db.DB {
	b.Helper()
	if testing.Short() {
		b.Skip("synthetic 400k-message database is skipped under -short")
	}
	perfOnce.Do(func() {
		dir, err := os.MkdirTemp("", "owncord-perfdb-")
		if err != nil {
			perfErr = fmt.Errorf("perf db temp dir: %w", err)
			return
		}
		perfPath = filepath.Join(dir, "perf.db")
		perfErr = buildPerfDB(perfPath)
	})
	if perfErr != nil {
		b.Fatalf("build synthetic db: %v", perfErr)
	}
	dst := filepath.Join(b.TempDir(), "perf.db")
	src, err := os.ReadFile(perfPath)
	if err != nil {
		b.Fatalf("read synthetic db: %v", err)
	}
	if err := os.WriteFile(dst, src, 0o600); err != nil {
		b.Fatalf("copy synthetic db: %v", err)
	}
	database, err := db.Open(dst)
	if err != nil {
		b.Fatalf("db.Open: %v", err)
	}
	b.Cleanup(func() { _ = database.Close() })
	return database
}

func buildPerfDB(path string) error {
	database, err := db.Open(path)
	if err != nil {
		return fmt.Errorf("open: %w", err)
	}
	if err := db.Migrate(database); err != nil {
		_ = database.Close()
		return fmt.Errorf("migrate: %w", err)
	}
	tx, err := database.SQLDb().Begin()
	if err != nil {
		_ = database.Close()
		return fmt.Errorf("begin: %w", err)
	}
	if err := seedPerfDB(tx); err != nil {
		_ = tx.Rollback()
		_ = database.Close()
		return fmt.Errorf("seed: %w", err)
	}
	if err := tx.Commit(); err != nil {
		_ = database.Close()
		return fmt.Errorf("commit: %w", err)
	}
	if _, err := database.SQLDb().Exec(`ANALYZE`); err != nil {
		_ = database.Close()
		return fmt.Errorf("analyze: %w", err)
	}
	if err := database.Close(); err != nil {
		return fmt.Errorf("close: %w", err)
	}
	return nil
}

type perfBatch struct {
	tx     *sql.Tx
	prefix string
	b      strings.Builder
	args   []any
}

func (pb *perfBatch) add(row string, vals ...any) error {
	if len(pb.args) > 0 {
		pb.b.WriteString(",")
	}
	pb.b.WriteString(row)
	pb.args = append(pb.args, vals...)
	if len(pb.args) >= 2000 {
		return pb.flush()
	}
	return nil
}

func (pb *perfBatch) flush() error {
	if len(pb.args) == 0 {
		return nil
	}
	_, err := pb.tx.Exec(pb.prefix+pb.b.String(), pb.args...)
	pb.b.Reset()
	pb.args = pb.args[:0]
	if err != nil {
		return fmt.Errorf("%s: %w", strings.Fields(pb.prefix)[2], err)
	}
	return nil
}

func seedPerfDB(tx *sql.Tx) error {
	rng := rand.New(rand.NewSource(perfSeed)) //nolint:gosec // G404: deterministic fixture, not security
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	users := &perfBatch{tx: tx, prefix: `INSERT INTO users (id, username, password, role_id, status, created_at) VALUES `}
	for id := 1; id <= perfUsers; id++ {
		role := 4
		if id == 1 {
			role = 1
		}
		if err := users.add("(?,?,?,?,?,?)", id, fmt.Sprintf("perf%03d", id), "x", role, "offline", start.Format(time.DateTime)); err != nil {
			return err
		}
	}
	if err := users.flush(); err != nil {
		return err
	}
	for id := 1; id <= perfChannels; id++ {
		if _, err := tx.Exec(`INSERT INTO channels (id, name, type, position) VALUES (?, ?, 'text', ?)`,
			id, fmt.Sprintf("perf-%02d", id), id); err != nil {
			return fmt.Errorf("channels: %w", err)
		}
	}

	msgs := &perfBatch{tx: tx, prefix: `INSERT INTO messages (id, channel_id, user_id, content, timestamp) VALUES `}
	var words strings.Builder
	for id := 1; id <= perfMessages; id++ {
		words.Reset()
		n := 4 + rng.Intn(14)
		for w := range n {
			if w > 0 {
				words.WriteByte(' ')
			}
			words.WriteString(perfLexicon[rng.Intn(len(perfLexicon))])
		}
		ch := 1 + (id-1)%perfChannels
		ts := start.Add(time.Duration(id) * 15 * time.Second).Format(time.DateTime)
		if err := msgs.add("(?,?,?,?,?)", id, ch, 1+rng.Intn(perfUsers), words.String(), ts); err != nil {
			return err
		}
	}
	if err := msgs.flush(); err != nil {
		return err
	}

	reacts := &perfBatch{tx: tx, prefix: `INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES `}
	for range perfReactions {
		if err := reacts.add("(?,?,?)", 1+rng.Intn(perfMessages), 1+rng.Intn(perfUsers), perfEmoji[rng.Intn(len(perfEmoji))]); err != nil {
			return err
		}
	}
	if err := reacts.flush(); err != nil {
		return err
	}

	atts := &perfBatch{tx: tx, prefix: `INSERT INTO attachments (id, message_id, filename, stored_as, mime_type, size, uploaded_at, uploader_id) VALUES `}
	for i := 1; i <= perfAttachments; i++ {
		id := fmt.Sprintf("perf-att-%05d", i)
		if err := atts.add("(?,?,?,?,?,?,?,?)", id, 1+rng.Intn(perfMessages), id+".png", id+".png", "image/png",
			1000+rng.Intn(500_000), start.Format(time.DateTime), 1+rng.Intn(perfUsers)); err != nil {
			return err
		}
	}
	if err := atts.flush(); err != nil {
		return err
	}

	mentions := &perfBatch{tx: tx, prefix: `INSERT OR IGNORE INTO message_mentions (message_id, mentioned_user_id) VALUES `}
	for range perfMentions {
		if err := mentions.add("(?,?)", 1+rng.Intn(perfMessages), 1+rng.Intn(perfUsers)); err != nil {
			return err
		}
	}
	if err := mentions.flush(); err != nil {
		return err
	}

	perChannel := perfMessages / perfChannels
	reads := &perfBatch{tx: tx, prefix: `INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES `}
	for ch := 1; ch <= perfChannels; ch++ {
		lastRead := (perChannel-perfUnreadGap-1)*perfChannels + ch
		if err := reads.add("(?,?,?,?)", 1, ch, lastRead, ch%3); err != nil {
			return err
		}
	}
	return reads.flush()
}

// BenchmarkSearchCommonWord is a global relevance search for a word that
// appears in about one message in five.
func BenchmarkSearchCommonWord(b *testing.B) {
	database := perfDB(b)
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		res, err := database.SearchMessages(ctx, "release", nil, db.SearchPage{Limit: 25})
		if err != nil || len(res) == 0 {
			b.Fatalf("SearchMessages = %d results, err %v", len(res), err)
		}
	}
}

// BenchmarkHistoryPage is the newest 50 messages of a channel in the API
// shape, with reactions, attachments and mentions.
func BenchmarkHistoryPage(b *testing.B) {
	database := perfDB(b)
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		res, err := database.GetMessagesForAPI(ctx, 7, 0, 50, 1)
		if err != nil || len(res) != 50 {
			b.Fatalf("GetMessagesForAPI = %d rows, err %v", len(res), err)
		}
	}
}

// BenchmarkUnreadCounts is the per-channel unread summary a client receives
// on connect, for a user behind in all 40 channels.
func BenchmarkUnreadCounts(b *testing.B) {
	database := perfDB(b)
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		res, err := database.GetChannelUnreadCounts(ctx, 1)
		if err != nil || len(res) != perfChannels {
			b.Fatalf("GetChannelUnreadCounts = %d channels, err %v", len(res), err)
		}
	}
}
