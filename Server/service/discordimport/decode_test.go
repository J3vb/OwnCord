package discordimport

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
)

func TestDecode_FixtureHeaderAndMessagesInOrder(t *testing.T) {
	f, err := os.Open("testdata/channel.json")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close() //nolint:errcheck

	var header Header
	var ids []string
	sum, err := Decode(context.Background(), f, Visitor{
		Header: func(h Header) error { header = h; return nil },
		Message: func(m Message) error {
			if header.Channel.ID == "" {
				t.Error("a message arrived before the header")
			}
			ids = append(ids, m.ID)
			return nil
		},
	})
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if header.Channel.Name != "general" || header.Channel.ID != "111" || header.Channel.Topic != "Where we talk" || header.Guild.Name != "Test Guild" {
		t.Errorf("header = %+v", header)
	}
	if got := strings.Join(ids, ","); got != "1001,1002,1003,1004,1005,1006,1007" {
		t.Errorf("message order = %s", got)
	}
	if sum.MessageCount != 7 || sum.Seen != 7 {
		t.Errorf("summary = %+v, want 7 and 7", sum)
	}
}

func TestDecode_ReadsFieldsTheImporterUses(t *testing.T) {
	f, _ := os.Open("testdata/channel.json")
	defer f.Close() //nolint:errcheck
	got := map[string]Message{}
	if _, err := Decode(context.Background(), f, Visitor{Message: func(m Message) error { got[m.ID] = m; return nil }}); err != nil {
		t.Fatal(err)
	}
	m := got["1002"]
	if m.Type != "Reply" || m.Reference == nil || m.Reference.MessageID != "1001" || m.TimestampEdited == nil || m.Author.ID != "43" {
		t.Errorf("reply = %+v", m)
	}
	if !got["1001"].IsPinned || got["1001"].Author.Color != "#FF0000" || got["1001"].Author.Nickname != "Ann N." {
		t.Errorf("first = %+v", got["1001"])
	}
	if a := got["1005"].Attachments; len(a) != 2 || a[0].FileName != "pic one.png" || a[0].FileSizeBytes != 67 {
		t.Errorf("attachments = %+v", a)
	}
}

func TestDisplayName_NicknameElseName(t *testing.T) {
	cases := []struct {
		a    Author
		want string
	}{
		{Author{Name: "ann", Nickname: "Ann N."}, "Ann N."},
		{Author{Name: "bob", Nickname: ""}, "bob"},
		{Author{Name: "cy", Nickname: "   "}, "cy"},
		{Author{}, "Unknown"},
	}
	for _, c := range cases {
		if got := c.a.DisplayName(); got != c.want {
			t.Errorf("DisplayName(%+v) = %q, want %q", c.a, got, c.want)
		}
	}
}

// The decoder must hand messages out one at a time: it is fed a stream whose
// messages array is far larger than it may hold, and stops after the first.
func TestDecode_StreamsWithoutReadingTheWholeArray(t *testing.T) {
	r := &countingReader{src: infiniteExport()}
	stop := errors.New("stop")
	n := 0
	_, err := Decode(context.Background(), r, Visitor{Message: func(Message) error {
		n++
		if n == 3 {
			return stop
		}
		return nil
	}})
	if !errors.Is(err, stop) {
		t.Fatalf("err = %v, want the visitor's error", err)
	}
	if r.read > 1<<20 {
		t.Errorf("decoder read %d bytes to deliver 3 messages", r.read)
	}
}

func TestDecode_RejectsMessagesBeforeChannel(t *testing.T) {
	in := `{"messages":[{"id":"1","type":"Default"}],"channel":{"id":"1","name":"x"}}`
	_, err := Decode(context.Background(), strings.NewReader(in), Visitor{})
	if !errors.Is(err, ErrBadExport) {
		t.Errorf("err = %v, want ErrBadExport", err)
	}
}

func TestDecode_RejectsNotAnExport(t *testing.T) {
	for _, in := range []string{``, `[]`, `{"guild":{}}`, `{"channel":{"id":"1","name":"x"},"messages":{}}`, `{"channel":{"id":"1","name":"x"},"messages":[{"id":`} {
		if _, err := Decode(context.Background(), strings.NewReader(in), Visitor{}); !errors.Is(err, ErrBadExport) {
			t.Errorf("Decode(%q) err = %v, want ErrBadExport", in, err)
		}
	}
}

func TestDecode_StopsWhenContextIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	_, err := Decode(ctx, &countingReader{src: infiniteExport()}, Visitor{Message: func(Message) error {
		cancel()
		return nil
	}})
	if !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want context.Canceled", err)
	}
}

type countingReader struct {
	src  *infiniteReader
	read int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.src.Read(p)
	c.read += n
	return n, err
}

// infiniteReader serves a valid export prefix and then the same message forever.
type infiniteReader struct {
	buf []byte
	pos int
	n   int
}

func infiniteExport() *infiniteReader {
	return &infiniteReader{buf: []byte(`{"channel":{"id":"1","name":"x"},"messages":[`)}
}

func (r *infiniteReader) Read(p []byte) (int, error) {
	const msg = `{"id":"1","type":"Default","timestamp":"2020-01-01T00:00:00+00:00","content":"hi","author":{"id":"1","name":"a"}},`
	if r.pos >= len(r.buf) {
		r.buf = []byte(msg)
		r.pos = 0
		r.n++
	}
	n := copy(p, r.buf[r.pos:])
	r.pos += n
	return n, nil
}
