// Package ws provides the WebSocket hub for the OwnCord server.
// Full implementation follows in Phase 4 (Real-Time Chat Features).
package ws

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
)

// Hub manages active WebSocket client connections.
// It is the central message routing point for all connected clients.
type Hub struct {
	mu      sync.RWMutex
	clients map[*Client]struct{}
	log     *slog.Logger
}

// Client represents a single WebSocket connection.
// Full implementation in Phase 4.
type Client struct {
	UserID int64
}

// NewHub creates a new Hub with the given logger.
func NewHub(log *slog.Logger) *Hub {
	return &Hub{
		clients: make(map[*Client]struct{}),
		log:     log,
	}
}

// Run starts the hub's message dispatch loop.
// It blocks until ctx is cancelled.
func (h *Hub) Run(ctx context.Context) {
	<-ctx.Done()
	h.log.Info("WebSocket hub shutting down")
}

// ServeWS handles an incoming WebSocket upgrade request.
// Full implementation in Phase 4.
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	http.Error(w, "WebSocket not yet implemented", http.StatusNotImplemented)
}
