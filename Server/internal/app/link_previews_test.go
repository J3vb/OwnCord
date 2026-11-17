package app

import (
	"context"
	"log/slog"
	"testing"
	"time"
)

// startLinkPreviews hands the message service its queue and registers a close step that stops
// the workers; without a store it does nothing and sends are unaffected.
func TestStartLinkPreviews_WiresTheQueueAndJoinsOnClose(t *testing.T) {
	cfg := runtimeTestConfig(t)
	cfg.Server.DataDir = t.TempDir()
	cfg.LinkPreviews.Enabled = true
	database := newMaintenanceTestDB(t)
	store := OpenLinkPreviews(slog.Default(), cfg, database)
	rt, err := StartRuntime(cfg, database, nil, RuntimeInputs{Version: "test", TOTPKey: make([]byte, 32), LinkPreviews: store})
	if err != nil {
		t.Fatalf("StartRuntime: %v", err)
	}
	defer rt.Hub.GracefulStop()

	a := newTestApp()
	a.cfg, a.runtime, a.hub, a.linkPreviews = cfg, rt, rt.Hub, store
	a.bgCtx = context.Background()
	if err := a.startLinkPreviews(); err != nil {
		t.Fatalf("startLinkPreviews: %v", err)
	}
	if !fieldSet(t, rt.Services.Messages, "unfurler") {
		t.Error("the message service was not given the unfurl queue")
	}
	if len(a.closers) != 1 || a.closers[0].stage != "link-previews" {
		t.Fatalf("close steps = %+v, want one link-previews step", a.closers)
	}
	done := make(chan error, 1)
	go func() { done <- a.closers[0].stop(context.Background()) }()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("close step = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the close step did not return")
	}
}

func TestStartLinkPreviews_NoStoreIsNoop(t *testing.T) {
	cfg := runtimeTestConfig(t)
	database := newMaintenanceTestDB(t)
	rt, err := StartRuntime(cfg, database, nil, RuntimeInputs{Version: "test", TOTPKey: make([]byte, 32)})
	if err != nil {
		t.Fatalf("StartRuntime: %v", err)
	}
	defer rt.Hub.GracefulStop()
	a := newTestApp()
	a.cfg, a.runtime, a.hub = cfg, rt, rt.Hub
	mustDo(t, "startLinkPreviews", a.startLinkPreviews())
	if len(a.closers) != 0 || fieldSet(t, rt.Services.Messages, "unfurler") {
		t.Error("a queue was wired without a store")
	}
}
