package app

import "testing"

// A sign-out seen from the services session is someone else's sign-out, so it
// is consumed; every other event still reaches the runtime and stops the
// server as before (Ctrl+C, Ctrl+Break, closing the console, shutdown), and an
// interactive session's own sign-out still drains it before the session ends.
func TestConsumeConsoleCtrl(t *testing.T) {
	const (
		ctrlC        = 0
		ctrlBreak    = 1
		ctrlClose    = 2
		ctrlShutdown = 6
	)
	for _, tc := range []struct {
		name    string
		event   uint32
		session uint32
		want    bool
	}{
		{"sign-out, services session", ctrlLogoffEvent, servicesSession, true},
		{"sign-out, interactive session", ctrlLogoffEvent, 1, false},
		{"sign-out, later interactive session", ctrlLogoffEvent, 3, false},
		{"Ctrl+C, services session", ctrlC, servicesSession, false},
		{"Ctrl+C, interactive session", ctrlC, 1, false},
		{"Ctrl+Break, services session", ctrlBreak, servicesSession, false},
		{"console closed, services session", ctrlClose, servicesSession, false},
		{"console closed, interactive session", ctrlClose, 1, false},
		{"shutdown, services session", ctrlShutdown, servicesSession, false},
		{"shutdown, interactive session", ctrlShutdown, 1, false},
	} {
		if got := consumeConsoleCtrl(tc.event, tc.session); got != tc.want {
			t.Errorf("%s: consumeConsoleCtrl(%d, %d) = %v, want %v", tc.name, tc.event, tc.session, got, tc.want)
		}
	}
}
