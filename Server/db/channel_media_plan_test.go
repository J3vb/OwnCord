package db

import (
	"context"
	"strings"
	"testing"
	"time"
)

// explainMediaPage returns the query plan of the page ListChannelMedia would run for q.
func explainMediaPage(t *testing.T, d *DB, q ChannelMediaQuery) string {
	t.Helper()
	ctx := context.Background()
	filter, args, err := d.channelMediaFilter(ctx, q, true)
	if err != nil {
		t.Fatal(err)
	}
	query, args := channelMediaPageSQL(q, filter, args)
	rows, err := d.reader.QueryContext(ctx, "EXPLAIN QUERY PLAN "+query, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close() //nolint:errcheck
	var plan []string
	for rows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return strings.Join(plan, "\n")
}

// Every page seeks: the channel's messages are walked through idx_messages_channel and attachments are looked
// up per message, so a channel with few pictures never reads the server's other attachments.
func TestChannelMediaPagePlanSeeks(t *testing.T) {
	d := openMigratedMemoryInternal(t)
	if _, err := d.writer.Exec(`INSERT INTO users (id, username, password) VALUES (1, 'u', 'h')`); err != nil {
		t.Fatal(err)
	}
	if _, err := d.writer.Exec(`INSERT INTO channels (id, name, type) VALUES (1, 'c', 'text')`); err != nil {
		t.Fatal(err)
	}
	base := ChannelMediaQuery{ChannelID: 1, ViewerID: 1, Kind: MediaKindMedia, Limit: 50}
	cases := map[string]ChannelMediaQuery{}
	cases["first newest"] = base
	oldest := base
	oldest.Oldest = true
	cases["first oldest"] = oldest
	cursor := base
	cursor.Cursor = MediaCursor{MessageID: 500, AttachmentID: "x"}
	cases["cursor newest"] = cursor
	cursorOld := oldest
	cursorOld.Cursor = cursor.Cursor
	cases["cursor oldest"] = cursorOld
	from := base
	from.From = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	cases["from"] = from
	for name, q := range cases {
		plan := explainMediaPage(t, d, q)
		if !strings.Contains(plan, "idx_messages_channel") || !strings.Contains(plan, "idx_attachments_message") {
			t.Errorf("%s: plan does not walk the channel's messages and look attachments up by message:\n%s", name, plan)
		}
		for _, line := range strings.Split(plan, "\n") {
			if strings.HasPrefix(line, "SCAN a") || strings.HasPrefix(line, "SCAN attachments") {
				t.Errorf("%s: plan scans every attachment: %s", name, line)
			}
		}
	}
	plan := explainMediaPage(t, d, cursor)
	if !strings.Contains(plan, "id<?") {
		t.Errorf("cursor page does not seek past the cursor message:\n%s", plan)
	}
	plan = explainMediaPage(t, d, cursorOld)
	if !strings.Contains(plan, "id>?") {
		t.Errorf("oldest-first cursor page does not seek past the cursor message:\n%s", plan)
	}
}
