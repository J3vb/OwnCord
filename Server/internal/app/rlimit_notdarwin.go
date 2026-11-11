//go:build !windows && !darwin

package app

// maxSoftFileLimit is the hard limit itself outside macOS.
func maxSoftFileLimit(hard uint64) uint64 { return hard }
