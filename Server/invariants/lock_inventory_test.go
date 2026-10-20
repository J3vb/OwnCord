package invariants

import (
	"strings"
	"testing"
)

// lockInventoryTable is a minimal lock_order.go with two ranked rows and one
// unranked row.
const lockInventoryTable = `package ws

// Ranks:
//
//	rank  lock                 declared
//	1 S   Hub.mu RW            hub.go:25      taken under it: Client.mu
//	      (continuation)       not a row
//	9     activityState.mu     a.go:3         leaf
//	3 S   admissionMu (local)  serve.go:62    Hub.mu
//	-     Proc.mu              p.go:1         unranked: independent subsystem
`

func TestLockInventory_Rule(t *testing.T) {
	const util = `import "github.com/J3vb/OwnCord/Server/syncutil"` + "\n"
	// base declares every lock the table lists, so a case reports only what
	// its own snippet adds or removes.
	const base = `package ws
` + util + `
type Hub struct{ mu syncutil.RWMutex }
type activityState struct{ mu syncutil.Mutex }
type Proc struct{ mu syncutil.Mutex }
func serve() { var admissionMu syncutil.Mutex; _ = &admissionMu }
`
	tests := []struct {
		name   string
		noBase bool
		table  string
		src    string
		want   []string // substrings, one per expected violation
	}{
		{
			name:  "every lock has a row",
			table: lockInventoryTable,
			src: `package ws
` + util + `
type Hub struct{ mu syncutil.RWMutex }
type activityState struct{ mu syncutil.Mutex }
type Proc struct{ mu syncutil.Mutex }
func serve() { var admissionMu syncutil.Mutex; _ = &admissionMu }
`,
		},
		{
			name:  "a struct field with no row names Type.field and the fix",
			table: lockInventoryTable,
			src: `package ws
` + util + `
type Gate struct{ seqMu syncutil.Mutex }
`,
			want: []string{"lock Gate.seqMu is not in the lock-order table; add a row to ws/lock_order.go naming it as Type.field"},
		},
		{
			name:  "a function-local lock is named by its identifier",
			table: lockInventoryTable,
			src: `package ws
` + util + `
func other() {
	var otherMu syncutil.Mutex
	shortMu := syncutil.Mutex{}
	_, _ = &otherMu, &shortMu
}
`,
			want: []string{"lock otherMu is not", "lock shortMu is not"},
		},
		{
			name:  "an embedded state's lock is named for the declaring struct",
			table: lockInventoryTable,
			src: `package ws
` + util + `
type Hub2 struct{ activity act2 }
type act2 struct {
	mu      syncutil.Mutex
	flushMu syncutil.Mutex
}
`,
			want: []string{"lock act2.mu is not", "lock act2.flushMu is not"},
		},
		{
			noBase: true,
			name:   "a renamed lock leaves a missing row and a stale row",
			table:  lockInventoryTable,
			src: `package ws
` + util + `
type Hub struct{ lock syncutil.RWMutex }
type activityState struct{ mu syncutil.Mutex }
type Proc struct{ mu syncutil.Mutex }
func serve() { var admissionMu syncutil.Mutex; _ = &admissionMu }
`,
			want: []string{"lock Hub.lock is not", "stale row: no mutex named Hub.mu"},
		},
		{
			noBase: true,
			name:   "a row for a lock that is gone is stale",
			table:  lockInventoryTable,
			src: `package ws
` + util + `
type Hub struct{ mu syncutil.RWMutex }
`,
			want: []string{"stale row: no mutex named activityState.mu", "stale row: no mutex named admissionMu", "stale row: no mutex named Proc.mu"},
		},
		{
			noBase: true,
			name:   "a row ranked - needs a reason",
			table:  strings.Replace(lockInventoryTable, "unranked: independent subsystem", "independent subsystem", 1),
			src: `package ws
` + util + `
type Hub struct{ mu syncutil.RWMutex }
type activityState struct{ mu syncutil.Mutex }
type Proc struct{ mu syncutil.Mutex }
func serve() { var admissionMu syncutil.Mutex; _ = &admissionMu }
`,
			want: []string{"row for Proc.mu has no rank"},
		},
		{
			name:  "raw sync locks and package vars are inventoried too",
			table: lockInventoryTable,
			src: `package ws
import "sync"
var gate sync.Mutex
type Raw struct{ mu *sync.RWMutex }
`,
			want: []string{"lock gate is not", "lock Raw.mu is not"},
		},
		{
			name:  "sync.Once and a pointer parameter are not declarations",
			table: lockInventoryTable,
			src: `package ws
import "sync"
` + util + `
type Once struct{ once sync.Once }
func use(m *syncutil.Mutex) {}
`,
		},
		{
			name:  "a missing table fails",
			table: "",
			src:   "package ws\n" + util + "type Hub struct{ mu syncutil.Mutex }\n",
			want:  []string{"ws/lock_order.go is missing"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			files := map[string][]byte{"ws/x.go": []byte(tt.src)}
			if !tt.noBase {
				files["ws/base.go"] = []byte(base)
			}
			if tt.table != "" {
				files[lockOrderFile] = []byte(tt.table)
			}
			got := checkLockInventory(files)
			if len(got) != len(tt.want) {
				t.Fatalf("got %d violation(s), want %d:\n%v", len(got), len(tt.want), got)
			}
			for _, w := range tt.want {
				found := false
				for _, v := range got {
					if v.Rule == lockInventoryID && strings.Contains(v.Msg, w) {
						found = true
					}
				}
				if !found {
					t.Errorf("no violation contains %q:\n%v", w, got)
				}
			}
		})
	}
}

// TestLockInventory_TreeIsClean runs the rule over the real ws/ and its real
// table. A failure names the lock and the row to add or delete.
func TestLockInventory_TreeIsClean(t *testing.T) {
	got, err := runWith([]Rule{lockInventory}, "..")
	if err != nil {
		t.Fatalf("walking the server tree: %v", err)
	}
	for _, v := range got {
		t.Errorf("%s", v)
	}
}
