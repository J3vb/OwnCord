package service

import (
	"fmt"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// requireOwnerGrantOnly refuses a change to the bits in changed (already
// masked to permissions.OwnerGrantOnly, added or removed) unless the actor is
// the owner or an Administrator. It is a no-op for a zero mask.
func requireOwnerGrantOnly(actor *db.Role, changed int64) error {
	if changed == 0 || permissions.CanChangeOwnerGrantOnly(actor.Permissions, actor.ID, actor.Position) {
		return nil
	}
	return fmt.Errorf("%w: only the owner can change %s", ErrForbidden, permissions.Name(changed&-changed))
}

// requireOwnerGrantOnlyAssign is the assignment form of the rule: carried is
// the owner-grant-only bits of the role being assigned or removed. The owner
// and an Administrator may always; anyone else only when their own effective
// mask holds all of those bits. Putting the bits on a role stays with
// requireOwnerGrantOnly.
func requireOwnerGrantOnlyAssign(actor *db.Role, carried int64) error {
	if carried == 0 || permissions.CanChangeOwnerGrantOnly(actor.Permissions, actor.ID, actor.Position) {
		return nil
	}
	if missing := carried &^ actor.Permissions; missing != 0 {
		return fmt.Errorf("%w: only the owner can change %s", ErrForbidden, permissions.Name(missing&-missing))
	}
	return nil
}
