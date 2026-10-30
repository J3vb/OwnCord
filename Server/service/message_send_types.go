package service

import "github.com/J3vb/OwnCord/Server/db"

// SendMessageParams is the validated input for sending a message.
type SendMessageParams struct {
	ClientMessageID string // stable logical id, optional for older clients
	ChannelID       int64
	UserID          int64
	Username        string
	Avatar          *string
	RoleName        string
	Content         string // raw, will be sanitized
	ReplyTo         *int64
	// ReplyPing adds the replied-to author to the mention set; ignored without
	// ReplyTo and for a reply to your own message.
	ReplyPing     bool
	AttachmentIDs []string
	// ForwardOf is the id of the message a forward copies, 0 for an ordinary send. It
	// only binds a retry to its receipt: Content and AttachmentIDs stay empty at hash
	// time, so an original edited between tries never makes the retry a conflict.
	ForwardOf int64
	// Poll is the canonical JSON of a poll_create's raw input, "" otherwise. Like
	// ForwardOf it only binds a retry to its receipt: Content stays empty at hash
	// time, so the same poll twice is one retry and another poll under the same id is
	// a conflict.
	Poll string
	// ForumPost is the canonical JSON of a forum_post_create's title and tag ids, ""
	// otherwise. ChannelID is the forum; Content and AttachmentIDs are the raw text and
	// uploads, so the receipt hash covers all of them.
	ForumPost string
	// StickerID is the sticker a sticker message carries, 0 otherwise. A sticker send
	// has no text or attachments and needs a ClientMessageID so the message and its
	// sticker row commit with the receipt.
	StickerID int64
}

// ReferencedMessage is the reply-parent snippet a chat_message frame carries,
// aliased so the ws transport depends on service, not db.
type ReferencedMessage = db.ReferencedMessage

// SendMessageResult is the output of a successful send.
type SendMessageResult struct {
	Duplicate bool // retry acknowledgment only, no repeated broadcasts or effects
	// SkippedAttachmentIDs are requested uploads the send did not attach, in request
	// order, de-duplicated; nil when none. A duplicate ack derives it from the
	// message's attachment rows (replaySkipped).
	SkippedAttachmentIDs []string
	MessageID            int64
	Timestamp            string
	Content              string // sanitized content
	IsDM                 bool
	Channel              *db.Channel

	ParticipantIDs []int64
	SenderUser     *db.User // for dm_channel_open events
	OpenedDMFor    []int64  // participant IDs that had their DM opened
	// DMParticipants is the DM's full participant list, viewer-neutral: read with
	// viewerID 0 (matches nobody), so every status is broadcast-collapsed (invisible
	// reads offline). That makes it safe to reuse for every addressee: the ws layer
	// builds a per-recipient dm_channel_open payload from it without re-deriving
	// visibility. Nil when the read failed; the caller falls back to the sender-only
	// 1:1 shape.
	DMParticipants []db.DMUser
	// DMIsGroup mirrors channels.is_group; carried because a group people left can
	// have two members and must still render as a group.
	DMIsGroup bool
	// DMOwnerID is the group's owner, read only for a group DM this send (re)opened,
	// as only dm_channel_open needs it. 0 otherwise.
	DMOwnerID int64
	// DMIconID is the group's icon attachment id, read with DMOwnerID; "" for none.
	DMIconID string

	Attachments []db.AttachmentInfo

	// ReferencedMessage is the reply parent's snippet; nil when not a reply or the
	// parent is unavailable.
	ReferencedMessage *ReferencedMessage

	// Mentions is the resolved mentioned user ids (never nil) and MentionsEveryone an
	// authorized @everyone/@here, broadcast so clients highlight from server-resolved
	// data.
	Mentions []int64
	// MentionRoles lists roles whose <@&id> token cleared the role-mention gate (never
	// nil); RoleUserIDs is every holder. The holders ride only on the server-side
	// fan-out (channel_activity, badges, push), never the wire.
	MentionRoles     []int64
	RoleUserIDs      []int64
	MentionsEveryone bool
	// ThreadJoined lists users this send newly made followers of its thread (the
	// author and each direct mention not already one); the ws layer tells each with a
	// thread_follow_update. Nil outside a thread and on a retry ack.
	ThreadJoined []int64
	// MentionsHere reports that MentionsEveryone came from @here, not @everyone
	// (mentionSet.HereOnly; never both). mentionEntries skips the badge bump for an
	// @here reader with no live connection at send time, so clients need this bit to
	// tell that case from a plain @everyone.
	MentionsHere bool

	// RequestCreatedFor lists the message_requests rows freshly created by this send
	// (the first-contact gate, message_request.go): one per untrusted 1:1 recipient
	// with no existing request. The ws layer sends one dm_request frame per entry,
	// each carrying RequestPreview. Empty for a group DM, a trusted recipient, or a
	// resend while a request exists.
	RequestCreatedFor []*db.MessageRequest
	// RequestPreview names this send's own message (a request is created only by the
	// pair's first-ever message). It is read fresh from the DB just before use
	// (canonicalRequestPreview), not copied from Content/Timestamp, so it agrees with
	// the REST inbox's deleted = 0 preview even if a delete races the frame; nil if
	// the message is already gone.
	RequestPreview *DMRequestPreview

	// Forward is the forward block of the broadcast, set only by ForwardMessage.
	Forward *db.ForwardInfo

	// Poll is the poll block of the broadcast, set only by CreatePoll; nil on a retry
	// ack or when it could not be read back after commit (the fallback text shows
	// until the next history read).
	Poll *db.PollInfo

	// Sticker is the sticker block of the broadcast, set only for a sticker message.
	Sticker *db.MessageStickerInfo
}
