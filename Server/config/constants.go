package config

const (
	// MaxMessageBytes is the maximum size of a single inbound message or
	// small HTTP response body that the server will read into memory (1 MiB).
	// Used by the WebSocket read-limit and the updater's capped response reader.
	MaxMessageBytes = 1 << 20
)
