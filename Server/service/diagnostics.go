package service

import (
	"context"
	"github.com/J3vb/OwnCord/Server/db"
)

// DiagnosticStore is a narrow, content-free read and audit boundary.
type DiagnosticStore interface {
	Diagnostics(context.Context) (*db.DiagnosticSnapshot, error)
	DiagnosticNames(context.Context) ([]string, error)
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

// KnownNames returns values the server knows are identifying (usernames,
// display names, the server name); they are used only to redact event text.
func (s *DiagnosticsService) KnownNames(ctx context.Context) ([]string, error) {
	return s.st.DiagnosticNames(ctx)
}

// RecordBundle uses fixed item names only. A failed audit refuses the export;
// neither diagnostic contents nor session hashes are ever recorded.
func (s *DiagnosticsService) RecordBundle(ctx context.Context, actor int64) error {
	return s.st.LogAudit(ctx, actor, "support_bundle_create", "server", 0,
		"items: manifest.json, build.json, configuration.json, database.json, health.json, events.json")
}
