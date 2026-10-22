package api_test

// router_member_roles_test.go — WP 6.3c. PUT and DELETE {base}/{id}/roles/{roleId}
// add and remove one role of a member, on both surfaces that mount the member
// actions: /api/v1/moderation/members and /admin/api/users.

import (
	"context"
	"net/http"
	"slices"
	"strings"
	"testing"
)

func (e *memberActionsEnv) heldRoles(t *testing.T, name string) []int64 {
	t.Helper()
	held, err := e.db.GetMemberRoles(context.Background(), e.ids[name])
	if err != nil || held == nil {
		t.Fatalf("GetMemberRoles(%s) = %v, %v", name, held, err)
	}
	return held.IDs
}

func TestMemberRoles_AddAndRemove_BothSurfaces(t *testing.T) {
	for _, base := range []string{"/api/v1/moderation/members/", "/admin/api/users/"} {
		t.Run(base, func(t *testing.T) {
			e := newMemberActionsEnv(t)
			url := func(name string, role int) string {
				return base + itoa(e.ids[name]) + "/roles/" + itoa(int64(role))
			}

			// The admin outranks the member and the moderator role sits below it.
			if rr := e.do(t, http.MethodPut, url("other", roleModerator), "admin", ""); rr.Code != http.StatusNoContent {
				t.Fatalf("PUT status = %d, want 204; body = %s", rr.Code, rr.Body.String())
			}
			if got := e.heldRoles(t, "other"); !slices.Equal(got, []int64{roleModerator, roleMember}) {
				t.Fatalf("held roles = %v, want [moderator member] (top first)", got)
			}
			if got := e.roleOf(t, "other"); got != roleModerator {
				t.Fatalf("users.role_id = %d, want the new top role", got)
			}
			// Idempotent.
			if rr := e.do(t, http.MethodPut, url("other", roleModerator), "admin", ""); rr.Code != http.StatusNoContent {
				t.Fatalf("repeat PUT status = %d, want 204; body = %s", rr.Code, rr.Body.String())
			}

			// The member role can go while another is held, and then the rest is the last.
			if rr := e.do(t, http.MethodDelete, url("other", roleMember), "admin", ""); rr.Code != http.StatusNoContent {
				t.Fatalf("DELETE status = %d, want 204; body = %s", rr.Code, rr.Body.String())
			}
			rr := e.do(t, http.MethodDelete, url("other", roleModerator), "admin", "")
			if rr.Code != http.StatusConflict || !strings.Contains(rr.Body.String(), `"LAST_ROLE"`) {
				t.Fatalf("DELETE of the last role: status = %d body = %s, want 409 LAST_ROLE", rr.Code, rr.Body.String())
			}
			if got := e.heldRoles(t, "other"); !slices.Equal(got, []int64{roleModerator}) {
				t.Fatalf("held roles = %v, want the last role kept", got)
			}
		})
	}
}

func TestMemberRoles_RankChecksEnforced(t *testing.T) {
	e := newMemberActionsEnv(t)
	cases := []struct {
		name   string
		method string
		actor  string
		target string
		role   int
		want   int
	}{
		{"moderator lacks manage roles", http.MethodPut, "mod", "other", roleMember, http.StatusForbidden},
		{"member lacks every permission", http.MethodPut, "member", "other", roleModerator, http.StatusForbidden},
		{"admin cannot grant a role at its own rank", http.MethodPut, "admin", "other", roleAdmin, http.StatusForbidden},
		{"admin cannot grant the owner role", http.MethodPut, "admin", "other", roleOwner, http.StatusForbidden},
		{"admin cannot change the owner's roles", http.MethodPut, "admin", "owner", roleModerator, http.StatusForbidden},
		{"admin cannot strip the owner's role", http.MethodDelete, "admin", "owner", roleOwner, http.StatusForbidden},
		{"unknown role is a bad request", http.MethodPut, "admin", "other", 9999, http.StatusBadRequest},
		{"unauthenticated", http.MethodPut, "", "other", roleModerator, http.StatusUnauthorized},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			before := slices.Clone(e.heldRoles(t, tc.target))
			rr := e.do(t, tc.method, e.path(tc.target)+"/roles/"+itoa(int64(tc.role)), tc.actor, "")
			if rr.Code != tc.want {
				t.Fatalf("status = %d, want %d; body = %s", rr.Code, tc.want, rr.Body.String())
			}
			if got := e.heldRoles(t, tc.target); !slices.Equal(got, before) {
				t.Fatalf("held roles changed from %v to %v on a refused request", before, got)
			}
		})
	}
}
