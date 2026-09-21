package safefetch

import (
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// classifyVector is one entry of testdata/classify_vectors.json, the corpus
// this suite shares with the desktop broker's Rust classifier
// (Client/src-tauri/src/external_content.rs). Only Allowed is asserted: Note
// is for a human reading a failure, and the two implementations are free to
// word a refusal differently.
type classifyVector struct {
	Address string `json:"address"`
	Allowed bool   `json:"allowed"`
	Note    string `json:"note"`
}

func loadClassifyVectors(t *testing.T) []classifyVector {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "classify_vectors.json"))
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	var corpus struct {
		Vectors []classifyVector `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &corpus); err != nil {
		t.Fatalf("parse corpus: %v", err)
	}
	if len(corpus.Vectors) == 0 {
		t.Fatal("corpus has no vectors")
	}
	return corpus.Vectors
}

// Every address class the C-09 policy calls non-global must be refused, and
// every globally routable address allowed — including both sides of the
// NAT64 unwrap, the subtlest rule in the list. The cases live in the shared
// corpus so a range dropped from either implementation fails loudly.
func TestClassifyAddr_Corpus(t *testing.T) {
	for _, v := range loadClassifyVectors(t) {
		addr, err := netip.ParseAddr(v.Address)
		if err != nil {
			t.Fatalf("ParseAddr(%q): %v", v.Address, err)
		}
		err = ClassifyAddr(addr)
		if v.Allowed && err != nil {
			t.Errorf("ClassifyAddr(%s) refused a %s address: %v", v.Address, v.Note, err)
		}
		if !v.Allowed && err == nil {
			t.Errorf("ClassifyAddr(%s) allowed a %s address", v.Address, v.Note)
		}
	}
}

// A corpus only catches drift if someone adds to it. A range added to
// blockedPrefixes fails here until it has a vector, and that vector is what
// turns the Rust suite red if the broker's list lacks the range.
func TestClassifyVectors_CoverEveryBlockedPrefix(t *testing.T) {
	vectors := loadClassifyVectors(t)
	for _, b := range blockedPrefixes {
		covered := false
		for _, v := range vectors {
			if v.Allowed {
				continue
			}
			addr, err := netip.ParseAddr(v.Address)
			if err == nil && b.prefix.Contains(addr) {
				covered = true
				break
			}
		}
		if !covered {
			t.Errorf("blockedPrefixes entry %s (%s) has no allowed:false vector in testdata/classify_vectors.json", b.prefix, b.why)
		}
	}
	for _, v := range vectors {
		if !v.Allowed {
			continue
		}
		if nat64WellKnown.Contains(netip.MustParseAddr(v.Address)) {
			return
		}
	}
	t.Error("the corpus has no allowed NAT64 vector: the unwrap must be pinned from both sides")
}

// The zero Addr is what a failed parse yields; it must never be treated as
// routable, and it must not panic.
func TestClassifyAddr_RejectsZeroValue(t *testing.T) {
	if err := ClassifyAddr(netip.Addr{}); err == nil {
		t.Fatal("the zero netip.Addr must be refused")
	}
}

// A refusal names the address class so an operator reading a log can tell a
// blocked destination from a DNS failure.
func TestClassifyAddr_ErrorIsBlockedAddress(t *testing.T) {
	err := ClassifyAddr(netip.MustParseAddr("169.254.169.254"))
	if err == nil {
		t.Fatal("want a refusal")
	}
	if !strings.Contains(err.Error(), "169.254.169.254") {
		t.Errorf("refusal should name the address, got %q", err)
	}
}

// A zone only ever names a scoped, non-global interface, and Unmap does not
// clear it for a non-mapped address. Without this the check is deletable with
// the suite green, which is how it was found.
func TestClassifyAddr_RejectsZonedAddresses(t *testing.T) {
	for _, s := range []string{"2606:4700:4700::1111%eth0", "fe80::1%eth0", "::1%lo"} {
		addr, err := netip.ParseAddr(s)
		if err != nil {
			t.Fatalf("ParseAddr(%q): %v", s, err)
		}
		if err := ClassifyAddr(addr); err == nil {
			t.Errorf("ClassifyAddr(%s) allowed a zoned address", s)
		}
	}
}
