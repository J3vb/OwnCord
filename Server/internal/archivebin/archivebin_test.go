package archivebin

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

type entry struct {
	name string
	body []byte
	link bool
	dir  bool
}

func buildTarGz(entries ...entry) ([]byte, error) {
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for _, e := range entries {
		hdr := &tar.Header{Name: e.name, Mode: 0o755, Typeflag: tar.TypeReg, Size: int64(len(e.body))}
		switch {
		case e.link:
			hdr.Typeflag, hdr.Linkname, hdr.Size = tar.TypeSymlink, string(e.body), 0
		case e.dir:
			hdr.Typeflag, hdr.Size = tar.TypeDir, 0
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return nil, err
		}
		if hdr.Size > 0 {
			if _, err := tw.Write(e.body); err != nil {
				return nil, err
			}
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func buildZip(entries ...entry) ([]byte, error) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		switch {
		case e.link:
			h.SetMode(fs.ModeSymlink | 0o777)
		case e.dir:
			h.Name += "/"
		default:
			h.SetMode(0o755)
		}
		w, err := zw.CreateHeader(h)
		if err != nil {
			return nil, err
		}
		if !e.dir {
			if _, err := w.Write(e.body); err != nil {
				return nil, err
			}
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func must(build func(...entry) ([]byte, error)) func(testing.TB, ...entry) []byte {
	return func(t testing.TB, entries ...entry) []byte {
		t.Helper()
		b, err := build(entries...)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
}

var (
	tarGz    = must(buildTarGz)
	zipBytes = must(buildZip)
)

func isBin(name string) bool { return filepath.Base(name) == "bin" }

type extractor func(t *testing.T, archive []byte, dest string, maxBytes int64) (string, error)

var extractors = map[string]struct {
	build func(testing.TB, ...entry) []byte
	run   extractor
}{
	"tar.gz": {tarGz, func(_ *testing.T, a []byte, dest string, maxBytes int64) (string, error) {
		return FromTarGz(bytes.NewReader(a), dest, isBin, maxBytes)
	}},
	"zip": {zipBytes, func(_ *testing.T, a []byte, dest string, maxBytes int64) (string, error) {
		return FromZip(bytes.NewReader(a), int64(len(a)), dest, isBin, maxBytes)
	}},
}

func sumOf(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestExtract_TakesTheFirstRegularMatchAndReturnsItsHash(t *testing.T) {
	want := []byte("#!/bin/real\n")
	cases := map[string][]entry{
		"plain":                 {{name: "LICENSE", body: []byte("text")}, {name: "bin", body: want}},
		"in a folder":           {{name: "pkg", dir: true}, {name: "pkg/bin", body: want}},
		"symlink skipped":       {{name: "bin", body: []byte("/etc/passwd"), link: true}, {name: "bin", body: want}},
		"folder named bin":      {{name: "bin", dir: true}, {name: "x/bin", body: want}},
		"dot-dot name skipped":  {{name: "../bin", body: []byte("planted")}, {name: "bin", body: want}},
		"first of two is taken": {{name: "bin", body: want}, {name: "a/bin", body: []byte("second")}},
	}
	for kind, ex := range extractors {
		for name, entries := range cases {
			t.Run(kind+"/"+name, func(t *testing.T) {
				dest := filepath.Join(t.TempDir(), "out")
				sum, err := ex.run(t, ex.build(t, entries...), dest, 1<<20)
				if err != nil {
					t.Fatalf("extract: %v", err)
				}
				if sum != sumOf(want) {
					t.Errorf("hash = %s, want the hash of the written bytes", sum)
				}
				got, err := os.ReadFile(dest)
				if err != nil || !bytes.Equal(got, want) {
					t.Fatalf("dest holds %q (err %v), want %q", got, err, want)
				}
				info, err := os.Stat(dest)
				if err != nil || info.Mode().Perm() != 0o600 {
					t.Errorf("dest mode = %v (err %v), want 0600", info.Mode().Perm(), err)
				}
			})
		}
	}
}

func TestExtract_NoMatchLeavesNothingBehind(t *testing.T) {
	for kind, ex := range extractors {
		t.Run(kind, func(t *testing.T) {
			dest := filepath.Join(t.TempDir(), "out")
			_, err := ex.run(t, ex.build(t, entry{name: "README", body: []byte("hi")}, entry{name: "bin", body: []byte("/bin/sh"), link: true}), dest, 1<<20)
			if !errors.Is(err, ErrNoEntry) {
				t.Fatalf("err = %v, want ErrNoEntry", err)
			}
			if _, statErr := os.Stat(dest); !errors.Is(statErr, fs.ErrNotExist) {
				t.Errorf("dest exists after a failed extraction (stat err %v)", statErr)
			}
		})
	}
}

func TestExtract_RefusesAnEntryOverTheCap(t *testing.T) {
	for kind, ex := range extractors {
		t.Run(kind, func(t *testing.T) {
			dest := filepath.Join(t.TempDir(), "out")
			_, err := ex.run(t, ex.build(t, entry{name: "bin", body: bytes.Repeat([]byte("x"), 101)}), dest, 100)
			if !errors.Is(err, ErrTooLarge) {
				t.Fatalf("err = %v, want ErrTooLarge", err)
			}
			if _, statErr := os.Stat(dest); !errors.Is(statErr, fs.ErrNotExist) {
				t.Errorf("dest exists after a refused extraction (stat err %v)", statErr)
			}
		})
	}
}

func TestExtract_NeverWritesThroughAnExistingFile(t *testing.T) {
	for kind, ex := range extractors {
		t.Run(kind, func(t *testing.T) {
			dest := filepath.Join(t.TempDir(), "out")
			planted := []byte("planted")
			if err := os.WriteFile(dest, planted, 0o600); err != nil {
				t.Fatal(err)
			}
			_, err := ex.run(t, ex.build(t, entry{name: "bin", body: []byte("real")}), dest, 1<<20)
			if !errors.Is(err, fs.ErrExist) {
				t.Fatalf("err = %v, want fs.ErrExist", err)
			}
			if got, _ := os.ReadFile(dest); !bytes.Equal(got, planted) {
				t.Errorf("the existing file was changed to %q", got)
			}
		})
	}
}

func TestExtract_TruncatedArchiveRemovesThePartialFile(t *testing.T) {
	body := bytes.Repeat([]byte("abcdefgh"), 4096)
	full := tarGz(t, entry{name: "bin", body: body})
	var raw bytes.Buffer
	gr, err := gzip.NewReader(bytes.NewReader(full))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := raw.ReadFrom(gr); err != nil {
		t.Fatal(err)
	}
	var cut bytes.Buffer
	gw := gzip.NewWriter(&cut)
	_, _ = gw.Write(raw.Bytes()[:512+len(body)/2])
	_ = gw.Close()

	dest := filepath.Join(t.TempDir(), "out")
	if _, err := FromTarGz(bytes.NewReader(cut.Bytes()), dest, isBin, 1<<20); err == nil {
		t.Fatal("a cut-off archive extracted without error")
	}
	if _, statErr := os.Stat(dest); !errors.Is(statErr, fs.ErrNotExist) {
		t.Errorf("a partial file was left at dest (stat err %v)", statErr)
	}
}
