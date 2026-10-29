package admin

// The browser client portal's start-up warnings, beside
// support_event_codes.go because that table is at the file-size ceiling.
func init() {
	supportEventCodes["server.browser_client_enabled is set, but this build does not include the browser client — GET / answers 404 until a build that carries it is installed"] = "server_browser_client_not_in_build"
	supportEventCodes["server.browser_client_enabled is set with tls.mode self_signed — browsers warn about the certificate before the browser client loads, and phone browsers may refuse it"] = "server_browser_client_self_signed"
}
