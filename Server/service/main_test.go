package service

import (
	"os"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"github.com/J3vb/OwnCord/Server/auth"
)

func TestMain(m *testing.M) {
	// Password hashing dominates the auth tests' runtime at the production
	// cost of 12 (the api, auth and admin suites already lower it); nothing
	// under test depends on hash strength.
	auth.SetCostForTesting(bcrypt.MinCost)
	os.Exit(m.Run())
}
