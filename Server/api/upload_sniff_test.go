package api_test

import (
	"context"
	"io"
	"net/http/httptest"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
)

// shortReadReader hands back at most maxPerRead bytes on every Read call,
// regardless of how much the caller asked for — this is what a genuine short
// read from a *multipart.Part looks like (the caller's Read(sniffBuf[:]) asks
// for 512 bytes but a trickling client, or the boundary-match margin
// multipart.Reader always holds back, can hand over far fewer). A single
// bytes.Reader or bytes.Buffer never reproduces this: both fill the caller's
// buffer in one call whenever the data is available, so the short-read path
// needs a reader that deliberately caps itself instead.
type shortReadReader struct {
	data       []byte
	pos        int
	maxPerRead int
	readCalls  int
}

func (r *shortReadReader) Read(p []byte) (int, error) {
	r.readCalls++
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	n := r.maxPerRead
	if remaining := len(r.data) - r.pos; remaining < n {
		n = remaining
	}
	if n > len(p) {
		n = len(p)
	}
	copy(p, r.data[r.pos:r.pos+n])
	r.pos += n
	return n, nil
}

// TestUploadStoreFile_ShortReadStillSniffsFullHeader pins OC-0427:
// uploadStoreFile must not assume a single Read call fills its 512-byte sniff
// buffer. file is a *multipart.Part in production, and Part.Read is allowed to
// return fewer bytes than requested even when more remain (a trickling client,
// or the boundary-match margin the multipart reader always holds back). If the
// sniff step trusts one short Read, http.DetectContentType runs over a
// truncated prefix and can miss a signature that only becomes recognizable
// once enough bytes are in hand — here, WEBP's 12-byte "RIFF????WEBP" pattern,
// split across two 10-byte reads.
func TestUploadStoreFile_ShortReadStillSniffsFullHeader(t *testing.T) {
	database := newUploadTestDB(t)
	store := newUploadTestStorage(t)
	svc := testUploadSvc(database)

	userID, err := database.CreateUser(context.Background(), "sniffuser", "$2a$12$fake", 1)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	// A minimal RIFF/WEBP header: bytes 0-3 "RIFF", 4-7 an (arbitrary,
	// masked-out) chunk size, 8-13 "WEBPVP". http.DetectContentType needs
	// all 14 bytes to recognize it. The reader below only ever hands back 10
	// bytes per Read call, so a single-Read sniff sees "RIFF" + 4 size bytes
	// + "WE" — four bytes short of the signature — even though the full
	// header is available from the underlying stream a moment later.
	data := make([]byte, 40)
	copy(data, "RIFF")
	data[4], data[5], data[6], data[7] = 0x1c, 0x00, 0x00, 0x00
	copy(data[8:], "WEBPVP")

	reader := &shortReadReader{data: data, maxPerRead: 10}

	res, err := svc.Reserve(context.Background(), userID, int64(len(data)))
	if err != nil {
		t.Fatalf("Reserve: %v", err)
	}
	defer res.Settle(context.Background())

	rr := httptest.NewRecorder()
	mimeType, size, _, _, ok := api.UploadStoreFileForTest(context.Background(), rr, reader, res, store)
	if !ok {
		t.Fatalf("UploadStoreFileForTest failed: status %d, body %s", rr.Code, rr.Body.String())
	}
	if reader.readCalls < 2 {
		t.Fatalf("reader.readCalls = %d, want >= 2 (test fixture did not exercise multiple reads)", reader.readCalls)
	}
	if mimeType != "image/webp" {
		t.Errorf("mime = %q, want image/webp (signature spans two short reads — the sniff step must not stop after one)", mimeType)
	}
	if size != int64(len(data)) {
		t.Errorf("size = %d, want %d", size, len(data))
	}
}
