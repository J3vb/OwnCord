package invariants

import (
	"strings"
	"testing"
)

// lockRankTable is a minimal lock_order.go: rows in rank order, a generic
// lock with two rows, and the rank types.
const lockRankTable = `package ws

//	rank  lock                 declared
//	1 S   entry.mu             u.go:1         (members.voice)
//	2 S   entry.mu             u.go:1         (Hub.mod)
//	5     Hub.seqMu            hub.go:65      Hub.mu
//	7     Hub.mu RW            hub.go:25      leaves
//	9     Client.mu            client.go:81   leaf
//	-     Proc.mu              p.go:1         unranked: independent subsystem

type (
	rankVoice struct{}
	rankMod   struct{}
	rankSeq   struct{}
	rankHub   struct{}
	rankLeaf  struct{}
)

func (rankVoice) Rank() int { return 1 }
func (rankMod) Rank() int   { return 2 }
func (rankSeq) Rank() int   { return 5 }
func (rankHub) Rank() int   { return 7 }
func (rankLeaf) Rank() int  { return 9 }
`

func TestLockRank_Rule(t *testing.T) {
	const util = `import "github.com/J3vb/OwnCord/Server/syncutil"` + "\n"
	const locks = `package ws
` + util + `
type locks[R syncutil.LockRank] struct{ m map[int64]*entry[R] }
type entry[R syncutil.LockRank] struct{ mu syncutil.Ranked[R] }
func (l *locks[R]) get() *entry[R] { return &entry[R]{} }
type members struct{ voice locks[rankVoice] }
type Proc struct{ mu syncutil.Mutex }
`
	const good = `type Hub struct {
	mu    syncutil.RankedRW[rankHub]
	seqMu syncutil.Ranked[rankSeq]
	mod   *locks[rankMod]
}
type Client struct{ mu syncutil.Ranked[rankLeaf] }
`
	tests := []struct {
		name  string
		table string
		locks string // replaces the shared declarations when set
		src   string
		want  []string
	}{
		{name: "ranks agree", table: lockRankTable, src: good},
		{
			name:  "a lock whose rank type differs from its row",
			table: lockRankTable,
			src:   strings.Replace(good, "Ranked[rankLeaf]", "Ranked[rankSeq]", 1),
			want:  []string{"lock Client.mu has rank 5 in the code but 9 in the table"},
		},
		{
			name:  "a ranked row on a plain mutex",
			table: lockRankTable,
			src:   strings.Replace(good, "syncutil.Ranked[rankLeaf]", "syncutil.Mutex", 1),
			want:  []string{"lock Client.mu is ranked 9 in the table but declared as a plain mutex"},
		},
		{
			name:  "a rank type with no Rank method",
			table: lockRankTable,
			src:   strings.Replace(good, "Ranked[rankLeaf]", "Ranked[rankNone]", 1),
			want:  []string{"lock Client.mu is ranked by rankNone, which is not a rank type"},
		},
		{
			name:  "a ranked lock in an unranked row",
			table: lockRankTable,
			locks: strings.Replace(locks, "Proc struct{ mu syncutil.Mutex }", "Proc struct{ mu syncutil.Ranked[rankLeaf] }", 1),
			src:   good,
			want:  []string{"lock Proc.mu is declared with rank type rankLeaf but its row is unranked"},
		},
		{
			name:  "a generic lock missing one of its instantiations",
			table: lockRankTable,
			src:   strings.Replace(good, "*locks[rankMod]", "*locks[rankVoice]", 1),
			want:  []string{"lock entry.mu has rank 1 in the code but 1 and 2 in the table"},
		},
		{
			name:  "a table out of rank order",
			table: strings.Replace(lockRankTable, "//\t7     Hub.mu RW", "//\t4     Hub.mu RW", 1),
			src:   good,
			want: []string{"row for Hub.mu (rank 4) follows a row of rank 5",
				"lock Hub.mu has rank 7 in the code but 4 in the table"},
		},
		{
			name:  "a ranked row after an unranked one",
			table: lockRankTable + "//\t9     Late.mu   l.go:1   leaf\n",
			src:   good + "type Late struct{ mu syncutil.Ranked[rankLeaf] }\n",
			want:  []string{"row for Late.mu (rank 9) follows an unranked row"},
		},
		{
			name:  "a Rank method that is not a literal",
			table: strings.Replace(lockRankTable, "func (rankLeaf) Rank() int  { return 9 }", "func (rankLeaf) Rank() int  { return 3 * 3 }", 1),
			src:   good,
			want: []string{"rankLeaf.Rank must be `return <integer literal>`",
				"lock Client.mu is ranked by rankLeaf, which is not a rank type"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			decls := locks
			if tt.locks != "" {
				decls = tt.locks
			}
			src := decls + "\n" + tt.src
			files := map[string][]byte{"ws/x.go": []byte(src), lockOrderFile: []byte(tt.table)}
			got := checkLockRanks(files)
			if len(got) != len(tt.want) {
				t.Fatalf("got %d violation(s), want %d:\n%v", len(got), len(tt.want), got)
			}
			for _, w := range tt.want {
				found := false
				for _, v := range got {
					if v.Rule == lockRankID && strings.Contains(v.Msg, w) {
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

// TestLockRank_TreeIsClean runs the rule over the real ws/ and its table.
func TestLockRank_TreeIsClean(t *testing.T) {
	got, err := runWith([]Rule{lockRank}, "..")
	if err != nil {
		t.Fatalf("walking the server tree: %v", err)
	}
	for _, v := range got {
		t.Errorf("%s", v)
	}
}
