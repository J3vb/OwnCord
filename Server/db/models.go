package db

import "time"

// User represents a row in the users table.
type User struct {
	ID           int64
	Username     string
	PasswordHash string
	Avatar       *string
	RoleID       int64
	TOTPSecret   *string
	Status       string
	CreatedAt    string
	LastSeen     *string
	Banned       bool
	BanReason    *string
	BanExpires   *string
}

// Session represents a row in the sessions table.
type Session struct {
	ID        int64
	UserID    int64
	TokenHash string
	Device    string
	IP        string
	CreatedAt string
	LastUsed  string
	ExpiresAt string
}

// Invite represents a row in the invites table.
type Invite struct {
	ID        int64
	Code      string
	CreatedBy int64
	Uses      int
	MaxUses   *int
	ExpiresAt *string
	Revoked   bool
	CreatedAt string
}

// Role represents a row in the roles table.
type Role struct {
	ID          int64
	Name        string
	Color       *string
	Permissions int64
	Position    int
	IsDefault   bool
}

// Channel represents a row in the channels table.
type Channel struct {
	ID        int64
	Name      string
	Type      string
	Category  string
	Topic     string
	Position  int
	SlowMode  int
	Archived  bool
	CreatedAt string
}

// Message represents a row in the messages table.
type Message struct {
	ID        int64
	ChannelID int64
	UserID    int64
	Content   string
	ReplyTo   *int64
	EditedAt  *string
	Deleted   bool
	Pinned    bool
	Timestamp string
}

// MessageWithUser joins a Message with the author's public fields.
type MessageWithUser struct {
	Message
	Username string
	Avatar   *string
}

// ReactionCount is an aggregated reaction count for a single emoji.
type ReactionCount struct {
	Emoji     string
	Count     int
	MeReacted bool
}

// MessageSearchResult is a row returned by the FTS5 message search.
type MessageSearchResult struct {
	MessageID   int64
	ChannelID   int64
	ChannelName string
	Username    string
	Content     string
	Timestamp   string
}

// sessionTTL is the duration a session remains valid after creation.
const sessionTTL = 30 * 24 * time.Hour
