// Command smoke boot-smokes a built standalone server binary through the whole
// owner-visible lifecycle, not merely "does it start":
//
//  1. cold boot into an empty directory — writes config.yaml, generates a
//     self-signed certificate, migrates a fresh SQLite database;
//  2. reach healthy through the binary's own `healthcheck` subcommand;
//  3. drain on a graceful stop and exit 0 inside the drain budget;
//  4. restart against the SAME directory and reach healthy again.
//
// Phase 4 is the one phase 1 cannot cover: a non-idempotent migration, a lock
// the drain failed to release, or state only a first boot creates. That is the
// difference between "the asset runs" and "an owner can operate it", which is
// what B6-1 has to prove.
//
// It is a Go program rather than a shell script because the graceful stop is
// the whole point and Windows has no SIGTERM. MSYS `kill -TERM` cannot deliver
// a POSIX signal to a native Windows binary — it terminates it, and the drain
// never runs (observed: exit status 143). Sending the console control event the
// OS actually offers needs process-group control, so the harness lives where
// that is expressible. See stop_windows.go and stop_other.go.
//
// Usage: go run ./cmd/smoke <path-to-server-binary>
package main

import (
	"crypto/sha256"
	"errors"
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
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: smoke <path-to-server-binary>")
		os.Exit(2)
	}
	if err := run(os.Args[1]); err != nil {
		// ::error:: is the GitHub Actions annotation prefix, matching
		// docker-smoke.sh so a failure is surfaced on the run summary.
		fmt.Printf("::error::%v\n", err)
		os.Exit(1)
	}
	fmt.Println("standalone smoke passed: boot, migrate, healthy, drain, restart")
}

func run(binArg string) error {
	bin, err := filepath.Abs(binArg)
	if err != nil {
		return err
	}
	// The server runs with its own directory as the working directory, so the
	// binary must be addressed absolutely or it would resolve against that.
	info, err := os.Stat(bin)
	if err != nil {
		return fmt.Errorf("%s is not readable: %w", binArg, err)
	}
	if info.IsDir() {
		return fmt.Errorf("%s is a directory, not a server binary", binArg)
	}

	dir, err := os.MkdirTemp("", "owncord-smoke-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(dir) }()

	fmt.Println("smoke directory:", dir)
	fmt.Println("binary:", bin)
	fmt.Println("graceful stop:", gracefulStopName)

	// --- Phases 1 and 2: cold boot into an empty directory, reach healthy ---
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

	// --- Phase 3: graceful drain -------------------------------------------
	if err := first.drain("drain"); err != nil {
		return err
	}
	if healthy(bin, dir) {
		return first.annotate("drain", errors.New("healthcheck still passes after shutdown"))
	}

	// --- Phase 4: restart on the SAME data directory ------------------------
	second, err := start(bin, dir, "boot2.log")
	if err != nil {
		return err
	}
	if err := second.waitHealthy("restart"); err != nil {
		return err
	}
	// A restart that rewrote config.yaml or re-created the database would be a
	// first boot wearing a restart's clothes, and would pass this phase for the
	// wrong reason. Both must be the files phase 1 left behind.
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

	return second.drain("restart drain")
}

// server is one launched instance and the log it is writing to.
type server struct {
	bin     string
	dir     string
	logPath string
	cmd     *exec.Cmd
	// waitErr carries the single permitted os/exec Wait result. Wait may only
	// be called once, so it runs in one goroutine and every phase reads here.
	waitErr chan error
	exited  bool
}

func start(bin, dir, logName string) (*server, error) {
	logPath := filepath.Join(dir, logName)
	logFile, err := os.Create(logPath)
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(bin)
	cmd.Dir = dir
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
// if the process dies first — a server that exits during boot would otherwise
// only be reported once the whole timeout elapsed.
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
// budget. A clean exit is the assertion that matters: the lifecycle installs
// signal.NotifyContext(os.Interrupt, syscall.SIGTERM) (internal/app/lifecycle.go)
// and returns nil on a graceful teardown, so a killed-by-signal status would
// mean the drain never ran.
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

// annotate wraps a phase failure with the server's log, so a CI failure carries
// the reason rather than only the symptom.
func (s *server) annotate(phase string, cause error) error {
	if !s.exited {
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
