package invariants

import (
	"go/token"
	"strings"
	"testing"
)

func TestSyncutilLocks(t *testing.T) {
	tests := []struct {
		name string
		path string
		src  string
		want int
	}{
		{
			name: "raw RWMutex field in ws is flagged",
			path: "ws/x.go",
			src: `package ws
import "sync"
type Hub struct{ mu sync.RWMutex }
`,
			want: 1,
		},
		{
			name: "raw Mutex field in service is flagged",
			path: "service/x.go",
			src: `package service
import "sync"
type S struct{ mu sync.Mutex }
`,
			want: 1,
		},
		{
			name: "embedded raw Mutex is flagged",
			path: "ws/x.go",
			src: `package ws
import "sync"
type Hub struct{ sync.Mutex }
`,
			want: 1,
		},
		{
			name: "local variable raw Mutex is flagged",
			path: "ws/x.go",
			src: `package ws
import "sync"
func f() { var mu sync.Mutex; _ = mu }
`,
			want: 1,
		},
		{
			name: "syncutil alias is clean",
			path: "ws/x.go",
			src: `package ws
import "github.com/owncord/server/syncutil"
type Hub struct{ mu syncutil.RWMutex }
`,
			want: 0,
		},
		{
			name: "sync.Once and sync.WaitGroup are not locks",
			path: "ws/x.go",
			src: `package ws
import "sync"
type Hub struct {
	once sync.Once
	wg   sync.WaitGroup
}
`,
			want: 0,
		},
		{
			name: "package outside scope is ignored",
			path: "api/x.go",
			src: `package api
import "sync"
type S struct{ mu sync.Mutex }
`,
			want: 0,
		},
		{
			name: "allow comment with a reason suppresses",
			path: "ws/x.go",
			src: `package ws
import "sync"
type Hub struct {
	mu sync.Mutex //invariant:allow syncutil-locks — guards a cgo callback that needs a std lock
}
`,
			want: 0,
		},
		{
			name: "allow comment without a reason does not suppress and is itself a violation",
			path: "ws/x.go",
			src: `package ws
import "sync"
type Hub struct {
	mu sync.Mutex //invariant:allow syncutil-locks
}
`,
			want: 2,
		},
		{
			name: "allow comment for a different rule does not suppress",
			path: "ws/x.go",
			src: `package ws
import "sync"
type Hub struct {
	mu sync.Mutex //invariant:allow some-other-rule — unrelated
}
`,
			want: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := CheckSource(token.NewFileSet(), tt.path, []byte(tt.src))
			if len(got) != tt.want {
				t.Fatalf("got %d violation(s), want %d:\n%v", len(got), tt.want, got)
			}
		})
	}
}

func TestSyncutilLocksMessageNamesTheFix(t *testing.T) {
	src := `package ws
import "sync"
type Hub struct{ mu sync.RWMutex }
`
	got := CheckSource(token.NewFileSet(), "ws/x.go", []byte(src))
	if len(got) != 1 {
		t.Fatalf("got %d violation(s), want 1: %v", len(got), got)
	}
	v := got[0]
	if v.Rule != "syncutil-locks" {
		t.Errorf("Rule = %q, want %q", v.Rule, "syncutil-locks")
	}
	if v.Line != 3 {
		t.Errorf("Line = %d, want 3", v.Line)
	}
	if !strings.Contains(v.Msg, "syncutil.RWMutex") {
		t.Errorf("message must name the fix, got %q", v.Msg)
	}
	if !strings.Contains(v.Msg, "-tags deadlock") {
		t.Errorf("message must name the consequence, got %q", v.Msg)
	}
}
