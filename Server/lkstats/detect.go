package lkstats

import (
	"context"
	"log/slog"
	"net"
	"net/url"
	"runtime"

	"github.com/J3vb/OwnCord/Server/sysstats"
)

const derivedPort = "6789"

// Detect is what the server knows when it picks a source.
type Detect struct {
	// Voice is false when voice is off or has no LiveKit client.
	Voice bool
	// Managed is true when OwnCord runs LiveKit itself; final here, as it is set before the process starts.
	Managed bool
	// MetricsURL is voice.livekit_metrics_url, already checked; empty if unset or invalid.
	MetricsURL string
	LiveKitURL string
	PID        func() (int, bool)
	RoomUsage  func(ctx context.Context) (rooms, participants int, err error)
}

// Pick returns the sampler for the card, or nil when there is nothing to read.
// A managed LiveKit is read through its process. Otherwise the configured
// stats page is used, and without one the page next to voice.livekit_url.
func (d Detect) Pick(log *slog.Logger) *Sampler {
	switch {
	case !d.Voice:
		return nil
	case d.Managed:
		return NewManaged(ManagedDeps{PID: d.PID, RoomUsage: d.RoomUsage, Cores: runtime.NumCPU(), Read: sysstats.ReadProcess}, log)
	case d.MetricsURL != "":
		return New(d.MetricsURL, log)
	}
	if guess, ok := DeriveURL(d.LiveKitURL); ok {
		return New(guess, log)
	}
	return nil
}

// DeriveURL guesses the stats page: the signalling host on port 6789, always plain http (LiveKit
// serves it without TLS even when signalling uses wss).
func DeriveURL(liveKitURL string) (string, bool) {
	u, err := url.Parse(liveKitURL)
	if err != nil || u.Hostname() == "" {
		return "", false
	}
	switch u.Scheme {
	case "ws", "http", "wss", "https":
	default:
		return "", false
	}
	guess := url.URL{Scheme: "http", Host: net.JoinHostPort(u.Hostname(), derivedPort), Path: "/metrics"}
	return guess.String(), true
}
