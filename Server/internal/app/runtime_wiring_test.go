package app

import (
	"log/slog"
	"reflect"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/service"
)

func runtimeTestConfig(t *testing.T) *config.Config {
	t.Helper()
	return &config.Config{
		Server: config.ServerConfig{Name: "Test Server", Port: 8443},
		Upload: config.UploadConfig{StorageDir: t.TempDir(), MaxSizeMB: 1},
	}
}

// fieldSet reports whether an unexported pointer/interface field is non-nil.
func fieldSet(t *testing.T, owner any, name string) bool {
	t.Helper()
	v := reflect.ValueOf(owner).Elem().FieldByName(name)
	if !v.IsValid() {
		t.Fatalf("%T has no field %q (renamed?)", owner, name)
	}
	return !v.IsNil()
}

// TestStartRuntime_WiresAuthBeforeRun pins WP 5.6g: wireAuth's setters and
// UseErasure have all run by the time the hub's dispatch goroutine is about to
// start, so none runs after Run and none can race a first client registering.
func TestStartRuntime_WiresAuthBeforeRun(t *testing.T) {
	cfg := runtimeTestConfig(t)
	database := newMaintenanceTestDB(t)

	var seen bool
	var missing []string
	beforeHubRun = func(svc *service.Services) {
		seen = true
		check := func(name string, ok bool) {
			if !ok {
				missing = append(missing, name)
			}
		}
		check("Auth", svc.Auth != nil)
		check("Erasure.SetFiles", svc.Erasure.HasFiles())
		check("Erasure.SetHub", fieldSet(t, svc.Erasure, "hub"))
		check("Retention.SetFiles", fieldSet(t, svc.Retention, "files"))
		check("Retention.SetHub", fieldSet(t, svc.Retention, "hub"))
		check("Moderation.SetNotifier", fieldSet(t, svc.Moderation, "notifier"))
		check("Moderation.SetVoiceMuter", fieldSet(t, svc.Moderation, "voiceMuter"))
		check("Appeals.SetNotifier", fieldSet(t, svc.Appeals, "notifier"))
		check("Appeals.SetQueueBroadcaster", fieldSet(t, svc.Appeals, "queue"))
		check("Appeals.SetUnbanBroadcaster", fieldSet(t, svc.Appeals, "unban"))
	}
	t.Cleanup(func() { beforeHubRun = nil })

	rt, err := StartRuntime(cfg, database, nil, RuntimeInputs{
		Version: "test", TOTPKey: make([]byte, 32), Storage: OpenStorage(slog.Default(), cfg),
	})
	if err != nil {
		t.Fatalf("StartRuntime: %v", err)
	}
	defer rt.Hub.GracefulStop()

	if !seen {
		t.Fatal("beforeHubRun never fired: the hub started without the seam")
	}
	if len(missing) > 0 {
		t.Fatalf("not wired when the hub was about to start: %v", missing)
	}
	if rt.Auth == nil || rt.Auth != rt.Services.Auth {
		t.Fatal("Runtime.Auth is nil or not the service the bundle shares")
	}
	if rt.Updater == nil {
		t.Fatal("Runtime.Updater is nil")
	}
	if !fieldSet(t, rt.Auth, "erasure") || reflect.ValueOf(rt.Auth).Elem().FieldByName("erasure").UnsafePointer() != reflect.ValueOf(rt.Services.Erasure).UnsafePointer() {
		t.Fatal("AuthService does not run through the shared erasure runner")
	}
	if got := reflect.ValueOf(rt.Auth).Elem().FieldByName("totpKey").Len(); got != 32 {
		t.Fatalf("AuthService TOTP key length = %d, want the 32-byte key from the totp-key stage", got)
	}
}

// TestStartRuntime_OneStorage pins that the router, the maintenance loop and
// the erasure/retention runners hold the same storage instance, and that a
// failed open degrades exactly as it did when each opened its own: Runtime.
// Storage nil, maintenance orphan cleanup off, the erasure runner left without
// files (so it journals them).
func TestStartRuntime_OneStorage(t *testing.T) {
	cfg := runtimeTestConfig(t)
	store := OpenStorage(slog.Default(), cfg)
	if store == nil {
		t.Fatal("OpenStorage returned nil for a writable directory")
	}
	rt, err := StartRuntime(cfg, newMaintenanceTestDB(t), nil, RuntimeInputs{Version: "test", Storage: store})
	if err != nil {
		t.Fatalf("StartRuntime: %v", err)
	}
	defer rt.Hub.GracefulStop()

	if rt.Storage != store {
		t.Fatal("Runtime.Storage is not the instance StartRuntime was given")
	}
	m := newMaintenance(slog.Default(), cfg, newMaintenanceTestDB(t), rt.Services, rt.Storage)
	if m.files != rt.Storage {
		t.Fatal("maintenance holds a different storage than the runtime")
	}
	rv := reflect.ValueOf(rt.Services.Retention).Elem().FieldByName("files")
	if rv.IsNil() || rv.Elem().Pointer() != reflect.ValueOf(store).Pointer() {
		t.Fatal("the retention runner holds a different storage than the runtime")
	}
	if !rt.Services.Erasure.HasFiles() {
		t.Fatal("the erasure runner has no file remover")
	}
}

// TestStartRuntime_StorageFailureDegrades is the degraded half: a nil store
// leaves Runtime.Storage nil, the erasure runner without files, and
// maintenance without orphan cleanup.
func TestStartRuntime_StorageFailureDegrades(t *testing.T) {
	cfg := runtimeTestConfig(t)
	rt, err := StartRuntime(cfg, newMaintenanceTestDB(t), nil, RuntimeInputs{Version: "test"})
	if err != nil {
		t.Fatalf("StartRuntime: %v", err)
	}
	defer rt.Hub.GracefulStop()

	if rt.Storage != nil {
		t.Fatal("Runtime.Storage is non-nil though none was given")
	}
	if rt.Services.Erasure.HasFiles() {
		t.Fatal("the erasure runner has files with no storage: it must journal them instead")
	}
	if m := newMaintenance(slog.Default(), cfg, newMaintenanceTestDB(t), rt.Services, rt.Storage); m.files != nil {
		t.Fatal("maintenance kept orphan cleanup on with no storage")
	}
}
