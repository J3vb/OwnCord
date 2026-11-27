package app

// ctrlLogoffEvent is Windows' CTRL_LOGOFF_EVENT, spelled here so the decision below builds and tests on
// every platform.
const ctrlLogoffEvent = 5

// servicesSession is the Windows session that services and non-interactive scheduled tasks run in. No user
// signs in to it, so a sign-out event seen there is always another session's.
const servicesSession = 0

// consumeConsoleCtrl reports whether a Windows console control event is consumed before the Go runtime turns
// it into SIGTERM. Only a sign-out seen from the services session is: Windows sends it to every console
// process there whenever any user signs out of the machine, and the server keeps running for everyone else.
// Ctrl+C, Ctrl+Break, closing the console and shutdown still stop the server, and in an interactive session
// a sign-out still drains it, since that session is ending.
func consumeConsoleCtrl(event, session uint32) bool {
	return event == ctrlLogoffEvent && session == servicesSession
}
