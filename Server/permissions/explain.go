package permissions

import "fmt"

// Action names one canonical predicate an administrator can ask about for a
// member in a channel (RI-06). The explanation runs the predicate itself —
// there is no second rule engine here, only a trace of the bits it consulted.
type Action string

const (
	ActionViewChannel   Action = "view_channel"   // CanViewChannel
	ActionReadContent   Action = "read_content"   // CanReadContent (NSFW consent)
	ActionSendMessage   Action = "send_message"   // CanSendMessage
	ActionAddReaction   Action = "add_reaction"   // CanAddReaction
	ActionJoinVoice     Action = "join_voice"     // CanJoinVoice
	ActionModerateVoice Action = "moderate_voice" // AuthorizeVoiceModerator
)

// Actions lists every explainable action in a stable order.
var Actions = []Action{
	ActionViewChannel, ActionReadContent, ActionSendMessage,
	ActionAddReaction, ActionJoinVoice, ActionModerateVoice,
}

// actionPredicate maps an Action to its predicate and the bits that
// predicate consults, so the trace names exactly the bits the decision read.
func actionPredicate(a Action, s Subject) (func(Subject) error, int64, bool) {
	switch a {
	case ActionViewChannel:
		return CanViewChannel, ReadMessages, true
	case ActionReadContent:
		return CanReadContent, ReadMessages, true
	case ActionSendMessage:
		bits := ReadMessages | SendMessages
		if s.Channel.Type == "announcement" {
			bits |= ManageMessages
		}
		return CanSendMessage, bits, true
	case ActionAddReaction:
		return CanAddReaction, ReadMessages | AddReactions, true
	case ActionJoinVoice:
		return CanJoinVoice, ConnectVoice, true
	case ActionModerateVoice:
		return AuthorizeVoiceModerator, ReadMessages | MuteMembers, true
	}
	return nil, 0, false
}

// BitRule is how one permission bit resolved through the layers:
// the base role, the channel's role override, then its member override.
// A layer is "allow", "deny" or "" (no opinion); within a layer allow wins.
type BitRule struct {
	Bit          string `json:"bit"`
	Base         bool   `json:"base"`
	RoleOverride string `json:"role_override"`
	UserOverride string `json:"user_override"`
	Effective    bool   `json:"effective"`
}

// Decision is the verdict of one action's predicate for a Subject, with the
// bit trace that fed it. Reason is the predicate's own error text when denied.
type Decision struct {
	Action              Action    `json:"action"`
	Allowed             bool      `json:"allowed"`
	Reason              string    `json:"reason,omitempty"`
	AdministratorBypass bool      `json:"administrator_bypass"`
	Bits                []BitRule `json:"bits"`
}

func layerState(allow, deny, bit int64) string {
	switch {
	case allow&bit != 0:
		return "allow"
	case deny&bit != 0:
		return "deny"
	}
	return ""
}

// Explain runs a's canonical predicate against s and traces the bits it
// consulted. An unknown action is an error, never a denial.
func Explain(a Action, s Subject) (Decision, error) {
	pred, bits, ok := actionPredicate(a, s)
	if !ok {
		return Decision{}, fmt.Errorf("unknown action %q", a)
	}
	d := Decision{Action: a, AdministratorBypass: HasAdmin(s.RolePerms)}
	if err := pred(s); err != nil {
		d.Reason = err.Error()
	} else {
		d.Allowed = true
	}
	for bits != 0 {
		bit := bits & -bits
		bits &^= bit
		d.Bits = append(d.Bits, BitRule{
			Bit:          Name(bit),
			Base:         HasPerm(s.RolePerms, bit),
			RoleOverride: layerState(s.Override.Allow, s.Override.Deny, bit),
			UserOverride: layerState(s.Override.UserAllow, s.Override.UserDeny, bit),
			Effective:    s.Has(bit),
		})
	}
	return d, nil
}
