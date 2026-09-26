package admin_test

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/admin"
	"github.com/J3vb/OwnCord/Server/service"
)

// TestNewAdminAPI_DoesNotMutateCallerBundle pins that the fallback services
// adminRequiredServices builds stay local to the admin mux. The bundle the
// caller passes is the app-wide one the composition root shares with the rest
// of the server; filling admin's fallbacks into it would make every later
// reader of that bundle observe admin's wiring instead of the root's own.
func TestNewAdminAPI_DoesNotMutateCallerBundle(t *testing.T) {
	database := openAdminTestDB(t)

	// Deliberately empty: every fallback fires.
	svc := &service.Services{}
	before := *svc

	_ = admin.NewAdminAPI(database, "1.0.0", &mockHub{}, nil, nil, nil, nil, svc)

	if *svc != before {
		t.Errorf("NewAdminAPI filled fallback services into the caller's bundle: %+v", svc)
	}
}
