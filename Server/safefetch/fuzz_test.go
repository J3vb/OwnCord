package safefetch

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net/http"
	"net/netip"
	"testing"
	"time"
)

const (
	fuzzWireCap     = 4 << 10
	fuzzInflatedCap = 16 << 10
)

func fuzzFetcher(t *testing.T, truncate bool) *Fetcher {
	t.Helper()
	f, err := New(Policy{
		Schemes:              []string{"https"},
		Ports:                []int{443},
		ContentTypes:         []string{"text/plain"},
		Deadline:             time.Second,
		MaxBytes:             fuzzWireCap,
		MaxDecompressedBytes: fuzzInflatedCap,
		MaxConcurrent:        1,
		Truncate:             truncate,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return f
}

// inflateAll is the reference: what a gzip body holds when nothing caps it
// (beyond a bound far above both ceilings, so a bomb seed stays cheap).
func inflateAll(b []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return nil, err
	}
	defer func() { _ = zr.Close() }()
	return io.ReadAll(io.LimitReader(zr, 4*fuzzInflatedCap))
}

// FuzzReadBody reads arbitrary bodies, plain and gzip, under small ceilings.
// The result never exceeds the ceiling that applies. Without truncation a
// plain body comes back byte for byte exactly when it fits and is refused
// with ErrBodyTooLarge when it does not; a gzip body that comes back is its
// whole inflated content.
func FuzzReadBody(f *testing.F) {
	var bomb bytes.Buffer
	zw := gzip.NewWriter(&bomb)
	_, _ = zw.Write(make([]byte, 1<<20))
	_ = zw.Close()
	f.Add([]byte("hello"), false, false, false)
	f.Add([]byte("hello"), true, true, false)
	f.Add(bytes.Repeat([]byte("a"), fuzzWireCap), false, false, false)
	f.Add(bytes.Repeat([]byte("a"), fuzzWireCap+1), false, false, true)
	f.Add(bytes.Repeat([]byte("ab"), fuzzInflatedCap), true, true, false)
	f.Add(bomb.Bytes(), true, false, false)
	f.Add(bomb.Bytes(), true, false, true)
	f.Add([]byte("\x1f\x8b\x08\x00garbage"), true, false, false)
	f.Fuzz(func(t *testing.T, body []byte, gzipped, wrap, truncate bool) {
		wire := body
		if gzipped && wrap {
			var buf bytes.Buffer
			w := gzip.NewWriter(&buf)
			_, _ = w.Write(body)
			_ = w.Close()
			wire = buf.Bytes()
		}
		resp := &http.Response{Body: io.NopCloser(bytes.NewReader(wire))}
		got, err := fuzzFetcher(t, truncate).readBody(context.Background(), resp, gzipped)

		limit := int64(fuzzWireCap)
		if gzipped {
			limit = fuzzInflatedCap
		}
		if int64(len(got)) > limit {
			t.Fatalf("readBody returned %d bytes, over the %d-byte ceiling", len(got), limit)
		}
		switch {
		case !gzipped && !truncate:
			fits := len(wire) <= fuzzWireCap
			if fits && (err != nil || !bytes.Equal(got, wire)) {
				t.Fatalf("a %d-byte plain body under the ceiling came back as %d bytes, err %v", len(wire), len(got), err)
			}
			if !fits && !errors.Is(err, ErrBodyTooLarge) {
				t.Fatalf("a %d-byte plain body over the ceiling gave err %v, want ErrBodyTooLarge", len(wire), err)
			}
		case !gzipped && truncate:
			n := min(len(wire), fuzzWireCap)
			if err != nil || !bytes.Equal(got, wire[:n]) {
				t.Fatalf("a truncated plain body came back as %d bytes (want %d), err %v", len(got), n, err)
			}
		case gzipped && !truncate && err == nil:
			want, refErr := inflateAll(wire)
			if refErr != nil || !bytes.Equal(got, want) {
				t.Fatalf("readBody accepted a gzip body the reference reads as %d bytes (err %v), but returned %d", len(want), refErr, len(got))
			}
		}
	})
}

// fuzzAddr16 turns arbitrary bytes into a 16-byte IPv6 address.
func fuzzAddr16(b []byte) netip.Addr {
	var a [16]byte
	copy(a[:], b)
	return netip.AddrFrom16(a)
}

func allowed(a netip.Addr) bool { return ClassifyAddr(a) == nil }

// FuzzClassifyAddr checks that one address gets one answer however it is
// spelled: an IPv4 address, its IPv4-mapped IPv6 form, the IPv4 address
// embedded in the NAT64 well-known prefix, and the text form parsed back.
// The IPv4-compatible form and any zoned address are always refused, and
// every refusal is ErrBlockedAddress.
func FuzzClassifyAddr(f *testing.F) {
	for _, s := range []string{
		"8.8.8.8", "127.0.0.1", "10.1.2.3", "169.254.169.254", "0.0.0.0", "255.255.255.255",
		"::1", "::", "2606:4700::1111", "fe80::1", "fc00::1", "64:ff9b::a9fe:a9fe", "64:ff9b::808:808",
		"::ffff:127.0.0.1", "::ffff:8.8.8.8", "::127.0.0.1", "2001:db8::1", "2002:c000:0204::1", "ff02::1",
	} {
		a := netip.MustParseAddr(s).As16()
		f.Add(a[:], "")
	}
	f.Add([]byte{0x26, 0x06, 0x47}, "eth0")
	f.Fuzz(func(t *testing.T, raw []byte, zone string) {
		a := fuzzAddr16(raw)
		if err := ClassifyAddr(a); err != nil && !errors.Is(err, ErrBlockedAddress) {
			t.Fatalf("ClassifyAddr(%s) = %v, want nil or ErrBlockedAddress", a, err)
		}
		if p, err := netip.ParseAddr(a.String()); err != nil || allowed(p) != allowed(a) {
			t.Fatalf("%s and its parsed text form get different answers (parse err %v)", a, err)
		}
		if zone != "" && allowed(a.WithZone(zone)) && !a.Is4In6() {
			t.Fatalf("zoned address %s was allowed", a.WithZone(zone))
		}

		b16 := a.As16()
		v4 := netip.AddrFrom4([4]byte(b16[12:16]))
		mapped := netip.AddrFrom16([16]byte{10: 0xff, 11: 0xff, 12: b16[12], 13: b16[13], 14: b16[14], 15: b16[15]})
		nat64 := netip.AddrFrom16([16]byte{0: 0x00, 1: 0x64, 2: 0xff, 3: 0x9b, 12: b16[12], 13: b16[13], 14: b16[14], 15: b16[15]})
		compat := netip.AddrFrom16([16]byte{12: b16[12], 13: b16[13], 14: b16[14], 15: b16[15]})
		want := allowed(v4)
		if allowed(mapped) != want {
			t.Fatalf("%s is allowed=%v but its mapped form %s is allowed=%v", v4, want, mapped, !want)
		}
		if allowed(nat64) != want {
			t.Fatalf("%s is allowed=%v but its NAT64 form %s is allowed=%v", v4, want, nat64, !want)
		}
		if allowed(compat) {
			t.Fatalf("IPv4-compatible address %s was allowed", compat)
		}
	})
}
