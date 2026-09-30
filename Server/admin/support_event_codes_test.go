package admin

// SRE-03 (M half): every Warn-or-above message a support bundle can carry must
// map to a fixed event code, not fall through to the generic log_event. This
// canary parses the whole Server tree, resolves every logger Warn/Error message
// to the constants it can take, and fails when any would be reported as
// log_event — so a new failure log added anywhere is caught here until its code
// is added to support_event_codes.go.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
)

// loggerReceiver reports whether a `.Warn`/`.Error` call's receiver is a
// structured logger rather than an unrelated Error method (http.Error, an
// error wrapper, an errgroup). It mirrors the derivation of
// support_event_codes.go. A chained receiver (slog.With(...), slog.Default(),
// h.log.With(...)) resolves through the call to the logger it derives from.
func loggerReceiver(e ast.Expr) bool {
	switch v := e.(type) {
	case *ast.Ident:
		return v.Name == "slog" || strings.Contains(strings.ToLower(v.Name), "log")
	case *ast.SelectorExpr:
		return strings.Contains(strings.ToLower(v.Sel.Name), "log")
	case *ast.CallExpr:
		if f, ok := v.Fun.(*ast.SelectorExpr); ok {
			return loggerReceiver(f.X) || loggerReceiver(f.Sel)
		}
		return loggerReceiver(v.Fun)
	}
	return false
}

// typeName returns the named type an expression spells (T or *T), or "".
func typeName(e ast.Expr) string {
	switch v := e.(type) {
	case *ast.Ident:
		return v.Name
	case *ast.StarExpr:
		return typeName(v.X)
	}
	return ""
}

// constPrefix folds the leading constant part of a string expression — string
// literals and the package's string constants joined by + — and reports
// whether the whole expression is constant.
func constPrefix(e ast.Expr, consts map[string]string) (string, bool) {
	switch v := e.(type) {
	case *ast.BasicLit:
		if v.Kind == token.STRING {
			if s, err := strconv.Unquote(v.Value); err == nil {
				return s, true
			}
		}
	case *ast.Ident:
		if s, ok := consts[v.Name]; ok {
			return s, true
		}
	case *ast.ParenExpr:
		return constPrefix(v.X, consts)
	case *ast.BinaryExpr:
		if v.Op == token.ADD {
			a, full := constPrefix(v.X, consts)
			if !full {
				return a, false
			}
			b, full := constPrefix(v.Y, consts)
			return a + b, full
		}
	}
	return "", false
}

// logMessageArg returns the message argument of a logger Warn/Error call (or of
// a slog.Log/LogAttrs call not pinned to Info/Debug), or nil when call is not
// one.
func logMessageArg(call *ast.CallExpr) ast.Expr {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || !loggerReceiver(sel.X) {
		return nil
	}
	skip := 0
	switch sel.Sel.Name {
	case "Warn", "Error":
	case "WarnContext", "ErrorContext":
		skip = 1
	case "Log", "LogAttrs":
		skip = 2
		if len(call.Args) > 1 {
			switch types.ExprString(call.Args[1]) {
			case "slog.LevelInfo", "slog.LevelDebug":
				return nil
			}
		}
	default:
		return nil
	}
	if len(call.Args) <= skip {
		return nil
	}
	return call.Args[skip]
}

type uncodedMessage struct {
	pos string
	msg string
}

// uncodedLogMessages checks every logger Warn/Error call in pkgs (files keyed
// by package directory) and returns each message that would be reported as
// log_event:
//   - a constant message needs an exact supportEventCodes entry;
//   - a struct-field message (step.failLog) needs an entry for every constant
//     the field is set to in the package — by keyed or positional composite
//     literal or by assignment — and at least one such constant; a field ever
//     set from a non-constant is reported;
//   - any other message needs a constant prefix that a supportEventPrefixCodes
//     entry matches — one with no constant prefix is always reported.
func uncodedLogMessages(fset *token.FileSet, pkgs map[string][]*ast.File) []uncodedMessage {
	var out []uncodedMessage
	for _, files := range pkgs {
		consts := map[string]string{}
		structs := map[string][]string{}
		for _, f := range files {
			ast.Inspect(f, func(n ast.Node) bool {
				switch v := n.(type) {
				case *ast.GenDecl:
					if v.Tok != token.CONST {
						return true
					}
					for _, spec := range v.Specs {
						vs := spec.(*ast.ValueSpec)
						for i, name := range vs.Names {
							if i < len(vs.Values) {
								if s, full := constPrefix(vs.Values[i], consts); full {
									consts[name.Name] = s
								}
							}
						}
					}
				case *ast.TypeSpec:
					if st, ok := v.Type.(*ast.StructType); ok {
						var names []string
						for _, field := range st.Fields.List {
							if len(field.Names) == 0 {
								names = append(names, "")
							}
							for _, name := range field.Names {
								names = append(names, name.Name)
							}
						}
						structs[v.Name.Name] = names
					}
				}
				return true
			})
		}
		fields := map[string][]string{}
		unresolved := map[string]bool{}
		record := func(field string, value ast.Expr) {
			if s, full := constPrefix(value, consts); full {
				fields[field] = append(fields[field], s)
			} else {
				unresolved[field] = true
			}
		}
		elided := map[*ast.CompositeLit]string{}
		for _, f := range files {
			ast.Inspect(f, func(n ast.Node) bool {
				switch v := n.(type) {
				case *ast.CompositeLit:
					typ := elided[v]
					if v.Type != nil {
						typ = typeName(v.Type)
					}
					var elem string
					switch t := v.Type.(type) {
					case *ast.ArrayType:
						elem = typeName(t.Elt)
					case *ast.MapType:
						elem = typeName(t.Value)
					}
					for i, e := range v.Elts {
						kv, keyed := e.(*ast.KeyValueExpr)
						if keyed {
							e = kv.Value
							if key, ok := kv.Key.(*ast.Ident); ok {
								record(key.Name, kv.Value)
							}
						} else if names := structs[typ]; i < len(names) && names[i] != "" {
							record(names[i], e)
						}
						if cl, ok := e.(*ast.CompositeLit); ok && cl.Type == nil && elem != "" {
							elided[cl] = elem
						}
					}
				case *ast.AssignStmt:
					if len(v.Lhs) == len(v.Rhs) {
						for i, lhs := range v.Lhs {
							if sel, ok := lhs.(*ast.SelectorExpr); ok {
								record(sel.Sel.Name, v.Rhs[i])
							}
						}
					}
				}
				return true
			})
		}
		for _, f := range files {
			ast.Inspect(f, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				msg := logMessageArg(call)
				if msg == nil {
					return true
				}
				pos := fset.Position(call.Pos()).String()
				prefix, full := constPrefix(msg, consts)
				switch sel, isField := msg.(*ast.SelectorExpr); {
				case full:
					if _, ok := supportEventCodes[prefix]; !ok {
						out = append(out, uncodedMessage{pos, prefix})
					}
				case isField:
					values := fields[sel.Sel.Name]
					if len(values) == 0 || unresolved[sel.Sel.Name] {
						out = append(out, uncodedMessage{pos, types.ExprString(msg)})
					}
					for _, v := range values {
						if _, ok := supportEventCodes[v]; !ok {
							out = append(out, uncodedMessage{pos, v})
						}
					}
				default:
					coded := false
					for p := range supportEventPrefixCodes {
						coded = coded || strings.HasPrefix(prefix, p)
					}
					if !coded {
						out = append(out, uncodedMessage{pos, types.ExprString(msg)})
					}
				}
				return true
			})
		}
	}
	return out
}

// TestSupportEventCodes_EveryWarnErrorLiteralIsCoded is the SRE-03 canary. It
// fails, for example, on the voice-refusal log added without a code — exactly
// the gap the M half closes. The receiver-agnostic walk catches `log.Warn(`
// and `a.log.Error(` as well as `slog.Warn(`/`slog.Error(`.
func TestSupportEventCodes_EveryWarnErrorLiteralIsCoded(t *testing.T) {
	root, err := filepath.Abs("..")
	if err != nil {
		t.Fatalf("Abs: %v", err)
	}
	fset := token.NewFileSet()
	pkgs := map[string][]*ast.File{}
	walkErr := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil //nolint:nilerr // an unreadable entry is skipped, not fatal: the canary checks the source it can read
		}
		f, parseErr := parser.ParseFile(fset, path, nil, 0)
		if parseErr != nil {
			return nil //nolint:nilerr // a file that does not parse already fails the build, so it has no log call to check
		}
		pkgs[filepath.Dir(path)] = append(pkgs[filepath.Dir(path)], f)
		return nil
	})
	if walkErr != nil {
		t.Fatalf("walk: %v", walkErr)
	}
	uncovered := uncodedLogMessages(fset, pkgs)
	if len(uncovered) > 0 {
		lines := make([]string, 0, len(uncovered))
		for _, u := range uncovered {
			rel, _ := filepath.Rel(root, u.pos)
			lines = append(lines, rel+": "+u.msg)
		}
		slices.Sort(lines)
		t.Fatalf("%d Warn/Error message(s) have no support-bundle event code and would be reported as log_event.\nAdd a code for each to support_event_codes.go (or a supportEventPrefixCodes entry for a message built with a variable suffix):\n%s",
			len(lines), strings.Join(lines, "\n"))
	}
}

// TestUncodedLogMessages_ReportsEveryUncodedForm pins the canary's own rules
// against a fixture package: each message form is accepted only when its code
// exists, and a message with no constant part is never silently skipped.
func TestUncodedLogMessages_ReportsEveryUncodedForm(t *testing.T) {
	const src = `package p

import "log/slog"

type step struct {
	job     string
	failLog string
}

type toggle struct{ updateLog string }

type reason struct{ warnLog string }

type hub struct{ log *slog.Logger }

const dropPrefix = "hub: broadcast channel full, dropping "

func f(kind, line string, s step, t toggle, r reason, h hub) {
	slog.Warn("upload rejected")
	slog.Warn("a brand new failure")
	slog.Warn("hub: broadcast channel full, dropping " + kind)
	slog.Warn("a new prefix " + kind)
	slog.Warn(kind + " rejected")
	slog.Error(s.failLog)
	slog.Error(t.updateLog)
	slog.Warn(r.warnLog)
	slog.Log(nil, slog.LevelWarn, dropPrefix+line)
	slog.Log(nil, slog.LevelWarn, "livekit companion output", "line", line)
	slog.Error("livekit: failed to write config " + kind)
	slog.Log(nil, slog.LevelInfo, line)
	slog.With("k", kind).Warn("a chained failure")
	slog.Default().Error("a default-logger failure")
	h.log.With("k", kind).Warn("upload rejected")
	_ = step{failLog: "storage recount failed"}
	_ = step{failLog: "a new step failure"}
	_ = []step{{"Job", "a positional failure"}}
	_ = toggle{updateLog: "ws handleVoiceMuteV2 UpdateVoiceMute"}
	_ = toggle{updateLog: "x " + kind}
	r.warnLog = "upload rejected"
	r.warnLog = kind
}
`
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "p.go", src, 0)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	uncovered := uncodedLogMessages(fset, map[string][]*ast.File{"p": {f}})
	got := make([]string, 0, len(uncovered))
	for _, u := range uncovered {
		got = append(got, u.msg)
	}
	slices.Sort(got)
	want := []string{
		`"a new prefix " + kind`, "a brand new failure", "a new step failure", `kind + " rejected"`,
		"a positional failure", "t.updateLog", `"livekit: failed to write config " + kind`, "r.warnLog", "a chained failure", "a default-logger failure",
	}
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("uncoded messages = %q, want %q", got, want)
	}
}

// TestSupportEventCode_VoiceRefusalIsCoded is the SRE-03 acceptance case: a
// forced voice refusal appears coded in the bundle rather than as log_event.
func TestSupportEventCode_VoiceRefusalIsCoded(t *testing.T) {
	if got := supportEventCode("ws voice_join refused"); got != "voice_join_refused" {
		t.Fatalf("voice refusal event code = %q, want voice_join_refused", got)
	}
}

// TestSupportEventCode_PrefixMatch covers a message built with a variable
// suffix: the constant prefix must resolve, and a message that merely shares a
// component's wording (OwnCord's own "livekit: ..." supervisor lines) must not
// be taken for LiveKit companion output.
func TestSupportEventCode_PrefixMatch(t *testing.T) {
	if got := supportEventCode("hub: broadcast channel full, dropping global message"); got != "broadcast_dropped" {
		t.Fatalf("prefix-coded message = %q, want broadcast_dropped", got)
	}
	if got := supportEventCode("livekit companion output"); got != "livekit_companion_log" {
		t.Fatalf("companion line = %q, want livekit_companion_log", got)
	}
	if got := supportEventCode("livekit: restarting process"); got != "log_event" {
		t.Fatalf("supervisor message = %q, want log_event", got)
	}
	if got := supportEventCode("auto-generated key saved to disk"); got != "key_auto_generated" {
		t.Fatalf("key generation = %q, want key_auto_generated", got)
	}
}

// TestSupportEventCode_KeepsEveryPreSRE03Code pins the codes the table had
// before SRE-03's M half: the regenerated table must keep resolving each of
// these messages to its original code, Info-level ones included (the canary
// only scans Warn/Error).
func TestSupportEventCode_KeepsEveryPreSRE03Code(t *testing.T) {
	for message, want := range map[string]string{
		"database backup created":                              "backup_created",
		"backup failed integrity check — removing":             "backup_verification_failed",
		"restore refused: backup failed integrity check":       "restore_verification_failed",
		"pre-restore backup failed — aborting restore":         "restore_safety_backup_failed",
		"audit log write failed":                               "audit_write_failed",
		"admin: token resolution failed":                       "authentication_storage_failed",
		"session sweep: batch session lookup failed":           "session_storage_failed",
		"ws service internal error":                            "message_service_failed",
		"ws handler internal error":                            "socket_handler_failed",
		"ws writePump error":                                   "socket_write_failed",
		"hub: closing stale connection (no activity)":          "socket_stale_closed",
		"hub: broadcast channel full, dropping message":        "broadcast_dropped",
		"hub: broadcast channel full, dropping global message": "broadcast_dropped",
		"hub: panic recovered":                                 "hub_panic_recovered",
		"livekit: process exited unexpectedly":                 "livekit_process_exited",
		"livekit: too many rapid failures, giving up":          "livekit_restart_exhausted",
		"livekit: auto-download failed — voice stays offline until livekit-server is available": "livekit_download_failed",
		"LeaveVoiceChannelIfMatch exhausted retries — ghost state may persist":                  "voice_cleanup_exhausted",
		"sweepStaleVoiceStates: removed ghost voice state":                                      "voice_ghost_removed",
		"voice permission reconciliation deferred":                                              "voice_permission_reconcile_deferred",
		"event pruner: PruneEventsOlderThan failed":                                             "event_prune_failed",
		"backup maintenance failed":                                                             "backup_maintenance_failed",
		"retention sweep failed":                                                                "retention_failed",
		"report content retention failed":                                                       "report_retention_failed",
		"moderation action retention failed":                                                    "moderation_retention_failed",
		"maintenance loop: circuit breaker open, skipping tick":                                 "maintenance_circuit_open",
	} {
		if got := supportEventCode(message); got != want {
			t.Errorf("supportEventCode(%q) = %q, want %q", message, got, want)
		}
	}
}

// TestSupportEventCode_UnknownFallsBackToLogEvent pins the safe default: an
// unrecognized message (or one whose constant part was stripped) is reported as
// the generic code, never the raw text.
func TestSupportEventCode_UnknownFallsBackToLogEvent(t *testing.T) {
	if got := supportEventCode("a message no table entry matches"); got != "log_event" {
		t.Fatalf("unknown message event code = %q, want log_event", got)
	}
}
