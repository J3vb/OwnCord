package invariants

import (
	"go/ast"
	"go/token"
	"path"
	"strings"
)

// voiceMembershipWritesID is the rule's stable id.
const voiceMembershipWritesID = "voice-membership-writes"

// voiceSlotFields are the per-connection voice slot's fields (ws.voiceSlot).
// Writing one outside the registry would change a membership without the
// lock handle and without the clear's paired VoiceTopic unsubscribe.
var voiceSlotFields = map[string]bool{
	"voiceChID":                true,
	"voiceJoinToken":           true,
	"voiceJoinCompleted":       true,
	"e2ee":                     true,
	"watching":                 true,
	"pendingModServerMuted":    true,
	"pendingModServerDeafened": true,
	"pendingModServerMutedBy":  true,
}

// voiceRowWriters are the VoiceStore methods that write a membership row.
var voiceRowWriters = map[string]bool{
	"Join":         true,
	"LeaveIfMatch": true,
}

// voiceSlotMutators are the voiceSlot methods that change a membership.
// Calling one outside the registry changes a slot without the lock handle.
// clearIfChannel and clearExact also exist on voiceTxn, so a call on a
// receiver named txn, or on a begin/heldTxn result, is the handle's own and is not
// flagged.
var voiceSlotMutators = map[string]bool{
	"setState": true, "clearState": true, "clearIfChannel": true, "clearExact": true,
	"markCompletedIfMatch": true, "setE2EE": true,
	"clearSnap": true, "clearSnapIfChannel": true, "drainAll": true, "adopt": true,
	"heldTxn": true, // the lock-free handle for the hub goroutine's Register event
}

// voiceTxnShared are the mutator names voiceTxn also defines.
var voiceTxnShared = map[string]bool{"clearIfChannel": true, "clearExact": true}

// VoiceMutatorAllow is the shrink-only inventory of non-registry call sites of
// the mutators above: file -> method -> exact call count. The E2EE announce setter
// stores a key and not a membership, and heldTxn has one production caller, the hub
// goroutine's Register event (onClientEvent, test-only via Hub.Register); the
// reconnect-race test borrows it to model an interleaving the member lock now
// forbids. A count above
// the row is a new writer; a count below it, or a file that no longer exists,
// is a stale row and fails too (TestVoiceMutatorAllowIsLive) -- delete it.
var VoiceMutatorAllow = map[string]map[string]int{
	"ws/hub_registry.go":        {"heldTxn": 1},
	"ws/voice_e2ee_announce.go": {"setE2EE": 1},
}

// isOwnTxnReceiver reports whether recv is a voiceTxn expression: an
// identifier named txn, or a call of begin/heldTxn.
func isOwnTxnReceiver(recv ast.Expr) bool {
	switch r := recv.(type) {
	case *ast.Ident:
		return r.Name == "txn"
	case *ast.CallExpr:
		if sel, ok := r.Fun.(*ast.SelectorExpr); ok {
			return sel.Sel.Name == "begin" || sel.Sel.Name == "heldTxn"
		}
	}
	return false
}

// voiceMutatorCalls lists the non-handle mutator calls in f by method name.
func voiceMutatorCalls(f *ast.File) map[string][]token.Pos {
	out := map[string][]token.Pos{}
	ast.Inspect(f, func(n ast.Node) bool {
		x, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := x.Fun.(*ast.SelectorExpr)
		if ok && voiceSlotMutators[sel.Sel.Name] &&
			(!voiceTxnShared[sel.Sel.Name] || !isOwnTxnReceiver(sel.X)) {
			out[sel.Sel.Name] = append(out[sel.Sel.Name], x.Pos())
		}
		return true
	})
	return out
}

// voiceMembershipWrites enforces the single-writer rule: voice membership has one writer.
// Every change to a user's voice slot and every membership row insert or
// delete lives in ws/voice_registry*.go, behind the lock handle Hub.begin
// returns, so a new path cannot forget the member lock, the grace entry or the
// VoiceTopic unsubscribe. Outside those files in ws/ the rule flags
//
//   - a call to <x>.voice.Join or <x>.voice.LeaveIfMatch (VoiceStore), and
//   - an assignment to one of the voiceSlot fields.
//
// Tests are not scanned (the walker skips _test.go), and the boot wipe
// (ClearAllVoiceStates in internal/app) is outside ws/.
var voiceMembershipWrites = Rule{
	ID:    voiceMembershipWritesID,
	Scope: []string{"ws"},
	Check: func(f *ast.File, fset *token.FileSet, rel string) []Violation {
		if path.Dir(rel) != "ws" || strings.HasPrefix(path.Base(rel), "voice_registry") {
			return nil
		}
		var out []Violation
		mutators := voiceMutatorCalls(f)
		report := func(pos token.Pos, what string) {
			out = append(out, Violation{
				Rule: voiceMembershipWritesID,
				File: rel,
				Line: fset.Position(pos).Line,
				Msg: what + " writes voice membership outside ws/voice_registry*.go. Every membership write " +
					"goes through the lock handle Hub.begin returns (voiceTxn: persistJoin, markCompleted, clear, " +
					"clearIfChannel, clearExact, deleteRow, setJoinToken), which owns the member lock, the grace " +
					"entry and the VoiceTopic unsubscribe. Add the operation to voiceTxn instead.",
			})
		}
		flagSlotWrite := func(lhs ast.Expr) {
			if sel, ok := lhs.(*ast.SelectorExpr); ok && voiceSlotFields[sel.Sel.Name] {
				report(lhs.Pos(), "assignment to the voice slot field ."+sel.Sel.Name)
			}
		}
		ast.Inspect(f, func(n ast.Node) bool {
			switch x := n.(type) {
			case *ast.CallExpr:
				sel, ok := x.Fun.(*ast.SelectorExpr)
				if !ok || !voiceRowWriters[sel.Sel.Name] {
					return true
				}
				switch recv := sel.X.(type) {
				case *ast.SelectorExpr:
					if recv.Sel.Name == "voice" {
						report(x.Pos(), "voice."+sel.Sel.Name+"()")
					}
				case *ast.Ident:
					if recv.Name == "voice" {
						report(x.Pos(), "voice."+sel.Sel.Name+"()")
					}
				}
			case *ast.AssignStmt:
				if x.Tok == token.DEFINE {
					return true
				}
				for _, lhs := range x.Lhs {
					flagSlotWrite(lhs)
				}
			case *ast.IncDecStmt:
				flagSlotWrite(x.X)
			}
			return true
		})
		allowed := VoiceMutatorAllow[rel]
		for name, poss := range mutators {
			for i, pos := range poss {
				if i >= allowed[name] {
					report(pos, "call to ."+name+"()")
				}
			}
		}
		return out
	},
}
