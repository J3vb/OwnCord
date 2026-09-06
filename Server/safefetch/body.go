package safefetch

import (
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
// Response. The body is read under both ceilings before anything else looks
// at it, and the media type is judged on the bytes that actually arrived.
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
	// The header has to describe the body being returned, not the one that
	// arrived: Body is inflated and inside both ceilings, so an upstream
	// Content-Encoding and Content-Length would both be lies about it.
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

// readBody reads the response under two independent ceilings: one on the
// bytes read from the response body before any decompression, one on the
// bytes after inflation. Both are enforced while reading, so an oversized
// body is refused once MaxBytes have been consumed rather than after all of
// it has been buffered — a Content-Length header is a claim about the body,
// not a limit on it.
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
	body, err := io.ReadAll(src)
	if err != nil {
		return nil, f.readError(ctx, err)
	}
	// limitedReader reports its breach on the read *after* the allowance runs
	// out, and a source that returns its last bytes together with io.EOF —
	// which net/http bodies do — never gives it that read. Without this check
	// a body of exactly ceiling+1 came back accepted while ceiling+2 was
	// refused, so whether the ceiling held depended on wire framing.
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("%w: %d bytes past a %d-byte ceiling", over, len(body), limit)
	}
	return body, nil
}

// encoding reports whether the body is gzip, and refuses anything else.
//
// The request asks for gzip and nothing more, so identity, gzip and an absent
// header are the only honest answers. Anything else — br, deflate, a stacked
// "gzip, gzip", or a second header line Header.Get would not show — is
// refused rather than returned as opaque bytes: we would be handing back
// content in an encoding the caller never agreed to, and a stacked encoding
// is a decompression bomb with an extra layer.
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

// readError keeps the two ceiling breaches and the context's own failure
// distinguishable from an upstream transport error.
func (f *Fetcher) readError(ctx context.Context, err error) error {
	if errors.Is(err, ErrBodyTooLarge) || errors.Is(err, ErrDecompressedTooLarge) {
		return err
	}
	return wrapContext(ctx, fmt.Errorf("safefetch: read body: %w", err))
}

// checkContentType judges the media type twice: as the response declares it,
// and as the bytes actually read sniff. A body that declares one type and
// sniffs as another is refused — that mismatch is how a caller expecting JSON
// is handed an HTML page or an image decoder is handed a script.
//
// An empty body has nothing to sniff, so only the declared type is checked.
// A response with an empty body AND no declared Content-Type passes: there
// is no content to have a type, which is a normal shape for a 201/204
// acknowledgement (RFC 8030's push-service response, among others) — this
// does not relax anything for a body that actually arrived with bytes.
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
	return media, sniffed, nil
}

// normaliseType strips parameters and folds case, so "Application/JSON;
// charset=utf-8" and "application/json" are the same allowlist entry.
func normaliseType(v string) string {
	if strings.TrimSpace(v) == "" {
		return ""
	}
	media, _, err := mime.ParseMediaType(v)
	if err != nil {
		// A malformed Content-Type is still a claim; keep whatever precedes
		// the first ';' so it can be judged rather than silently accepted.
		media, _, _ = strings.Cut(v, ";")
	}
	return strings.ToLower(strings.TrimSpace(media))
}

// limitedReader is the one place bytes are counted. It hands out at most
// remaining bytes and then fails with over, so the ceiling applies while the
// body streams rather than after it has been buffered.
//
// It is the streaming half of the ceiling: it stops an endless body after
// ceiling+1 bytes so nothing larger ever reaches memory. It is not the whole
// ceiling — a source that returns its last bytes together with io.EOF is never
// asked for the read that would report the breach — so readBody checks the
// final length as well. Both are needed: this one bounds memory, that one
// makes the limit exact.
//
// B5 decision 2's deferred aggregate byte budget is charged here.
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
