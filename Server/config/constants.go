package config

const (
	// MaxMessageBytes caps one inbound message or small HTTP response body read
	// into memory (1 MiB); used by the WebSocket read limit and the updater's
	// capped response reader.
	MaxMessageBytes = 1 << 20
)
