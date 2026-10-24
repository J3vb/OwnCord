package service

import "github.com/J3vb/OwnCord/Server/db"

// SendMessageParams contains validated input for sending a message.
type SendMessageParams struct {
	ClientMessageID string // stable logical id, optional for older clients
	ChannelID       int64
	UserID          int64
	Username        string
	Avatar          *string
	RoleName        string
	Content         string // raw, will be sanitized
	ReplyTo         *int64
	// ReplyPing adds the replied-to author to the mention set. It is ignored
	// without ReplyTo and for a reply to your own message.
	ReplyPing     bool
	AttachmentIDs []string
	// ForwardOf is the id of the message a forward copies (WP 6.9a), 0 for an
	// ordinary send. It only binds a retry to its receipt: Content and
	// AttachmentIDs stay empty at hash time, so an original edited between two
	// tries never turns the retry into a conflict.
	ForwardOf int64
	// Poll is the canonical JSON of the raw poll input of a poll_create (WP
	// 6.9b), "" for every other send. Like ForwardOf it only binds a retry to
	// its receipt: Content stays empty at hash time, so the same poll sent
	// twice is one retry and another poll under the same id is a conflict.
	Poll string
	// ForumPost is the canonical JSON of a forum_post_create's title and tag
	// ids (WP 6.9d), "" for every other send. ChannelID is the forum, and
	// Content and AttachmentIDs are the raw text and uploads, so the receipt
	// hash covers the forum, the title, the tags, the text and the uploads.
	ForumPost string
	// StickerID is the sticker a sticker message carries (WP 8.8a), 0 for an
	// ordinary send. A sticker send has no text and no attachments, and needs a
	// ClientMessageID so the message and its sticker row commit with the
	// receipt.
	StickerID int64
}

// ReferencedMessage is the reply-parent snippet a chat_message frame carries.
// It aliases the db shape so the ws transport depends on service, not db.
type ReferencedMessage = db.ReferencedMessage

// SendMessageResult contains the output of a successful message send.
type SendMessageResult struct {
	Duplicate bool // retry acknowledgment only, no repeated broadcasts or effects
	// SkippedAttachmentIDs are requested uploads the send did not attach, in
	// request order, de-duplicated; nil when none. A duplicate ack derives it
	// from the message's attachment rows (replaySkipped).
	SkippedAttachmentIDs []string
	MessageID            int64
	Timestamp            string
	Content              string // sanitized content
	IsDM                 bool
	Channel              *db.Channel

	// DM-specific fields populated when IsDM is true.
	ParticipantIDs []int64
	SenderUser     *db.User // for dm_channel_open events
	OpenedDMFor    []int64  // participant IDs that had their DM opened
	// DMParticipants is the full participant list of the DM, viewer-neutral:
	// it is read with viewerID 0, which matches nobody, so every status is
	// already broadcast-collapsed (an invisible participant reads as offline).
	// That is what makes it safe to reuse for every addressee — the ws layer
	// turns it into a per-recipient dm_channel_open payload without re-deriving
	// visibility. Nil when the participant read failed, in which case the
	// caller falls back to the sender-only 1:1 shape.
	DMParticipants []db.DMUser
	// DMIsGroup mirrors channels.is_group for this DM. Carried alongside the
	// participants because a group that people have left can have two members
	// and must still render as a group.
	DMIsGroup bool
	// DMOwnerID is the group's owner, read only for a group DM this send
	// (re)opened for someone, because only then is it needed for the
	// dm_channel_open payload. 0 otherwise.
	DMOwnerID int64
	// DMIconID is the group's icon attachment id, read with DMOwnerID. "" for
	// none.
	DMIconID string

	// Attachment data for broadcast.
	Attachments []db.AttachmentInfo

	// ReferencedMessage is the reply parent's snippet for the broadcast; nil
	// when the send is not a reply or the parent is unavailable.
	ReferencedMessage *ReferencedMessage

	// Mentions is the resolved mentioned user ids (never nil) and
	// MentionsEveryone an authorized @everyone/@here. Both are broadcast so
	// clients highlight from server-resolved data instead of re-guessing.
	Mentions []int64
	// MentionRoles lists the roles whose <@&id> token cleared the role-mention
	// gate (never nil); RoleUserIDs is every holder of those roles. The holders
	// ride only on the server-side fan-out (channel_activity, badges, push),
	// never on the wire.
	MentionRoles     []int64
	RoleUserIDs      []int64
	MentionsEveryone bool
	// ThreadJoined lists the users this send newly made followers of its thread
	// (WP 6.9c): the author and each direct mention who was not one already. The
	// ws layer tells each of them with a thread_follow_update. Nil outside a
	// thread and on a retry acknowledgment.
	ThreadJoined []int64
	// MentionsHere reports that MentionsEveryone came from @here rather than
	// @everyone (mentionSet.HereOnly — never both, @here only narrows when
	// @everyone is absent). mentionEntries skips the mention-count bump
	// for an @here reader with no live connection at send time; clients need
	// this bit to tell that case apart from a plain @everyone, which reaches
	// every reader regardless (OC-0271).
	MentionsHere bool

	// RequestCreatedFor lists the message_requests rows freshly created by
	// this send (B5-6 decision 4's first-contact gate,
	// service/message_request.go): one entry per untrusted one-to-one
	// recipient who had no existing request in any state. The ws layer sends
	// one dm_request frame per entry; RequestPreview is what every one of
	// those frames carries. Empty for a group DM, a trusted recipient, or a
	// resend while a request already exists (decision 5 — there is only ever
	// one row to create).
	RequestCreatedFor []*db.MessageRequest
	// RequestPreview names this send's own message — a request can only ever
	// be created by the pair's first-ever message, since a resend finds the
	// row already there and creates nothing. Read fresh from the DB right
	// before use (canonicalRequestPreview), not copied from this result's
	// own Content/Timestamp above, so it agrees with the REST inbox's
	// deleted = 0 preview even if a delete races the frame; nil if the
	// message was already gone by the time of that read.
	RequestPreview *DMRequestPreview

	// Forward is the forward block of the broadcast, set only by
	// ForwardMessage.
	Forward *db.ForwardInfo

	// Poll is the poll block of the broadcast, set only by CreatePoll. It is
	// nil on a retry acknowledgment, and when the block could not be read back
	// after the commit (the poll then shows as its fallback text until the next
	// history read).
	Poll *db.PollInfo

	// Sticker is the sticker block of the broadcast, set only for a sticker
	// message.
	Sticker *db.MessageStickerInfo
}
