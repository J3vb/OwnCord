package ws

import "github.com/J3vb/OwnCord/Server/permissions"

// channelAffordances are one viewer's per-channel verdicts that the client
// uses to pre-disable controls: the ready payload ships them per non-DM
// channel and the targeted channel_create refreshes them. Each field is
// exactly one predicate's verdict over one subject, so none can drift from the
// rule the server enforces; the server stays the authority.
type channelAffordances struct {
	CanSend          bool // permissions.CanSendMessage
	CanModerateVoice bool // permissions.AuthorizeVoiceModerator
	CanMoveVoice     bool // permissions.AuthorizeVoiceMover
	CanDeleteOthers  bool // permissions.CanDeleteMessage as a moderation action
	CanPin           bool // permissions.CanPinMessage
	CanReact         bool // permissions.CanAddReaction
}

// affordancesFor is the only place the six affordance predicates are asked.
// The ready builder, the composer refresh and every channel_create sender go
// through it. The zero subject yields all false.
func affordancesFor(sub permissions.Subject) channelAffordances {
	asMod, delErr := permissions.CanDeleteMessage(sub, false)
	return channelAffordances{
		CanSend:          permissions.CanSendMessage(sub) == nil,
		CanModerateVoice: permissions.AuthorizeVoiceModerator(sub) == nil,
		CanMoveVoice:     permissions.AuthorizeVoiceMover(sub) == nil,
		CanDeleteOthers:  delErr == nil && asMod,
		CanPin:           permissions.CanPinMessage(sub) == nil,
		CanReact:         permissions.CanAddReaction(sub) == nil,
	}
}

// spreadInto writes the six verdicts into a ready channel entry. All six
// keys are always present on a non-DM channel.
func (a channelAffordances) spreadInto(entry map[string]any) {
	entry["can_send"] = a.CanSend
	entry["can_moderate_voice"] = a.CanModerateVoice
	entry["can_move_voice"] = a.CanMoveVoice
	entry["can_delete_others"] = a.CanDeleteOthers
	entry["can_pin"] = a.CanPin
	entry["can_react"] = a.CanReact
}
