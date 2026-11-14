package service

import (
	"context"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/linkpreview"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// recordingUnfurler is the queue the service hands messages to.
type recordingUnfurler struct {
	mu       sync.Mutex
	jobs     []linkpreview.Job
	backfill [][]linkpreview.Job
	cards    []string
	images   []string
}

func (u *recordingUnfurler) Enqueue(j linkpreview.Job) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.jobs = append(u.jobs, j)
}

func (u *recordingUnfurler) EnqueueBackfill(js []linkpreview.Job) int {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.backfill = append(u.backfill, slices.Clone(js))
	return len(js)
}

func (u *recordingUnfurler) NoteShown(c, i []string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.cards, u.images = append(u.cards, c...), append(u.images, i...)
}

// countingReader counts the batch reads history makes.
type countingReader struct {
	*linkpreview.Store
	calls int
}

func (r *countingReader) PreviewsForMessages(ctx context.Context, ids []int64) ([]linkpreview.Card, error) {
	r.calls++
	return r.Store.PreviewsForMessages(ctx, ids)
}

func linkPreviewHistory(t *testing.T) (*MessageService, *db.DB, *countingReader, *recordingUnfurler) {
	t.Helper()
	svc, database := newTestMessageService(t)
	store, err := linkpreview.NewStore(database, filepath.Join(t.TempDir(), linkpreview.DirName))
	mustDo(t, "NewStore", err)
	reader := &countingReader{Store: store}
	q := &recordingUnfurler{}
	svc.SetLinkPreviews(reader)
	svc.SetLinkUnfurler(q)
	return svc, database, reader, q
}

// unfurled stores a titled card for rawURL on message id, as the worker would.
func unfurled(t *testing.T, database *db.DB, reader *countingReader, id int64, rawURL, title string) {
	t.Helper()
	ctx := context.Background()
	hash, norm, err := linkpreview.URLHash(rawURL)
	mustDo(t, "URLHash", err)
	mustDo(t, "PutPreview", reader.PutPreview(ctx, linkpreview.Preview{
		UrlHash: hash, Url: norm, Title: &title, FetchedAt: "2030-01-01T00:00:00Z", LastUsedAt: "2030-01-01T00:00:00Z",
	}))
	msg, err := database.GetMessage(ctx, id)
	mustDo(t, "GetMessage", err)
	version := msg.Timestamp
	if msg.EditedAt != nil {
		version = *msg.EditedAt
	}
	ok, err := reader.ReplaceMessagePreviews(ctx, id, version, msg.Content, []string{hash})
	if err != nil || !ok {
		t.Fatalf("ReplaceMessagePreviews = %v, %v", ok, err)
	}
}

func TestHistory_AttachesCardsInOneReadAndBackfillsTheRest(t *testing.T) {
	svc, database, reader, q := linkPreviewHistory(t)
	ctx := context.Background()
	done := mustCreateMessage(t, database, 10, 1, "see https://a.example/x", nil)
	pending := mustCreateMessage(t, database, 10, 1, "and https://b.example/y", nil)
	plain := mustCreateMessage(t, database, 10, 1, "no links", nil)
	unfurled(t, database, reader, done, "https://a.example/x", "Card A")

	msgs, _, err := svc.GetMessages(ctx, 1, 10, 0, 50)
	mustDo(t, "GetMessages", err)

	if reader.calls != 1 {
		t.Errorf("batch reads = %d, want 1 for the page", reader.calls)
	}
	byID := map[int64]db.MessageAPIResponse{}
	for _, m := range msgs {
		byID[m.ID] = m
	}
	if c := byID[done].Cards; len(c) != 1 || *c[0].Title != "Card A" || c[0].URL != "https://a.example/x" {
		t.Errorf("unfurled message cards = %+v", c)
	}
	if len(byID[pending].Cards) != 0 || len(byID[plain].Cards) != 0 {
		t.Error("a message without a stored card was given one")
	}
	if len(q.backfill) != 1 || len(q.backfill[0]) != 1 || q.backfill[0][0].MessageID != pending {
		t.Fatalf("backfill = %+v, want only the message with links and no card", q.backfill)
	}
	job := q.backfill[0][0]
	if job.Content != "and https://b.example/y" || job.AuthorID != 1 || job.ChannelID != 10 || job.Version == "" || job.Edited {
		t.Errorf("backfill job = %+v", job)
	}
	if len(q.cards) != 1 {
		t.Errorf("noted shown cards = %v, want the one shown", q.cards)
	}
}

func TestHistory_NoLinksMeansNoReadAndNoBackfill(t *testing.T) {
	svc, database, reader, q := linkPreviewHistory(t)
	mustCreateMessage(t, database, 10, 1, "just words", nil)
	_, _, err := svc.GetMessages(context.Background(), 1, 10, 0, 50)
	mustDo(t, "GetMessages", err)
	if reader.calls != 0 || len(q.backfill) != 0 {
		t.Errorf("reads = %d, backfills = %d; want none", reader.calls, len(q.backfill))
	}
}

// An edit that swapped the link hides the old card at once, and queues the message again.
func TestHistory_StaleCardHiddenAfterEditAndRequeued(t *testing.T) {
	svc, database, reader, q := linkPreviewHistory(t)
	ctx := context.Background()
	id := mustCreateMessage(t, database, 10, 1, "https://old.example/", nil)
	unfurled(t, database, reader, id, "https://old.example/", "Old")
	_, err := database.EditMessage(ctx, id, 1, "https://new.example/")
	mustDo(t, "EditMessage", err)

	msgs, _, err := svc.GetMessages(ctx, 1, 10, 0, 50)
	mustDo(t, "GetMessages", err)
	if len(msgs[0].Cards) != 0 {
		t.Errorf("stale card shown: %+v", msgs[0].Cards)
	}
	if len(q.backfill) != 1 || q.backfill[0][0].Content != "https://new.example/" || q.backfill[0][0].Version != *msgs[0].EditedAt {
		t.Errorf("backfill = %+v, want the edited text at its edited_at version", q.backfill)
	}
}

func TestHistory_BackfillIsCappedPerPageNewestFirst(t *testing.T) {
	svc, database, _, q := linkPreviewHistory(t)
	ids := make([]int64, 0, 30)
	for i := range 30 {
		ids = append(ids, mustCreateMessage(t, database, 10, 1, "https://s"+strings.Repeat("x", i)+".example/", nil))
	}
	_, _, err := svc.GetMessages(context.Background(), 1, 10, 0, 50)
	mustDo(t, "GetMessages", err)
	if len(q.backfill) != 1 || len(q.backfill[0]) != backfillPerPage {
		t.Fatalf("backfill batches = %d, want one of %d", len(q.backfill), backfillPerPage)
	}
	if q.backfill[0][0].MessageID != ids[29] || q.backfill[0][backfillPerPage-1].MessageID != ids[10] {
		t.Errorf("backfill spans %d..%d, want the newest %d messages", q.backfill[0][0].MessageID, q.backfill[0][backfillPerPage-1].MessageID, backfillPerPage)
	}
}

func TestHistory_DeletedAndSystemRowsAreLeftAlone(t *testing.T) {
	svc, database, _, q := linkPreviewHistory(t)
	id := mustCreateMessage(t, database, 10, 1, "https://gone.example/", nil)
	mustDo(t, "DeleteMessage", database.DeleteMessage(context.Background(), id, 1, false))
	_, _, err := svc.GetMessages(context.Background(), 1, 10, 0, 50)
	mustDo(t, "GetMessages", err)
	if len(q.backfill) != 0 {
		t.Errorf("a deleted message was queued: %+v", q.backfill)
	}
}

func TestHistory_WithoutAStoreNothingIsAttached(t *testing.T) {
	svc, database := newTestMessageService(t)
	mustCreateMessage(t, database, 10, 1, "https://a.example/", nil)
	msgs, _, err := svc.GetMessages(context.Background(), 1, 10, 0, 50)
	mustDo(t, "GetMessages", err)
	if len(msgs) != 1 || len(msgs[0].Cards) != 0 {
		t.Errorf("msgs = %+v", msgs)
	}
}

func TestSendAndEdit_QueueTheCommittedMessage(t *testing.T) {
	svc, database, _, q := linkPreviewHistory(t)
	ctx := context.Background()
	res := mustSendMessage(ctx, t, svc, SendMessageParams{ChannelID: 10, UserID: 1, Username: "alice", Content: "hi https://a.example/"})

	if len(q.jobs) != 1 {
		t.Fatalf("jobs after send = %+v", q.jobs)
	}
	stored, err := database.GetMessage(ctx, res.MessageID)
	mustDo(t, "GetMessage", err)
	j := q.jobs[0]
	if j.MessageID != res.MessageID || j.Content != stored.Content || j.Version != stored.Timestamp || j.Edited || j.AuthorID != 1 || j.ChannelID != 10 {
		t.Errorf("send job = %+v, stored = %+v", j, stored)
	}

	edit, err := svc.EditMessage(ctx, 1, res.MessageID, "now https://b.example/")
	mustDo(t, "EditMessage", err)
	if len(q.jobs) != 2 {
		t.Fatalf("jobs after edit = %+v", q.jobs)
	}
	if e := q.jobs[1]; !e.Edited || e.Version != edit.EditedAt || e.Content != "now https://b.example/" || e.MessageID != res.MessageID {
		t.Errorf("edit job = %+v, edited_at = %q", e, edit.EditedAt)
	}
}

func TestLinkPreviewAudience(t *testing.T) {
	database := newTestDB(t)
	seedAliceBobDM(t, database, permissions.SendMessages|permissions.ReadMessages)
	seedChannel(t, database, &db.Channel{ID: 10, Name: "general", Type: "text"})
	svc := newMessageServiceOn(database)
	ctx := context.Background()

	isDM, ids, err := svc.LinkPreviewAudience(ctx, 10, 1)
	if err != nil || isDM || ids != nil {
		t.Errorf("channel audience = %v, %v, %v; want the channel topic", isDM, ids, err)
	}
	isDM, ids, err = svc.LinkPreviewAudience(ctx, 50, 1)
	slices.Sort(ids)
	if err != nil || !isDM || !slices.Equal(ids, []int64{1, 2}) {
		t.Errorf("dm audience = %v, %v, %v; want [1 2]", isDM, ids, err)
	}
	if _, _, err := svc.LinkPreviewAudience(ctx, 999, 1); err == nil {
		t.Error("an unknown channel should be an error")
	}
}
