//go:build !windows && !darwin

package app

// maxSoftFileLimit is the highest soft limit setrlimit accepts under hard,
// which outside macOS is the hard limit itself.
func maxSoftFileLimit(hard uint64) uint64 { return hard }
