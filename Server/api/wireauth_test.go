package api

// wireAuth is unexported, so these live in package api (not api_test) to
// call it directly. They pin OC-0404's two halves: the nil-Erasure guard
// used to dominate RetentionService's file/hub wiring below it, and
// UseErasure's nil case used to leave AuthService silently degraded on its
// private erasure runner (no markers, no files, no hub — so DeleteAccount
// erases rows but records no deletion marker, and a restore can resurrect
// the account) with nothing in the log to say so.

import (
	"bytes"
	"log/slog"
	"reflect"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/service"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/J3vb/OwnCord/Server/ws"
)

// retentionWiredForTest reports whether SetFiles/SetHub reached
// RetentionService's unexported field (there is no exported getter, unlike
// ErasureService.HasFiles). A rename of the field makes FieldByName return
// the zero Value and IsNil panic — a loud failure, not a silent pass.
func retentionWiredForTest(t *testing.T, r *service.RetentionService, field string) bool {
	t.Helper()
	v := reflect.ValueOf(r).Elem().FieldByName(field)
	if !v.IsValid() {
		t.Fatalf("RetentionService has no field %q (renamed?)", field)
	}
	return !v.IsNil()
}

// authServiceErasureForTest returns the erasure runner AuthService is
// currently using, via its unexported field — the only way to tell whether
// UseErasure actually swapped it from outside the package.
func authServiceErasureForTest(t *testing.T, a *service.AuthService) *service.ErasureService {
	t.Helper()
	v := reflect.ValueOf(a).Elem().FieldByName("erasure")
	if !v.IsValid() {
		t.Fatalf("AuthService has no field %q (renamed?)", "erasure")
	}
	return (*service.ErasureService)(v.UnsafePointer())
}

func newWireAuthTestStorage(t *testing.T) *storage.Storage {
	t.Helper()
	st, err := storage.New(t.TempDir(), 10)
	if err != nil {
		t.Fatalf("storage.New: %v", err)
	}
	return st
}

func newWireAuthTestAuthSvc(t *testing.T) *service.AuthService {
	t.Helper()
	return service.NewAuthService(nil, auth.NewRateLimiter(), make([]byte, 32), nil)
}

// TestWireAuth_NilErasureStillWiresRetention pins the first half of
// OC-0404: `if svc.Erasure == nil { return }` used to dominate the
// Retention SetFiles/SetHub calls below it, so a bundle missing only the
// erasure runner silently left the message-retention sweep (B4-11) with no
// file remover and no hub — it could never purge files or the replay
// tiers, with nothing in the log to say so.
func TestWireAuth_NilErasureStillWiresRetention(t *testing.T) {
	svc := &service.Services{Retention: service.NewRetentionService(nil)}
	authSvc := newWireAuthTestAuthSvc(t)
	store := newWireAuthTestStorage(t)
	hub := &ws.Hub{}

	wireAuth(svc, authSvc, store, hub)

	if !retentionWiredForTest(t, svc.Retention, "files") {
		t.Fatal("Retention.SetFiles was not called when svc.Erasure was nil")
	}
	if !retentionWiredForTest(t, svc.Retention, "hub") {
		t.Fatal("Retention.SetHub was not called when svc.Erasure was nil")
	}
}

// TestWireAuth_NilErasureLogsInsteadOfSilentlyDegrading pins the second
// half of OC-0404: a bundle with no erasure runner used to leave AuthService
// on its private per-instance runner (no markers, no files, no hub) with no
// signal anywhere — UseErasure(nil) was already a no-op, so `if svc.Erasure
// != nil { UseErasure(...) }` was observationally identical to skipping the
// call outright. The composition root must say so instead of staying quiet.
func TestWireAuth_NilErasureLogsInsteadOfSilentlyDegrading(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	svc := &service.Services{Retention: service.NewRetentionService(nil)}
	authSvc := newWireAuthTestAuthSvc(t)
	privateRunner := authServiceErasureForTest(t, authSvc)

	wireAuth(svc, authSvc, nil, nil)

	if got := authServiceErasureForTest(t, authSvc); got != privateRunner {
		t.Fatalf("AuthService's erasure runner changed with svc.Erasure == nil: got %p, want the private runner %p", got, privateRunner)
	}
	out := logs.String()
	if !strings.Contains(out, "level=ERROR") || !strings.Contains(out, "erasure") {
		t.Fatalf("wireAuth left the bundle's missing erasure runner unlogged; log output = %q", out)
	}
}

// TestWireAuth_NonNilErasureSwapsQuietly is the regression companion: when
// svc.Erasure is present, wireAuth must swap it in and wire Retention as
// before, without logging an error.
func TestWireAuth_NonNilErasureSwapsQuietly(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	svc := &service.Services{
		Erasure:   service.NewErasureService(nil),
		Retention: service.NewRetentionService(nil),
	}
	authSvc := newWireAuthTestAuthSvc(t)
	store := newWireAuthTestStorage(t)
	hub := &ws.Hub{}

	wireAuth(svc, authSvc, store, hub)

	if got := authServiceErasureForTest(t, authSvc); got != svc.Erasure {
		t.Fatalf("AuthService's erasure runner was not swapped to the shared one: got %p, want %p", got, svc.Erasure)
	}
	if !retentionWiredForTest(t, svc.Retention, "files") {
		t.Fatal("Retention.SetFiles was not called")
	}
	if !retentionWiredForTest(t, svc.Retention, "hub") {
		t.Fatal("Retention.SetHub was not called")
	}
	if out := logs.String(); strings.Contains(out, "level=ERROR") {
		t.Fatalf("wireAuth logged an error with svc.Erasure present; log output = %q", out)
	}
}
