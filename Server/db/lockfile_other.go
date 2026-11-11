//go:build !linux && !darwin && !windows

package db

import "errors"

func tryLockFile(string) (func(), error) {
	return nil, errors.ErrUnsupported
}
