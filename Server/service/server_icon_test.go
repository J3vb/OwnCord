package service

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// iconPNG draws a w x h PNG; shade varies the bytes so two icons hash differently.
func iconPNG(t testing.TB, w, h int, shade uint8) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.Set(x, y, color.RGBA{R: shade, G: uint8(x), B: uint8(y), A: 255})
		}
	}
	var buf bytes.Buffer
	mustDo(t, "png.Encode", png.Encode(&buf, img))
	return buf.Bytes()
}

func newIconService(t *testing.T) (*SettingsService, string) {
	t.Helper()
	svc, _ := newSettingsService(t)
	dir := t.TempDir()
	svc.SetServerIconDir(dir)
	return svc, dir
}

func TestServerIcon_SetStoresFileAndHash(t *testing.T) {
	svc, dir := newIconService(t)
	ctx := context.Background()
	data := iconPNG(t, 128, 128, 10)

	hash, err := svc.SetServerIcon(ctx, 1, data)
	mustDo(t, "SetServerIcon", err)
	onDisk, err := os.ReadFile(filepath.Join(dir, ServerIconFile))
	mustDo(t, "read icon file", err)
	if len(hash) != 16 || hash != ServerIconHashOf(onDisk) {
		t.Fatalf("hash = %q, want the 16-hex prefix of the sha256 of the stored file", hash)
	}
	if _, err := png.Decode(bytes.NewReader(onDisk)); err != nil {
		t.Fatalf("stored file is not a PNG: %v", err)
	}
	if got, _ := svc.Setting(ctx, ServerIconKey); got != hash {
		t.Fatalf("server_icon row = %q, want %q", got, hash)
	}
	got, gotHash, err := svc.ServerIcon(ctx)
	mustDo(t, "ServerIcon", err)
	if !bytes.Equal(got, onDisk) || gotHash != hash {
		t.Fatal("ServerIcon returned a different picture or hash")
	}
	if listed, err := svc.ServerIconHash(ctx); err != nil || listed != hash {
		t.Fatalf("ServerIconHash = %q, %v; want %q", listed, err, hash)
	}
	left, _ := filepath.Glob(filepath.Join(dir, "*.tmp-*"))
	if len(left) != 0 {
		t.Fatalf("temp files left behind: %v", left)
	}
}

// A failed rename (the crash window between the temp write and the rename) leaves the old icon and the old
// hash, and no half file.
func TestServerIcon_FailedRenameKeepsOldIconAndHash(t *testing.T) {
	svc, dir := newIconService(t)
	ctx := context.Background()
	oldHash, err := svc.SetServerIcon(ctx, 1, iconPNG(t, 64, 64, 1))
	mustDo(t, "first SetServerIcon", err)
	oldData, err := os.ReadFile(filepath.Join(dir, ServerIconFile))
	mustDo(t, "read old icon", err)

	renameErr := errors.New("disk gone")
	svc.iconRename = func(string, string) error { return renameErr }
	_, err = svc.SetServerIcon(ctx, 1, iconPNG(t, 64, 64, 2))
	if !errors.Is(err, renameErr) {
		t.Fatalf("err = %v, want the rename failure", err)
	}
	if got, _ := svc.Setting(ctx, ServerIconKey); got != oldHash {
		t.Fatalf("hash row = %q after a failed rename, want the old %q", got, oldHash)
	}
	if hash, _ := svc.ServerIconHash(ctx); hash != oldHash {
		t.Fatalf("served hash = %q after a failed rename, want the old %q", hash, oldHash)
	}
	got, gotHash, err := svc.ServerIcon(ctx)
	mustDo(t, "ServerIcon", err)
	if !bytes.Equal(got, oldData) || gotHash != oldHash {
		t.Fatal("the old icon was not served after a failed rename")
	}
	left, _ := filepath.Glob(filepath.Join(dir, "*.tmp-*"))
	if len(left) != 0 {
		t.Fatalf("temp files left behind: %v", left)
	}
}

func TestServerIcon_ReplaceChangesHash(t *testing.T) {
	svc, _ := newIconService(t)
	ctx := context.Background()
	first, err := svc.SetServerIcon(ctx, 1, iconPNG(t, 64, 64, 1))
	mustDo(t, "first", err)
	second, err := svc.SetServerIcon(ctx, 1, iconPNG(t, 64, 64, 2))
	mustDo(t, "second", err)
	if first == second {
		t.Fatal("a different picture kept the same hash")
	}
	hash, err := svc.ServerIconHash(ctx)
	mustDo(t, "ServerIconHash", err)
	if hash != second {
		t.Fatalf("hash = %q, want %q", hash, second)
	}
}

// failingRowStore is a store whose settings write fails, as a full disk or a locked database would.
type failingRowStore struct{ *db.DB }

func (failingRowStore) ApplySettings(context.Context, map[string]string) error {
	return errors.New("settings write refused")
}

// The file is the source of truth: a failed row write after the rename changes nothing about what clients see.
func TestServerIcon_RowWriteFailureStillServesNewIcon(t *testing.T) {
	database := newTestDB(t)
	svc := NewSettingsService(failingRowStore{database})
	svc.SetServerIconDir(t.TempDir())
	ctx := context.Background()
	hash, err := svc.SetServerIcon(ctx, 1, iconPNG(t, 64, 64, 4))
	mustDo(t, "SetServerIcon", err)
	data, gotHash, err := svc.ServerIcon(ctx)
	mustDo(t, "ServerIcon", err)
	if gotHash != hash || ServerIconHashOf(data) != hash {
		t.Fatalf("served hash %q, stored hash %q", gotHash, hash)
	}
	if listed, _ := svc.ServerIconHash(ctx); listed != hash {
		t.Fatalf("ServerIconHash = %q, want %q", listed, hash)
	}
}

// A file swapped under the server (a restore, a manual copy) is what clients see; the row is not consulted.
func TestServerIcon_HashFollowsTheFileNotTheRow(t *testing.T) {
	svc, dir := newIconService(t)
	ctx := context.Background()
	first, err := svc.SetServerIcon(ctx, 1, iconPNG(t, 64, 64, 1))
	mustDo(t, "SetServerIcon", err)
	other := iconPNG(t, 64, 64, 9)
	mustDo(t, "swap file", os.WriteFile(filepath.Join(dir, ServerIconFile), other, 0o600))
	hash, err := svc.ServerIconHash(ctx)
	mustDo(t, "ServerIconHash", err)
	if hash == first || hash != ServerIconHashOf(other) {
		t.Fatalf("hash = %q, want the hash of the file on disk %q", hash, ServerIconHashOf(other))
	}
	if row, _ := svc.Setting(ctx, ServerIconKey); row != first {
		t.Fatalf("row = %q, expected the mirror to stay untouched", row)
	}
}

// pngWithTextChunk inserts a tEXt chunk after the IHDR of a PNG.
func pngWithTextChunk(t *testing.T, src []byte) []byte {
	t.Helper()
	const ihdrEnd = 8 + 4 + 4 + 13 + 4
	payload := []byte("Comment\x00secret-metadata")
	chunk := make([]byte, 0, len(payload)+12)
	chunk = binary.BigEndian.AppendUint32(chunk, uint32(len(payload)))
	chunk = append(chunk, "tEXt"...)
	chunk = append(chunk, payload...)
	chunk = binary.BigEndian.AppendUint32(chunk, crc32.ChecksumIEEE(chunk[4:]))
	out := append([]byte{}, src[:ihdrEnd]...)
	out = append(out, chunk...)
	return append(out, src[ihdrEnd:]...)
}

func TestServerIcon_UploadIsReencodedWithoutMetadata(t *testing.T) {
	svc, dir := newIconService(t)
	upload := pngWithTextChunk(t, iconPNG(t, 64, 64, 5))
	upload = append(upload, []byte("trailing garbage")...)
	if !bytes.Contains(upload, []byte("secret-metadata")) {
		t.Fatal("test setup: the chunk is missing")
	}
	_, err := svc.SetServerIcon(context.Background(), 1, upload)
	mustDo(t, "SetServerIcon", err)
	stored, err := os.ReadFile(filepath.Join(dir, ServerIconFile))
	mustDo(t, "read icon", err)
	if bytes.Contains(stored, []byte("secret-metadata")) || bytes.Contains(stored, []byte("trailing garbage")) {
		t.Fatal("metadata or trailing data survived the re-encode")
	}
	if len(stored) > ServerIconMaxBytes {
		t.Fatalf("stored %d bytes", len(stored))
	}
}

func TestServerIcon_StartupSweepsStaleTempFiles(t *testing.T) {
	svc, _ := newSettingsService(t)
	dir := t.TempDir()
	stale := filepath.Join(dir, ServerIconFile+".tmp-123")
	keep := filepath.Join(dir, "other.tmp-1")
	mustDo(t, "write stale", os.WriteFile(stale, []byte("half"), 0o600))
	mustDo(t, "write other", os.WriteFile(keep, []byte("x"), 0o600))
	svc.SetServerIconDir(dir)
	if _, err := os.Stat(stale); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("stale temp file survived: %v", err)
	}
	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("an unrelated file was removed: %v", err)
	}
}

func TestServerIcon_ClearRemovesFileAndRow(t *testing.T) {
	svc, dir := newIconService(t)
	ctx := context.Background()
	_, err := svc.SetServerIcon(ctx, 1, iconPNG(t, 64, 64, 1))
	mustDo(t, "SetServerIcon", err)
	mustDo(t, "ClearServerIcon", svc.ClearServerIcon(ctx, 1))
	if _, err := os.Stat(filepath.Join(dir, ServerIconFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("icon file still present: %v", err)
	}
	if got, _ := svc.Setting(ctx, ServerIconKey); got != "" {
		t.Fatalf("row = %q, want cleared", got)
	}
	if _, _, err := svc.ServerIcon(ctx); !errors.Is(err, ErrNoServerIcon) {
		t.Fatalf("err = %v, want ErrNoServerIcon", err)
	}
	mustDo(t, "clearing again", svc.ClearServerIcon(ctx, 1))
}

// A database restored without the data directory has a hash and no file: report no icon.
func TestServerIcon_MissingFileMeansNoIcon(t *testing.T) {
	svc, dir := newIconService(t)
	ctx := context.Background()
	_, err := svc.SetServerIcon(ctx, 1, iconPNG(t, 64, 64, 1))
	mustDo(t, "SetServerIcon", err)
	mustDo(t, "remove file", os.Remove(filepath.Join(dir, ServerIconFile)))
	if hash, err := svc.ServerIconHash(ctx); err != nil || hash != "" {
		t.Fatalf("hash = %q, %v; want empty", hash, err)
	}
}

func TestServerIcon_Validation(t *testing.T) {
	svc, dir := newIconService(t)
	var big bytes.Buffer
	big.Write(iconPNG(t, 64, 64, 1))
	big.Write(make([]byte, ServerIconMaxBytes))
	truncated := iconPNG(t, 64, 64, 1)
	truncated = truncated[:len(truncated)/2]
	cases := map[string][]byte{
		"empty":         nil,
		"not a png":     []byte("GIF89a not a png at all"),
		"too big":       big.Bytes(),
		"truncated":     truncated,
		"not square":    iconPNG(t, 64, 96, 1),
		"too small":     iconPNG(t, 16, 16, 1),
		"too large":     iconPNG(t, 300, 300, 1),
		"just too wide": iconPNG(t, 257, 257, 1),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := svc.SetServerIcon(context.Background(), 1, data)
			if !errors.Is(err, ErrBadRequest) {
				t.Fatalf("err = %v, want ErrBadRequest", err)
			}
			if _, statErr := os.Stat(filepath.Join(dir, ServerIconFile)); statErr == nil {
				t.Fatal("a refused upload wrote the icon file")
			}
		})
	}
	for _, px := range []int{32, 256} {
		if _, err := svc.SetServerIcon(context.Background(), 1, iconPNG(t, px, px, 1)); err != nil {
			t.Fatalf("%d px icon refused: %v", px, err)
		}
	}
}

func TestServerIcon_NoDirIsUnavailable(t *testing.T) {
	svc, _ := newSettingsService(t)
	_, err := svc.SetServerIcon(context.Background(), 1, iconPNG(t, 64, 64, 1))
	if !errors.Is(err, ErrServerIconUnavailable) {
		t.Fatalf("err = %v, want ErrServerIconUnavailable", err)
	}
	if hash, err := svc.ServerIconHash(context.Background()); err != nil || hash != "" {
		t.Fatalf("hash = %q, %v; want empty", hash, err)
	}
}

func TestSettings_PatchRefusesServerIcon(t *testing.T) {
	svc, _ := newIconService(t)
	_, err := svc.Patch(context.Background(), 1, map[string]string{"server_icon": "abc"})
	if !errors.Is(err, ErrBadRequest) || !strings.HasPrefix(err.Error(), "server_icon is set with") {
		t.Fatalf("err = %v, want a 400 naming the upload route", err)
	}
}
