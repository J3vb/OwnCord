package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"net/http"
	"path"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/andybalholm/brotli"
)

// The portal serves each text file in up to three forms: the raw bytes, a
// gzip copy and a brotli copy. The copies are made once, in the background,
// after the portal is mounted: gzip for every file first (fast), then brotli at
// its highest quality (seconds of CPU for a full bundle). Until a file's copy
// exists, a request gets the next best form, so start-up never waits on it.

const (
	portalGzipLevel   = gzip.BestCompression
	portalBrotliLevel = brotli.BestCompression
	// portalEncodeChunk bounds how much is fed to an encoder between checks
	// of the context, so a shutdown does not wait for a whole large file.
	portalEncodeChunk = 64 << 10
)

// portalCompressible is the set of extensions worth compressing. Images,
// fonts and audio in the bundle are already compressed formats.
var portalCompressible = map[string]bool{
	".js": true, ".mjs": true, ".css": true, ".html": true, ".json": true,
	".map": true, ".svg": true, ".wasm": true, ".webmanifest": true, ".txt": true,
}

type portalEncoded struct {
	gzip   []byte
	brotli []byte
}

// portalFile is one served file. raw never changes after mount; enc is
// replaced whole by the encoder goroutine, so a reader sees either no copy,
// the gzip copy, or both.
type portalFile struct {
	raw []byte
	enc atomic.Pointer[portalEncoded]
}

func newPortalFile(raw []byte) *portalFile { return &portalFile{raw: raw} }

// encodePortalFiles makes the gzip copies of every compressible file, then the
// brotli copies, and stops early when ctx ends. A copy that is not smaller than
// the raw bytes is dropped. ready is closed when it returns.
func encodePortalFiles(ctx context.Context, files map[string]*portalFile, ready chan<- struct{}) {
	defer close(ready)
	names := make([]string, 0, len(files))
	for name, f := range files {
		if portalCompressible[strings.ToLower(path.Ext(name))] && len(f.raw) > 0 {
			names = append(names, name)
		}
	}
	for _, name := range names {
		f := files[name]
		gz, err := portalEncode(ctx, f.raw, newPortalGzip)
		if err != nil {
			return
		}
		f.enc.Store(&portalEncoded{gzip: smallerThan(gz, f.raw)})
	}
	for _, name := range names {
		f := files[name]
		br, err := portalEncode(ctx, f.raw, newPortalBrotli)
		if err != nil {
			return
		}
		prev := f.enc.Load()
		f.enc.Store(&portalEncoded{gzip: prev.gzip, brotli: smallerThan(br, f.raw)})
	}
}

type portalEncoder interface {
	Write(p []byte) (int, error)
	Close() error
}

func newPortalGzip(buf *bytes.Buffer) portalEncoder {
	w, err := gzip.NewWriterLevel(buf, portalGzipLevel)
	if err != nil {
		return gzip.NewWriter(buf)
	}
	return w
}

func newPortalBrotli(buf *bytes.Buffer) portalEncoder {
	return brotli.NewWriterLevel(buf, portalBrotliLevel)
}

func portalEncode(ctx context.Context, raw []byte, newEncoder func(*bytes.Buffer) portalEncoder) (out []byte, err error) {
	var buf bytes.Buffer
	enc := newEncoder(&buf)
	for rest := raw; len(rest) > 0; {
		if err = ctx.Err(); err != nil {
			return nil, fmt.Errorf("portal encode: %w", err)
		}
		n := min(len(rest), portalEncodeChunk)
		if _, err = enc.Write(rest[:n]); err != nil {
			return nil, fmt.Errorf("portal encode: %w", err)
		}
		rest = rest[n:]
	}
	if err = enc.Close(); err != nil {
		return nil, fmt.Errorf("portal encode: %w", err)
	}
	return buf.Bytes(), nil
}

func smallerThan(encoded, raw []byte) []byte {
	if len(encoded) >= len(raw) {
		return nil
	}
	return encoded
}

// writePortalFile writes f in the best form the request accepts, with
// Vary: Accept-Encoding on every answer so a shared cache keys on it.
func writePortalFile(w http.ResponseWriter, req *http.Request, f *portalFile) {
	h := w.Header()
	h.Add("Vary", "Accept-Encoding")
	body, encoding := f.raw, ""
	if enc := f.enc.Load(); enc != nil {
		gz, br := acceptedEncodings(req.Header.Values("Accept-Encoding"))
		switch {
		case br && enc.brotli != nil:
			body, encoding = enc.brotli, "br"
		case gz && enc.gzip != nil:
			body, encoding = enc.gzip, "gzip"
		}
	}
	if encoding != "" {
		h.Set("Content-Encoding", encoding)
	}
	h.Set("Content-Length", strconv.Itoa(len(body)))
	_, _ = w.Write(body)
}

// acceptedEncodings reports whether an Accept-Encoding header allows gzip and
// brotli. A coding listed with q=0 is refused, and "*" covers any coding the
// header does not name.
func acceptedEncodings(values []string) (gzipOK, brotliOK bool) {
	var gzipSet, brotliSet, star, starSet bool
	for _, v := range values {
		for _, part := range strings.Split(v, ",") {
			name, params, _ := strings.Cut(part, ";")
			name = strings.ToLower(strings.TrimSpace(name))
			ok := portalQualityAllows(params)
			switch name {
			case "gzip", "x-gzip":
				gzipOK, gzipSet = ok, true
			case "br":
				brotliOK, brotliSet = ok, true
			case "*":
				star, starSet = ok, true
			}
		}
	}
	if starSet {
		if !gzipSet {
			gzipOK = star
		}
		if !brotliSet {
			brotliOK = star
		}
	}
	return gzipOK, brotliOK
}

// portalQualityAllows reads the q parameter of one Accept-Encoding entry; an
// entry without one, or with one that does not parse, counts as allowed.
func portalQualityAllows(params string) bool {
	for _, p := range strings.Split(params, ";") {
		k, v, found := strings.Cut(strings.TrimSpace(p), "=")
		if !found || !strings.EqualFold(strings.TrimSpace(k), "q") {
			continue
		}
		q, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil {
			return true
		}
		return q > 0
	}
	return true
}
