// Command smoke boot-smokes a built standalone server binary through the whole
// owner-visible lifecycle, not merely "does it start":
//
//  1. cold boot into an empty directory — writes config.yaml, generates a
//     self-signed certificate, migrates a fresh SQLite database;
//  2. reach healthy through the binary's own `healthcheck` subcommand;
//  3. drain on a graceful stop and exit 0 inside the drain budget;
//  4. restart against the SAME directory and reach healthy again;
//  5. with -browser-client, boot once more with the browser client enabled and
//     GET / (an HTML page with a module script) and that script from /assets/.
//
// Phase 4 covers what phase 1 cannot: a non-idempotent migration, a lock the
// drain failed to release, or state only a first boot creates. Phase 5 makes a
// release asset provably carry the browser client, which is embedded at build
// time; a build that missed it still boots and drains cleanly.
//
// It is a Go program rather than a shell script because the graceful stop is
// the point and Windows has no SIGTERM: MSYS `kill -TERM` terminates a native
// Windows binary without running the drain (exit status 143), so the harness
// uses the console control event via process-group control. See
// stop_windows.go and stop_other.go.
//
// With -upgrade it instead rehearses the upgrade an owner performs (install
// the new version over a populated install, then roll back), sharing one
// fixture across both deployment modes through the target seam in target.go.
// Usage: go run ./cmd/smoke <path-to-server-binary>
//
//	go run ./cmd/smoke -browser-client <path-to-server-binary>
//	go run ./cmd/smoke -upgrade -from <old-binary> <new-binary>
//	go run ./cmd/smoke -upgrade -docker -from <old-image> <new-image>
//	go run ./cmd/smoke -drills -data-fs <dir> <path-to-server-binary>
package main

import (
	"crypto/sha256"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const (
	// bootTimeout is generous because a cold boot also downloads the LiveKit
	// server on first run; a restart is normally healthy within a second.
	bootTimeout = 90 * time.Second
	drainBudget = 20 * time.Second
	pollEvery   = time.Second
)

func main() {
	upgrade := flag.Bool("upgrade", false, "rehearse an upgrade from -from to the positional target, then roll back out of it")
	drills := flag.Bool("drills", false, "run the failure and recovery drills (phases R, C, D, S) instead of the boot smoke")
	from := flag.String("from", "", "the version to upgrade FROM: a server binary, or an image reference with -docker")
	useDocker := flag.Bool("docker", false, "rehearse containers on a named volume instead of processes in a temporary directory")
	phases := flag.String("phases", "", "which drill phases to run — any of R, C, D, S (default: all of them)")
	dataFS := flag.String("data-fs", "", "the size-limited filesystem phase D fills; without it phase D is skipped")
	findings := flag.String("known-findings", "", "comma-separated OPEN OC-* ledger ids a release-path run may downgrade to ::warning::; the ids are validated against the ledger, but no drill failure carries a ledger id yet, so the flag is inert until one does")
	browserClient := flag.Bool("browser-client", false, "after the restart, boot with the browser client enabled and check the binary serves its bundle (plain standalone mode only)")
	flag.Usage = usage
	flag.Parse()

	// One positional argument in every mode; a mode's own flags without it
	// would silently run something else.
	if err := (invocation{
		args:       flag.Args(),
		upgrade:    *upgrade,
		drills:     *drills,
		docker:     *useDocker,
		from:       *from,
		drillFlags: *phases != "" || *dataFS != "" || *findings != "",

		browserClient: *browserClient,
	}).validate(); err != nil {
		usageError("%v", err)
	}
	args := flag.Args()

	action := func() error { return run(args[0], *browserClient) }
	summary := "standalone smoke passed: boot, migrate, healthy, drain, restart"
	if *browserClient {
		summary += ", browser client"
	}
	if *upgrade {
		action = func() error { return runUpgrade(*from, args[0], *useDocker) }
		summary = "upgrade rehearsal passed"
	}
	if *drills {
		// Usage errors, not warnings: a -phases spec selecting nothing would
		// run no drill and exit 0, and an unknown ledger id would read like a
		// flag that worked.
		selected, err := parsePhases(*phases)
		if err != nil {
			usageError("%v", err)
		}
		if *useDocker && phaseLetters(selected) != "D" {
			// The container leg is the disk-pressure half: no host install
			// directory, no port to restart through, no addressable child.
			usageError("-docker runs phase D only, got -phases %s", phaseLetters(selected))
		}
		k, err := knownFindings(*findings)
		if err != nil {
			usageError("%v", err)
		}
		action = func() error { return runDrills(args[0], *useDocker, selected, *dataFS, k) }
		// runDrills prints the summary itself: only it knows which phases
		// skipped, and a skip must not be reported as a pass.
		summary = ""
	}
	if err := action(); err != nil {
		// ::error:: is the GitHub Actions annotation prefix, as in docker-smoke.sh.
		fmt.Printf("::error::%v\n", err)
		os.Exit(1)
	}
	if summary != "" {
		fmt.Println(summary)
	}
}

// invocation is the command line as typed, checked as a whole: each of these
// combinations would otherwise run something the caller did not ask for.
type invocation struct {
	args       []string
	upgrade    bool
	drills     bool
	docker     bool
	from       string
	drillFlags bool // -phases, -data-fs or -known-findings was set

	browserClient bool // -browser-client
}

// validate names the first thing wrong with the invocation, or nil. It returns
// an error so the exit code stays in main.
func (in invocation) validate() error {
	switch {
	case len(in.args) != 1:
		return fmt.Errorf("want exactly one positional argument, got %d", len(in.args))
	case in.upgrade && in.drills:
		return fmt.Errorf("-upgrade and -drills are two different rehearsals, pick one")
	case !in.upgrade && in.from != "":
		return fmt.Errorf("-from is only meaningful together with -upgrade")
	case in.upgrade && in.from == "":
		return fmt.Errorf("-upgrade needs -from <old-binary|old-image> to upgrade from")
	case !in.upgrade && !in.drills && in.docker:
		return fmt.Errorf("-docker is only meaningful together with -upgrade or -drills")
	case !in.drills && in.drillFlags:
		return fmt.Errorf("-phases, -data-fs and -known-findings are only meaningful together with -drills")
	case in.browserClient && (in.upgrade || in.drills || in.docker):
		return fmt.Errorf("-browser-client is only meaningful in the plain standalone smoke, not with -upgrade, -drills or -docker")
	}
	return nil
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: smoke [-browser-client] <path-to-server-binary>")
	fmt.Fprintln(os.Stderr, "       smoke -upgrade -from <old-binary> <new-binary>")
	fmt.Fprintln(os.Stderr, "       smoke -upgrade -docker -from <old-image> <new-image>")
	fmt.Fprintln(os.Stderr, `       smoke -drills [-phases RCDS] [-data-fs <dir>] [-known-findings <ids>] <path-to-server-binary>`)
	fmt.Fprintln(os.Stderr, "       smoke -drills -docker -phases D <image>")
	flag.PrintDefaults()
}

// usageError exits 2, as the flag package does, so CI can tell a bad
// invocation from a smoke failure.
func usageError(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "smoke: "+format+"\n", args...)
	usage()
	os.Exit(2)
}

func run(binArg string, browserClient bool) error {
	bin, err := serverBinary(binArg)
	if err != nil {
		return err
	}

	dir, err := os.MkdirTemp("", "owncord-smoke-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(dir) }()

	fmt.Println("smoke directory:", dir)
	fmt.Println("binary:", bin)
	fmt.Println("graceful stop:", gracefulStopName)

	first, err := start(bin, dir, "boot1.log")
	if err != nil {
		return err
	}
	if err := first.waitHealthy("cold boot"); err != nil {
		return err
	}
	for _, artefact := range []string{"config.yaml", filepath.Join("data", "chatserver.db")} {
		if _, err := os.Stat(filepath.Join(dir, artefact)); err != nil {
			return first.annotate("cold boot", fmt.Errorf("first boot did not create %s", artefact))
		}
	}
	configBefore, err := hashFile(filepath.Join(dir, "config.yaml"))
	if err != nil {
		return err
	}
	fmt.Println("cold boot: config.yaml and a migrated database exist")

	if err := first.drain("drain"); err != nil {
		return err
	}
	if healthy(bin, dir) {
		return first.annotate("drain", errors.New("healthcheck still passes after shutdown"))
	}

	second, err := start(bin, dir, "boot2.log")
	if err != nil {
		return err
	}
	if err := second.waitHealthy("restart"); err != nil {
		return err
	}
	// A restart that rewrote config.yaml or re-created the database would be a
	// first boot passing for the wrong reason.
	configAfter, err := hashFile(filepath.Join(dir, "config.yaml"))
	if err != nil {
		return err
	}
	if configBefore != configAfter {
		return second.annotate("restart", errors.New("config.yaml was rewritten on restart"))
	}
	if _, err := os.Stat(filepath.Join(dir, "data", "chatserver.db")); err != nil {
		return second.annotate("restart", errors.New("database is missing after restart"))
	}
	fmt.Println("restart: reused the existing config and database")

	if err := second.drain("restart drain"); err != nil {
		return err
	}
	if !browserClient {
		return nil
	}

	return runBrowserClient(bin, dir)
}

// server is one launched instance and the log it is writing to.
type server struct {
	bin     string
	dir     string
	logPath string
	cmd     *exec.Cmd
	// waitErr carries the single os/exec Wait result; Wait may be called once,
	// so one goroutine runs it and every phase reads here.
	waitErr chan error
	exited  bool
	// adopted marks a server this harness did not spawn: the self-restart
	// replacement, which shares the log file and install directory but has no
	// *exec.Cmd. Healthcheck polling is all it supports (see awaitRestart).
	adopted bool
}

// start launches the server. extraEnv is variadic so the plain smoke inherits
// the harness environment untouched, as the release asset is deployed, while
// the rehearsal can add settings (see noLiveKitDownload).
func start(bin, dir, logName string, extraEnv ...string) (*server, error) {
	logPath := filepath.Join(dir, logName)
	logFile, err := os.Create(logPath)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(bin)
	cmd.Dir = dir
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = newProcessGroup()
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return nil, fmt.Errorf("starting server: %w", err)
	}
	s := &server{bin: bin, dir: dir, logPath: logPath, cmd: cmd, waitErr: make(chan error, 1)}
	go func() {
		s.waitErr <- cmd.Wait()
		_ = logFile.Close()
	}()
	return s, nil
}

// waitHealthy polls the binary's own healthcheck until it passes, failing early
// if the process dies rather than after the whole timeout.
func (s *server) waitHealthy(phase string) error {
	deadline := time.Now().Add(bootTimeout)
	for attempt := 1; time.Now().Before(deadline); attempt++ {
		select {
		case err := <-s.waitErr:
			s.exited = true
			return s.annotate(phase, fmt.Errorf("server exited before reporting healthy: %w", err))
		case <-time.After(pollEvery):
		}
		if healthy(s.bin, s.dir) {
			fmt.Printf("%s: healthy after %ds\n", phase, attempt)
			return nil
		}
	}
	return s.annotate(phase, fmt.Errorf("never reported healthy within %s", bootTimeout))
}

// drain sends the platform's graceful stop and asserts a clean exit inside the
// budget. The lifecycle installs signal.NotifyContext (internal/app/lifecycle.go)
// and returns nil on graceful teardown, so a killed-by-signal status means the
// drain never ran.
func (s *server) drain(phase string) error {
	started := time.Now()
	if err := stopGracefully(s.cmd.Process); err != nil {
		return s.annotate(phase, fmt.Errorf("sending %s: %w", gracefulStopName, err))
	}
	select {
	case err := <-s.waitErr:
		s.exited = true
		if err != nil {
			return s.annotate(phase, fmt.Errorf("exited with %w after %s, expected a clean exit", err, gracefulStopName))
		}
		fmt.Printf("%s: drained cleanly in %s\n", phase, time.Since(started).Round(time.Millisecond))
		return nil
	case <-time.After(drainBudget):
		_ = s.cmd.Process.Kill()
		return s.annotate(phase, fmt.Errorf("still running %s after %s", drainBudget, gracefulStopName))
	}
}

// log is everything the server has printed so far, stdout and stderr.
func (s *server) log() (string, error) {
	data, err := os.ReadFile(s.logPath)
	return string(data), err
}

// annotate wraps a phase failure with the server's log, so a CI failure carries
// the reason.
func (s *server) annotate(phase string, cause error) error {
	// An adopted server has no cmd; the kill only stops a server still writing
	// to the log being read.
	if !s.exited && s.cmd != nil {
		_ = s.cmd.Process.Kill()
	}
	log, readErr := os.ReadFile(s.logPath)
	if readErr != nil {
		log = []byte("(no log)")
	}
	return fmt.Errorf("%s: %w\n--- server log (%s) ---\n%s", phase, cause, phase, log)
}

// healthy runs the binary's healthcheck subcommand, which reads config.yaml
// from the working directory and probes /health without side effects.
func healthy(bin, dir string) bool {
	cmd := exec.Command(bin, "healthcheck")
	cmd.Dir = dir
	return cmd.Run() == nil
}

func hashFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", sha256.Sum256(data)), nil
}
