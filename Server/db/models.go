package db

import "time"

// User represents a row in the users table.
type User struct {
	ID           int64
	Username     string
	PasswordHash string `json:"-"`
	Avatar       *string
	RoleID       int64
	TOTPSecret   *string `json:"-"`
	Status       string
	CreatedAt    string
	LastSeen     *string
	Banned       bool
	BanReason    *string
	BanExpires   *string
	// IdentityPublicKey is the long-term E2EE identity public key (base64,
	// ECDSA P-256) used for TOFU pinning of voice E2EE announces. Nil = not
	// published (legacy client).
	IdentityPublicKey *string
	// DisplayName is the optional nickname shown instead of Username. Nil =
	// unset, and every renderer falls back to Username. Mentions still resolve
	// against Username alone — it is the unique key.
	DisplayName *string
	// RegistrationStatus is 'active', 'pending' (an approval-mode
	// application holding its username until an admin approves it — B4-1)
	// or 'denied' (anonymised and locked for good, since audit rows keep
	// the id).
	RegistrationStatus string
	// About is the optional profile bio shown in the profile popup. Nil = unset.
	About *string
	// CustomStatus is the optional free-text status line shown under the name.
	// Nil = unset. Set over the WebSocket presence path and cleared on logout.
	CustomStatus *string
}

// EffectiveDisplayName returns the name to render for the user: the display
// name when set and non-empty, the username otherwise. Every payload builder
// goes through this so the fallback cannot be spelled three different ways.
func (u *User) EffectiveDisplayName() string {
	if u == nil {
		return ""
	}
	if u.DisplayName != nil && *u.DisplayName != "" {
		return *u.DisplayName
	}
	return u.Username
}

// Session represents a row in the sessions table.
type Session struct {
	ID        int64
	UserID    int64
	TokenHash string `json:"-"`
	Device    string
	IP        string
	CreatedAt string
	LastUsed  string
	ExpiresAt string
	// Unseen is the new-login signal (B4-7): true from the login that created
	// the session until the account lists its sessions from another device.
	Unseen bool
}

// APIToken represents a row in the api_tokens table — a long-lived, revocable
// bearer token that authenticates as UserID with that user's role/permissions.
// Raw tokens are never stored; TokenHash is the SHA-256 hex, like Session.
type APIToken struct {
	ID        int64
	UserID    int64
	TokenHash string `json:"-"`
	Label     string
	CreatedAt string
	LastUsed  *string
	ExpiresAt *string // nil = never expires
	RevokedAt *string // nil = active
}

// APITokenListItem is one row of the admin/CLI token listing. It carries the
// owning user's name for display and deliberately omits the hash.
type APITokenListItem struct {
	ID        int64   `json:"id"`
	UserID    int64   `json:"user_id"`
	Username  string  `json:"username"`
	Label     string  `json:"label"`
	CreatedAt string  `json:"created_at"`
	LastUsed  *string `json:"last_used"`
	ExpiresAt *string `json:"expires_at"`
	RevokedAt *string `json:"revoked_at"`
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
	// NSFW marks the channel as possibly carrying sensitive content. It is
	// metadata only: the server stores, ships and audits it but imposes no
	// content behaviour of its own (see migration 025). Clients decide what
	// to do with it — the desktop client shows a per-session age gate.
	NSFW bool `json:"nsfw"`
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
	// MentionsEveryone is set when the message resolved an @everyone or @here
	// token and the author held MENTION_EVERYONE. Per-user mentions live in
	// message_mentions.
	MentionsEveryone bool
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
	MessageID        int64      `json:"message_id"`
	ChannelID        int64      `json:"channel_id"`
	ChannelName      string     `json:"channel_name"`
	User             UserPublic `json:"user"`
	Content          string     `json:"content"`
	Timestamp        string     `json:"timestamp"`
	Mentions         []int64    `json:"mentions"`
	MentionsEveryone bool       `json:"mentions_everyone"`
}

// UserPublic is the public-facing user shape for API responses.
type UserPublic struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar,omitempty"`
}

// MessageAPIResponse matches the API.md shape for GET /channels/{id}/messages.
type MessageAPIResponse struct {
	ID          int64            `json:"id"`
	ChannelID   int64            `json:"channel_id"`
	User        UserPublic       `json:"user"`
	Content     string           `json:"content"`
	ReplyTo     *int64           `json:"reply_to"`
	Attachments []AttachmentInfo `json:"attachments"`
	Reactions   []ReactionInfo   `json:"reactions"`
	Pinned      bool             `json:"pinned"`
	EditedAt    *string          `json:"edited_at"`
	Deleted     bool             `json:"deleted"`
	Timestamp   string           `json:"timestamp"`
	// Mentions is the resolved user ids the message mentions (never nil);
	// MentionsEveryone reports an authorized @everyone/@here.
	Mentions         []int64 `json:"mentions"`
	MentionsEveryone bool    `json:"mentions_everyone"`
}

// AttachmentInfo is the attachment shape in API responses.
type AttachmentInfo struct {
	ID       string `json:"id"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	Mime     string `json:"mime"`
	URL      string `json:"url"`
	Width    *int   `json:"width,omitempty"`
	Height   *int   `json:"height,omitempty"`
}

// ReactionInfo is the reaction shape in API responses.
type ReactionInfo struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
	Me    bool   `json:"me"`
}

// ReactionUser is one reactor in the who-reacted list returned by
// GET /channels/{id}/messages/{messageId}/reactions/{emoji}/users. Avatar is a
// plain string ("" = none) rather than UserPublic's pointer: the tooltip that
// consumes this never distinguishes null from empty.
type ReactionUser struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar"`
}

// VoiceState represents a row in the voice_states table.
// It tracks which voice channel a user is in and their current audio state.
//
// ServerMuted/ServerDeafened are moderator-imposed and, unlike Muted/Deafened,
// the user cannot clear them: while set, their own voice_mute/voice_deafen
// unmute attempts are refused. They are scoped to the voice session — the row
// is deleted on leave — but survive a channel switch.
type VoiceState struct {
	UserID         int64  `json:"user_id"`
	ChannelID      int64  `json:"channel_id"`
	Username       string `json:"username"`
	Muted          bool   `json:"muted"`
	Deafened       bool   `json:"deafened"`
	Speaking       bool   `json:"speaking"`
	Camera         bool   `json:"camera"`
	Screenshare    bool   `json:"screenshare"`
	ServerMuted    bool   `json:"server_muted"`
	ServerDeafened bool   `json:"server_deafened"`
	JoinedAt       string `json:"-"`
}

// ChannelUnread holds per-user unread data for a single channel.
type ChannelUnread struct {
	LastMessageID int64 `json:"last_message_id"`
	UnreadCount   int   `json:"unread_count"`
	// MentionCount is read_states.mention_count: unread messages that mention
	// this user directly or via an authorized @everyone/@here. Zeroed by
	// channel_focus, never advanced by an edit.
	MentionCount int `json:"mention_count"`
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

// Emoji represents a row in the emoji table: one server-wide custom emoji.
//
// StoredAs is the storage-layer UUID the image bytes live under (the table's
// legacy column name is `filename`); it is never shown to a user and never
// derived from anything the uploader sent. Shortcode is always lowercase --
// the only spelling the validator admits -- which is what makes the table's
// plain UNIQUE index a case-insensitive one.
type Emoji struct {
	ID         int64  `json:"id"`
	Shortcode  string `json:"shortcode"`
	StoredAs   string `json:"-"`
	MimeType   string `json:"-"`
	UploadedBy int64  `json:"uploaded_by"`
	CreatedAt  string `json:"created_at"`
}

// sessionTTL is the duration a session remains valid after creation.
const sessionTTL = 30 * 24 * time.Hour

// sessionTimeLayout is the storage format for sessions.expires_at (and the
// other RFC3339-UTC expiry columns). DeleteExpiredSessions compares these as
// plain text against an index, so every writer and the sweep's cutoff must
// use exactly this layout.
const sessionTimeLayout = "2006-01-02T15:04:05Z"

// Registration statuses of a users row (B4-1).
const (
	RegistrationActive  = "active"
	RegistrationPending = "pending"
	RegistrationDenied  = "denied"
)

// PendingApproval reports an approval-mode application that no admin has
// decided yet.
func (u *User) PendingApproval() bool { return u.RegistrationStatus == RegistrationPending }
