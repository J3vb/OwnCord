package externalcontent

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/safefetch"
)

// A link to a host that keeps failing is fetched once per failureTTL, not
// once per viewer per render, for previews and images alike; after the TTL it
// is tried again.
func TestBroker_FailureIsKeptForTheNegativeTTL(t *testing.T) {
	var hits atomic.Int32
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	b := testBroker(t, srv)
	now := time.Unix(0, 0)
	b.cache.now = func() time.Time { return now }

	for i := range 3 {
		if _, err := b.Preview(context.Background(), int64(i), srv.URL+"/dead"); FailureOf(err) != Unavailable {
			t.Fatalf("preview %d: %v, want unavailable", i, err)
		}
		if _, _, err := b.Image(context.Background(), int64(i), "", srv.URL+"/dead.gif"); FailureOf(err) != Unavailable {
			t.Fatalf("image %d: %v, want unavailable", i, err)
		}
	}
	if got := hits.Load(); got != 2 {
		t.Fatalf("upstream hit %d times, want 2 (one page, one image)", got)
	}

	now = now.Add(failureTTL)
	if _, err := b.Preview(context.Background(), 1, srv.URL+"/dead"); FailureOf(err) != Unavailable {
		t.Fatalf("after the TTL: %v", err)
	}
	if got := hits.Load(); got != 3 {
		t.Fatalf("upstream hit %d times after the TTL, want 3 (the page fetched again)", got)
	}
}

// A page that does not reduce to a preview is remembered with its failure
// class, so a later viewer sees the same answer without a fetch.
func TestBroker_WrongTypeIsKeptWithItsClass(t *testing.T) {
	var hits atomic.Int32
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "image/gif")
		_, _ = w.Write(gif)
	})
	b := testBroker(t, srv)
	for range 2 {
		if _, err := b.Preview(context.Background(), 1, srv.URL+"/not-a-page"); FailureOf(err) != WrongType {
			t.Fatalf("Preview: %v, want wrong-type", err)
		}
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("upstream hit %d times, want 1", got)
	}
}

// A refused destination and a fetch that never got a slot are not kept: the
// first costs nothing to refuse again, and the second says nothing about the
// link.
func TestBroker_RefusalsAndBusySlotsAreNotKept(t *testing.T) {
	b, err := New(DefaultPagePolicy, DefaultImagePolicy)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := b.Preview(context.Background(), 1, "http://example.com/"); FailureOf(err) != BlockedDestination {
		t.Fatalf("http URL: %v, want blocked-destination", err)
	}
	if _, ok := b.cache.get("preview:http://example.com/"); ok {
		t.Error("a blocked destination was kept")
	}

	busy := &Error{Failure: Unavailable, transient: true}
	if got := b.rememberFailure("preview:https://busy.example/", busy); !errors.Is(got, busy) {
		t.Fatalf("rememberFailure changed the error: %v", got)
	}
	if _, ok := b.cache.get("preview:https://busy.example/"); ok {
		t.Error("a fetch that never got a slot was kept")
	}
}

// safefetch marks a wait for a slot that ran out as ErrBusy, which is what
// tells the broker the fetch never started.
func TestBroker_SlotTimeoutIsTransient(t *testing.T) {
	release := make(chan struct{})
	srv := stub(t, func(w http.ResponseWriter, _ *http.Request) {
		<-release
		w.WriteHeader(http.StatusOK)
	})
	t.Cleanup(func() { close(release) })
	b := testBroker(t, srv)
	for range maxConcurrent {
		go func() { _, _ = b.page.Fetch(context.Background(), safefetch.Request{URL: srv.URL + "/hold"}) }()
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		_, err := b.page.Fetch(ctx, safefetch.Request{URL: srv.URL + "/queued"})
		cancel()
		if errors.Is(err, safefetch.ErrBusy) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("a fetch with every slot held: %v, want ErrBusy", err)
		}
	}
}
