package app

import "strings"

// isAddrInUse reports whether err is an "address already in use" bind
// failure. The errno check (platform files: addrinuse_unix.go /
// addrinuse_windows.go) is authoritative; the string checks remain as a
// fallback for errors that arrive with the errno wrapped away. String
// matching alone was the original implementation and silently disabled the
// bind retry on non-English Windows, where the system error text is
// localized.
func isAddrInUse(err error) bool {
	if err == nil {
		return false
	}
	if errnoIsAddrInUse(err) {
		return true
	}
	return strings.Contains(err.Error(), "address already in use") ||
		strings.Contains(err.Error(), "Only one usage of each socket address")
}
