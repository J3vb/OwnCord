package main

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"testing"
	"time"
)

// A real double-bind must be recognized through the errno chain
// (net.OpError → os.SyscallError → Errno) — this is what keeps the bind
// retry alive on non-English Windows, where the old string-only match never
// fired against localized error text.
func TestIsAddrInUse_RealBindConflict(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer l.Close() //nolint:errcheck

	_, err = net.Listen("tcp", l.Addr().String())
	if err == nil {
		t.Fatal("second listen on the same address unexpectedly succeeded")
	}
	if !isAddrInUse(err) {
		t.Errorf("isAddrInUse(%v) = false, want true for a real bind conflict", err)
	}
}

func TestIsAddrInUse_Table(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"unrelated error", errors.New("connection refused"), false},
		{"unix string fallback", errors.New("listen tcp :8443: bind: address already in use"), true},
		{"windows string fallback", errors.New("listen tcp :8443: bind: Only one usage of each socket address (protocol/network address/port) is normally permitted."), true},
		{"out of range port", fmt.Errorf("listen tcp: address 99999: invalid port"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isAddrInUse(tc.err); got != tc.want {
				t.Errorf("isAddrInUse(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

func TestServeWithBindRetry(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	addrInUse := errors.New("listen tcp :1: bind: address already in use")

	prevEvery := bindRetryEvery
	bindRetryEvery = time.Millisecond
	t.Cleanup(func() { bindRetryEvery = prevEvery })

	t.Run("retries through a transient conflict", func(t *testing.T) {
		calls := 0
		err := serveWithBindRetry(log, "test", func() error {
			calls++
			if calls < 3 {
				return addrInUse
			}
			return http.ErrServerClosed
		})
		if !errors.Is(err, http.ErrServerClosed) {
			t.Errorf("err = %v, want ErrServerClosed after the conflict clears", err)
		}
		if calls != 3 {
			t.Errorf("serve calls = %d, want 3", calls)
		}
	})

	t.Run("gives up on a non-conflict error immediately", func(t *testing.T) {
		calls := 0
		otherErr := errors.New("listen tcp: address 99999: invalid port")
		err := serveWithBindRetry(log, "test", func() error {
			calls++
			return otherErr
		})
		if !errors.Is(err, otherErr) {
			t.Errorf("err = %v, want the serve error passed through", err)
		}
		if calls != 1 {
			t.Errorf("serve calls = %d, want 1 (no retry for non-conflict errors)", calls)
		}
	})

	t.Run("bounded attempts on a persistent conflict", func(t *testing.T) {
		calls := 0
		err := serveWithBindRetry(log, "test", func() error {
			calls++
			return addrInUse
		})
		if !errors.Is(err, addrInUse) {
			t.Errorf("err = %v, want the final conflict error", err)
		}
		if calls != 20 {
			t.Errorf("serve calls = %d, want exactly 20", calls)
		}
	})

	t.Run("clean shutdown passes through untouched", func(t *testing.T) {
		if err := serveWithBindRetry(log, "test", func() error { return http.ErrServerClosed }); !errors.Is(err, http.ErrServerClosed) {
			t.Errorf("err = %v, want ErrServerClosed", err)
		}
	})
}
