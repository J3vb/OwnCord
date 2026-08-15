// Package diskutil reports free disk space for a path, with per-OS
// implementations behind build tags. Consumers treat errors (including
// ErrUnsupported on exotic platforms) as "unknown", never as "full".
package diskutil

import "errors"

// ErrUnsupported is returned on platforms without an implementation.
var ErrUnsupported = errors.New("diskutil: free-space query not supported on this platform")
