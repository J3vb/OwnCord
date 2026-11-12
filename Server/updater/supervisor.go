package updater

import "os"

// RunningUnderSupervisor reports whether the server appears to run under a
// supervisor that relaunches it after a clean exit, which decides whether a
// self-restart just exits or spawns the replacement itself. This is only the
// auto-detection half: server.restart_mode overrides it, and containers
// (RunningInContainer) are treated as supervised by the caller.
//
// Detected: systemd (INVOCATION_ID, set for every unit process since v232) and
// NSSM_SERVICE_NAME. NSSM 2.24, the release the deployment docs install, does
// not set it, so NSSM deployments must set OWNCORD_SERVER_RESTART_MODE=supervised
// (docs/deployment.md); the check stays for newer NSSM releases.
func RunningUnderSupervisor() bool {
	return os.Getenv("INVOCATION_ID") != "" || os.Getenv("NSSM_SERVICE_NAME") != ""
}

const (
	RestartModeSpawn      = "spawn"
	RestartModeSupervised = "supervised"
)

// ResolveRestartMode turns a server.restart_mode value into the effective mode.
// "spawn"/"supervised" win; "auto" (or empty or unknown, known=false) detects:
// containers and supervised services exit to be relaunched, others spawn.
func ResolveRestartMode(cfgVal string) (mode string, known bool) {
	switch cfgVal {
	case RestartModeSpawn, RestartModeSupervised:
		return cfgVal, true
	case "", "auto":
		known = true
	}
	if RunningInContainer() || RunningUnderSupervisor() {
		return RestartModeSupervised, known
	}
	return RestartModeSpawn, known
}
