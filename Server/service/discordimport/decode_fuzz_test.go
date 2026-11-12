package discordimport

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"io"
	"io/fs"
	"path"
	"strings"
	"testing"
)

// FuzzDecode feeds arbitrary bytes to the streaming export decoder. It must
// never panic, must only fail with ErrBadExport (the visitor here never
// errors), must count every message it hands over, and must send the header
// exactly once on success and at most once otherwise.
func FuzzDecode(f *testing.F) {
	seeds := []string{
		``,
		`{}`,
		`[]`,
		`{"channel":{"id":"1","name":"general"},"messages":[]}`,
		`{"guild":{"id":"9","name":"g"},"channel":{"id":"1"},"messages":[{"id":"2","type":"Default","content":"hi","author":{"id":"3","name":"a"}}],"messageCount":1}`,
		`{"messages":[],"channel":{}}`,
		`{"channel":{},"messages":[{"id":1}]}`,
		`{"channel":{},"messages":[{},{},`,
		`{"channel":{},"messages":{}}`,
		`{"channel":{},"extra":[1,{"a":[null]}],"messageCount":"x"}`,
		`{"channel":{},"messages":[{"attachments":[{"url":"../x","fileSizeBytes":-1}]}]}`,
		`{"channel":{}}` + `}`,
		`{"channel":{},"channel":{"id":"2"},"messages":[]}`,
		strings.Repeat(`[`, 64),
	}
	for _, s := range seeds {
		f.Add([]byte(s))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		headers, messages := 0, 0
		sum, err := Decode(context.Background(), bytes.NewReader(data), Visitor{
			Header:  func(Header) error { headers++; return nil },
			Message: func(Message) error { messages++; return nil },
		})
		if err != nil && !errors.Is(err, ErrBadExport) {
			t.Fatalf("Decode failed with %v, which is not ErrBadExport", err)
		}
		if sum.Seen != messages {
			t.Fatalf("Summary.Seen = %d, but the visitor got %d messages", sum.Seen, messages)
		}
		if headers > 1 {
			t.Fatalf("header sent %d times", headers)
		}
		if err == nil && headers != 1 {
			t.Fatalf("a successful decode sent the header %d times, want 1", headers)
		}
	})
}

// fuzzZipCaps are tight so the size and entry caps are reachable while
// fuzzing.
var fuzzZipCaps = ZipLimits{MaxEntries: 32, MaxUncompressedBytes: 1 << 16}

// fuzzZipFromNames builds a zip with one entry per line of names, each
// holding body. A line starting with '@' becomes a symlink entry; a name the
// zip writer refuses, or a folder that cannot hold a body, is written empty or
// left out.
func fuzzZipFromNames(names string, body []byte) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i, n := range strings.Split(names, "\n") {
		if i >= 16 {
			break
		}
		h := &zip.FileHeader{Name: n, Method: zip.Deflate}
		if rest, ok := strings.CutPrefix(n, "@"); ok {
			h.Name = rest
			h.SetMode(fs.ModeSymlink | 0o777)
		}
		w, err := zw.CreateHeader(h)
		if err != nil {
			continue
		}
		if !strings.HasSuffix(h.Name, "/") {
			_, _ = w.Write(body)
		}
	}
	_ = zw.Close()
	return buf.Bytes()
}

// FuzzNewZipExport checks the zip reader on archives built from fuzzed entry
// names, and on raw fuzzed bytes. A refusal must be one of the package's
// errors. An accepted archive must index only clean relative names, and
// nothing read from it, the JSON or any attachment a fuzzed reference finds,
// may yield more bytes than the uncompressed cap.
func FuzzNewZipExport(f *testing.F) {
	f.Add("export.json\nmedia/a.png", []byte(`{}`), "media/a.png", []byte(nil))
	f.Add("chan/export.json\nchan/media/a.png", []byte("x"), "media%2Fa.png", []byte(nil))
	f.Add("../export.json", []byte("x"), "", []byte(nil))
	f.Add("a.json\n/abs.png\nC:/x.png", []byte("x"), "C:/x.png", []byte(nil))
	f.Add("a.json\n@link.png", []byte("/etc/passwd"), "link.png", []byte(nil))
	f.Add("a.json\nb\\..\\c.png", []byte("x"), "b\\..\\c.png", []byte(nil))
	f.Add("a.json\nx\x00y", []byte("x"), "x", []byte(nil))
	f.Add("a.json\nb.json", []byte("x"), "", []byte(nil))
	f.Add("__MACOSX/._a.json\nd/a.json", []byte("x"), "//host/a.png", []byte(nil))
	f.Add("a.json\nbig.bin", bytes.Repeat([]byte("z"), 40000), "big.bin", []byte(nil))
	f.Add("", []byte(nil), "", []byte("PK\x05\x06"+strings.Repeat("\x00", 18)))

	f.Fuzz(func(t *testing.T, names string, body []byte, ref string, raw []byte) {
		archives := [][]byte{fuzzZipFromNames(names, body)}
		if len(raw) > 0 {
			archives = append(archives, raw)
		}
		for _, b := range archives {
			z, err := NewZipExport(bytes.NewReader(b), int64(len(b)), fuzzZipCaps)
			if err != nil {
				if !errors.Is(err, ErrBadExport) && !errors.Is(err, ErrUnsafeZip) && !errors.Is(err, ErrZipTooLarge) {
					t.Fatalf("NewZipExport refused with %v, which is none of the package's errors", err)
				}
				continue
			}
			fuzzCheckZipNames(t, z)
			read := fuzzDrain(t, z.OpenJSON)
			m, mErr := z.OpenMedia(ref)
			if mErr == nil {
				read += fuzzDrain(t, func() (io.ReadCloser, error) { return m.Reader, nil })
			} else if !errors.Is(mErr, ErrMediaMissing) && !errors.Is(mErr, ErrRemoteMedia) {
				t.Fatalf("OpenMedia(%q) failed with %v", ref, mErr)
			}
			if read > fuzzZipCaps.MaxUncompressedBytes {
				t.Fatalf("read %d bytes from the zip, over the %d-byte cap", read, fuzzZipCaps.MaxUncompressedBytes)
			}
		}
	})
}

func fuzzCheckZipNames(t *testing.T, z *ZipExport) {
	t.Helper()
	if len(z.files) > fuzzZipCaps.MaxEntries {
		t.Fatalf("indexed %d entries, over the %d cap", len(z.files), fuzzZipCaps.MaxEntries)
	}
	for name := range z.files {
		if strings.HasPrefix(name, "/") || strings.ContainsRune(name, 0) || strings.Contains(name, "\\") ||
			driveLetter.MatchString(name) || name != path.Clean(name) || name == ".." || strings.HasPrefix(name, "../") {
			t.Fatalf("indexed an unsafe entry name %q", name)
		}
	}
}

// fuzzDrain reads one opened entry to the end and returns how many bytes it
// gave. Reading past the cap is ErrZipTooLarge; any other read error fails.
func fuzzDrain(t *testing.T, open func() (io.ReadCloser, error)) int64 {
	t.Helper()
	rc, err := open()
	if err != nil {
		return 0
	}
	defer func() { _ = rc.Close() }()
	n, err := io.Copy(io.Discard, rc)
	if err != nil && !errors.Is(err, ErrZipTooLarge) && !strings.Contains(err.Error(), "zip:") && !strings.Contains(err.Error(), "flate:") {
		t.Fatalf("reading an entry failed with %v", err)
	}
	return n
}

// FuzzImageSize measures arbitrary bytes as a PNG or GIF header. It must not
// panic, and it reports either no size or two positive sides.
func FuzzImageSize(f *testing.F) {
	img := image.NewPaletted(image.Rect(0, 0, 3, 2), color.Palette{color.Black, color.White})
	var p, g bytes.Buffer
	_ = png.Encode(&p, img)
	_ = gif.Encode(&g, img, nil)
	f.Add(p.Bytes(), false)
	f.Add(g.Bytes(), true)
	f.Add(p.Bytes()[:24], false)
	f.Add([]byte("GIF89a\xff\xff\xff\xff"), true)
	f.Add([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\xff\xff\xff\xff\xff\xff\xff\xff"), false)
	f.Fuzz(func(t *testing.T, head []byte, asGIF bool) {
		mime := "image/png"
		if asGIF {
			mime = "image/gif"
		}
		w, h := imageSize(head, mime)
		if (w == nil) != (h == nil) {
			t.Fatalf("imageSize gave one side without the other: %v, %v", w, h)
		}
		if w != nil && (*w <= 0 || *h <= 0) {
			t.Fatalf("imageSize gave %dx%d", *w, *h)
		}
		if w, h := imageSize(head, "image/jpeg"); w != nil || h != nil {
			t.Fatal("imageSize measured a JPEG")
		}
	})
}
