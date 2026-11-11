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
	// IdentityPublicKey is the long-term E2EE identity key (base64 ECDSA P-256) for TOFU pinning; nil
	// = not published.
	IdentityPublicKey *string
	DisplayName       *string
	// RegistrationStatus is 'active', 'pending' (approval-mode application) or 'denied' (anonymised
	// and locked).
	RegistrationStatus    string
	About                 *string
	CustomStatus          *string
	CustomStatusExpiresAt *string
	// BannerID is the attachment id of the profile banner; the file is public while this names it.
	BannerID    *string
	BannerColor *string
}

// BannerPath is the URL the banner image is served from, nil when none.
func (u *User) BannerPath() *string {
	return BannerURL(u.BannerID)
}

// EffectiveDisplayName returns the display name when non-empty, else the username.
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
	// Unseen is true from the login that created the session until the account lists its sessions from
	// another device.
	Unseen bool
}

// APIToken is a long-lived, revocable bearer token authenticating as UserID; only
// TokenHash (SHA-256 hex) is stored.
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

// APITokenListItem is one row of the token listing; it omits the hash.
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
	ID              int64
	Code            string
	CreatedBy       int64
	CreatorUsername string
	Uses            int
	MaxUses         *int
	ExpiresAt       *string
	Revoked         bool
	CreatedAt       string
}

// Expired reports whether the invite's expiry has passed at now; an unparseable stamp
// counts as expired, as in the redemption query.
func (i *Invite) Expired(now time.Time) bool {
	if i.ExpiresAt == nil {
		return false
	}
	t, err := time.Parse(time.RFC3339, *i.ExpiresAt)
	if err != nil {
		return true
	}
	return !now.Before(t)
}

// Channel represents a row in the channels table.
type Channel struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Category string `json:"category"`
	// CategoryID / CategoryPosition come from the LEFT JOIN on channel_categories; CategoryID 0 means
	// uncategorized.
	CategoryID       int64   `json:"category_id"`
	CategoryPosition int     `json:"category_position"`
	Topic            string  `json:"topic"`
	Position         int     `json:"position"`
	SlowMode         int     `json:"slow_mode"`
	Archived         bool    `json:"archived"`
	CreatedAt        string  `json:"created_at"`
	VoiceMaxUsers    int     `json:"voice_max_users"`
	VoiceQuality     *string `json:"voice_quality,omitempty"`
	MixingThreshold  *int    `json:"mixing_threshold,omitempty"`
	VoiceMaxVideo    int     `json:"voice_max_video"`
	// NSFW is metadata only: the server stores and audits it but imposes no behaviour; clients decide.
	NSFW bool `json:"nsfw"`
	// AFK marks the one AFK voice channel (at most one row); members parked there can only listen.
	AFK    bool          `json:"afk"`
	Thread ChannelThread `json:"-"`
	Forum  *ChannelForum `json:"forum,omitempty"` // forum rows only (migration 075)
	ChannelPassword
}

// Message represents a row in the messages table.
type Message struct {
	ID               int64
	ChannelID        int64
	UserID           int64
	Content          string
	ReplyTo          *int64
	EditedAt         *string
	Deleted          bool
	Pinned           bool
	Timestamp        string
	MentionsEveryone bool
	// Kind is MessageKindUser for an ordinary message; other values are server-written rows (call log,
	// group event).
	Kind         int64
	ThreadJoined []int64 // users this send newly made thread followers; send transactions only
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
	MessageID        int64               `json:"message_id"`
	ChannelID        int64               `json:"channel_id"`
	ChannelName      string              `json:"channel_name"`
	User             UserPublic          `json:"user"`
	Content          string              `json:"content"`
	Timestamp        string              `json:"timestamp"`
	Mentions         []int64             `json:"mentions"`
	MentionsEveryone bool                `json:"mentions_everyone"`
	Sticker          *MessageStickerInfo `json:"sticker,omitempty"`
	ImportedBy
}

// SearchPage selects one page of full-text search results; the zero value is best match first, no cursor.
type SearchPage struct {
	Limit int
	// Recent orders newest first instead of by rank; relevance ranks only the newest 2,000 matches.
	Recent bool
	Before int64
}

// UserPublic is the public-facing user shape for API responses.
type UserPublic struct {
	ID       int64   `json:"id"`
	Username string  `json:"username"`
	Avatar   *string `json:"avatar,omitempty"`
}

// MessageAPIResponse matches the docs/api.md shape for GET /channels/{id}/messages.
type MessageAPIResponse struct {
	ID               int64            `json:"id"`
	ChannelID        int64            `json:"channel_id"`
	User             UserPublic       `json:"user"`
	Content          string           `json:"content"`
	ReplyTo          *int64           `json:"reply_to"`
	Attachments      []AttachmentInfo `json:"attachments"`
	Reactions        []ReactionInfo   `json:"reactions"`
	Pinned           bool             `json:"pinned"`
	EditedAt         *string          `json:"edited_at"`
	Deleted          bool             `json:"deleted"`
	Timestamp        string           `json:"timestamp"`
	Mentions         []int64          `json:"mentions"`
	MentionsEveryone bool             `json:"mentions_everyone"`
	// RoleMentions adds mention_roles; embedded so its json tag lives outside models.go, whose tag
	// count is pinned.
	RoleMentions
	// ReferencedMessage is the reply parent's snippet, computed at read time; null when not a reply or
	// the parent is gone or in another channel.
	ReferencedMessage *ReferencedMessage  `json:"referenced_message"`
	Kind              string              `json:"kind,omitempty"`
	Call              *CallInfo           `json:"call,omitempty"`
	GroupEvent        *GroupEventInfo     `json:"group_event,omitempty"`
	Forward           *ForwardInfo        `json:"forward,omitempty"`
	Poll              *PollInfo           `json:"poll,omitempty"`
	Thread            *ThreadInfo         `json:"thread,omitempty"`
	Sticker           *MessageStickerInfo `json:"sticker,omitempty"`
	ImportedBy
}

// GroupEventInfo is the group_event block of a group DM row: add/remove carry
// TargetUserID, rename Name ("" = removed), icon IconRemoved; leave carries none and
// encodes as {}.
type GroupEventInfo struct {
	TargetUserID int64   `json:"target_user_id,omitempty"`
	Name         *string `json:"name,omitempty"`
	IconRemoved  *bool   `json:"icon_removed,omitempty"`
}

// CallInfo is the call block of a call log row; EndedAt is nil while live.
type CallInfo struct {
	StartedAt    string  `json:"started_at"`
	EndedAt      *string `json:"ended_at"`
	Participants []int64 `json:"participants"`
}

// ReferencedMessage is a reply parent's snippet; a deleted parent is redacted to {id,
// deleted: true}.
type ReferencedMessage struct {
	ID             int64       `json:"id"`
	User           *UserPublic `json:"user"`
	Content        string      `json:"content"`
	Deleted        bool        `json:"deleted"`
	HasAttachments bool        `json:"has_attachments"`
	ImportedBy
	// IsSystem marks a server-written row (call log, group event, welcome row). Server-side only: a
	// reply to one is refused.
	IsSystem bool `json:"-"`
}

// ReactionInfo is the reaction shape in API responses.
type ReactionInfo struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
	Me    bool   `json:"me"`
}

// ReactionUser is one reactor; Avatar is a plain string ("" = none).
type ReactionUser struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar"`
}

// VoiceState is a row of voice_states. ServerMuted/ServerDeafened are
// moderator-imposed, last for the voice session and survive a channel switch; the user
// cannot clear them.
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
	// ServerMutedBy is the moderation_actions id when ServerMuted came from a
	// timeout; nil for a manual mute. Never marshaled; only
	// GetVoiceState/GetUserVoiceState populate it (for RestoreModFlags).
	ServerMutedBy *int64
}

// ChannelUnread holds per-user unread data for a single channel.
type ChannelUnread struct {
	LastMessageID int64 `json:"last_message_id"`
	UnreadCount   int   `json:"unread_count"`
	// MentionCount is read_states.mention_count, zeroed by channel_focus and never advanced by an edit.
	MentionCount      int   `json:"mention_count"`
	LastReadMessageID int64 `json:"last_read_message_id"`
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

// UserWithRole extends User with the user's role name and hierarchy position.
type UserWithRole struct {
	User
	RoleName     string `json:"role_name"`
	RolePosition int    `json:"role_position"`
	RoleIDs      []int64
}

// Emoji is one server-wide custom emoji. StoredAs is the storage-layer UUID (legacy
// column `filename`), never derived from the uploader's input. Shortcode is lowercase,
// making the UNIQUE index case-insensitive.
type Emoji struct {
	ID         int64  `json:"id"`
	Shortcode  string `json:"shortcode"`
	StoredAs   string `json:"-"`
	MimeType   string `json:"-"`
	UploadedBy int64  `json:"uploaded_by"`
	CreatedAt  string `json:"created_at"`
}

// sessionTTL is the idle window, slid by TouchSessions and capped at created_at + 365 days in that query.
const sessionTTL = 30 * 24 * time.Hour

const (
	RegistrationActive  = "active"
	RegistrationPending = "pending"
	RegistrationDenied  = "denied"
	RegistrationSystem  = "system"
)

// PendingApproval reports an approval-mode application no admin has decided.
func (u *User) PendingApproval() bool { return u.RegistrationStatus == RegistrationPending }

// IsSystemAccount reports the hidden import account.
func (u *User) IsSystemAccount() bool { return u.RegistrationStatus == RegistrationSystem }
