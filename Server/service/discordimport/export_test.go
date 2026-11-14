package discordimport

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type zipEntry struct {
	name string
	body string
	mode fs.FileMode
}

func buildZip(t *testing.T, entries ...zipEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		if e.mode != 0 {
			h.SetMode(e.mode)
		}
		w, err := zw.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(e.body)); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func openZipBytes(t *testing.T, b []byte, lim ZipLimits) (*ZipExport, error) {
	t.Helper()
	return NewZipExport(bytes.NewReader(b), int64(len(b)), lim)
}

func TestZipExport_ReadsJSONAndLocalMedia(t *testing.T) {
	b := buildZip(t,
		zipEntry{name: "channel.json", body: `{"channel":{"id":"1","name":"x"},"messages":[]}`},
		zipEntry{name: "channel.json_Files/", body: ""},
		zipEntry{name: "channel.json_Files/pic one.png", body: "PNGDATA"},
		zipEntry{name: "__MACOSX/._channel.json", body: "junk"},
	)
	z, err := openZipBytes(t, b, ZipLimits{})
	if err != nil {
		t.Fatal(err)
	}
	rc, err := z.OpenJSON()
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rc)
	_ = rc.Close()
	if !strings.Contains(string(got), `"messages"`) {
		t.Errorf("json = %s", got)
	}

	for _, ref := range []string{"channel.json_Files/pic one.png", "channel.json_Files/pic%20one.png", "./channel.json_Files/pic one.png"} {
		m, err := z.OpenMedia(ref)
		if err != nil {
			t.Errorf("OpenMedia(%q): %v", ref, err)
			continue
		}
		data, _ := io.ReadAll(m.Reader)
		_ = m.Reader.Close()
		if string(data) != "PNGDATA" || m.Size != 7 {
			t.Errorf("OpenMedia(%q) = %q size %d", ref, data, m.Size)
		}
	}
}

// A downloaded .json attachment sits in the media folder; it is not a second
// export document.
func TestZipExport_JSONInsideTheMediaFolderIsMedia(t *testing.T) {
	b := buildZip(t,
		zipEntry{name: "chan.json", body: `{"channel":{"id":"1","name":"x"},"messages":[]}`},
		zipEntry{name: "chan.json_Files/config-1A2B.json", body: `{"a":1}`},
	)
	z, err := openZipBytes(t, b, ZipLimits{})
	if err != nil {
		t.Fatalf("a media .json made the zip unusable: %v", err)
	}
	rc, err := z.OpenJSON()
	if err != nil {
		t.Fatal(err)
	}
	doc, _ := io.ReadAll(rc)
	_ = rc.Close()
	if !strings.Contains(string(doc), `"channel"`) {
		t.Errorf("export document = %s", doc)
	}
	m, err := z.OpenMedia("chan.json_Files/config-1A2B.json")
	if err != nil {
		t.Fatalf("OpenMedia: %v", err)
	}
	data, _ := io.ReadAll(m.Reader)
	_ = m.Reader.Close()
	if string(data) != `{"a":1}` {
		t.Errorf("media = %q", data)
	}
}

func TestZipExport_MediaRelativeToAJSONInAFolder(t *testing.T) {
	b := buildZip(t,
		zipEntry{name: "export/channel.json", body: `{}`},
		zipEntry{name: "export/channel.json_Files/a.png", body: "A"},
	)
	z, err := openZipBytes(t, b, ZipLimits{})
	if err != nil {
		t.Fatal(err)
	}
	m, err := z.OpenMedia("channel.json_Files/a.png")
	if err != nil {
		t.Fatalf("OpenMedia: %v", err)
	}
	_ = m.Reader.Close()
}

func TestZipExport_RemoteAndMissingMediaAreNeverFetched(t *testing.T) {
	b := buildZip(t, zipEntry{name: "c.json", body: `{}`})
	z, err := openZipBytes(t, b, ZipLimits{})
	if err != nil {
		t.Fatal(err)
	}
	for _, ref := range []string{"https://cdn.discordapp.com/a.png", "http://x/y", "HTTPS://X/Y", "ftp://x/y", "C:\\Users\\a.png", "//host/share/a.png"} {
		if _, err := z.OpenMedia(ref); !errors.Is(err, ErrRemoteMedia) {
			t.Errorf("OpenMedia(%q) err = %v, want ErrRemoteMedia", ref, err)
		}
	}
	for _, ref := range []string{"nothing/here.png", "", "../c.json", "/c.json"} {
		if _, err := z.OpenMedia(ref); !errors.Is(err, ErrMediaMissing) {
			t.Errorf("OpenMedia(%q) err = %v, want ErrMediaMissing", ref, err)
		}
	}
}

func TestZipExport_RefusesUnsafeEntries(t *testing.T) {
	cases := map[string]zipEntry{
		"absolute path":        {name: "/etc/passwd", body: "x"},
		"parent segment":       {name: "../outside.png", body: "x"},
		"nested parent":        {name: "a/../../outside.png", body: "x"},
		"backslash parent":     {name: "a\\..\\..\\outside.png", body: "x"},
		"windows drive":        {name: "C:/x.png", body: "x"},
		"windows drive back":   {name: "C:\\x.png", body: "x"},
		"backslash absolute":   {name: "\\share\\x.png", body: "x"},
		"nul byte":             {name: "a\x00b.png", body: "x"},
		"symlink":              {name: "link.png", body: "/etc/passwd", mode: fs.ModeSymlink | 0o777},
		"symlink in subfolder": {name: "d/link.png", body: "../../x", mode: fs.ModeSymlink | 0o777},
	}
	for name, e := range cases {
		t.Run(name, func(t *testing.T) {
			b := buildZip(t, zipEntry{name: "c.json", body: `{}`}, e)
			if _, err := openZipBytes(t, b, ZipLimits{}); !errors.Is(err, ErrUnsafeZip) {
				t.Errorf("err = %v, want ErrUnsafeZip", err)
			}
		})
	}
}

func TestZipExport_CapsEntryCountAndSize(t *testing.T) {
	entries := make([]zipEntry, 0, 11)
	entries = append(entries, zipEntry{name: "c.json", body: `{}`})
	for i := range 10 {
		entries = append(entries, zipEntry{name: "m/" + string(rune('a'+i)), body: "x"})
	}
	b := buildZip(t, entries...)
	if _, err := openZipBytes(t, b, ZipLimits{MaxEntries: 5}); !errors.Is(err, ErrZipTooLarge) {
		t.Errorf("entry cap: err = %v, want ErrZipTooLarge", err)
	}
	if _, err := openZipBytes(t, b, ZipLimits{MaxEntries: 100}); err != nil {
		t.Errorf("under the entry cap: %v", err)
	}

	big := buildZip(t, zipEntry{name: "c.json", body: `{}`}, zipEntry{name: "zeros.bin", body: strings.Repeat("\x00", 1<<20)})
	if _, err := openZipBytes(t, big, ZipLimits{MaxUncompressedBytes: 1 << 19}); !errors.Is(err, ErrZipTooLarge) {
		t.Errorf("declared size cap: err = %v, want ErrZipTooLarge", err)
	}
}

// A zip can lie about an entry's size. The reader enforces the byte budget as
// it reads, not only from the declared sizes.
func TestZipExport_BudgetHoldsWhileReading(t *testing.T) {
	b := buildZip(t, zipEntry{name: "c.json", body: `{}`}, zipEntry{name: "a.bin", body: strings.Repeat("a", 4000)}, zipEntry{name: "b.bin", body: strings.Repeat("b", 4000)})
	z, err := openZipBytes(t, b, ZipLimits{MaxUncompressedBytes: 9000})
	if err != nil {
		t.Fatal(err)
	}
	z.budget.remaining = 5000 // as if the headers had understated the sizes
	for _, name := range []string{"a.bin", "b.bin"} {
		m, err := z.OpenMedia(name)
		if err != nil {
			t.Fatal(err)
		}
		_, err = io.Copy(io.Discard, m.Reader)
		_ = m.Reader.Close()
		if name == "b.bin" && !errors.Is(err, ErrZipTooLarge) {
			t.Errorf("second read err = %v, want ErrZipTooLarge", err)
		}
		if name == "a.bin" && err != nil {
			t.Errorf("first read err = %v", err)
		}
	}
}

func TestZipExport_NeedsExactlyOneJSON(t *testing.T) {
	none := buildZip(t, zipEntry{name: "a.png", body: "x"})
	if _, err := openZipBytes(t, none, ZipLimits{}); !errors.Is(err, ErrBadExport) {
		t.Errorf("no json: err = %v", err)
	}
	two := buildZip(t, zipEntry{name: "a.json", body: "{}"}, zipEntry{name: "b.json", body: "{}"})
	if _, err := openZipBytes(t, two, ZipLimits{}); !errors.Is(err, ErrBadExport) {
		t.Errorf("two json: err = %v", err)
	}
}

func TestOpenFile_PicksReaderByExtension(t *testing.T) {
	dir := t.TempDir()
	zp := filepath.Join(dir, "e.zip")
	if err := os.WriteFile(zp, buildZip(t, zipEntry{name: "c.json", body: `{"channel":{"id":"1","name":"x"},"messages":[]}`}), 0o600); err != nil {
		t.Fatal(err)
	}
	ex, err := OpenFile(zp, ZipLimits{})
	if err != nil {
		t.Fatal(err)
	}
	if err := ex.Close(); err != nil {
		t.Error(err)
	}

	jp := filepath.Join(dir, "c.json")
	if err := os.WriteFile(jp, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	ex, err = OpenFile(jp, ZipLimits{})
	if err != nil {
		t.Fatal(err)
	}
	defer ex.Close() //nolint:errcheck
	if _, err := ex.OpenMedia("c.json_Files/a.png"); !errors.Is(err, ErrMediaMissing) {
		t.Errorf("plain json media err = %v, want ErrMediaMissing", err)
	}
	if _, err := ex.OpenMedia("https://x/y.png"); !errors.Is(err, ErrRemoteMedia) {
		t.Errorf("plain json remote err = %v, want ErrRemoteMedia", err)
	}
	if _, err := OpenFile(filepath.Join(dir, "x.txt"), ZipLimits{}); !errors.Is(err, ErrBadExport) {
		t.Errorf("unknown extension err = %v", err)
	}
}
