package service

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// MessageService's parts must all reach the same store: the removal part asserts
// an optional capability on the store at run time, and a part handed a narrower
// wrapper would quietly lose it.
func TestMessageServicePartsShareStore(t *testing.T) {
	database := newTestDB(t)
	svc := New(database, auth.NewRateLimiter()).Messages
	for name, st := range map[string]any{
		"core":    svc.st,
		"reads":   svc.messageReads.st,
		"mention": svc.mentionState.st,
		"dm":      svc.dmDelivery.st,
		"pins":    svc.messagePins.st,
		"removal": svc.messageRemoval.st,
	} {
		if st != any(database) {
			t.Errorf("%s store = %T, want the shared *db.DB", name, st)
		}
	}
	if _, ok := svc.messageRemoval.st.(EmptyMessageDeleter); !ok {
		t.Error("removal store lost the optional EmptyMessageDeleter capability")
	}
	if svc.emptyDeleter == nil {
		t.Error("removal part did not pick up the store's EmptyMessageDeleter")
	}
}

// The mention worker is started on MessageService after construction; the removal
// part reverses badges through the same mention state, so the worker it flushes
// must be the one the service started.
func TestMessageServiceRemovalSeesStartedMentionWorker(t *testing.T) {
	database := newTestDB(t)
	svc := New(database, auth.NewRateLimiter()).Messages
	if svc.mentions != svc.mentionState || svc.messageRemoval.dm != svc.dmDelivery {
		t.Fatal("removal part does not share the service's mention state and DM delivery")
	}
	if svc.messagePins.dm != svc.dmDelivery {
		t.Fatal("pin part does not share the service's DM delivery")
	}
	stop := svc.StartMentionWorker(t.Context())
	defer stop(t.Context())
	if svc.mentions.mentionWorkerForSend() == nil {
		t.Error("removal part's mention state has no worker after StartMentionWorker")
	}
}

// setLimiterForTest swaps the rate limiter on the service and on every part that
// was handed a copy at construction, so no path keeps the old one.
func (s *MessageService) setLimiterForTest(l *auth.RateLimiter) {
	s.limiter = l
	s.messagePins.limiter = l
	s.messageRemoval.limiter = l
}
