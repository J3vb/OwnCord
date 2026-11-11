package ws

import (
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// filterChannels is chs without the rows these features do not allow; returns chs itself when nothing is
// dropped, so the common path allocates nothing.
func (f clientFeatures) filterChannels(chs []db.Channel) []db.Channel {
	if f.forums {
		return chs
	}
	for i := range chs {
		if !f.allowsType(chs[i].Type) {
			out := make([]db.Channel, 0, len(chs)-1)
			for j := range chs {
				if f.allowsType(chs[j].Type) {
					out = append(out, chs[j])
				}
			}
			return out
		}
	}
	return chs
}

// readyChannelPayloads builds the ready's channel objects, one per visible channel with
// per-user unread fields folded in. ackMap carries the caller's acknowledgement per
// NSFW-labelled channel (readyNSFWAcknowledgements); a missing entry reads as false.
// timedOut is the caller's timeout verdict, fed into every channel's affordances.
func readyChannelPayloads(visibleChannels []db.Channel, grants permissions.MemberGrants, unreadMap map[int64]db.ChannelUnread, ackMap map[int64]bool, timedOut bool, privacy service.ChannelPrivacySnapshot) []map[string]any {
	channelPayloads := make([]map[string]any, 0, len(visibleChannels))
	for i := range visibleChannels {
		entry := map[string]any{
			"id":       visibleChannels[i].ID,
			"name":     visibleChannels[i].Name,
			"type":     visibleChannels[i].Type,
			"category": visibleChannels[i].Category,
			// 0/0 when uncategorized. Derived from the channel's own row, so a non-manager learns only
			// categories of channels they see.
			"category_id":       visibleChannels[i].CategoryID,
			"category_position": visibleChannels[i].CategoryPosition,
			"topic":             visibleChannels[i].Topic,
			"position":          visibleChannels[i].Position,
			// Cooldown in seconds (0 = off): lets the composer disable itself instead of sending into
			// SLOW_MODE. The server still enforces.
			"slow_mode": visibleChannels[i].SlowMode,
			// Age-gate flag; the server enforces it (permissions.CanReadContent). nsfw_acknowledged below is
			// the caller's consent.
			"nsfw": visibleChannels[i].NSFW,
			// The server's one AFK voice channel: listen-only, and the idle sweep's destination.
			"afk": visibleChannels[i].AFK,
			// Whether a voice channel has a password; the same for every viewer.
			"password_protected": visibleChannels[i].JoinLocked,
			"private":            privacy.PrivateOf(&visibleChannels[i]), // 3D-6, channel-level
			// Whether THIS caller acknowledged the label. Always present, like nsfw: false for an
			// unlabelled channel (two meanings for "absent" is what the other NSFW fields avoid).
			"nsfw_acknowledged": ackMap[visibleChannels[i].ID],
			// Voice capacity limits (0 = unlimited), as enforced by the join path (CHANNEL_FULL /
			// VIDEO_LIMIT).
			"voice_max_users": visibleChannels[i].VoiceMaxUsers,
			"voice_max_video": visibleChannels[i].VoiceMaxVideo,
		}
		// Per-viewer affordances (can_send, can_moderate_voice, can_delete_others, can_pin,
		// can_react): verdicts over one subject, asked only in affordancesFor. The server remains
		// the authority; these only pre-disable controls.
		readyAffordances(grants, &visibleChannels[i], timedOut).spreadInto(entry)
		if visibleChannels[i].Forum != nil {
			// The forum's settings and tags. can_send means "may create posts"; a forum has no unread state.
			entry["forum"] = visibleChannels[i].Forum
		}
		if carriesChatState(visibleChannels[i].Type) {
			if u, ok := unreadMap[visibleChannels[i].ID]; ok {
				entry["unread_count"] = u.UnreadCount
				entry["last_message_id"] = u.LastMessageID
				entry["mention_count"] = u.MentionCount
				entry["last_read_message_id"] = u.LastReadMessageID
			} else {
				entry["unread_count"] = 0
				entry["last_message_id"] = 0
				entry["mention_count"] = 0
				entry["last_read_message_id"] = 0
			}
		}
		channelPayloads = append(channelPayloads, entry)
	}
	return channelPayloads
}
