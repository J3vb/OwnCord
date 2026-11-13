package linkpreview

import (
	"context"
	"testing"
)

type msgFixture struct {
	*fixture
	channelID, userID int64
}

func newMsgFixture(ctx context.Context, t *testing.T) *msgFixture {
	t.Helper()
	f := newFixture(t)
	uid, err := f.db.CreateUser(ctx, "alice", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	cid, err := f.db.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	return &msgFixture{fixture: f, channelID: cid, userID: uid}
}

func (m *msgFixture) message(ctx context.Context) (id int64, version string) {
	m.t.Helper()
	id, err := m.db.CreateMessage(ctx, m.channelID, m.userID, "see https://example.com/a", nil)
	if err != nil {
		m.t.Fatal(err)
	}
	return id, m.version(ctx, id)
}

func (m *msgFixture) version(ctx context.Context, id int64) string {
	m.t.Helper()
	var v string
	err := m.db.QueryRowContext(ctx, `SELECT COALESCE(edited_at, timestamp) FROM messages WHERE id = ?`, id).Scan(&v)
	if err != nil {
		m.t.Fatal(err)
	}
	return v
}

func (m *msgFixture) exec(ctx context.Context, query string, args ...any) {
	m.t.Helper()
	if _, err := m.db.ExecContext(ctx, query, args...); err != nil {
		m.t.Fatalf("%s: %v", query, err)
	}
}

func (m *msgFixture) count(ctx context.Context, query string, args ...any) int {
	m.t.Helper()
	var n int
	if err := m.db.QueryRowContext(ctx, query, args...).Scan(&n); err != nil {
		m.t.Fatal(err)
	}
	return n
}

func TestReplaceMessagePreviews(t *testing.T) {
	ctx := t.Context()
	m := newMsgFixture(ctx, t)
	id, version := m.message(ctx)
	a := m.card(ctx, "https://example.com/a", nil)
	b := m.card(ctx, "https://example.com/b", nil)

	// Applies when the version matches, in link order.
	ok, err := m.store.ReplaceMessagePreviews(ctx, id, version, []string{b, a})
	if err != nil || !ok {
		t.Fatalf("Replace = %v, %v; want applied", ok, err)
	}
	cards, err := m.store.MessagePreviews(ctx, id)
	if err != nil || len(cards) != 2 || cards[0].UrlHash != b || cards[1].UrlHash != a {
		t.Fatalf("cards = %+v, %v", cards, err)
	}
	var unfurl string
	if err := m.db.QueryRowContext(ctx, `SELECT content_version FROM message_unfurls WHERE message_id = ?`, id).Scan(&unfurl); err != nil || unfurl != version {
		t.Errorf("unfurl version = %q, %v; want %q", unfurl, err, version)
	}

	// Replacing swaps the whole set, and an empty set still records the unfurl.
	if ok, err = m.store.ReplaceMessagePreviews(ctx, id, version, []string{a}); err != nil || !ok {
		t.Fatalf("second Replace = %v, %v", ok, err)
	}
	if cards, _ = m.store.MessagePreviews(ctx, id); len(cards) != 1 || cards[0].UrlHash != a {
		t.Errorf("cards after replace = %+v", cards)
	}
	if ok, err = m.store.ReplaceMessagePreviews(ctx, id, version, nil); err != nil || !ok {
		t.Fatalf("empty Replace = %v, %v", ok, err)
	}
	if cards, _ = m.store.MessagePreviews(ctx, id); len(cards) != 0 {
		t.Errorf("cards after empty replace = %+v", cards)
	}
	if n := m.count(ctx, `SELECT COUNT(*) FROM message_unfurls WHERE message_id = ?`, id); n != 1 {
		t.Errorf("unfurl rows = %d, want 1 (unfurled with no links)", n)
	}
}

func TestReplaceMessagePreviewsRefusesStale(t *testing.T) {
	ctx := t.Context()
	a := func(m *msgFixture) string { return m.card(ctx, "https://example.com/a", nil) }

	tests := []struct {
		name  string
		setup func(ctx context.Context, m *msgFixture, id int64) (version string)
	}{
		{"edited since", func(ctx context.Context, m *msgFixture, id int64) string {
			v := m.version(ctx, id)
			m.exec(ctx, `UPDATE messages SET edited_at = '2031-02-03 04:05:06' WHERE id = ?`, id)
			return v
		}},
		{"wrong version", func(context.Context, *msgFixture, int64) string { return "2000-01-01 00:00:00" }},
		{"soft deleted", func(ctx context.Context, m *msgFixture, id int64) string {
			v := m.version(ctx, id)
			m.exec(ctx, `UPDATE messages SET deleted = 1 WHERE id = ?`, id)
			return v
		}},
		{"hard deleted", func(ctx context.Context, m *msgFixture, id int64) string {
			v := m.version(ctx, id)
			m.exec(ctx, `DELETE FROM messages WHERE id = ?`, id)
			return v
		}},
		{"never existed", func(ctx context.Context, m *msgFixture, id int64) string { return m.version(ctx, id) }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m := newMsgFixture(ctx, t)
			id, _ := m.message(ctx)
			h := a(m)
			version := tc.setup(ctx, m, id)
			target := id
			if tc.name == "never existed" {
				target = id + 1000
			}
			ok, err := m.store.ReplaceMessagePreviews(ctx, target, version, []string{h})
			if err != nil || ok {
				t.Fatalf("Replace = %v, %v; want refused without error", ok, err)
			}
			if n := m.count(ctx, `SELECT COUNT(*) FROM message_link_previews`); n != 0 {
				t.Errorf("link rows = %d after a refused write", n)
			}
			if n := m.count(ctx, `SELECT COUNT(*) FROM message_unfurls`); n != 0 {
				t.Errorf("unfurl rows = %d after a refused write", n)
			}
		})
	}
}

// A refused write must leave an earlier current result intact.
func TestReplaceRefusalKeepsEarlierResult(t *testing.T) {
	ctx := t.Context()
	m := newMsgFixture(ctx, t)
	id, version := m.message(ctx)
	a := m.card(ctx, "https://example.com/a", nil)
	if ok, err := m.store.ReplaceMessagePreviews(ctx, id, version, []string{a}); err != nil || !ok {
		t.Fatal(ok, err)
	}
	m.exec(ctx, `UPDATE messages SET edited_at = '2031-02-03 04:05:06' WHERE id = ?`, id)
	if ok, err := m.store.ReplaceMessagePreviews(ctx, id, version, nil); err != nil || ok {
		t.Fatalf("stale Replace = %v, %v", ok, err)
	}
	if cards, _ := m.store.MessagePreviews(ctx, id); len(cards) != 1 {
		t.Errorf("earlier result lost: %+v", cards)
	}
}

func TestMessageDeleteDropsLinks(t *testing.T) {
	ctx := t.Context()
	for _, tc := range []struct{ name, stmt string }{
		{"hard delete cascades", `DELETE FROM messages WHERE id = ?`},
		{"soft delete clears", `UPDATE messages SET deleted = 1 WHERE id = ?`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newMsgFixture(ctx, t)
			id, version := m.message(ctx)
			otherID, otherVersion := m.message(ctx)
			a := m.card(ctx, "https://example.com/a", nil)
			if ok, err := m.store.ReplaceMessagePreviews(ctx, id, version, []string{a}); err != nil || !ok {
				t.Fatal(ok, err)
			}
			if ok, err := m.store.ReplaceMessagePreviews(ctx, otherID, otherVersion, []string{a}); err != nil || !ok {
				t.Fatal(ok, err)
			}
			m.exec(ctx, tc.stmt, id)
			if n := m.count(ctx, `SELECT COUNT(*) FROM message_link_previews WHERE message_id = ?`, id); n != 0 {
				t.Errorf("link rows for the deleted message = %d", n)
			}
			if n := m.count(ctx, `SELECT COUNT(*) FROM message_unfurls WHERE message_id = ?`, id); n != 0 {
				t.Errorf("unfurl rows for the deleted message = %d", n)
			}
			if n := m.count(ctx, `SELECT COUNT(*) FROM message_link_previews WHERE message_id = ?`, otherID); n != 1 {
				t.Errorf("the other message lost its link: %d", n)
			}
			if n := m.count(ctx, `SELECT COUNT(*) FROM link_previews`); n != 1 {
				t.Errorf("the shared card was removed: %d", n)
			}
		})
	}
}

func TestPreviewsForMessagesJoinsImage(t *testing.T) {
	ctx := t.Context()
	m := newMsgFixture(ctx, t)
	id1, v1 := m.message(ctx)
	id2, v2 := m.message(ctx)
	id3, _ := m.message(ctx)
	img := m.put(ctx, "pic")
	withImage := m.card(ctx, "https://example.com/with", &img)
	without := m.card(ctx, "https://example.com/without", nil)
	for _, w := range []struct {
		id      int64
		version string
		hashes  []string
	}{{id1, v1, []string{without, withImage}}, {id2, v2, []string{withImage}}} {
		if ok, err := m.store.ReplaceMessagePreviews(ctx, w.id, w.version, w.hashes); err != nil || !ok {
			t.Fatal(ok, err)
		}
	}

	rows, err := m.store.PreviewsForMessages(ctx, []int64{id2, id1, id3})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3: %+v", len(rows), rows)
	}
	// Ordered by message id, then position.
	if rows[0].MessageID != id1 || rows[0].UrlHash != without || rows[0].ImageHash != nil || rows[0].ImageMimeType != nil {
		t.Errorf("row 0 = %+v", rows[0])
	}
	if rows[1].MessageID != id1 || rows[1].Position != 1 || rows[1].ImageMimeType == nil || *rows[1].ImageMimeType != "image/webp" || *rows[1].ImageWidth != 10 {
		t.Errorf("row 1 = %+v", rows[1])
	}
	if rows[2].MessageID != id2 {
		t.Errorf("row 2 = %+v", rows[2])
	}
	if none, err := m.store.PreviewsForMessages(ctx, nil); err != nil || len(none) != 0 {
		t.Errorf("no ids = %+v, %v", none, err)
	}
	single, err := m.store.MessagePreviews(ctx, id1)
	if err != nil || len(single) != 2 || single[0].UrlHash != without {
		t.Errorf("MessagePreviews = %+v, %v", single, err)
	}
}

func TestPreviewRoundTrip(t *testing.T) {
	ctx := t.Context()
	f := newFixture(t)
	if _, err := f.store.Preview(ctx, mustHash(t, "https://nope.example/")); err == nil {
		t.Fatal("missing preview returned no error")
	}
	h := f.card(ctx, "https://example.com/x", nil)
	failure := "unavailable"
	stamp := FormatTime(f.clock.now())
	if err := f.store.PutPreview(ctx, dbPreview(h, "https://example.com/x", &failure, stamp)); err != nil {
		t.Fatal(err)
	}
	p, err := f.store.Preview(ctx, h)
	if err != nil || p.Failure == nil || *p.Failure != "unavailable" || p.Title != nil {
		t.Errorf("preview after refetch = %+v, %v", p, err)
	}
}
