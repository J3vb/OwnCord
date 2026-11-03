package auth

import (
	"bytes"
	"crypto/rand"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestRecoveryCodeSymbols_EveryByteValueMapsEvenly(t *testing.T) {
	all := make([]byte, 256)
	for i := range all {
		all[i] = byte(i)
	}
	got, err := recoveryCodeSymbols(bytes.NewReader(all), recoveryCodeSampleLimit)
	if err != nil {
		t.Fatalf("recoveryCodeSymbols: %v", err)
	}
	counts := map[byte]int{}
	for _, c := range got {
		counts[c]++
	}
	want := recoveryCodeSampleLimit / len(recoveryCodeAlphabet)
	if len(counts) != len(recoveryCodeAlphabet) {
		t.Fatalf("got %d distinct symbols, want %d", len(counts), len(recoveryCodeAlphabet))
	}
	for i := range len(recoveryCodeAlphabet) {
		c := recoveryCodeAlphabet[i]
		if counts[c] != want {
			t.Errorf("symbol %q appeared %d times over one pass of every byte value, want %d", c, counts[c], want)
		}
	}
}

func TestRecoveryCodeSymbols_SkipsBytesAboveLimit(t *testing.T) {
	src := []byte{255, 254, 248, 0, 253, 30, 249, 31, 7}
	got, err := recoveryCodeSymbols(bytes.NewReader(src), 3)
	if err != nil {
		t.Fatalf("recoveryCodeSymbols: %v", err)
	}
	want := string([]byte{recoveryCodeAlphabet[0], recoveryCodeAlphabet[30], recoveryCodeAlphabet[0]})
	if string(got) != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestRecoveryCodeSymbols_ShortSourceIsAnError(t *testing.T) {
	_, err := recoveryCodeSymbols(bytes.NewReader([]byte{255, 255, 255}), 3)
	if !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		t.Fatalf("err = %v, want an EOF error", err)
	}
}

func TestRecoveryCodeSymbols_DistributionIsFlat(t *testing.T) {
	const samples = 100_000
	got, err := recoveryCodeSymbols(rand.Reader, samples)
	if err != nil {
		t.Fatalf("recoveryCodeSymbols: %v", err)
	}
	counts := map[byte]int{}
	for _, c := range got {
		if !strings.ContainsRune(recoveryCodeAlphabet, rune(c)) {
			t.Fatalf("symbol %q is outside the alphabet", c)
		}
		counts[c]++
	}
	expected := float64(samples) / float64(len(recoveryCodeAlphabet))
	chi2 := 0.0
	for i := range len(recoveryCodeAlphabet) {
		d := float64(counts[recoveryCodeAlphabet[i]]) - expected
		chi2 += d * d / expected
	}
	// 30 degrees of freedom: the 99.99th percentile is about 66. A loose bound
	// keeps the test from flaking while still catching a skew like the one
	// plain modulo gives (about 9/8 weight on eight symbols, chi-square near 300).
	if chi2 > 80 {
		t.Fatalf("chi-square %.1f over %d samples, symbol counts %v", chi2, samples, counts)
	}
}
