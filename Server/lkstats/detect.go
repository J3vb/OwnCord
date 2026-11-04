package lkstats

import (
	"context"
	"log/slog"
	"net"
	"net/url"
	"runtime"

	"github.com/J3vb/OwnCord/Server/sysstats"
)

// derivedPort is LiveKit's conventional Prometheus port.
const derivedPort = "6789"

// Detect is what the server knows when it picks a source.
type Detect struct {
	// Voice is false when voice is off or has no LiveKit client.
	Voice bool
	// Managed is true when OwnCord runs LiveKit itself. It is set when the
	// hub is built, before the process starts, so it is final here.
	Managed bool
	// MetricsURL is voice.livekit_metrics_url, already checked; empty if unset
	// or invalid.
	MetricsURL string
	// LiveKitURL is voice.livekit_url.
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

// DeriveURL guesses LiveKit's stats page from its signalling address: the same
// host on port 6789, ws as http and wss as https.
func DeriveURL(liveKitURL string) (string, bool) {
	u, err := url.Parse(liveKitURL)
	if err != nil || u.Hostname() == "" {
		return "", false
	}
	var scheme string
	switch u.Scheme {
	case "ws", "http":
		scheme = "http"
	case "wss", "https":
		scheme = "https"
	default:
		return "", false
	}
	guess := url.URL{Scheme: scheme, Host: net.JoinHostPort(u.Hostname(), derivedPort), Path: "/metrics"}
	return guess.String(), true
}
