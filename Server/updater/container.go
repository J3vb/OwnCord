package updater

import (
	"os"
	"strings"
)

// containerMarkerFiles are runtime-created markers of the two container engines
// OwnCord ships under, backing up the env var for older images.
var containerMarkerFiles = []string{
	"/.dockerenv",        // Docker
	"/run/.containerenv", // Podman
}

// RunningInContainer reports whether the server appears to run in a container
// image. OWNCORD_CONTAINER (set to 1 by the shipped Dockerfile) overrides in
// both directions: an operator who bind-mounts the binary and wants in-place
// update can set 0/false. Otherwise the engine marker files decide. In-place
// update is refused in containers because the new binary dies with the
// container and the restart comes back as the old image; upgrades are image
// pulls (docs/deployment.md).
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
