package service

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

// genTestVAPIDKey returns a fresh P-256 private key for tests, independent
// of the auth package's file-backed loader.
func genTestVAPIDKey(t *testing.T) *ecdh.PrivateKey {
	t.Helper()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generating test VAPID key: %v", err)
	}
	return priv
}

func seedPushRow(t *testing.T, database *db.DB, userID int64, endpoint, keyID string, lastSeen time.Time) {
	t.Helper()
	_, err := database.ExecContext(context.Background(),
		`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, vapid_key_id, last_seen_at)
		 VALUES (?, ?, 'p', 'a', ?, ?)`,
		userID, endpoint, keyID, lastSeen.UTC().Format("2006-01-02 15:04:05"),
	)
	if err != nil {
		t.Fatalf("seedPushRow: %v", err)
	}
}

// TestPushSweep_UsesTheConfiguredWindow proves the staleness half: a row
// last seen before now-TTL is swept, one still inside the window survives.
func TestPushSweep_UsesTheConfiguredWindow(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1})
	svc := NewPushService(database)
	// 30 days, not the 90-day compiled default: a sweep that ignored the
	// configured TTL and fell back to the default would still pass at 90.
	svc.SetSubscriptionTTL(30 * 24 * time.Hour)
	svc.SetVAPIDKey(genTestVAPIDKey(t))
	_, keyID, _ := svc.PublicKey()

	seedPushRow(t, database, 1, "https://push.example/old", keyID, time.Now().Add(-31*24*time.Hour))
	seedPushRow(t, database, 1, "https://push.example/new", keyID, time.Now().Add(-29*24*time.Hour))

	n, err := svc.Sweep(context.Background())
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if n != 1 {
		t.Fatalf("Sweep deleted %d rows, want 1", n)
	}
	rows, err := svc.List(context.Background(), 1)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(rows) != 1 || rows[0].Endpoint != "https://push.example/new" {
		t.Fatalf("rows after sweep = %+v, want only the 29-day-old one", rows)
	}
}

// TestPushSweep_RotationInvalidatesAndRecollects proves decision 2: rotating
// the VAPID key makes every row under the old key invisible to List
// immediately, and Sweep then collects them, even though they are not
// stale by time.
func TestPushSweep_RotationInvalidatesAndRecollects(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1})
	svc := NewPushService(database)
	svc.SetVAPIDKey(genTestVAPIDKey(t))
	_, keyA, _ := svc.PublicKey()
	seedPushRow(t, database, 1, "https://push.example/a", keyA, time.Now())

	if rows, err := svc.List(context.Background(), 1); err != nil || len(rows) != 1 {
		t.Fatalf("List before rotation = %v, %v; want the one row under key A", rows, err)
	}

	svc.SetVAPIDKey(genTestVAPIDKey(t))
	_, keyB, _ := svc.PublicKey()
	if keyB == keyA {
		t.Fatal("the two generated keys collided; the test proves nothing")
	}

	rows, err := svc.List(context.Background(), 1)
	if err != nil {
		t.Fatalf("List after rotation: %v", err)
	}
	if len(rows) != 0 {
		t.Fatalf("List after rotation = %v, want none (the row is under the old key)", rows)
	}

	n, err := svc.Sweep(context.Background())
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if n != 1 {
		t.Fatalf("Sweep deleted %d rows, want 1 (the row under the rotated-away key)", n)
	}
	if _, keyIDNow, ok := svc.PublicKey(); !ok || keyIDNow != keyB {
		t.Fatalf("PublicKey() reports %q, ok=%v; want key B's id (%q)", keyIDNow, ok, keyB)
	}
}

// TestPushSweep_NoKeyInstalledSweepsByTimeOnly proves the sweep does not
// depend on dispatch (or even a key) existing: with no VAPID key installed,
// Sweep still removes stale rows by time and leaves fresh ones, regardless
// of what vapid_key_id they carry.
func TestPushSweep_NoKeyInstalledSweepsByTimeOnly(t *testing.T) {
	database := newTestDB(t)
	seedUser(t, database, &db.User{ID: 1})
	svc := NewPushService(database)
	svc.SetSubscriptionTTL(90 * 24 * time.Hour)
	// No SetVAPIDKey call: PublicKey().ok is false and currentKeyID() is "".

	seedPushRow(t, database, 1, "https://push.example/old", "some-old-key", time.Now().Add(-91*24*time.Hour))
	seedPushRow(t, database, 1, "https://push.example/new", "some-other-key", time.Now().Add(-1*time.Hour))

	if _, _, ok := svc.PublicKey(); ok {
		t.Fatal("PublicKey() reports installed with no SetVAPIDKey call")
	}

	n, err := svc.Sweep(context.Background())
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if n != 1 {
		t.Fatalf("Sweep deleted %d rows, want 1 (time-only: the key mismatch must not also fire)", n)
	}
}
