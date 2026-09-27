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
// support_event_codes.go.
func loggerReceiver(e ast.Expr) bool {
	switch v := e.(type) {
	case *ast.Ident:
		return v.Name == "slog" || strings.Contains(strings.ToLower(v.Name), "log")
	case *ast.SelectorExpr:
		return strings.Contains(strings.ToLower(v.Sel.Name), "log")
	}
	return false
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
//     the field is set to in the package, and at least one such constant;
//   - any other message needs a constant prefix that a supportEventPrefixCodes
//     entry matches — one with no constant prefix is always reported.
func uncodedLogMessages(fset *token.FileSet, pkgs map[string][]*ast.File) []uncodedMessage {
	var out []uncodedMessage
	for _, files := range pkgs {
		consts := map[string]string{}
		fields := map[string][]string{}
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
				case *ast.KeyValueExpr:
					if key, ok := v.Key.(*ast.Ident); ok {
						if s, full := constPrefix(v.Value, consts); full {
							fields[key.Name] = append(fields[key.Name], s)
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
					if len(values) == 0 {
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
			return nil
		}
		f, parseErr := parser.ParseFile(fset, path, nil, 0)
		if parseErr != nil {
			return nil
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

type step struct{ failLog string }

const companionPrefix = "livekit: "

func f(kind, line string, s step) {
	slog.Warn("upload rejected")
	slog.Warn("a brand new failure")
	slog.Warn("hub: broadcast channel full, dropping " + kind)
	slog.Warn("a new prefix " + kind)
	slog.Warn(kind + " rejected")
	slog.Error(s.failLog)
	slog.Log(nil, slog.LevelWarn, companionPrefix+line)
	slog.Log(nil, slog.LevelInfo, line)
	_ = step{failLog: "storage recount failed"}
	_ = step{failLog: "a new step failure"}
}
`
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "p.go", src, 0)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	var got []string
	for _, u := range uncodedLogMessages(fset, map[string][]*ast.File{"p": {f}}) {
		got = append(got, u.msg)
	}
	slices.Sort(got)
	want := []string{`"a new prefix " + kind`, "a brand new failure", "a new step failure", `kind + " rejected"`}
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
// suffix: the constant prefix must resolve, and an exact entry must win over a
// prefix that also matches.
func TestSupportEventCode_PrefixMatch(t *testing.T) {
	if got := supportEventCode("hub: broadcast channel full, dropping global message"); got != "broadcast_dropped" {
		t.Fatalf("prefix-coded message = %q, want broadcast_dropped", got)
	}
	if got := supportEventCode("livekit: 2026-09-27T12:00:00Z WARN room closed"); got != "livekit_companion_log" {
		t.Fatalf("companion line = %q, want livekit_companion_log", got)
	}
	if got := supportEventCode("livekit: process exited unexpectedly"); got != "livekit_process_exited" {
		t.Fatalf("exact-coded message under a prefix = %q, want livekit_process_exited", got)
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
