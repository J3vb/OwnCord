package permissions

import (
	"errors"
	"testing"
)

// Explain must agree with the predicate it names for every subject — it
// traces the rule, it never re-decides it.
func TestExplainMatchesPredicates(t *testing.T) {
	subjects := []Subject{
		{RolePerms: memberBits, Channel: text(false)},
		{RolePerms: memberBits, Override: deny(SendMessages), Channel: text(false)},
		{RolePerms: memberBits, Override: ChannelOverride{Deny: ReadMessages, UserAllow: ReadMessages}, Channel: text(false)},
		{RolePerms: memberBits, Channel: text(true)},
		{RolePerms: memberBits, Channel: nsfwText(false)},
		{RolePerms: memberBits, Channel: nsfwText(false), NSFWAcknowledged: true},
		{RolePerms: memberBits, Channel: announcement()},
		{RolePerms: modBits, Channel: announcement()},
		{RolePerms: memberBits, Channel: voice(false), TimedOut: true},
		{RolePerms: modBits, Channel: voice(false)},
		{RolePerms: Administrator, Override: deny(ReadMessages), Channel: voice(true)},
		{Channel: text(false)},
	}
	for i, s := range subjects {
		for _, a := range Actions {
			pred, _, _ := actionPredicate(a, s)
			d, err := Explain(a, s)
			if err != nil {
				t.Fatalf("Explain(%s): %v", a, err)
			}
			want := pred(s)
			if d.Allowed != (want == nil) || (want != nil && d.Reason != want.Error()) {
				t.Errorf("subject %d %s: decision %+v, predicate %v", i, a, d, want)
			}
		}
	}
}

func TestExplainTracesLayers(t *testing.T) {
	s := Subject{
		RolePerms: memberBits,
		Override:  ChannelOverride{Deny: ManageMessages | SendMessages, UserAllow: SendMessages},
		Channel:   announcement(),
	}
	d, _ := Explain(ActionSendMessage, s)
	want := []BitRule{
		{Bit: "SEND_MESSAGES", Base: true, RoleOverride: "deny", UserOverride: "allow", Effective: true},
		{Bit: "READ_MESSAGES", Base: true, Effective: true},
		{Bit: "MANAGE_MESSAGES", RoleOverride: "deny"},
	}
	if d.Allowed || len(d.Bits) != len(want) {
		t.Fatalf("decision = %+v", d)
	}
	for i := range want {
		if d.Bits[i] != want[i] {
			t.Errorf("bit %d = %+v, want %+v", i, d.Bits[i], want[i])
		}
	}
	if d, _ := Explain(ActionViewChannel, Subject{RolePerms: Administrator, Override: deny(ReadMessages), Channel: text(false)}); !d.AdministratorBypass || !d.Allowed || d.Bits != nil {
		t.Errorf("admin = %+v", d)
	}
}

// A DM call consults only CONNECT_VOICE; a server voice channel also reads
// READ_MESSAGES, so hiding it by READ alone is traced as the refusal.
func TestExplainJoinVoiceTracesTypeAwareBits(t *testing.T) {
	cases := []struct {
		name    string
		s       Subject
		allowed bool
		want    []BitRule
	}{
		{
			name:    "dm",
			s:       Subject{RolePerms: ConnectVoice, Channel: dm(), DMParticipant: true},
			allowed: true,
			want:    []BitRule{{Bit: "CONNECT_VOICE", Base: true, Effective: true}},
		},
		{
			name: "voice hidden by READ",
			s:    Subject{RolePerms: memberBits, Override: deny(ReadMessages), Channel: voice(false)},
			want: []BitRule{
				{Bit: "READ_MESSAGES", Base: true, RoleOverride: "deny"},
				{Bit: "CONNECT_VOICE", Base: true, Effective: true},
			},
		},
	}
	for _, tc := range cases {
		d, err := Explain(ActionJoinVoice, tc.s)
		if err != nil || d.Allowed != tc.allowed || len(d.Bits) != len(tc.want) {
			t.Fatalf("%s: decision = %+v, err = %v", tc.name, d, err)
		}
		for i := range tc.want {
			if d.Bits[i] != tc.want[i] {
				t.Errorf("%s: bit %d = %+v, want %+v", tc.name, i, d.Bits[i], tc.want[i])
			}
		}
	}
}

func TestExplainUnknownAction(t *testing.T) {
	if _, err := Explain("fly", Subject{}); err == nil || errors.Is(err, ErrPermissionDenied) {
		t.Fatalf("err = %v, want a non-denial error", err)
	}
}

// move_voice traces AuthorizeVoiceMover over READ_MESSAGES and MOVE_MEMBERS,
// not MUTE_MEMBERS (WP 8.4b).
func TestExplainMoveVoiceTracesMoveMembers(t *testing.T) {
	s := Subject{RolePerms: ReadMessages | MoveMembers, Channel: voice(false)}
	d, err := Explain(ActionMoveVoice, s)
	if err != nil {
		t.Fatalf("Explain(move_voice): %v", err)
	}
	if !d.Allowed {
		t.Fatalf("MOVE_MEMBERS holder denied: %+v", d)
	}
	seen := map[string]bool{}
	for _, b := range d.Bits {
		seen[b.Bit] = true
	}
	if len(d.Bits) != 2 || !seen["READ_MESSAGES"] || !seen["MOVE_MEMBERS"] {
		t.Errorf("trace bits = %+v, want READ_MESSAGES and MOVE_MEMBERS", d.Bits)
	}
	if d, _ := Explain(ActionMoveVoice, Subject{RolePerms: ReadMessages | MuteMembers, Channel: voice(false)}); d.Allowed {
		t.Errorf("MUTE_MEMBERS alone allowed to move_voice: %+v", d)
	}
	found := false
	for _, a := range Actions {
		found = found || a == ActionMoveVoice
	}
	if !found {
		t.Error("ActionMoveVoice missing from Actions")
	}
}
