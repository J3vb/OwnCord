package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

type drill struct {
	bin    string // standalone: the server binary; container leg: the image
	dir    string
	dataFS string
	phase  string
	known  known
	docker bool

	// srv is the process the harness believes is serving; after a restore, the replacement the server spawned,
	// which this harness did not start and cannot signal (see awaitRestart).
	srv   *server
	boots int
	// container is the running container (-docker leg only): phase D needs its log and filesystem, which the
	// target seam does not expose.
	container *dockerTarget
	// skipped are phases that measured nothing because the machine could not give them what they assert on, so
	// the last line cannot report a skip as a pass.
	skipped []byte
	// partial are steps within a phase that never ran, keyed by phase; the phase names them instead of choosing
	// between passed and skipped.
	partial map[byte][]string
	letter  byte
	// dirs are the install directories this run booted in, so reclaimPort recognises a leftover replacement as
	// its own.
	dirs []string
}

func (d *drill) baseURL() string { return defaultBaseURL }

// boot launches the drill's server in its install directory and waits for it; extraEnv uses
// OWNCORD_<SECTION>_<KEY> overrides so a phase can change a setting without rewriting config.yaml.
func (d *drill) boot(logName string, extraEnv ...string) error {
	return d.bootAt(d.dir, logName, extraEnv...)
}

// bootAt is boot in another install directory (phase S's second step must not inherit step 1's config.yaml).
// data/ is created first: tls.cert_file is the relative "data/cert.pem", and a boot that moves data_dir
// (phase D) would otherwise die writing its certificate with a message about the certificate, not the missing
// directory.
func (d *drill) bootAt(dir, logName string, extraEnv ...string) error {
	d.dir = dir
	if !slices.Contains(d.dirs, dir) {
		d.dirs = append(d.dirs, dir)
	}
	d.boots++
	name := fmt.Sprintf("boot%d-%s", d.boots, logName)
	if err := os.MkdirAll(filepath.Join(dir, "data"), 0o700); err != nil {
		return err
	}
	s, err := start(d.bin, dir, name, append([]string{noLiveKitDownload, spawnRestart}, extraEnv...)...)
	if err != nil {
		return err
	}
	d.srv = s
	return s.waitHealthy(d.phase)
}

// failures reports a phase's failures: downgraded ones print a ::warning:: and
// pass, the rest fail the phase with the server's log attached.
func (d *drill) failures(problems []failure) error {
	if len(problems) == 0 {
		return nil
	}
	fail, warn := d.known.triage(problems)
	for _, f := range warn {
		fmt.Printf("::warning::%s\n", f)
	}
	if len(fail) == 0 {
		return nil
	}
	err := errors.New(failureList(fail))
	if d.srv != nil {
		return d.srv.annotate(d.phase, err)
	}
	return err
}

// awaitRestart waits out a restart the server performed on its own and points the harness at whatever comes
// next. The replacement is not this harness's child (updater.SpawnReplacement starts it detached with no PID
// file), so drain and waitErr are unavailable; what is shared is the log file and install directory
// (inherited stdout/stderr and cwd), which is all healthcheck polling needs. Hence a local server value with
// adopted set, not a method on the target seam.
func (d *drill) awaitRestart() error {
	s := d.srv
	if s == nil {
		return errors.New("no boot to wait for")
	}
	select {
	case err := <-s.waitErr:
		s.exited = true
		if err != nil {
			return s.annotate(d.phase, fmt.Errorf("the server exited with %w, want a clean exit for the restart handoff", err))
		}
	case <-time.After(drainBudget):
		return s.annotate(d.phase, fmt.Errorf("the server was still running %s after the restart was requested", drainBudget))
	}
	fmt.Printf("%s: the boot exited cleanly, waiting for the replacement\n", d.phase)
	replacement := &server{bin: d.bin, dir: d.dir, logPath: s.logPath, adopted: true, waitErr: make(chan error, 1)}
	if err := replacement.waitHealthy(d.phase + " restart"); err != nil {
		return err
	}
	d.srv = replacement
	return nil
}

type restartOutcome struct {
	booted bool
	tail   string // the log written since the restart was requested
}

// awaitUnwatchedRestart waits for a restart whose processes the harness holds no handle on, and reports
// whether a server answered the healthcheck again or the replacement died on boot and said why: the port and
// the log are all an operator has after a restore.
func (d *drill) awaitUnwatchedRestart(logOffset int64) (restartOutcome, error) {
	deadline := time.Now().Add(bootTimeout)
	// The old process must leave before anything new can bind, and until it does the healthcheck passes against
	// the leaving server.
	quiet := false
	for time.Now().Before(deadline) {
		if !serving(d.baseURL()) {
			quiet = true
			break
		}
		time.Sleep(pollEvery)
	}
	if !quiet {
		return restartOutcome{}, fmt.Errorf("something is still serving %s %s after the restore was requested", d.baseURL(), bootTimeout)
	}
	for time.Now().Before(deadline) {
		time.Sleep(pollEvery)
		tail, err := logSince(d.srv.logPath, logOffset)
		if err != nil {
			return restartOutcome{}, err
		}
		if healthy(d.bin, d.dir) {
			return restartOutcome{booted: true, tail: tail}, nil
		}
		// A replacement that cannot serve prints [ERROR] and goes quiet on the port: the boot's obituary, well
		// before the timeout.
		if strings.Contains(tail, "[ERROR]") || strings.Contains(tail, "server exited with error") {
			return restartOutcome{booted: false, tail: tail}, nil
		}
	}
	return restartOutcome{}, fmt.Errorf("neither a healthy server nor a boot failure appeared within %s", bootTimeout)
}

// logSince reads the log from offset on. The replacement shares the boot's file descriptor, so a step wanting
// only what the restart said must record the offset first.
func logSince(path string, offset int64) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return "", err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func logOffset(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// ensurePortFree fails a boot fast when something else already serves the port; otherwise a leftover
// replacement from an earlier phase would answer every healthcheck and later phases would measure it.
func (d *drill) ensurePortFree() error {
	if serving(d.baseURL()) {
		return fmt.Errorf("something is already serving %s before this phase booted anything — a previous phase left a server behind", d.baseURL())
	}
	return nil
}

// stop drains the server this harness started. A replacement cannot be drained (see awaitRestart); reporting
// that beats killing a process this harness cannot address.
func (d *drill) stop() error {
	if d.srv == nil {
		return nil
	}
	if d.srv.adopted {
		return errors.New("the server this phase ended with is a self-restart replacement, which this harness did not spawn and cannot drain")
	}
	return d.srv.drain(d.phase)
}

const (
	// drillPassword is the throwaway accounts' password; an invite-mode install validates only its length
	// (8-72), on a temp install never reachable off loopback.
	drillPassword = "drill-passphrase" //nolint:gosec // throwaway accounts on a temp-dir server

	// markerRelPath is the deletion-marker file under the data directory (internal/app/erasure.go), spelled here
	// because importing app would drag in the whole server.
	markerRelPath = "erasure/markers.sqlite"

	erasureKeyRelPath = "erasure.key"

	victimMessages = 10

	restartSockets = 20
)

// dataDir is server.data_dir (default "data" under the install directory);
// database.path, backup.dir and upload.storage_dir default to children of it.
func (d *drill) dataDir() string    { return filepath.Join(d.dir, "data") }
func (d *drill) backupDir() string  { return filepath.Join(d.dataDir(), "backups") }
func (d *drill) uploadsDir() string { return filepath.Join(d.dataDir(), "uploads") }

// annotate wraps a failure with the log of whatever is serving, on either leg.
// A phase failure that carries only a symptom is not diagnosable from CI.
func (d *drill) annotate(cause error) error {
	if d.container != nil {
		return d.container.annotate(d.phase, cause)
	}
	if d.srv != nil {
		return d.srv.annotate(d.phase, cause)
	}
	return cause
}

func (d *drill) setup() (string, error) {
	var serverLog string
	var err error
	switch {
	case d.container != nil:
		serverLog, err = d.container.log()
	case d.srv != nil:
		serverLog, err = d.srv.log()
	default:
		err = errors.New("no server to read a setup token from")
	}
	if err != nil {
		return "", err
	}
	return runSetup(d.baseURL(), serverLog)
}

func (d *drill) logText() (string, error) {
	if d.container != nil {
		return docker("logs", d.container.name)
	}
	if d.srv == nil {
		return "", errors.New("no server to read a log from")
	}
	data, err := os.ReadFile(d.srv.logPath)
	return string(data), err
}

func (d *drill) backupFile(name string) (string, error) {
	if d.container == nil {
		return filepath.Join(d.dataFS, "backups", name), nil
	}
	dir, err := os.MkdirTemp("", "owncord-drill-backup-")
	if err != nil {
		return "", err
	}
	if err := d.container.copyOut(containerData+"/backups/"+name, dir); err != nil {
		return "", err
	}
	return filepath.Join(dir, name), nil
}

const (
	// drillTmpfsBytes is the filesystem phase D fills (24 MiB tmpfs standalone, --tmpfs size=24m in the
	// container); declared, not measured, since a container's tmpfs cannot be stat'ed from the host.
	drillTmpfsBytes = 24 << 20

	// drillMinFreeDiskMB is the boot's server.min_free_disk_mb floor, which /health reports and uploads reserve,
	// so crossing it once makes both observable.
	drillMinFreeDiskMB = 8

	// drillHeadroomFirstFill is the tmpfs minus a margin that leaves free space in the headroom window (under 8
	// MiB, above 2 MiB) after the server's own files; later fills top up until /health agrees.
	drillHeadroomFirstFill = 17 << 20

	drillFillStep = 1 << 20

	// drillFillCap bounds everything phase D writes, so a -data-fs mistake (a real disk) fails instead of
	// filling it.
	drillFillCap = 64 << 20

	// drillJunkName names the junk file (or container file prefix) so a leftover from a killed run is
	// recognisable.
	drillJunkName = "drill-junk"

	drillFullSends = 50

	// drillFullSendPause spaces the full stage's sends: the precheck allows ten chat sends per user per second
	// (service.sendMessageRateGate) and answers RATE_LIMITED before reading the channel, so a fast loop would
	// measure the drill's pacing, not the filesystem. 120ms is eight a second.
	drillFullSendPause = 120 * time.Millisecond

	// The two WS error codes phases D and S must tell apart by name, spelled here because importing ws would
	// drag in the whole server (as markerRelPath); they mirror Server/ws/errors.go. errCodeVoiceError is what
	// the LiveKit-process guard answers; it is also the code for "voice is not configured", which the post-kill
	// probe cannot reach: a join completes first, so h.livekit is non-nil.
	errCodeRateLimited = "RATE_LIMITED"
	errCodeVoiceError  = "VOICE_ERROR"

	// drillVictim and drillNewcomer are the accounts phase R registers: the one it erases, and one created after
	// the backup so the restore has newer data to drop.
	drillVictim   = "drill-victim"
	drillNewcomer = "drill-newcomer"

	// healthCacheWait bounds a wait for /health to show the disk state (the endpoint caches five seconds,
	// api/router.go healthCacheTTL).
	healthCacheWait = 8 * time.Second

	pollInterval = 250 * time.Millisecond

	// configFailBudget is how long a boot on a broken config.yaml may take before the delay is the finding.
	configFailBudget = 5 * time.Second

	// restartBroadcastBudget is how long sessions get to receive server_restart; generous because the frame is
	// buffered per connection before the process exits.
	restartBroadcastBudget = 10 * time.Second

	// restartWindow is how long the post-kill probe may keep asking while the managed SFU is down; the
	// supervisor's first restart is after a 3 second backoff (livekitproc.Process), so the window stays inside
	// it.
	restartWindow = 2500 * time.Millisecond

	// voiceProbePause spaces the post-kill voice_join probe: voice_join is capped at five attempts per user per
	// second (ws.voiceJoinRateLimit), checked before the guard, so a faster probe collects its own RATE_LIMITED
	// frames. 300ms gives ~8 attempts across restartWindow.
	voiceProbePause = 300 * time.Millisecond

	// supervisorRestartBudget is how long the managed SFU's first restart gets: the 3 second backoff plus the
	// child's boot, with room for a loaded CI machine.
	supervisorRestartBudget = 30 * time.Second

	// registerRateLimitPerMinute is the API's registration cap per IP per minute (api/constants.go), quoted in
	// phase R's output so the scaling reads as deliberate.
	registerRateLimitPerMinute = 3

	// drillAuthRateScale is security.auth_rate_limit_multiplier for phase R's boot: 20 accounts at 3 a minute
	// per IP would take seven minutes. It is the documented knob for many users behind one address, and nothing
	// phase R asserts goes through the auth rate limiter.
	drillAuthRateScale = 40
)

// configLinePattern is the file-and-line the broken-config step asserts (YAML's "yaml: line 3: ..." is what
// the operator needs).
var configLinePattern = regexp.MustCompile(`(?i)\bline \d+`)
