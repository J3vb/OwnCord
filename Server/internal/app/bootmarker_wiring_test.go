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
	mustDo(t, "startDataDir", a.startDataDir())
	markerPath := bootMarkerPath(a.cfg.Server.DataDir)
	// A previous run that started and was killed (never closed).
	if _, err := openBootMarker(markerPath, time.Now().Add(-time.Hour)); err != nil {
		t.Fatalf("arming the previous marker: %v", err)
	}

	mustDo(t, "startBootMarker", a.startBootMarker())
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

	mustDo(t, "Close", a.Close(context.Background()))
	if st := readBootMarker(markerPath); !st.Recorded || st.Unclean {
		t.Fatalf("after a clean close the marker reads %+v, want recorded and clean", st)
	}
}

// SRE-08: a start after a kill -9 that fails before the hub stage never shows
// the unclean exit, so its close must not mark the marker clean — the next
// successful start still reports the killed run, then clears it.
func TestApp_BootMarkerStage_FailedStartCarriesUncleanExitForward(t *testing.T) {
	a := bootTestApp(t, "0", "")
	mustDo(t, "startDataDir", a.startDataDir())
	dataDir, err := filepath.Abs(a.cfg.Server.DataDir)
	mustDo(t, "Abs", err)
	a.cfg.Server.DataDir = dataDir
	markerPath := bootMarkerPath(dataDir)
	killedAt := time.Now().Add(-time.Hour).Truncate(time.Second)
	if _, err := openBootMarker(markerPath, killedAt); err != nil {
		t.Fatalf("arming the killed run's marker: %v", err)
	}

	// The restart fails before the hub stage: Close runs without a report.
	mustDo(t, "startBootMarker", a.startBootMarker())
	mustDo(t, "Close", a.Close(context.Background()))

	// The next start still sees the killed run.
	b := bootTestApp(t, "0", "")
	b.cfg.Server.DataDir = dataDir
	mustDo(t, "startBootMarker", b.startBootMarker())
	if !b.prevBoot.Unclean || !b.prevBoot.StartedAt.Equal(killedAt) {
		t.Fatalf("after a failed start prevBoot = %+v, want the killed run started %v", b.prevBoot, killedAt)
	}
	svc := service.NewAttentionService(service.AttentionThresholds{}, service.AttentionSources{})
	b.recordBootStatus(&service.Services{Attention: svc})
	b.bootMarker.reported() // every start stage came up
	mustDo(t, "Close", b.Close(context.Background()))
	if st := readBootMarker(markerPath); !st.Recorded || st.Unclean {
		t.Fatalf("after a reported start and a clean close the marker reads %+v, want clean", st)
	}
}

// SRE-08: the hub stage puts the previous exit on the attention panel, but a
// start that then fails at a later stage never serves that panel, so its close
// must still carry the unclean exit forward.
func TestAppRun_LateStageFailureCarriesUncleanExitForward(t *testing.T) {
	a := bootTestApp(t, "0", "http")
	mustDo(t, "MkdirAll", os.MkdirAll(a.cfg.Server.DataDir, 0o750))
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
