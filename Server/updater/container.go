package updater

import (
	"os"
	"strings"
)

// containerMarkerFiles are runtime-created markers that identify the two
// container engines OwnCord is deployed under in practice. They back up the
// env var for images built before it existed.
var containerMarkerFiles = []string{
	"/.dockerenv",        // Docker
	"/run/.containerenv", // Podman
}

// RunningInContainer reports whether the server appears to be running inside
// a container image. OWNCORD_CONTAINER is the authoritative override in both
// directions — the shipped Dockerfile sets it to 1, and an operator who
// bind-mounts the binary into a container and genuinely wants in-place
// self-update can set 0/false to opt back in. Without the variable, the
// engine marker files decide.
//
// In-place self-update is refused in containers because the running binary
// is image content: the replacement written next to it dies with the
// container, and the restart comes back as the old image. Container upgrades
// are image pulls (see docs/deployment.md).
func RunningInContainer() bool {
	if v, ok := os.LookupEnv("OWNCORD_CONTAINER"); ok {
		v = strings.TrimSpace(v)
		return v != "" && v != "0" && !strings.EqualFold(v, "false")
	}
	for _, marker := range containerMarkerFiles {
		if _, err := os.Stat(marker); err == nil {
			return true
		}
	}
	return false
}
