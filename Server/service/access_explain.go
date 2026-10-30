package service

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Access explanation and override preview. Both answer from the canonical
// predicates (permissions.Explain) over a Subject resolved live by
// permissions.Checker.Subject, the resolution the authorization paths use, never
// the 30s cache and never a session: an admin asks about a member without acting as
// them. The only rule applied on top is account admission (ban, unapproved
// registration), which gates every session before any channel predicate.

// AccessRestrictions are the non-role facts that feed a member's decisions.
type AccessRestrictions struct {
	Banned             bool   `json:"banned"`
	RegistrationStatus string `json:"registration_status"`
	TimedOut           bool   `json:"timed_out"`
	NSFWAcknowledged   bool   `json:"nsfw_acknowledged"`
	ChannelArchived    bool   `json:"channel_archived"`
	ChannelNSFW        bool   `json:"channel_nsfw"`
	ChannelType        string `json:"channel_type"`
}

// AccessExplanation is one member's effective access in one channel.
type AccessExplanation struct {
	UserID       int64                  `json:"user_id"`
	Username     string                 `json:"username"`
	RoleID       int64                  `json:"role_id"`
	RoleName     string                 `json:"role_name"`
	ChannelID    int64                  `json:"channel_id"`
	Restrictions AccessRestrictions     `json:"restrictions"`
	Decisions    []permissions.Decision `json:"decisions"`
}

// accessMember is one member's live authorization state in a channel.
type accessMember struct {
	user     *db.User
	role     *db.Role // the member's top role (rank and display)
	held     []int64  // every held role id, top first
	masks    map[int64]int64
	subject  permissions.Subject
	blockMsg string // account admission refusal, "" when admitted
}

// accountBlock is session admission: a banned or unapproved account holds no
// session, so no channel predicate can allow it anything.
func accountBlock(u *db.User) string {
	if auth.IsEffectivelyBanned(u) {
		return "account is banned"
	}
	if u.RegistrationStatus != "" && u.RegistrationStatus != "active" {
		return "account registration is " + u.RegistrationStatus
	}
	return ""
}

// loadAccessMember resolves userID's live Subject in ch, composing every role
// they hold.
func (s *ChannelService) loadAccessMember(ctx context.Context, userID int64, ch *db.Channel) (*accessMember, error) {
	user, err := s.st.GetUserByID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch user: %w", ErrInternal, err)
	}
	if user == nil {
		return nil, fmt.Errorf("user not found%.0w", ErrNotFound)
	}
	held, err := s.st.GetMemberRoles(ctx, user.ID)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to fetch role: %w", ErrInternal, err)
	}
	var role *db.Role
	var ids []int64
	var heldGrants []permissions.RoleGrant
	var masks map[int64]int64
	if held != nil {
		role, ids, heldGrants = &held.Top, held.IDs, held.Held()
		masks = make(map[int64]int64, len(ids))
		for i, id := range ids {
			masks[id] = held.Masks[i]
		}
	} else {
		// A member with no role holds no bits; the zero role says so.
		role = &db.Role{ID: user.RoleID}
	}
	sub, err := permissions.NewChecker(s.st).Subject(ctx, heldGrants, user.ID, ch.AuthorityID())
	if err != nil {
		return nil, fmt.Errorf("%w: failed to resolve permissions: %w", ErrInternal, err)
	}
	sub.Channel = permissions.ChannelRef{ID: ch.ID, Type: ch.Type, Archived: ch.Archived, NSFW: ch.NSFW,
		AuthorityID: ch.Thread.ParentID, ThreadLocked: ch.Thread.Locked}
	if ch.NSFW {
		if sub.NSFWAcknowledged, err = s.st.HasNSFWAcknowledgement(ctx, user.ID, ch.ID); err != nil {
			return nil, fmt.Errorf("%w: failed to read NSFW acknowledgement: %w", ErrInternal, err)
		}
	}
	return &accessMember{user: user, role: role, held: ids, masks: masks, subject: sub, blockMsg: accountBlock(user)}, nil
}

// withRoleOverride returns the member's subject with roleID's channel override
// replaced by allow/deny. A member with several roles is resolved per role (only
// roleID's override changes), so the proposal composes as a saved override would.
func (m *accessMember) withRoleOverride(roleID, allow, deny int64) permissions.Subject {
	sub := m.subject
	if len(m.held) <= 1 {
		sub.Override.Allow, sub.Override.Deny = allow, deny
		return sub
	}
	layers := make([]permissions.RoleGrant, 0, len(m.held))
	for _, id := range m.held {
		g := permissions.RoleGrant{RoleID: id, Perms: m.masks[id]}
		for _, cur := range m.subject.Layers {
			if cur.RoleID == id {
				g.Allow, g.Deny = cur.Allow, cur.Deny
			}
		}
		if id == roleID {
			g.Allow, g.Deny = allow, deny
		}
		layers = append(layers, g)
	}
	sub.Layers = layers
	sub.Override.Allow, sub.Override.Deny = 0, 0
	return sub
}

// decisions evaluates every action's predicate for m under the subject sub
// (m.subject, or a proposal derived from it).
func (m *accessMember) decisions(sub permissions.Subject) []permissions.Decision {
	out := make([]permissions.Decision, 0, len(permissions.Actions))
	for _, a := range permissions.Actions {
		d, _ := permissions.Explain(a, sub) // a is always a known action
		if m.blockMsg != "" {
			d.Allowed, d.Reason = false, m.blockMsg
		}
		out = append(out, d)
	}
	return out
}

// ExplainAccess reports userID's effective decision for action in the guild
// channel ch and the rules behind it. The read is audited: it discloses a member's
// restriction state, so like editing their override it is refused for a member
// ranked at or above the actor.
func (s *ChannelService) ExplainAccess(ctx context.Context, actorID int64, actorRole *db.Role, userID int64, ch *db.Channel, action string) (AccessExplanation, error) {
	if _, err := permissions.Explain(permissions.Action(action), permissions.Subject{}); err != nil {
		return AccessExplanation{}, fmt.Errorf("%w%.0w", err, ErrBadRequest)
	}
	m, err := s.loadAccessMember(ctx, userID, ch)
	if err != nil {
		return AccessExplanation{}, err
	}
	if err := s.requireOutranks(ctx, actorRole, m.user); err != nil {
		return AccessExplanation{}, err
	}
	var ds []permissions.Decision
	for _, d := range m.decisions(m.subject) {
		if string(d.Action) == action {
			ds = append(ds, d)
		}
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "permission_explain", "user", m.user.ID,
		fmt.Sprintf("explained access for %s on #%s", m.user.Username, ch.Name))
	return AccessExplanation{
		UserID: m.user.ID, Username: m.user.Username, RoleID: m.role.ID, RoleName: m.role.Name,
		ChannelID: ch.ID,
		Restrictions: AccessRestrictions{
			Banned:             auth.IsEffectivelyBanned(m.user),
			RegistrationStatus: m.user.RegistrationStatus,
			TimedOut:           m.subject.TimedOut,
			NSFWAcknowledged:   m.subject.NSFWAcknowledged,
			ChannelArchived:    ch.Archived,
			ChannelNSFW:        ch.NSFW,
			ChannelType:        ch.Type,
		},
		Decisions: ds,
	}, nil
}

// AccessChange is one action whose decision a proposed override flips.
type AccessChange struct {
	Action       permissions.Action `json:"action"`
	Before       bool               `json:"before"`
	After        bool               `json:"after"`
	BeforeReason string             `json:"before_reason,omitempty"`
	AfterReason  string             `json:"after_reason,omitempty"`
}

// MemberAccessChange lists one member's flipped decisions.
type MemberAccessChange struct {
	UserID   int64          `json:"user_id"`
	Username string         `json:"username"`
	Changes  []AccessChange `json:"changes"`
}

// AccessPreview is the effect of a proposed override before it is saved.
type AccessPreview struct {
	ChannelID int64                `json:"channel_id"`
	Allow     int64                `json:"allow"`
	Deny      int64                `json:"deny"`
	Evaluated int                  `json:"evaluated"`
	Members   []MemberAccessChange `json:"members"`
}

// PreviewOverride evaluates a proposed override on ch (the role layer for roleID,
// or the member layer for userID; exactly one is non-zero) against ExplainAccess's
// predicates and returns every member whose decision for any action changes. A
// role or member ranked at or above the actor is refused, as editing its override
// is. Only the audit row is written; the save path re-checks its own authority.
// ponytail: one live Subject per member of the role (a few indexed reads each);
// batch the reads if a role grows to tens of thousands of members.
func (s *ChannelService) PreviewOverride(ctx context.Context, actorID int64, actorRole *db.Role, ch *db.Channel, roleID, userID, allowRaw, denyRaw int64) (AccessPreview, error) {
	if (roleID == 0) == (userID == 0) {
		return AccessPreview{}, fmt.Errorf("exactly one of role_id or user_id is required%.0w", ErrBadRequest)
	}
	allow, deny := allowRaw&permissions.AllPerms, denyRaw&permissions.AllPerms
	ids := []int64{userID}
	target := "user"
	if roleID != 0 {
		role, err := s.st.GetRoleByID(ctx, roleID)
		if err != nil {
			return AccessPreview{}, fmt.Errorf("%w: failed to fetch role: %w", ErrInternal, err)
		}
		if role == nil {
			return AccessPreview{}, fmt.Errorf("role not found%.0w", ErrNotFound)
		}
		if role.Position >= actorRole.Position {
			return AccessPreview{}, fmt.Errorf("cannot manage a role at or above your own rank%.0w", ErrForbidden)
		}
		if ids, err = s.st.ListUserIDsByRole(ctx, roleID); err != nil {
			return AccessPreview{}, fmt.Errorf("%w: failed to list role members: %w", ErrInternal, err)
		}
		target = "role " + role.Name
	}

	out := AccessPreview{ChannelID: ch.ID, Allow: allow, Deny: deny, Members: []MemberAccessChange{}}
	for _, id := range ids {
		m, err := s.loadAccessMember(ctx, id, ch)
		if err != nil {
			return AccessPreview{}, err
		}
		if roleID == 0 {
			if err := s.requireOutranks(ctx, actorRole, m.user); err != nil {
				return AccessPreview{}, err
			}
			target = "user " + m.user.Username
		}
		proposed := m.subject
		if roleID != 0 {
			proposed = m.withRoleOverride(roleID, allow, deny)
		} else {
			proposed.Override.UserAllow, proposed.Override.UserDeny = allow, deny
		}
		before, after := m.decisions(m.subject), m.decisions(proposed)
		var changes []AccessChange
		for i := range before {
			if before[i].Allowed != after[i].Allowed {
				changes = append(changes, AccessChange{
					Action: before[i].Action, Before: before[i].Allowed, After: after[i].Allowed,
					BeforeReason: before[i].Reason, AfterReason: after[i].Reason,
				})
			}
		}
		out.Evaluated++
		if changes != nil {
			out.Members = append(out.Members, MemberAccessChange{UserID: m.user.ID, Username: m.user.Username, Changes: changes})
		}
	}
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "permission_preview", "channel", ch.ID,
		fmt.Sprintf("previewed overrides for %s on #%s (allow=%#x deny=%#x): %d of %d members change",
			target, ch.Name, allow, deny, len(out.Members), out.Evaluated))
	return out, nil
}
