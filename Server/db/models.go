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
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	Color       *string `json:"color"`
	Permissions int64   `json:"permissions"`
	Position    int     `json:"position"`
	IsDefault   bool    `json:"is_default"`
}

// Channel represents a row in the channels table.
type Channel struct {
	ID              int64   `json:"id"`
	Name            string  `json:"name"`
	Type            string  `json:"type"`
	Category        string  `json:"category"`
	Topic           string  `json:"topic"`
	Position        int     `json:"position"`
	SlowMode        int     `json:"slow_mode"`
	Archived        bool    `json:"archived"`
	CreatedAt       string  `json:"created_at"`
	VoiceMaxUsers   int     `json:"voice_max_users"`
	VoiceQuality    *string `json:"voice_quality,omitempty"`
	MixingThreshold *int    `json:"mixing_threshold,omitempty"`
	VoiceMaxVideo   int     `json:"voice_max_video"`
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
	MessageID   int64          `json:"message_id"`
	ChannelID   int64          `json:"channel_id"`
	ChannelName string         `json:"channel_name"`
	User        UserPublic     `json:"user"`
	Content     string         `json:"content"`
	Timestamp   string         `json:"timestamp"`
}

// UserPublic is the public-facing user shape for API responses.
type UserPublic struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar,omitempty"`
}

// MessageAPIResponse matches the API.md shape for GET /channels/{id}/messages.
type MessageAPIResponse struct {
	ID          int64           `json:"id"`
	ChannelID   int64           `json:"channel_id"`
	User        UserPublic      `json:"user"`
	Content     string          `json:"content"`
	ReplyTo     *int64          `json:"reply_to"`
	Attachments []AttachmentInfo `json:"attachments"`
	Reactions   []ReactionInfo  `json:"reactions"`
	Pinned      bool            `json:"pinned"`
	EditedAt    *string         `json:"edited_at"`
	Deleted     bool            `json:"deleted"`
	Timestamp   string          `json:"timestamp"`
}

// AttachmentInfo is the attachment shape in API responses.
type AttachmentInfo struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	Mime     string `json:"mime"`
	URL      string `json:"url"`
}

// ReactionInfo is the reaction shape in API responses.
type ReactionInfo struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
	Me    bool   `json:"me"`
}

// VoiceState represents a row in the voice_states table.
// It tracks which voice channel a user is in and their current audio state.
type VoiceState struct {
	UserID      int64  `json:"user_id"`
	ChannelID   int64  `json:"channel_id"`
	Username    string `json:"username"`
	Muted       bool   `json:"muted"`
	Deafened    bool   `json:"deafened"`
	Speaking    bool   `json:"speaking"`
	Camera      bool   `json:"camera"`
	Screenshare bool   `json:"screenshare"`
}

// ChannelUnread holds per-user unread data for a single channel.
type ChannelUnread struct {
	LastMessageID int64 `json:"last_message_id"`
	UnreadCount   int   `json:"unread_count"`
}

// ServerStats contains aggregate counts for the admin dashboard.
type ServerStats struct {
	UserCount    int64 `json:"user_count"`
	MessageCount int64 `json:"message_count"`
	ChannelCount int64 `json:"channel_count"`
	InviteCount  int64 `json:"invite_count"`
	DBSizeBytes  int64 `json:"db_size_bytes"`
	OnlineCount  int   `json:"online_count"`
}

// UserWithRole extends User with the name of the user's role.
type UserWithRole struct {
	User
	RoleName string `json:"role_name"`
}

// AuditEntry represents a single row from the audit_log table joined with the
// actor's username.
type AuditEntry struct {
	ID         int64  `json:"id"`
	ActorID    int64  `json:"actor_id"`
	ActorName  string `json:"actor_name"`
	Action     string `json:"action"`
	TargetType string `json:"target_type"`
	TargetID   int64  `json:"target_id"`
	Detail     string `json:"detail"`
	CreatedAt  string `json:"created_at"`
}

// sessionTTL is the duration a session remains valid after creation.
const sessionTTL = 30 * 24 * time.Hour
