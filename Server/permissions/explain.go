package permissions

import "fmt"

// Action names one canonical predicate an administrator can ask about. Explain
// runs the predicate itself; there is no second rule engine.
type Action string

const (
	ActionViewChannel   Action = "view_channel"   // CanViewChannel
	ActionReadContent   Action = "read_content"   // CanReadContent (NSFW consent)
	ActionSendMessage   Action = "send_message"   // CanSendMessage
	ActionAddReaction   Action = "add_reaction"   // CanAddReaction
	ActionJoinVoice     Action = "join_voice"     // CanJoinVoice
	ActionModerateVoice Action = "moderate_voice" // AuthorizeVoiceModerator
	ActionMoveVoice     Action = "move_voice"     // AuthorizeVoiceMover
)

// Actions lists every explainable action in a stable order.
var Actions = []Action{
	ActionViewChannel, ActionReadContent, ActionSendMessage,
	ActionAddReaction, ActionJoinVoice, ActionModerateVoice, ActionMoveVoice,
}

// actionPredicate maps an Action to its predicate and the bits it consults.
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
		if s.Channel.Type == "dm" {
			return CanJoinVoice, ConnectVoice, true
		}
		return CanJoinVoice, ReadMessages | ConnectVoice, true
	case ActionModerateVoice:
		return AuthorizeVoiceModerator, ReadMessages | MuteMembers, true
	case ActionMoveVoice:
		return AuthorizeVoiceMover, ReadMessages | MoveMembers, true
	}
	return nil, 0, false
}

// BitRule is how one bit resolved through base role, role override and member
// override ("allow", "deny" or ""). For a multi-role member with an override,
// RoleOverride is empty and Decision.RoleBits carries the per-role rows.
type BitRule struct {
	Bit          string `json:"bit"`
	Base         bool   `json:"base"`
	RoleOverride string `json:"role_override"`
	UserOverride string `json:"user_override"`
	Effective    bool   `json:"effective"`
}

// RoleBitRule is one held role's resolution of one bit; Effective is the
// role-layer result that is OR'd with the other held roles.
type RoleBitRule struct {
	Bit          string `json:"bit"`
	RoleID       int64  `json:"role_id"`
	Base         bool   `json:"base"`
	RoleOverride string `json:"role_override"`
	Effective    bool   `json:"effective"`
}

// Decision is one action's verdict with its bit trace; an Administrator's has none.
type Decision struct {
	Action              Action    `json:"action"`
	Allowed             bool      `json:"allowed"`
	Reason              string    `json:"reason,omitempty"`
	AdministratorBypass bool      `json:"administrator_bypass"`
	Bits                []BitRule `json:"bits,omitempty"`
	// RoleBits is the per-role breakdown of Bits; present only for a multi-role
	// member with an override in the channel.
	RoleBits []RoleBitRule `json:"role_bits,omitempty"`
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

// Explain runs a's predicate against s and traces the bits it consulted. An
// unknown action is an error, never a denial.
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
	if d.AdministratorBypass {
		return d, nil
	}
	for bits != 0 {
		bit := bits & -bits
		bits &^= bit
		rule := BitRule{
			Bit:          Name(bit),
			Base:         HasPerm(s.RolePerms, bit),
			UserOverride: layerState(s.Override.UserAllow, s.Override.UserDeny, bit),
			Effective:    s.Has(bit),
		}
		if s.Layers != nil {
			for _, g := range s.Layers {
				d.RoleBits = append(d.RoleBits, RoleBitRule{
					Bit:          rule.Bit,
					RoleID:       g.RoleID,
					Base:         HasPerm(g.Perms, bit),
					RoleOverride: layerState(g.Allow, g.Deny, bit),
					Effective:    HasPerm(EffectivePerms(g.Perms, g.Allow, g.Deny), bit),
				})
			}
		} else {
			rule.RoleOverride = layerState(s.Override.Allow, s.Override.Deny, bit)
		}
		d.Bits = append(d.Bits, rule)
	}
	return d, nil
}
