package main

import "testing"

func TestSetupTokenIn(t *testing.T) {
	boot := func(token string) string {
		return "    Press Ctrl+C to stop the server.\n\n" +
			"   ─────────────────────────────────────────────\n" +
			"    Setup token  " + token + "\n" +
			"   ─────────────────────────────────────────────\n" +
			`{"level":"INFO","msg":"listening"}` + "\n"
	}
	cases := map[string]struct{ log, want string }{
		"one boot":              {boot("ABC234DEF"), "ABC234DEF"},
		"restart prints a new":  {boot("FIRST") + boot("SECOND"), "SECOND"},
		"release with no token": {`{"level":"INFO","msg":"listening"}` + "\n", ""},
	}
	for name, c := range cases {
		if got := setupTokenIn(c.log); got != c.want {
			t.Errorf("%s: setupTokenIn = %q, want %q", name, got, c.want)
		}
	}
}
