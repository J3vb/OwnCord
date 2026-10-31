package invariants

import (
	"go/ast"
	"go/token"
	"strconv"
)

// requestPathGoID is the rule's stable id.
const requestPathGoID = "request-path-go"

// GoEntry is one row of the request-path goroutine inventory: how many bare
// go statements a production file may hold, and why each is not joined by a
// syncutil.Group.
type GoEntry struct {
	Count int
	Why   string
}

// GoAllow is the inventory of every go statement in api, admin, service and
// ws. A file not listed here may hold none; a listed file
// with more go statements than Count fails; and a listed file with fewer
// fails too, so a row that no longer describes the code is deleted rather
// than left to excuse the next goroutine added there (TestGoAllowIsLive also
// fails a row whose file is gone). Work that outlives a request or a message
// belongs on syncutil.Group.Go, which the lifecycle owner joins before the
// database closes.
var GoAllow = map[string]GoEntry{
	"admin/handlers_backup.go":           {1, "restart hand-off: requestRestart only cancels a context, and joining it is circular because it starts the Close that would join it"},
	"admin/handlers_config_overrides.go": {1, "restart hand-off, as in handlers_backup.go"},
	"admin/setup_handler.go":             {1, "restart hand-off, as in handlers_backup.go"},
	"api/livekit_proxy.go":               {2, "proxy copy pair, joined inside the handler"},
	"service/push_dispatch.go":           {1, "per-round sends, joined by the WaitGroup inside Notify"},
	"admin/logfile.go":                   {1, "saved log history writer, a lifecycle worker joined by its close step"},
	"service/mention_worker.go":          {1, "lifecycle worker, joined by its close step"},
	"service/call_log_worker.go":         {1, "lifecycle worker, joined by its close step"},
	"ws/event_persister.go":              {1, "lifecycle worker, joined by its close step"},
	"ws/event_pruner.go":                 {1, "lifecycle worker, joined by its close step"},
	"ws/livekit_process.go":              {1, "supervised process monitor, joined by its close step"},
	"ws/serve.go":                        {2, "connection-scoped write and ping pumps; Shutdown does not wait on hijacked connections (residual class, follow-up: connection teardown join)"},
	"ws/focus_defer.go":                  {1, "connection-scoped deferred focus drain (residual class, as in ws/serve.go)"},
}

// requestPathGo enforces the request-path goroutine rule: a go statement in a handler, service or hub
// file is a goroutine no shutdown step joins. Every one must be inventoried in
// GoAllow with its reason; anything that outlives its caller runs on
// syncutil.Group.Go instead.
//
// The rule is syntactic on go statements. It does not catch a spawn through
// sync.WaitGroup.Go or errgroup.Group.Go, which start a goroutine without
// one; review those by hand.
//
// time.AfterFunc is out of scope: its timers either check the hub's stop
// signal or touch memory only, and the rule is syntactic on go statements.
var requestPathGo = Rule{
	ID:    requestPathGoID,
	Scope: []string{"api", "admin", "service", "ws"},
	Check: func(f *ast.File, fset *token.FileSet, rel string) []Violation {
		var stmts []token.Pos
		ast.Inspect(f, func(n ast.Node) bool {
			if g, ok := n.(*ast.GoStmt); ok {
				stmts = append(stmts, g.Pos())
			}
			return true
		})
		allowed, listed := GoAllow[rel]
		var out []Violation
		for i, pos := range stmts {
			if listed && i < allowed.Count {
				continue
			}
			out = append(out, Violation{
				Rule: requestPathGoID,
				File: rel,
				Line: fset.Position(pos).Line,
				Msg: "go statement in a request-path package that no shutdown step joins (ARCH-034). " +
					"Run work that outlives its caller on syncutil.Group.Go so the lifecycle owner drains it " +
					"before the database closes, or, for a lifecycle worker the owner already joins, " +
					"add the file to invariants.GoAllow with the reason.",
			})
		}
		if listed && len(stmts) < allowed.Count {
			out = append(out, Violation{
				Rule: requestPathGoID,
				File: rel,
				Line: 1,
				Msg: "invariants.GoAllow lists " + rel + " with " + strconv.Itoa(allowed.Count) +
					" go statement(s) but the file has " + strconv.Itoa(len(stmts)) +
					": the row is stale. Lower its Count, or delete it when none remain.",
			})
		}
		return out
	},
}
