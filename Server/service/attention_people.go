package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// attentionMinModerators is how many active people must be able to work reports before
// the moderators signal is healthy.
const attentionMinModerators = 2

// attentionPeopleTimeout bounds the database reads of one People sample.
const attentionPeopleTimeout = 5 * time.Second

var errNoOwnerAccount = errors.New("no owner account found")

// AttentionPeople is one sample of who can recover the owner account and work reports.
// Each half carries its own error so a failed read makes only its signals unknown.
type AttentionPeople struct {
	// OwnerHasKit is true when the owner holds an unspent recovery kit; OwnerKitSpent
	// distinguishes a used kit from none ever issued. Valid when KitErr is nil.
	OwnerHasKit   bool
	OwnerKitSpent bool
	KitErr        error
	// Moderators counts active people who can work reports; ModerateRoles counts roles
	// below Owner that carry Moderate members themselves. Valid when CoverageErr is nil.
	Moderators    int
	ModerateRoles int
	CoverageErr   error
}

// PeopleSource reads the owner's recovery kit and the moderation coverage, bounded by the
// sample context and a 5 s budget so a stuck database cannot stall the sample.
func PeopleSource(database *db.DB) func(context.Context) AttentionPeople {
	return func(parent context.Context) AttentionPeople {
		ctx, cancel := context.WithTimeout(parent, attentionPeopleTimeout)
		defer cancel()
		var p AttentionPeople
		p.OwnerHasKit, p.OwnerKitSpent, p.KitErr = readOwnerKit(ctx, database)
		cov, err := database.ReadModerationCoverage(ctx)
		if err != nil {
			p.CoverageErr = fmt.Errorf("moderation coverage: %w", err)
			return p
		}
		p.Moderators, p.ModerateRoles = cov.Moderators, cov.ModerateRoles
		return p
	}
}

func readOwnerKit(ctx context.Context, database *db.DB) (has, spent bool, err error) {
	owner, err := database.GetOwnerUser(ctx)
	if err != nil {
		return false, false, fmt.Errorf("owner lookup: %w", err)
	}
	if owner == nil {
		return false, false, errNoOwnerAccount
	}
	// GetOwnerUser returns the highest-ranked live account, which is only the owner when
	// that account holds the owner role.
	roles, err := database.GetMemberRoles(ctx, owner.ID)
	if err != nil {
		return false, false, fmt.Errorf("owner role lookup: %w", err)
	}
	if roles == nil || !permissions.IsOwner(roles.Top.ID, roles.Top.Position) {
		return false, false, errNoOwnerAccount
	}
	kit, err := database.GetRecoveryKit(ctx, owner.ID)
	if err != nil {
		return false, false, fmt.Errorf("recovery kit lookup: %w", err)
	}
	if kit == nil {
		return false, false, nil
	}
	if kit.UsedAt != nil {
		return false, true, nil
	}
	return true, false, nil
}

func (s *AttentionService) evalPeople(r attentionReadings, now time.Time) {
	s.evalOwnerKit(r.people, now)
	s.evalModerators(r.people, now)
	s.evalModerateRole(r.people, now)
}

func (s *AttentionService) evalOwnerKit(p *AttentionPeople, now time.Time) {
	sig := AttentionSignal{ID: "owner_recovery_kit", Label: "Owner recovery kit", ObservedAt: now}
	const title = "The owner has no recovery kit"
	const action = "Sign in as the owner and open Settings > Account > Recovery kit, choose Create recovery kit, and keep the secret offline. Without one, a lost owner password means restoring a backup and running setup again."
	switch {
	case p == nil:
		sig.Status, sig.Detail = AttentionStatusUnknown, "not measured on this server"
	case p.KitErr != nil:
		sig.Status, sig.Detail = AttentionStatusUnknown, p.KitErr.Error()
	case p.OwnerHasKit:
		sig.Status, sig.Value = AttentionStatusOK, "unspent kit on file"
	case p.OwnerKitSpent:
		sig.Status, sig.Value, sig.Detail = AttentionStatusWarning, "kit already used", "the owner's only kit was spent"
	default:
		sig.Status, sig.Value = AttentionStatusWarning, "none issued"
	}
	s.settle(sig, title, action)
}

func attentionPeopleCount(n int) string {
	if n == 1 {
		return "1 person"
	}
	return fmt.Sprintf("%d people", n)
}

func (s *AttentionService) evalModerators(p *AttentionPeople, now time.Time) {
	sig := AttentionSignal{ID: "moderators", Label: "Moderator coverage", ObservedAt: now}
	const title = "Fewer than two people can work reports"
	const action = "Give a trusted member a role with Moderate Members (or Administrator) so reports are covered when someone is away: edit the role in Roles & permissions, then assign it in Members."
	switch {
	case p == nil:
		sig.Status, sig.Detail = AttentionStatusUnknown, "not measured on this server"
	case p.CoverageErr != nil:
		sig.Status, sig.Detail = AttentionStatusUnknown, p.CoverageErr.Error()
	default:
		sig.Value = attentionPeopleCount(p.Moderators)
		sig.Threshold = fmt.Sprintf("warn below %d", attentionMinModerators)
		sig.Status = AttentionStatusOK
		if p.Moderators < attentionMinModerators {
			sig.Status = AttentionStatusWarning
		}
	}
	s.settle(sig, title, action)
}

func (s *AttentionService) evalModerateRole(p *AttentionPeople, now time.Time) {
	sig := AttentionSignal{ID: "moderate_role", Label: "Moderate Members role", ObservedAt: now}
	const title = "No role besides Owner can moderate members"
	const action = "Give your moderator role Moderate Members in Roles & permissions. A customised Moderator role did not receive it automatically, and Administrator does not count here."
	switch {
	case p == nil:
		sig.Status, sig.Detail = AttentionStatusUnknown, "not measured on this server"
	case p.CoverageErr != nil:
		sig.Status, sig.Detail = AttentionStatusUnknown, p.CoverageErr.Error()
	case p.ModerateRoles == 0:
		sig.Status, sig.Value = AttentionStatusWarning, "0 roles"
	default:
		sig.Status, sig.Value = AttentionStatusOK, fmt.Sprintf("%d role(s)", p.ModerateRoles)
	}
	s.settle(sig, title, action)
}
