package service

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/google/uuid"
)

func deliveryTestID(at time.Time) string {
	return fmt.Sprintf("%d:%s", at.UnixMilli(), uuid.NewString())
}

func deliveryTestParams() SendMessageParams {
	return SendMessageParams{UserID: 1, ChannelID: 10, Content: "hello", ClientMessageID: deliveryTestID(time.Now())}
}

func TestMessageDelivery_ConcurrentRetriesCommitOneMessageAndMention(t *testing.T) {
	svc, database := newTestMessageService(t)
	svc.RunBackgroundInlineForTest()
	seedUser(t, database, &db.User{ID: 2, Username: "bob", Status: "online"})
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	p := deliveryTestParams()
	p.Content = "hello @bob"
	type outcome struct {
		result *SendMessageResult
		err    error
	}
	results := make(chan outcome, 8)
	start := make(chan struct{})
	for range cap(results) {
		go func() {
			<-start
			result, err := svc.SendMessage(context.Background(), p)
			results <- outcome{result, err}
		}()
	}
	close(start)
	var messageID int64
	var timestamp string
	created := 0
	for range cap(results) {
		got := <-results
		if got.err != nil {
			t.Fatal(got.err)
		}
		if !got.result.Duplicate {
			created++
		}
		if messageID == 0 {
			messageID, timestamp = got.result.MessageID, got.result.Timestamp
		}
		if got.result.MessageID != messageID || got.result.Timestamp != timestamp {
			t.Fatalf("retry result changed: %+v", got.result)
		}
	}
	if created != 1 {
		t.Fatalf("new-message results = %d, want 1", created)
	}
	var count int
	if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM messages`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("stored messages = %d, want 1", count)
	}
	if count, err := database.GetMentionCount(context.Background(), 2, 10); err != nil || count != 1 {
		t.Fatalf("mention count = %d, %v; want 1", count, err)
	}
}

func TestMessageDelivery_PayloadMismatchAndSenderScope(t *testing.T) {
	svc, database := newTestMessageService(t)
	svc.RunBackgroundInlineForTest()
	p := deliveryTestParams()
	first, err := svc.SendMessage(context.Background(), p)
	if err != nil {
		t.Fatal(err)
	}
	seedChannel(t, database, &db.Channel{ID: 11, Name: "other", Type: "text"})
	for _, mutate := range []func(*SendMessageParams){
		func(p *SendMessageParams) { p.Content = "different" },
		func(p *SendMessageParams) { p.ChannelID = 11 },
		func(p *SendMessageParams) { p.ReplyTo = &first.MessageID },
	} {
		changed := p
		mutate(&changed)
		if _, err := svc.SendMessage(context.Background(), changed); !errors.Is(err, ErrConflict) {
			t.Fatalf("mismatch = %v, want conflict", err)
		}
	}
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	p.UserID = 2
	other, err := svc.SendMessage(context.Background(), p)
	if err != nil || other.Duplicate || other.MessageID == first.MessageID {
		t.Fatalf("other sender = %+v, %v", other, err)
	}
}

func TestMessageDelivery_RetryRechecksPermissionAndSkipsSlowMode(t *testing.T) {
	svc, database := newTestMessageService(t)
	svc.RunBackgroundInlineForTest()
	svc.limiter = auth.NewRateLimiter()
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `UPDATE channels SET slow_mode = 60 WHERE id = 10`); err != nil {
		t.Fatal(err)
	}
	p := deliveryTestParams()
	if _, err := svc.SendMessage(ctx, p); err != nil {
		t.Fatal(err)
	}
	retry, err := svc.SendMessage(ctx, p)
	if err != nil || !retry.Duplicate {
		t.Fatalf("matching retry = %+v, %v", retry, err)
	}
	other := p
	other.ClientMessageID = deliveryTestID(time.Now())
	if _, err := svc.SendMessage(ctx, other); !errors.Is(err, ErrSlowMode) {
		t.Fatalf("new send = %v, want slow mode", err)
	}
	if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = ? WHERE id = ?`, permissions.ReadMessages, permissions.MemberRoleID); err != nil {
		t.Fatal(err)
	}
	svc.perms.InvalidateAll()
	if _, err := svc.SendMessage(ctx, p); !errors.Is(err, ErrForbidden) {
		t.Fatalf("revoked retry = %v, want forbidden", err)
	}
}

func TestMessageDelivery_RejectsExpiredAndFutureIDs(t *testing.T) {
	svc, _ := newTestMessageService(t)
	for _, id := range []string{
		deliveryTestID(time.Now().Add(-MessageRetryWindow - time.Minute)),
		deliveryTestID(time.Now().Add(6 * time.Minute)),
		"not-an-id", "1700000000000:" + uuid.NewString(),
	} {
		p := deliveryTestParams()
		p.ClientMessageID = id
		if _, err := svc.SendMessage(context.Background(), p); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("id %q = %v, want bad request", id, err)
		}
	}
}

func TestMessageDelivery_DeletedOriginalCannotBeResent(t *testing.T) {
	for _, hard := range []bool{false, true} {
		t.Run(fmt.Sprint("hard=", hard), func(t *testing.T) {
			svc, database := newTestMessageService(t)
			svc.RunBackgroundInlineForTest()
			p := deliveryTestParams()
			first, err := svc.SendMessage(context.Background(), p)
			if err != nil {
				t.Fatal(err)
			}
			query := `UPDATE messages SET deleted = 1 WHERE id = ?`
			if hard {
				query = `DELETE FROM messages WHERE id = ?`
			}
			if _, err := database.ExecContext(context.Background(), query, first.MessageID); err != nil {
				t.Fatal(err)
			}
			if _, err := svc.SendMessage(context.Background(), p); !errors.Is(err, ErrDeletedMessage) {
				t.Fatalf("deleted retry = %v", err)
			}
			var count int
			if err := database.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM messages WHERE deleted = 0`).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatalf("retry resurrected %d messages", count)
			}
		})
	}
}

func TestMessageDelivery_AttachmentOnlyFailureIsAtomicAndRetryable(t *testing.T) {
	svc, database := newTestMessageService(t)
	svc.RunBackgroundInlineForTest()
	ctx := context.Background()
	if _, err := database.ExecContext(ctx, `UPDATE roles SET permissions = permissions | ? WHERE id = ?`, permissions.AttachFiles, permissions.MemberRoleID); err != nil {
		t.Fatal(err)
	}
	p := deliveryTestParams()
	p.Content, p.AttachmentIDs = "", []string{"pending-upload"}
	if _, err := svc.SendMessage(ctx, p); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("missing attachment = %v", err)
	}
	var count int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("failed attachment send left %d message rows", count)
	}
	if err := database.CreateAttachment(ctx, "pending-upload", 1, "a.txt", "a.txt", "text/plain", 1, nil, nil); err != nil {
		t.Fatal(err)
	}
	first, err := svc.SendMessage(ctx, p)
	if err != nil || len(first.Attachments) != 1 {
		t.Fatalf("completed upload = %+v, %v", first, err)
	}
	retry, err := svc.SendMessage(ctx, p)
	if err != nil || !retry.Duplicate || retry.MessageID != first.MessageID {
		t.Fatalf("linked retry = %+v, %v", retry, err)
	}
}

func TestMessageDelivery_DuplicateStillUsesGeneralRateLimit(t *testing.T) {
	svc, _ := newTestMessageService(t)
	svc.RunBackgroundInlineForTest()
	svc.limiter = auth.NewRateLimiter()
	p := deliveryTestParams()
	if _, err := svc.SendMessage(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	// Charge the same general limiter deterministically, then retry the
	// committed id. Looking up a receipt must not bypass this gate.
	for range 10 {
		svc.limiter.Allow(auth.Key("chat", p.UserID), 10, time.Second)
	}
	if _, err := svc.SendMessage(context.Background(), p); !errors.Is(err, ErrRateLimited) {
		t.Fatalf("limited retry = %v", err)
	}
}

func TestMessageDelivery_DuplicateRechecksDMBlock(t *testing.T) {
	svc, database := newTestMessageService(t)
	svc.RunBackgroundInlineForTest()
	seedUser(t, database, &db.User{ID: 2, Username: "bob"})
	seedUserRole(t, database, 2, permissions.MemberRoleID)
	seedChannel(t, database, &db.Channel{ID: 50, Name: "dm", Type: "dm"})
	seedDMParticipant(t, database, 50, 1)
	seedDMParticipant(t, database, 50, 2)
	p := deliveryTestParams()
	p.ChannelID = 50
	if _, err := svc.SendMessage(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	seedBlock(t, database, 2, 1)
	if _, err := svc.SendMessage(context.Background(), p); !errors.Is(err, ErrBlocked) {
		t.Fatalf("blocked DM retry = %v, want blocked", err)
	}
}

func TestMessageDelivery_NewIDsHonorAdvertisedRestoreFloor(t *testing.T) {
	p := deliveryTestParams()
	floor := time.Now().Add(6 * time.Minute).UnixMilli()
	p.ClientMessageID = deliveryTestID(time.UnixMilli(floor))
	if _, err := messageDeliveryParams(p, p.Content, 0); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("future id without restore floor = %v", err)
	}
	parsed, err := messageDeliveryParams(p, p.Content, floor)
	if err != nil || parsed.CreatedAtMS != floor {
		t.Fatalf("new id exactly at advertised floor = %+v, %v", parsed, err)
	}
	p.ClientMessageID = deliveryTestID(time.UnixMilli(floor + 1))
	if _, err := messageDeliveryParams(p, p.Content, floor); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("new id beyond floor and clock tolerance = %v", err)
	}
}
