package service

import (
	"context"
	"github.com/J3vb/OwnCord/Server/db"
)

// DiagnosticStore is a narrow, content-free read and audit boundary.
type DiagnosticStore interface {
	Diagnostics(context.Context) (*db.DiagnosticSnapshot, error)
	LogAudit(context.Context, int64, string, string, int64, string) error
}

// DiagnosticsService provides the data admitted by the support-bundle contract.
type DiagnosticsService struct{ st DiagnosticStore }

func NewDiagnosticsService(st DiagnosticStore) *DiagnosticsService {
	return &DiagnosticsService{st: st}
}

func (s *DiagnosticsService) Snapshot(ctx context.Context) (*db.DiagnosticSnapshot, error) {
	return s.st.Diagnostics(ctx)
}

// RecordBundle uses fixed item names only. A failed audit refuses the export;
// neither diagnostic contents nor session hashes are ever recorded.
func (s *DiagnosticsService) RecordBundle(ctx context.Context, actor int64) error {
	return s.st.LogAudit(ctx, actor, "support_bundle_create", "server", 0,
		"items: manifest.json, build.json, configuration.json, database.json, health.json, events.json")
}
