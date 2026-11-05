package api

import "testing"

// Each group is named once, so a duplicated entry (a feature mounted twice,
// which chi turns into a start-up panic on a repeated Mount) is caught here
// with the group's name rather than in the panic.
func TestRouteGroupsAreNamedOnce(t *testing.T) {
	t.Parallel()
	seen := make(map[string]bool, len(routeGroups))
	for _, g := range routeGroups {
		if g.name == "" || g.mount == nil {
			t.Fatalf("route group %q is missing its name or mount", g.name)
		}
		if seen[g.name] {
			t.Errorf("route group %q is listed twice", g.name)
		}
		seen[g.name] = true
	}
}
