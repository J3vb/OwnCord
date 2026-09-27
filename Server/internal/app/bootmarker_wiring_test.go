package app

import (
	"context"
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
	svc.RecordBootStatus(a.prevBoot)
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
