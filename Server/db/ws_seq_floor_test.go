package db

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestWSSeqFloorSidecar_RoundTripAndDamage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chat.db")
	database, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })

	if _, ok, err := database.WSSeqFloorSidecar(); ok || err != nil {
		t.Fatalf("missing sidecar: ok=%v err=%v, want false/nil", ok, err)
	}
	if err := database.StoreWSSeqFloorSidecar(3_000_000_000); err != nil {
		t.Fatal(err)
	}
	if got, ok, err := database.WSSeqFloorSidecar(); !ok || err != nil || got != 3_000_000_000 {
		t.Fatalf("round trip = %d ok=%v err=%v", got, ok, err)
	}
	for _, bad := range []string{"", "12", "12\n\n", "+5\n", "007\n", "x\n", "99999999999999999999999\n"} {
		if err := os.WriteFile(path+wsSeqFloorSuffix, []byte(bad), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, ok, err := database.WSSeqFloorSidecar(); ok || err == nil {
			t.Fatalf("%q accepted: ok=%v err=%v", bad, ok, err)
		}
	}
}

func TestWSSeqFloorSidecar_MemoryDatabaseIsNoOp(t *testing.T) {
	database, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := database.StoreWSSeqFloorSidecar(5); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := database.WSSeqFloorSidecar(); ok || err != nil {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
}

func TestCarryWSSeqFloorForRestore_ErrorPaths(t *testing.T) {
	const validSidecar = "3000000000\n"
	seedLive := func(t *testing.T, path, value string) {
		t.Helper()
		WriteMigratedFileForTest(t, path)
		d, err := Open(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := Migrate(d); err != nil {
			t.Fatal(err)
		}
		if value != "" {
			if err := d.SetSetting(context.Background(), WSSeqFloorSettingKey, value); err != nil {
				t.Fatal(err)
			}
		}
		if err := d.Close(); err != nil {
			t.Fatal(err)
		}
	}
	tests := []struct {
		name        string
		sidecar     string // initial sidecar content; "" means none
		setup       func(t *testing.T, path string)
		ctx         func() context.Context
		wantIs      error  // errors.Is target, when the error wraps a sentinel
		wantMsg     string // substring the error must contain
		wantSidecar string // expected content afterwards
		wantDirSide bool   // the sidecar path is still the directory the test planted
	}{
		{
			name:        "missing live database",
			sidecar:     validSidecar,
			setup:       func(*testing.T, string) {},
			wantIs:      os.ErrNotExist,
			wantMsg:     "reading live ws seq floor",
			wantSidecar: validSidecar,
		},
		{
			name:    "corrupt live database",
			sidecar: validSidecar,
			setup: func(t *testing.T, path string) {
				if err := os.WriteFile(path, []byte("this is not a sqlite database at all"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
			wantMsg:     "reading live ws seq floor",
			wantSidecar: validSidecar,
		},
		{
			name:        "non-numeric live value",
			sidecar:     validSidecar,
			setup:       func(t *testing.T, path string) { seedLive(t, path, "abc") },
			wantIs:      strconv.ErrSyntax,
			wantMsg:     "is not a valid value",
			wantSidecar: validSidecar,
		},
		{
			name:        "out-of-range live value",
			sidecar:     validSidecar,
			setup:       func(t *testing.T, path string) { seedLive(t, path, strconv.FormatUint(MaxWSSeqFloor+1, 10)) },
			wantMsg:     "is out of range",
			wantSidecar: validSidecar,
		},
		{
			name:        "damaged sidecar replaced by a valid live value",
			sidecar:     "garbage",
			setup:       func(t *testing.T, path string) { seedLive(t, path, "5000000000") },
			wantMsg:     "invalid ws seq floor file", // the damage is still reported
			wantSidecar: "5000000000\n",
		},
		{
			name:    "cancelled context",
			sidecar: validSidecar,
			setup:   func(t *testing.T, path string) { seedLive(t, path, "5000000000") },
			ctx: func() context.Context {
				c, cancel := context.WithCancel(context.Background())
				cancel()
				return c
			},
			wantIs:      context.Canceled,
			wantSidecar: validSidecar,
		},
		{
			// The sidecar path cannot be replaced (a directory sits there), so the
			// write fails after the temp file was created; the temp file must go.
			name:    "destination cannot be replaced",
			sidecar: "",
			setup: func(t *testing.T, path string) {
				seedLive(t, path, "5000000000")
				if err := os.Mkdir(path+wsSeqFloorSuffix, 0o700); err != nil {
					t.Fatal(err)
				}
			},
			wantIs:      ErrWSSeqFloorNotStored,
			wantMsg:     "persisting ws seq floor",
			wantDirSide: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "chat.db")
			tc.setup(t, path)
			if tc.sidecar != "" {
				if err := os.WriteFile(path+wsSeqFloorSuffix, []byte(tc.sidecar), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			ctx := context.Background()
			if tc.ctx != nil {
				ctx = tc.ctx()
			}
			err := CarryWSSeqFloorForRestore(ctx, path)
			if err == nil {
				t.Fatal("expected an error")
			}
			if tc.wantIs != nil && !errors.Is(err, tc.wantIs) {
				t.Fatalf("err = %v, want errors.Is %v", err, tc.wantIs)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Fatalf("err = %q, want it to contain %q", err, tc.wantMsg)
			}
			if leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".ws-seq-floor-*")); len(leftovers) != 0 {
				t.Fatalf("temp files left behind: %v", leftovers)
			}
			if tc.wantDirSide {
				if fi, serr := os.Stat(path + wsSeqFloorSuffix); serr != nil || !fi.IsDir() {
					t.Fatalf("sidecar path changed: %v %v", fi, serr)
				}
				return
			}
			got, rerr := os.ReadFile(path + wsSeqFloorSuffix)
			if rerr != nil {
				t.Fatalf("sidecar: %v", rerr)
			}
			if string(got) != tc.wantSidecar {
				t.Fatalf("sidecar = %q, want %q", got, tc.wantSidecar)
			}
		})
	}
}
