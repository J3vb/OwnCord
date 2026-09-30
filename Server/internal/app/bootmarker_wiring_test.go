package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/service"
)

// TestApp_BootMarkerStage_ReportsPreviousExitAndClearsOnCleanClose pins the
// wiring SRE-08's acceptance names: a process started after an unclean exit
// folds that previous exit into its attention panel, and a clean close clears
// the marker for the next boot.
func TestApp_BootMarkerStage_ReportsPreviousExitAndClearsOnCleanClose(t *testing.T) {
	a := bootTestApp(t, "0", "")
	if err := a.startDataDir(); err != nil {
		t.Fatalf("startDataDir: %v", err)
	}
	markerPath := bootMarkerPath(a.cfg.Server.DataDir)
	// A previous run that started and was killed (never closed).
	if _, err := openBootMarker(markerPath, time.Now().Add(-time.Hour)); err != nil {
		t.Fatalf("arming the previous marker: %v", err)
	}

	if err := a.startBootMarker(); err != nil {
		t.Fatalf("startBootMarker: %v", err)
	}
	if a.bootMarker == nil {
		t.Fatal("startBootMarker left no handle, so a clean close cannot clear the marker")
	}
	if !a.prevBoot.Recorded || !a.prevBoot.Unclean {
		t.Fatalf("prevBoot = %+v, want the unclean previous run", a.prevBoot)
	}

	svc := service.NewAttentionService(service.AttentionThresholds{}, service.AttentionSources{
		DiskFree: func() (uint64, error) { return 1 << 30, nil },
	})
	a.recordBootStatus(&service.Services{Attention: svc})
	a.bootMarker.reported() // every start stage came up
	svc.Evaluate(context.Background(), time.Now())
	raised := false
	for _, w := range svc.Report().Warnings {
		if w.ID == "last_exit" {
			raised = true
		}
	}
	if !raised {
		t.Fatal("the unclean previous exit did not raise an attention warning")
	}

	if err := a.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if st := readBootMarker(markerPath); !st.Recorded || st.Unclean {
		t.Fatalf("after a clean close the marker reads %+v, want recorded and clean", st)
	}
}

// SRE-08: a start after a kill -9 that fails before the hub stage never shows
// the unclean exit, so its close must not mark the marker clean — the next
// successful start still reports the killed run, then clears it.
func TestApp_BootMarkerStage_FailedStartCarriesUncleanExitForward(t *testing.T) {
	a := bootTestApp(t, "0", "")
	if err := a.startDataDir(); err != nil {
		t.Fatalf("startDataDir: %v", err)
	}
	dataDir, err := filepath.Abs(a.cfg.Server.DataDir)
	if err != nil {
		t.Fatalf("Abs: %v", err)
	}
	a.cfg.Server.DataDir = dataDir
	markerPath := bootMarkerPath(dataDir)
	killedAt := time.Now().Add(-time.Hour).Truncate(time.Second)
	if _, err := openBootMarker(markerPath, killedAt); err != nil {
		t.Fatalf("arming the killed run's marker: %v", err)
	}

	// The restart fails before the hub stage: Close runs without a report.
	if err := a.startBootMarker(); err != nil {
		t.Fatalf("startBootMarker: %v", err)
	}
	if err := a.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// The next start still sees the killed run.
	b := bootTestApp(t, "0", "")
	b.cfg.Server.DataDir = dataDir
	if err := b.startBootMarker(); err != nil {
		t.Fatalf("startBootMarker: %v", err)
	}
	if !b.prevBoot.Unclean || !b.prevBoot.StartedAt.Equal(killedAt) {
		t.Fatalf("after a failed start prevBoot = %+v, want the killed run started %v", b.prevBoot, killedAt)
	}
	svc := service.NewAttentionService(service.AttentionThresholds{}, service.AttentionSources{})
	b.recordBootStatus(&service.Services{Attention: svc})
	b.bootMarker.reported() // every start stage came up
	if err := b.Close(context.Background()); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if st := readBootMarker(markerPath); !st.Recorded || st.Unclean {
		t.Fatalf("after a reported start and a clean close the marker reads %+v, want clean", st)
	}
}

// SRE-08: the hub stage puts the previous exit on the attention panel, but a
// start that then fails at a later stage never serves that panel, so its close
// must still carry the unclean exit forward.
func TestAppRun_LateStageFailureCarriesUncleanExitForward(t *testing.T) {
	a := bootTestApp(t, "0", "http")
	if err := os.MkdirAll(a.cfg.Server.DataDir, 0o750); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	markerPath := bootMarkerPath(a.cfg.Server.DataDir)
	killedAt := time.Now().Add(-time.Hour).Truncate(time.Second)
	if _, err := openBootMarker(markerPath, killedAt); err != nil {
		t.Fatalf("arming the killed run's marker: %v", err)
	}

	if err := a.Run(context.Background()); err == nil {
		t.Fatal("Run() = nil, want the injected http failure")
	}
	if a.hub == nil {
		t.Fatal("the hub stage never ran, so this does not test a failure after the report")
	}
	st := readBootMarker(markerPath)
	if !st.Unclean || !st.StartedAt.Equal(killedAt) {
		t.Fatalf("after a late start failure the marker reads %+v, want the killed run started %v", st, killedAt)
	}
}
