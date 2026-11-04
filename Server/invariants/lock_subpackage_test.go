package invariants

import (
	"strings"
	"testing"
	"testing/fstest"
)

// subTable is a minimal lock_order.go whose rank types are aliases of
// ws/lockrank's, with a row for a lock in a package under ws/.
const subTable = `package ws

import "github.com/J3vb/OwnCord/Server/ws/lockrank"

//	rank  lock                 declared
//	6     cache.Cache.mu       cache/c.go:1   leaves only
//	7     Hub.mu               hub.go:25      leaves
//	9     Client.mu            client.go:81   leaf

type (
	rankCache = lockrank.HubCache
	rankHub   = lockrank.Hub
	rankLeaf  = lockrank.Leaf
)
`

const subRanks = `package lockrank

type (
	HubCache struct{}
	Hub      struct{}
	Leaf     struct{}
)

func (HubCache) Rank() int { return 6 }
func (Hub) Rank() int      { return 7 }
func (Leaf) Rank() int     { return 9 }
`

const subWS = `package ws

import "github.com/J3vb/OwnCord/Server/syncutil"

type Hub struct{ mu syncutil.Ranked[rankHub] }
type Client struct{ mu syncutil.Ranked[rankLeaf] }
`

const subCache = `package cache

import (
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws/lockrank"
)

type Cache struct{ mu syncutil.RankedRW[lockrank.HubCache] }
`

func subFiles(cache string) map[string][]byte {
	return map[string][]byte{
		lockOrderFile:         []byte(subTable),
		"ws/lockrank/rank.go": []byte(subRanks),
		"ws/x.go":             []byte(subWS),
		"ws/cache/c.go":       []byte(cache),
	}
}

func TestLockRules_SubpackageLockIsCheckedLikeOneInWS(t *testing.T) {
	tests := []struct {
		name      string
		cache     string
		inventory []string
		rank      []string
	}{
		{name: "a subpackage lock with its row and the shared rank type", cache: subCache},
		{
			name:  "a subpackage lock whose rank type differs from its row",
			cache: strings.Replace(subCache, "lockrank.HubCache", "lockrank.Leaf", 1),
			rank:  []string{"lock cache.Cache.mu has rank 9 in the code but 6 in the table"},
		},
		{
			name:      "a subpackage lock with no row",
			cache:     strings.Replace(subCache, "Cache struct{ mu", "Cache struct{ other syncutil.Mutex; mu", 1),
			inventory: []string{"lock cache.Cache.other is not in the lock-order table"},
		},
		{
			name:      "a row whose subpackage lock is gone",
			cache:     "package cache\n",
			inventory: []string{"stale row: no mutex named cache.Cache.mu"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assertViolations(t, checkLockInventory(subFiles(tt.cache)), lockInventoryID, tt.inventory)
			assertViolations(t, checkLockRanks(subFiles(tt.cache)), lockRankID, tt.rank)
		})
	}
}

func TestReadLockFiles_WalksSubpackagesButNotTestsOrTestdata(t *testing.T) {
	fsys := fstest.MapFS{
		"ws/a.go":             {Data: []byte("package ws\n")},
		"ws/a_test.go":        {Data: []byte("package ws\n")},
		"ws/sub/b.go":         {Data: []byte("package sub\n")},
		"ws/sub/b_test.go":    {Data: []byte("package sub\n")},
		"ws/testdata/fake.go": {Data: []byte("package fake\n")},
	}
	files, bad := readLockFiles(fsys, lockInventoryID)
	if bad != nil {
		t.Fatalf("readLockFiles: %v", bad)
	}
	if len(files) != 2 || files["ws/a.go"] == nil || files["ws/sub/b.go"] == nil {
		keys := make([]string, 0, len(files))
		for k := range files {
			keys = append(keys, k)
		}
		t.Fatalf("read %v, want ws/a.go and ws/sub/b.go", keys)
	}
}

func assertViolations(t *testing.T, got []Violation, rule string, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: got %d violation(s), want %d:\n%v", rule, len(got), len(want), got)
	}
	for _, w := range want {
		found := false
		for _, v := range got {
			if v.Rule == rule && strings.Contains(v.Msg, w) {
				found = true
			}
		}
		if !found {
			t.Errorf("%s: no violation contains %q:\n%v", rule, w, got)
		}
	}
}

func TestLockRank_SubpackageGenericTakesWSInstantiation(t *testing.T) {
	const generic = `package cache

import "github.com/J3vb/OwnCord/Server/syncutil"

type Locks[R syncutil.LockRank] struct{ mu syncutil.Ranked[R] }
`
	table := strings.Replace(subTable, "//\t6     cache.Cache.mu       cache/c.go:1   leaves only\n",
		"//\t6     cache.Locks.mu       cache/c.go:1   leaves only\n", 1)
	for _, tt := range []struct {
		name, inst string
		want       []string
	}{
		{name: "instantiated with the row's rank", inst: "rankCache"},
		{name: "instantiated with the shared type directly", inst: "lockrank.HubCache"},
		{name: "instantiated with another rank", inst: "rankLeaf",
			want: []string{"lock cache.Locks.mu has rank 9 in the code but 6 in the table"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ws := subWS + "type owner struct{ l cache.Locks[" + tt.inst + "] }\n"
			files := map[string][]byte{
				lockOrderFile:         []byte(table),
				"ws/lockrank/rank.go": []byte(subRanks),
				"ws/x.go":             []byte(ws),
				"ws/cache/c.go":       []byte(generic),
			}
			assertViolations(t, checkLockInventory(files), lockInventoryID, nil)
			assertViolations(t, checkLockRanks(files), lockRankID, tt.want)
		})
	}
}

func TestLockRank_SubpackageCannotBorrowWSRankNames(t *testing.T) {
	const own = `package cache

import "github.com/J3vb/OwnCord/Server/syncutil"

type rankCache struct{}

func (rankCache) Rank() int { return 9 }

type Cache struct{ mu syncutil.RankedRW[rankCache] }
`
	assertViolations(t, checkLockRanks(subFiles(own)), lockRankID,
		[]string{"lock cache.Cache.mu is ranked by cache.rankCache, which is not a rank type"})

	const other = `package cache

import (
	"github.com/J3vb/OwnCord/Server/syncutil"
	"github.com/J3vb/OwnCord/Server/ws/otherrank"
)

type Cache struct{ mu syncutil.RankedRW[otherrank.HubCache] }
`
	assertViolations(t, checkLockRanks(subFiles(other)), lockRankID,
		[]string{"lock cache.Cache.mu is ranked by otherrank.HubCache, which is not a rank type"})
}

func TestLockInventory_TwoPackagesWithOneNameFail(t *testing.T) {
	files := subFiles(subCache)
	files["ws/voice/cache/c.go"] = []byte("package cache\n")
	files["ws/voice/cache/d.go"] = []byte("package cache\n")
	assertViolations(t, checkLockInventory(files), lockInventoryID,
		[]string{"ws/cache and ws/voice/cache are both named cache"})
}
