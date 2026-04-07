package plugin

import "errors"

// ErrRuntimeUnavailable is returned when the plugin runtime cannot start
// because the wazero build tag was not enabled. Default builds surface this
// error from Registry.LoadAll so the rest of the server can keep running.
var ErrRuntimeUnavailable = errors.New("plugin runtime: wazero build tag not enabled (build with -tags wazero to load .wasm plugins)")

// ErrPluginNotFound is returned when an operation references an unknown
// plugin id or name.
var ErrPluginNotFound = errors.New("plugin not found")

// ErrCapabilityNotGranted is returned when a host API call would require a
// capability the plugin's manifest did not declare.
var ErrCapabilityNotGranted = errors.New("plugin capability not granted")
