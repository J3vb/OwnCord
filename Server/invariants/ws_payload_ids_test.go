package invariants

import (
	"go/token"
	"testing"
)

func wsPayloadIDViolations(t *testing.T, rel, src string) []Violation {
	t.Helper()
	return checkSourceWith([]Rule{wsPayloadIDs}, token.NewFileSet(), rel, []byte(src))
}

func TestWSPayloadIDs_RawInt64IsFlagged(t *testing.T) {
	src := "package ws\nfunc parse() { id, err := p.MessageID.Int64(); _, _ = id, err }\n"
	got := wsPayloadIDViolations(t, "ws/command_new.go", src)
	if len(got) != 1 || got[0].Rule != wsPayloadIDsID {
		t.Fatalf("violations = %v, want exactly one %s", got, wsPayloadIDsID)
	}
	// A bare number variable is flagged too, whatever it is called.
	src = "package ws\nfunc parse(n json.Number) { n.Int64() }\n"
	if got := wsPayloadIDViolations(t, "ws/command_new.go", src); len(got) != 1 {
		t.Errorf("bare receiver: %v, want one violation", got)
	}
}

func TestWSPayloadIDs_PositiveIDIsClean(t *testing.T) {
	src := "package ws\nfunc parse() { id, err := positiveID(p.MessageID, \"message_id\"); _, _ = id, err }\n"
	if got := wsPayloadIDViolations(t, "ws/command_new.go", src); len(got) != 0 {
		t.Fatalf("violations = %v, want none", got)
	}
}

func TestWSPayloadIDs_OnlyPositiveIDMayCallInt64(t *testing.T) {
	helper := "package ws\nfunc positiveID(n json.Number) { n.Int64() }\n"
	if got := wsPayloadIDViolations(t, "ws/ids.go", helper); len(got) != 0 {
		t.Errorf("positiveID in ws/ids.go: %v, want none", got)
	}
	// The same name in another file, or another function in ids.go, is not the helper.
	if got := wsPayloadIDViolations(t, "ws/other.go", helper); len(got) != 1 {
		t.Errorf("positiveID in another file: %v, want one violation", got)
	}
	other := "package ws\nfunc readID(n json.Number) { n.Int64() }\n"
	if got := wsPayloadIDViolations(t, "ws/ids.go", other); len(got) != 1 {
		t.Errorf("another function in ws/ids.go: %v, want one violation", got)
	}
}

func TestWSPayloadIDs_DurationHoursIsAllowedOnlyInPollCreate(t *testing.T) {
	src := "package ws\nfunc parsePollCreate() { p.DurationHours.Int64() }\n"
	if got := wsPayloadIDViolations(t, "ws/command_poll.go", src); len(got) != 0 {
		t.Errorf("duration_hours in command_poll.go: %v, want none", got)
	}
	if got := wsPayloadIDViolations(t, "ws/command_other.go", src); len(got) != 1 {
		t.Errorf("duration_hours in another file: %v, want one violation", got)
	}
	id := "package ws\nfunc parsePollCreate() { p.ChannelID.Int64() }\n"
	if got := wsPayloadIDViolations(t, "ws/command_poll.go", id); len(got) != 1 {
		t.Errorf("channel id in command_poll.go: %v, want one violation", got)
	}
}

func TestWSPayloadIDs_OutsideScopeIsNotChecked(t *testing.T) {
	src := "package api\nfunc h() { n.Int64() }\n"
	if got := wsPayloadIDViolations(t, "api/x.go", src); len(got) != 0 {
		t.Fatalf("violations = %v, want none outside ws", got)
	}
}

func TestWSPayloadIDs_RealTreeIsClean(t *testing.T) {
	violations, err := runWith([]Rule{wsPayloadIDs}, serverRoot(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) != 0 {
		t.Fatalf("real tree: %v, want none", violations)
	}
}
