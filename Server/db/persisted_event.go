package db

import "time"

// PersistedEvent is a single broadcast event written to the events table for
// cold-replay during reconnection. The event payload is the same wire-format
// JSON the WebSocket clients receive at broadcast time, including the seq
// field injected by the hub.
//
// Phase B Step 7 (event persistence layer).
type PersistedEvent struct {
	Seq       int64
	EventType string
	ChannelID int64
	Payload   []byte
	CreatedAt time.Time
}

// PluginRow represents a row in the plugins table (Phase C Step 9).
type PluginRow struct {
	ID           int64
	Name         string
	Version      string
	Enabled      bool
	ManifestJSON string
	InstalledAt  time.Time
}
