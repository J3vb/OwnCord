package service

import "testing"

// ModerationService's parts must reach the same store as the core: the role
// paths assert an optional capability on the core's store at run time, and a
// part handed a narrower wrapper would quietly lose it.
func TestModerationServicePartsShareStore(t *testing.T) {
	database := newTestDB(t)
	mods := NewModerationService(database, nil)
	for name, st := range map[string]any{
		"core":    mods.st,
		"history": mods.moderationHistory.st,
	} {
		if st != any(database) {
			t.Errorf("%s store = %T, want the shared *db.DB", name, st)
		}
	}
	if _, ok := mods.st.(MemberRoleStore); !ok {
		t.Error("core store lost the optional MemberRoleStore capability")
	}
}

// The history part holds no hook of its own, so service.New must wire it on
// the same store as the core.
func TestServicesWireModerationHistoryPart(t *testing.T) {
	database := newTestDB(t)
	svcs := New(database, nil)
	if svcs.Moderation.moderationHistory == nil {
		t.Fatal("Moderation has no history part")
	}
	if svcs.Moderation.moderationHistory.st != any(svcs.Moderation.st) {
		t.Error("history part store differs from the core's")
	}
}
