package plugin

import "errors"

// ErrRuntimeUnavailable is returned when the wazero build tag is off; LoadAll
// surfaces it so the rest of the server keeps running.
var ErrRuntimeUnavailable = errors.New("plugin runtime: wazero build tag not enabled (build with -tags wazero to load .wasm plugins)")

// ErrPluginNotFound is returned when an operation references an unknown
// plugin id or name.
var ErrPluginNotFound = errors.New("plugin not found")

// ErrCapabilityNotGranted is returned when a host API call would require a
// capability the plugin's manifest did not declare.
var ErrCapabilityNotGranted = errors.New("plugin capability not granted")

// ErrCommandNotDeclared is returned when a plugin binds a command its manifest
// did not list; the manifest is the authority.
var ErrCommandNotDeclared = errors.New("plugin command not declared in manifest")
