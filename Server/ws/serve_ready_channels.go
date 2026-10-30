package ws

import (
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// filterChannels is chs without the rows these features do not allow. It
// returns chs itself when nothing is dropped, which is every server without a
// forum, so the common path allocates nothing.
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

// readyChannelPayloads builds the ready payload's channel objects — one entry
// per visible channel, with the per-user unread fields folded in. ackMap
// carries the caller's own acknowledgement per NSFW-labelled channel id
// (readyNSFWAcknowledgements); a missing entry (an unlabelled channel never
// gets one) reads as false, which is correct either way — nothing needs
// acknowledging there. timedOut is the caller's current timeout verdict,
// fed into every channel's affordances — see readyAffordances.
func readyChannelPayloads(visibleChannels []db.Channel, grants permissions.MemberGrants, unreadMap map[int64]db.ChannelUnread, ackMap map[int64]bool, timedOut bool, privacy service.ChannelPrivacySnapshot) []map[string]any {
	channelPayloads := make([]map[string]any, 0, len(visibleChannels))
	for i := range visibleChannels {
		entry := map[string]any{
			"id":       visibleChannels[i].ID,
			"name":     visibleChannels[i].Name,
			"type":     visibleChannels[i].Type,
			"category": visibleChannels[i].Category,
			// The category object behind the name: 0/0 when the
			// channel is uncategorized. Derived from the channel's own row, so
			// a non-manager learns only the categories of channels they see.
			"category_id":       visibleChannels[i].CategoryID,
			"category_position": visibleChannels[i].CategoryPosition,
			"topic":             visibleChannels[i].Topic,
			"position":          visibleChannels[i].Position,
			// Cooldown in seconds (0 = off). Lets the composer disable itself
			// for the window instead of accepting a send the server refuses
			// with SLOW_MODE. The server still enforces.
			"slow_mode": visibleChannels[i].SlowMode,
			// Age-gate flag. The server enforces content behaviour on a
			// flagged channel now (permissions.CanReadContent); see
			// nsfw_acknowledged below for the caller's own consent state.
			"nsfw": visibleChannels[i].NSFW,
			// The server's one AFK voice channel (migration 068):
			// listen-only, and what the idle sweep moves members into.
			"afk": visibleChannels[i].AFK,
			// Whether a voice channel has a password. The same for every
			// viewer; the join itself says whether this one must enter it.
			"password_protected": visibleChannels[i].JoinLocked,
			"private":            privacy.PrivateOf(&visibleChannels[i]), // 3D-6, channel-level
			// Whether THIS caller has acknowledged the label. Always
			// present, like nsfw itself — false for an unlabelled channel,
			// where it means nothing but must not be omitted (two different
			// meanings for "absent" is exactly what the other always-shipped NSFW
			// fields avoid).
			"nsfw_acknowledged": ackMap[visibleChannels[i].ID],
			// Voice capacity limits (0 = unlimited) — the same values the
			// voice-join path enforces with CHANNEL_FULL / VIDEO_LIMIT.
			"voice_max_users": visibleChannels[i].VoiceMaxUsers,
			"voice_max_video": visibleChannels[i].VoiceMaxVideo,
		}
		// Per-viewer affordances (can_send, can_moderate_voice,
		// can_delete_others, can_pin, can_react): the predicates' verdicts
		// over one subject, asked only in affordancesFor. The server remains
		// the authority; these only pre-disable controls.
		readyAffordances(grants, &visibleChannels[i], timedOut).spreadInto(entry)
		if visibleChannels[i].Forum != nil {
			// The forum's settings and tags. can_send above means "may create
			// posts"; a forum has no unread state (it holds no messages).
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
