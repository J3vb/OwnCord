package admin

// SRE-03 (M half): every Warn-or-above message a support bundle can carry must
// map to a fixed event code, not fall through to the generic log_event. This
// canary parses the whole Server tree, collects the constant part of every
// logger Warn/Error message, and fails when any would be reported as log_event —
// so a new failure log added anywhere is caught here until its code is added to
// support_event_codes.go.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
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

// constMessage folds a constant string expression (literals joined by +) and
// reports whether the whole expression is constant.
func constMessage(e ast.Expr) (string, bool) {
	switch v := e.(type) {
	case *ast.BasicLit:
		if v.Kind == token.STRING {
			s, err := strconv.Unquote(v.Value)
			if err != nil {
				return "", false
			}
			return s, true
		}
	case *ast.ParenExpr:
		return constMessage(v.X)
	case *ast.BinaryExpr:
		if v.Op == token.ADD {
			a, oka := constMessage(v.X)
			b, okb := constMessage(v.Y)
			if oka && okb {
				return a + b, true
			}
		}
	}
	return "", false
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
	var uncovered []string
	walkErr := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, parseErr := parser.ParseFile(fset, path, nil, 0)
		if parseErr != nil {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			switch sel.Sel.Name {
			case "Warn", "Error", "WarnContext", "ErrorContext":
			default:
				return true
			}
			if !loggerReceiver(sel.X) {
				return true
			}
			args := call.Args
			if strings.HasSuffix(sel.Sel.Name, "Context") && len(args) > 0 {
				args = args[1:]
			}
			if len(args) == 0 {
				return true
			}
			msg, ok := constMessage(args[0])
			if !ok {
				return true // no constant part: cannot be mapped from source
			}
			if supportEventCode(msg) == "log_event" {
				pos := fset.Position(call.Pos())
				uncovered = append(uncovered, rel+":"+strconv.Itoa(pos.Line)+": "+msg)
			}
			return true
		})
		return nil
	})
	if walkErr != nil {
		t.Fatalf("walk: %v", walkErr)
	}
	if len(uncovered) > 0 {
		t.Fatalf("%d Warn/Error message(s) have no support-bundle event code and would be reported as log_event.\nAdd a code for each to support_event_codes.go (or a supportEventPrefixCodes entry for a message built with a variable suffix):\n%s",
			len(uncovered), strings.Join(uncovered, "\n"))
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
// suffix: the constant prefix must resolve, and the longest matching prefix
// must win.
func TestSupportEventCode_PrefixMatch(t *testing.T) {
	if got := supportEventCode("hub: broadcast channel full, dropping message"); got != "broadcast_dropped" {
		t.Fatalf("exact-coded message = %q, want broadcast_dropped", got)
	}
	if got := supportEventCode("hub: broadcast channel full, dropping global message"); got != "broadcast_dropped" {
		t.Fatalf("prefix-coded message = %q, want broadcast_dropped", got)
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
