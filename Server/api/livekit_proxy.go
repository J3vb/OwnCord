package api

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

// NewLiveKitProxy creates a reverse proxy handler that forwards requests
// to the LiveKit server. This allows the client to reach LiveKit through
// OwnCord's existing HTTPS server, avoiding mixed-content blocks in
// WebView2 (secure page → insecure WebSocket).
//
// The client connects to wss://server:8443/livekit/ which is proxied to
// ws://localhost:7880/ on the LiveKit server.
func NewLiveKitProxy(livekitURL string) http.Handler {
	target, err := url.Parse(livekitURL)
	if err != nil {
		// Fall back to default if URL is invalid
		target, _ = url.Parse("http://localhost:7880")
	}

	// Convert ws:// to http:// for the proxy target
	switch target.Scheme {
	case "ws":
		target.Scheme = "http"
	case "wss":
		target.Scheme = "https"
	}

	proxy := &httputil.ReverseProxy{
		Director: func(req *http.Request) {
			req.URL.Scheme = target.Scheme
			req.URL.Host = target.Host
			req.Host = target.Host
		},
	}

	return proxy
}
