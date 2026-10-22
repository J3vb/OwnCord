//go:build !unix

package db

import "os"

// matchLiveOwner is a no-op where files carry no Unix owner: a renamed-in copy
// inherits the directory's access rules.
func matchLiveOwner(string, *os.File) error { return nil }
