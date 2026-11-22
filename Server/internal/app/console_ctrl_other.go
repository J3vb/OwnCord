//go:build !windows

package app

// installLogoffFilter does nothing off Windows, which has no console sign-out event.
func installLogoffFilter() (installed bool, err error) {
	return false, nil
}
