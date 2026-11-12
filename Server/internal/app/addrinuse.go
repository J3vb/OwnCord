package app

import "strings"

// isAddrInUse reports whether err is an "address already in use" bind failure.
// The errno check is authoritative; the string match is a fallback, since text
// alone fails on localized Windows.
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
