package safefetch

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
)

// readResponse turns a live http.Response into a bounded, type-checked
// Response, judging the media type on the bytes that actually arrived.
func (f *Fetcher) readResponse(ctx context.Context, resp *http.Response, dest *destination) (*Response, error) {
	gzipped, err := encoding(resp.Header)
	if err != nil {
		return nil, fmt.Errorf("%w (from %s)", err, dest.url.Redacted())
	}
	body, err := f.readBody(ctx, resp, gzipped)
	if err != nil {
		return nil, err
	}
	declared, sniffed, err := f.checkContentType(resp.Header.Get("Content-Type"), body)
	if err != nil {
		return nil, fmt.Errorf("%w (from %s)", err, dest.url.Redacted())
	}
	// The header must describe the returned (inflated) body, so the upstream
	// Content-Encoding and Content-Length are replaced.
	header := resp.Header.Clone()
	if header == nil {
		// Clone returns nil for a nil map, and Set on a nil Header panics.
		header = http.Header{}
	}
	header.Del("Content-Encoding")
	header.Set("Content-Length", strconv.Itoa(len(body)))
	return &Response{
		StatusCode:  resp.StatusCode,
		Header:      header,
		Body:        body,
		ContentType: declared,
		SniffedType: sniffed,
		FinalURL:    dest.url.String(),
	}, nil
}

// readBody reads the response under two ceilings, on wire bytes and on inflated
// bytes, both enforced while reading so an oversized body is refused early.
func (f *Fetcher) readBody(ctx context.Context, resp *http.Response, gzipped bool) ([]byte, error) {
	wire := &limitedReader{r: resp.Body, remaining: f.policy.MaxBytes + 1, over: ErrBodyTooLarge}
	var src io.Reader = wire
	limit, over := f.policy.MaxBytes, ErrBodyTooLarge
	if gzipped {
		zr, err := gzip.NewReader(wire)
		if err != nil {
			return nil, f.readError(ctx, fmt.Errorf("safefetch: gzip: %w", err))
		}
		defer func() { _ = zr.Close() }()
		src = &limitedReader{r: zr, remaining: f.policy.MaxDecompressedBytes + 1, over: ErrDecompressedTooLarge}
		limit, over = f.policy.MaxDecompressedBytes, ErrDecompressedTooLarge
	}
	if f.policy.Truncate {
		// Never past the inflated ceiling, nor one byte past it, which
		// limitedReader would report on the read after.
		keep := min(f.policy.MaxDecompressedBytes, limit)
		body, err := io.ReadAll(io.LimitReader(src, keep))
		if err != nil {
			return nil, f.readError(ctx, err)
		}
		return body, nil
	}
	body, err := io.ReadAll(src)
	if err != nil {
		return nil, f.readError(ctx, err)
	}
	// limitedReader reports a breach only on the read after its allowance, which
	// a source returning its last bytes with io.EOF never gives it; without this
	// check a body of ceiling+1 would pass depending on wire framing.
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("%w: %d bytes past a %d-byte ceiling", over, len(body), limit)
	}
	return body, nil
}

// encoding reports whether the body is gzip and refuses any other encoding.
// Only gzip, identity and an absent header are honest answers to our request;
// anything else, including a stacked "gzip, gzip" (a decompression bomb with an
// extra layer) or a second header line Header.Get would not show, is refused.
func encoding(h http.Header) (gzipped bool, err error) {
	values := h.Values("Content-Encoding")
	if len(values) == 0 {
		return false, nil
	}
	if len(values) > 1 {
		return false, fmt.Errorf("%w: %d Content-Encoding headers", ErrContentEncoding, len(values))
	}
	switch strings.ToLower(strings.TrimSpace(values[0])) {
	case "", "identity":
		return false, nil
	case "gzip":
		return true, nil
	default:
		return false, fmt.Errorf("%w: %q", ErrContentEncoding, values[0])
	}
}

// readError keeps ceiling breaches and context failure distinct from a transport error.
func (f *Fetcher) readError(ctx context.Context, err error) error {
	if errors.Is(err, ErrBodyTooLarge) || errors.Is(err, ErrDecompressedTooLarge) {
		return err
	}
	return wrapContext(ctx, fmt.Errorf("safefetch: read body: %w", err))
}

// checkContentType judges the media type as declared and as sniffed; an
// incompatible mismatch is refused (how a JSON caller is handed an HTML page).
// An empty body has nothing to sniff, and with no declared type passes (a normal
// 201/204 acknowledgement).
func (f *Fetcher) checkContentType(declared string, body []byte) (string, string, error) {
	media := normaliseType(declared)
	if len(f.policy.ContentTypes) == 0 {
		return media, "", nil
	}
	if media == "" && len(body) == 0 {
		return media, "", nil
	}
	if media == "" {
		return "", "", fmt.Errorf("%w: the response declared no Content-Type", ErrContentType)
	}
	if !f.typeAllowed(media) {
		return "", "", fmt.Errorf("%w: declared %s", ErrContentType, media)
	}
	if len(body) == 0 {
		return media, "", nil
	}
	sniffed := normaliseType(http.DetectContentType(body))
	if !f.typeAllowed(sniffed) {
		return "", "", fmt.Errorf("%w: declared %s but the body sniffs as %s", ErrContentType, media, sniffed)
	}
	if !compatible(media, sniffed, body) {
		return "", "", fmt.Errorf("%w: declared %s but the body sniffs as %s", ErrContentType, media, sniffed)
	}
	return media, sniffed, nil
}

// textual lists declared types whose bytes http.DetectContentType reports as text/plain.
var textual = map[string]bool{
	"application/json":                  true,
	"application/xml":                   true,
	"application/xhtml+xml":             true,
	"application/javascript":            true,
	"application/x-www-form-urlencoded": true,
	"image/svg+xml":                     true,
}

// compatible reports whether a sniffed type can be what the response declared.
func compatible(declared, sniffed string, body []byte) bool {
	switch {
	case declared == sniffed, declared == "application/octet-stream":
		return true
	case sniffed == "text/plain":
		return strings.HasPrefix(declared, "text/") || textual[declared]
	case sniffed == "text/xml":
		return strings.HasPrefix(declared, "text/") || declared == "application/xml" || declared == "application/xhtml+xml" || declared == "image/svg+xml"
	case sniffed == "text/html" && declared == "application/xhtml+xml":
		return true
	case sniffed == "text/html":
		// A leading "<!--" sniffs as HTML but is also a valid XML/SVG/CSS comment;
		// only the comment is excused, what follows is judged on its own.
		if !strings.HasPrefix(declared, "text/") && declared != "application/xml" && declared != "image/svg+xml" {
			return false
		}
		rest, ok := skipLeadingComments(body)
		if !ok {
			return false
		}
		return len(rest) == 0 || compatible(declared, normaliseType(http.DetectContentType(rest)), rest)
	}
	return false
}

// skipLeadingComments strips the whitespace-separated "<!-- ... -->" comments
// a body opens with. ok is false when it opens with none or one never closes.
func skipLeadingComments(body []byte) (rest []byte, ok bool) {
	rest = body
	for {
		// The whitespace http.DetectContentType skips before sniffing.
		rest = bytes.TrimLeft(rest, "\t\n\x0c\r ")
		after, found := bytes.CutPrefix(rest, []byte("<!--"))
		if !found {
			return rest, ok
		}
		var text []byte
		if text, rest, found = bytes.Cut(after, []byte("-->")); !found {
			return nil, false
		}
		// Only a well-formed XML comment, which an HTML parser closes at the same place.
		if bytes.HasPrefix(text, []byte(">")) || bytes.HasPrefix(text, []byte("->")) ||
			bytes.Contains(text, []byte("--")) || bytes.HasSuffix(text, []byte("-")) {
			return nil, false
		}
		ok = true
	}
}

// normaliseType strips parameters and folds case, so "Application/JSON;
// charset=utf-8" and "application/json" are the same allowlist entry.
func normaliseType(v string) string {
	if strings.TrimSpace(v) == "" {
		return ""
	}
	media, _, err := mime.ParseMediaType(v)
	if err != nil {
		// Keep what precedes the first ';' so a malformed type is judged, not accepted.
		media, _, _ = strings.Cut(v, ";")
	}
	return strings.ToLower(strings.TrimSpace(media))
}

// limitedReader is the one place bytes are counted: it hands out at most
// remaining bytes, then fails with over. It bounds memory; readBody's final
// length check makes the limit exact.
type limitedReader struct {
	r         io.Reader
	remaining int64
	over      error
}

func (l *limitedReader) Read(p []byte) (int, error) {
	if l.remaining <= 0 {
		return 0, l.over
	}
	if int64(len(p)) > l.remaining {
		p = p[:l.remaining]
	}
	n, err := l.r.Read(p)
	l.remaining -= int64(n)
	return n, err
}
