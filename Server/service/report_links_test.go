package service

import (
	"context"
	"reflect"
	"testing"
)

// The batched link lookup applies the same confidentiality guard as the single
// one: a report about the viewer is left out, a missing id is absent, and the
// per-row fallback for a store without the batch read gives the same answer.
func TestVisibleReportPublicIDs_GuardsTheSubjectInOneRead(t *testing.T) {
	svc, database := newTestReportService(t)
	ctx := context.Background()
	if svc.links == nil {
		t.Fatal("a *db.DB store must wire the batched report-link read")
	}

	aboutViewer, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetUser, TargetID: "11", Reason: "harassment"})
	mustDo(t, "File(about viewer)", err)
	aboutOther, err := svc.File(ctx, FileReportParams{ReporterID: 10, TargetType: TargetUser, TargetID: "12", Reason: "harassment"})
	mustDo(t, "File(about other)", err)
	other := mustGetReport(t, database, aboutOther)

	ids := []int64{aboutViewer, aboutOther, aboutOther, aboutOther + 1000}
	want := map[int64]string{aboutOther: other.PublicID}
	if got := svc.VisibleReportPublicIDs(ctx, 11, ids); !reflect.DeepEqual(got, want) {
		t.Fatalf("batched = %v, want %v", got, want)
	}

	svc.links = nil
	if got := svc.VisibleReportPublicIDs(ctx, 11, ids); !reflect.DeepEqual(got, want) {
		t.Fatalf("per-row fallback = %v, want %v", got, want)
	}
	if got := svc.VisibleReportPublicIDs(ctx, 11, nil); len(got) != 0 {
		t.Fatalf("empty input = %v, want empty", got)
	}
}
