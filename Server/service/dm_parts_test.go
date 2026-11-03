package service

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
)

// DMService's group management part must reach the same store as the core: the
// recipient check asserts an optional reachability reader on its store at run
// time, and a part handed a narrower wrapper would quietly lose it.
func TestDMServicePartsShareStore(t *testing.T) {
	database := newTestDB(t)
	dms := NewDMService(database, nil)
	for name, st := range map[string]any{
		"core":  dms.st,
		"group": dms.groupManagement.st,
	} {
		if st != any(database) {
			t.Errorf("%s store = %T, want the shared *db.DB", name, st)
		}
	}
	if _, ok := dms.groupManagement.st.(groupReachabilityReader); !ok {
		t.Error("group part store lost the optional groupReachabilityReader capability")
	}
}

// service.New builds the DM service with its group part sharing the permission
// service, which the part's timeout gate reads.
func TestServicesWireDMGroupPart(t *testing.T) {
	database := newTestDB(t)
	svcs := New(database, auth.NewRateLimiter())
	if svcs.DMs.groupManagement == nil {
		t.Fatal("DMService has no group management part")
	}
	if svcs.DMs.groupManagement.perms == nil || svcs.DMs.groupManagement.perms != svcs.DMs.perms {
		t.Errorf("group part perms = %p, want the core's %p", svcs.DMs.groupManagement.perms, svcs.DMs.perms)
	}
}
