package updater

import "os"

// RunningUnderSupervisor reports whether the server appears to be running
// under a process supervisor that will relaunch it after a clean exit. It
// decides how a self-restart (update apply, backup restore, setup wizard)
// hands off: under a supervisor the server just exits and lets the supervisor
// start the new binary; unsupervised it spawns the replacement itself.
//
// Detected supervisors:
//   - systemd: INVOCATION_ID is set for every process systemd starts as a
//     unit (v232+). Interactive shells are started by terminal emulators,
//     not by the service manager, so they do not carry it.
//   - NSSM: NSSM_SERVICE_NAME. NSSM 2.24 (the release the deployment docs
//     install) does NOT set this for the service process — only newer
//     pre-releases do — so NSSM deployments must set
//     OWNCORD_SERVER_RESTART_MODE=supervised explicitly (docs/deployment.md).
//     The check stays because it makes future NSSM releases work unconfigured.
//
// This is only the auto-detection half of the decision: server.restart_mode
// ("spawn"/"supervised") overrides it in both directions, and containers
// (RunningInContainer) are treated as supervised by the caller because the
// engine's restart policy is what relaunches PID 1.
func RunningUnderSupervisor() bool {
	return os.Getenv("INVOCATION_ID") != "" || os.Getenv("NSSM_SERVICE_NAME") != ""
}

// Effective self-restart handoff modes (server.restart_mode once resolved).
const (
	RestartModeSpawn      = "spawn"
	RestartModeSupervised = "supervised"
)

// ResolveRestartMode turns a server.restart_mode value into the effective
// handoff mode. Explicit "spawn"/"supervised" win; "auto" (or empty, or an
// unknown value, reported by known=false) detects: containers and supervised
// services exit for their supervisor or engine to relaunch, everything else
// spawns its own replacement.
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
