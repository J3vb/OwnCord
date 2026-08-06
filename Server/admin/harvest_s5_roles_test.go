package admin_test

// 2026-08-06 harvest S5: PATCH /roles/{id} must blanket-invalidate the
// permission cache when the affected-member lookup fails — role.go documents
// that fallback, but the handler only ever did per-user evictions.

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/owncord/server/admin"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/service"
)

// failingMembersStore makes exactly the role-member lookup fail, the way a
// transient reader-pool error would, while every other query keeps working.
type failingMembersStore struct {
	service.Store
}

func (failingMembersStore) ListUserIDsByRole(context.Context, int64) ([]int64, error) {
	return nil, errors.New("reader pool exhausted")
}

func TestAdminAPI_PatchRole_MemberLookupFailureBlanketInvalidates(t *testing.T) {
	database := openAdminTestDB(t)
	hub := &mockHub{}
	inv := &mockPermInvalidator{}
	roleSvc := service.NewRoleService(
		failingMembersStore{Store: database},
		service.NewPermissionService(database, permissions.NewChecker(database)),
	)
	handler := admin.NewAdminAPI(database, "1.0.0", hub, nil, nil, nil, inv,
		newTestModService(database), roleSvc)
	token := createAdminUser(t, database)

	// Strip the seeded Member role down to READ_MESSAGES — a permissions
	// change whose members could not be enumerated.
	w := doRequest(t, handler, http.MethodPatch, "/roles/3", token, map[string]any{
		"permissions": permissions.ReadMessages,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
	}
	if inv.invalidateAllN == 0 {
		t.Fatalf("permissions changed but the member lookup failed and nothing was blanket-invalidated (InvalidateAll=0, per-user=%v) — the members keep their revoked grants until the cache TTL", inv.invalidateUserIDs)
	}
}
