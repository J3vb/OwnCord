package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	_ "modernc.org/sqlite" // the same pure-Go driver the server uses, registered as "sqlite"
)

// ─── the -drills run ────────────────────────────────────────────────────────
//
// B6-11's drills ask the questions the Go unit tests in db/ cannot: a real
// process that really restarts itself, a real filesystem that really fills, a
// real child process that really dies. The Go tests prove the mechanisms on a
// copy; these phases prove the install an owner operates.
//
// Four phases, each with its own install directory:
//
//	R  backup, restore, deletion markers      (drills 1 and 2)
//	C  corrupt operator input                  (drill 5, process half)
//	D  headroom, then full, then recovery      (drills 3 and 4)
//	S  the SFU                                 (drill 6)
//
// Nothing here relaunches the server. Each phase boots it and, where a phase
// needs a restart, it asks the server for one through the same endpoint an
// owner uses and then waits for whatever the restart produced — which is the
// behaviour under test rather than a rehearsal of it.

// phase is one drill phase: the letter -phases selects it by, and what it
// covers (printed so a green run says what it ran).
type phase struct {
	letter byte
	what   string
}

var drillPhases = []phase{
	{'R', "backup, restore, deletion markers"},
	{'C', "corrupt operator input"},
	{'D', "headroom, then full, then recovery"},
	{'S', "the SFU"},
}

// parsePhases turns -phases into the phases to run, in the order they are
// numbered rather than the order they were typed: a phase may depend on what
// an earlier one left behind, and the numbering is the only order that is
// known to be correct.
//
// An empty spec means all of them. A spec that selects nothing — no letters at
// all — is an error rather than an empty run, because a run that executes no
// drill exits 0 and reads exactly like a run that passed every drill.
func parsePhases(spec string) ([]phase, error) {
	asked := make([]byte, 0, len(drillPhases))
	for _, r := range spec {
		switch r {
		case ',', ' ', '\t':
			continue
		}
		if !slices.ContainsFunc(drillPhases, func(p phase) bool { return p.letter == byte(r) }) {
			return nil, fmt.Errorf("unknown phase %q, want any of %s", string(r), allPhaseLetters())
		}
		asked = append(asked, byte(r))
	}
	if spec != "" && len(asked) == 0 {
		return nil, fmt.Errorf("no phase letters in %q, want any of %s", spec, allPhaseLetters())
	}
	out := make([]phase, 0, len(drillPhases))
	for _, p := range drillPhases {
		if spec == "" || slices.Contains(asked, p.letter) {
			out = append(out, p)
		}
	}
	return out, nil
}

// phaseLetters prints a phase list as the letters -phases takes.
func phaseLetters(phases []phase) string {
	out := make([]byte, 0, len(phases))
	for _, p := range phases {
		out = append(out, p.letter)
	}
	return string(out)
}

func allPhaseLetters() string {
	letters := make([]string, 0, len(drillPhases))
	for _, p := range drillPhases {
		letters = append(letters, string(p.letter))
	}
	return strings.Join(letters, ", ")
}

// ─── known findings ─────────────────────────────────────────────────────────

// ledgerRow is the part of a .superpowers/findings-ledger.json row this
// harness reads. Two fields, because those are the two the flag is validated
// against and nothing here is a ledger tool.
type ledgerRow struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

// ledger is the part of the findings ledger this harness reads.
type ledger struct {
	Findings []ledgerRow `json:"findings"`
}

// ledgerPaths is where the tracked ledger is looked for, in order: the workflow
// runs this harness from Server/, a developer may run it from the repository
// root. An id the ledger cannot be checked against is a usage error (see
// newKnown), so a path that quietly resolved to nothing would disable the
// flag's validation rather than fail it.
var ledgerPaths = []string{
	filepath.Join("..", ".superpowers", "findings-ledger.json"),
	filepath.Join(".superpowers", "findings-ledger.json"),
}

func parseLedger(data []byte) (ledger, error) {
	var l ledger
	if err := json.Unmarshal(data, &l); err != nil {
		return ledger{}, fmt.Errorf("parsing the findings ledger: %w", err)
	}
	return l, nil
}

func readLedger() (ledger, error) {
	for _, path := range ledgerPaths {
		data, err := os.ReadFile(path)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return ledger{}, fmt.Errorf("reading the findings ledger: %w", err)
		}
		l, err := parseLedger(data)
		if err != nil {
			return ledger{}, fmt.Errorf("%s: %w", path, err)
		}
		return l, nil
	}
	return ledger{}, fmt.Errorf("the findings ledger is in none of %v", ledgerPaths)
}

func (l ledger) find(id string) (ledgerRow, bool) {
	for _, row := range l.Findings {
		if row.ID == id {
			return row, true
		}
	}
	return ledgerRow{}, false
}

// known is the -known-findings flag: the ledger ids this run may downgrade a
// failure to a warning for.
//
// The flag is currently inert by construction. triage downgrades only a failure
// that carries an id, no failure construction in this file sets one, and the
// ledger holds no open row a drill could name — so every run that can pass
// validation today downgrades nothing. That is deliberate rather than
// unfinished: R12 keeps an unfixed security-adjacent finding out of the tracked
// ledger and R13 forbids inventing an id for one, so there is nothing honest to
// name yet. Read the flag as a gate being prepared, never as a gate that is
// holding something open.
type known struct {
	// ids are the OPEN ledger ids the flag named.
	ids map[string]bool
	// release reports whether this run is the release (workflow_call) path.
	// Only there is a known id downgraded: the nightly and dispatch runs fail
	// on exactly the same phase, so a finding cannot hide behind the flag on
	// the runs that exist to find it.
	release bool
}

// newKnown validates the flag against the ledger. An id the ledger does not
// list, or lists as anything but open, is refused rather than ignored: ignored,
// it would downgrade nothing and read exactly like a flag that worked — and a
// fixed finding left in the list would become a permanent hole in the gate the
// moment it was repaired (R14).
func newKnown(spec string, l ledger, release bool) (known, error) {
	k := known{ids: map[string]bool{}, release: release}
	for id := range strings.SplitSeq(spec, ",") {
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		row, ok := l.find(id)
		if !ok {
			return known{}, fmt.Errorf("-known-findings names %s, which is not in the findings ledger", id)
		}
		if row.Status != "open" {
			return known{}, fmt.Errorf("-known-findings names %s, which the ledger lists as %s, not open", id, row.Status)
		}
		k.ids[id] = true
	}
	return k, nil
}

// knownFindings is -known-findings as the run uses it. The ledger is read only
// when the flag names something, so a run without the flag cannot fail because
// the ledger was not where it was expected — and the flag is empty on every run
// that is not a release rehearsal (task 4 gates the steps).
func knownFindings(spec string) (known, error) {
	if strings.TrimSpace(spec) == "" {
		return known{ids: map[string]bool{}, release: releasePath()}, nil
	}
	l, err := readLedger()
	if err != nil {
		return known{}, err
	}
	return newKnown(spec, l, releasePath())
}

// releasePath reports whether this run is the release rehearsal. The workflow
// calls the rehearsal through workflow_call, so that is the one event name the
// downgrade is allowed on.
func releasePath() bool { return os.Getenv("GITHUB_EVENT_NAME") == "workflow_call" }

// failure is one thing a drill measured that the milestone says must not
// happen. id names the ledger finding it is an instance of, when the drill
// knows of one: a failure with no id is new by definition and always fails.
type failure struct {
	id   string
	what string
}

func (f failure) String() string {
	if f.id == "" {
		return "drill failure: " + f.what
	}
	return "drill failure [" + f.id + "]: " + f.what
}

func failureList(failures []failure) string {
	lines := make([]string, 0, len(failures))
	for _, f := range failures {
		lines = append(lines, f.String())
	}
	return strings.Join(lines, "\n")
}

// triage splits a phase's failures into the ones that fail this run and the
// ones the release path downgrades to a ::warning::. A failure is downgraded
// only when the flag named its id AND this is the release path: the flag is
// what authorises it, and the release path is the only place the owner asked
// for it (question 5).
func (k known) triage(failures []failure) (fail, warn []failure) {
	for _, f := range failures {
		if f.id != "" && k.release && k.ids[f.id] {
			warn = append(warn, f)
			continue
		}
		fail = append(fail, f)
	}
	return fail, warn
}

// ─── the run ────────────────────────────────────────────────────────────────

// runDrills runs the phases -phases selected. The phases run in one process and
// in the numbered order; each gets its own install directory, because a phase
// that breaks a credential or fills a filesystem must not leave that behind for
// the next one.
func runDrills(binRef string, useDocker bool, phases []phase, dataFS string, k known) error {
	d := &drill{bin: binRef, dataFS: dataFS, known: k, docker: useDocker}

	// One phase leaves a server running only when it failed to leave the state
	// it wanted (a replacement that booted when it should have refused), and
	// the next phase would then measure that process instead of its own. Named
	// here so the failure reads as what it is rather than as a port conflict.
	if useDocker {
		fmt.Printf("drills: container leg, phase %s, image %s\n", phaseLetters(phases), binRef)
	} else {
		bin, err := serverBinary(binRef)
		if err != nil {
			return err
		}
		d.bin = bin
		fmt.Println("drills:", phaseLetters(phases), "against", bin)
	}

	for _, p := range phases {
		if err := d.runPhase(p); err != nil {
			return err
		}
	}
	// Printed here rather than by main, because a phase that skipped is not a
	// pass and the run's last line is where that has to be legible: "phase D:
	// passed" over a skip is the read the brief's gotcha forbids.
	fmt.Println(d.summary(phases))
	return nil
}

// summary is the run's last line. It exists as a function for the same reason
// verdict does: a reader who skims past the per-phase lines reads only this one,
// so a step that did not run has to be legible here too — and a green run is
// exactly when nobody notices that it is not.
func (d *drill) summary(phases []phase) string {
	ran := make([]byte, 0, len(phases))
	for _, p := range phases {
		if !slices.Contains(d.skipped, p.letter) {
			ran = append(ran, p.letter)
		}
	}
	summary := "failure and recovery drills passed"
	if len(ran) > 0 {
		summary += ": phase " + string(ran)
	}
	if len(d.skipped) > 0 {
		summary += fmt.Sprintf(" (%s skipped — no measurement was made)", string(d.skipped))
	}
	// A step-level skip is not a pass, so the run's last line carries it too: a
	// reader who skips the per-step output and reads only this line still learns
	// that part of a phase never ran.
	var never []string
	for _, p := range phases {
		for _, step := range d.partial[p.letter] {
			never = append(never, fmt.Sprintf("phase %c: %s", p.letter, step))
		}
	}
	if len(never) > 0 {
		summary += " (" + strings.Join(never, "; ") + ")"
	}
	return summary
}

func (d *drill) runPhase(p phase) error {
	d.phase = fmt.Sprintf("phase %c", p.letter)
	d.letter = p.letter
	// Each phase owns its install directory. Phase R's restores leave a
	// replacement process behind when it boots, and that process holds both
	// the directory and the port, so the directory is not removed here — the
	// process may still be writing to it. It is under the OS temp directory
	// and the next run uses a fresh one.
	dir, err := os.MkdirTemp("", "owncord-drill-")
	if err != nil {
		return err
	}
	d.dir = dir
	d.srv = nil

	var runErr error
	switch p.letter {
	case 'R':
		runErr = d.phaseR()
	case 'C':
		runErr = d.phaseC()
	case 'D':
		runErr = d.phaseD()
	case 'S':
		runErr = d.phaseS()
	default:
		// parsePhases only yields letters in drillPhases, so this is a bug
		// rather than input; it fails loudly instead of skipping silently.
		runErr = fmt.Errorf("phase %q has no implementation", string(p.letter))
	}
	if runErr != nil {
		return fmt.Errorf("phase %c (%s): %w", p.letter, p.what, runErr)
	}
	if line := d.verdict(p); line != "" {
		fmt.Println(line)
	}
	return nil
}

// verdict is the line a completed phase prints, or "" for a phase that must
// print none. Every branch of it exists to keep one word off that line —
// "passed" — for work that did not run, which is the brief's gotcha and the
// reason the skip machinery exists at all. It is a function rather than three
// prints at their call sites so a test can hold that, since nothing in a green
// run can.
func (d *drill) verdict(p phase) string {
	if slices.Contains(d.skipped, p.letter) {
		// No line: the phase measured nothing, and the run's summary is the one
		// place that says so.
		return ""
	}
	if steps := d.partial[p.letter]; len(steps) > 0 {
		// The rest of the phase measured, so neither word alone is true. Name
		// the step, and the reason, on the line a reader skims.
		return fmt.Sprintf("phase %c (%s): passed, except %s", p.letter, p.what, strings.Join(steps, "; except "))
	}
	return fmt.Sprintf("phase %c (%s): passed", p.letter, p.what)
}

// skipStep records a step that did not run and prints why. Recording is the
// half that matters: without it the phase's verdict is computed as though the
// step had passed, which is how a whole brief step once went unexecuted behind
// a green run.
func (d *drill) skipStep(reason string) {
	if d.partial == nil {
		d.partial = make(map[byte][]string)
	}
	d.partial[d.letter] = append(d.partial[d.letter], reason)
	fmt.Printf("%s: skipped — %s\n", d.phase, reason)
}

// drill is one phase's state: the artefact under test, the install directory it
// serves from, the server this harness believes is answering on the port, and
// the phase string every failure is labelled with.
type drill struct {
	bin    string // standalone: the server binary; container leg: the image
	dir    string
	dataFS string
	phase  string
	known  known
	docker bool

	// srv is the process the harness believes is serving. After a restore it is
	// the replacement the server spawned, which this harness did not start and
	// cannot signal (see awaitRestart).
	srv   *server
	boots int
	// container is the running container, on the -docker leg only: phase D
	// needs its log and its filesystem, which the target seam's methods do not
	// expose (they are the upgrade rehearsal's vocabulary, not the drill's).
	container *dockerTarget
	// skipped are the phases that measured nothing because the machine could
	// not give them what they assert on. Collected so the run's own last line
	// cannot report a skip as a pass.
	skipped []byte
	// partial are the steps within a phase that never ran, keyed by phase. A
	// step-level skip is neither a pass nor a phase skip: the phase's other
	// steps did measure, so the phase has to name the part of itself that did
	// not happen rather than choosing between "passed" and "skipped".
	partial map[byte][]string
	// letter is the running phase's letter, so a step can record its own skip
	// without being handed it.
	letter byte
}

func (d *drill) baseURL() string { return defaultBaseURL }

// boot launches the drill's server in its install directory and waits for it.
// extraEnv is the config-override channel the rehearsal already uses
// (OWNCORD_<SECTION>_<KEY>), so a phase can change a setting without rewriting
// the config.yaml it is about to measure.
func (d *drill) boot(logName string, extraEnv ...string) error {
	return d.bootAt(d.dir, logName, extraEnv...)
}

// bootAt is boot in another install directory, which phase S's second step
// needs: an install told to use an SFU somebody else manages must not inherit
// the config.yaml step 1's boot wrote, or it is the same install asked twice.
//
// The install directory's own data/ is created first, and it is not redundant:
// config.yaml ships tls.cert_file as "data/cert.pem", relative to the WORKING
// directory rather than to server.data_dir, and a boot that moves data_dir
// (phase D) is exactly the boot that stops the server creating this one. Left
// out, that boot dies writing its self-signed certificate — before it can
// measure any disk pressure, and with a message about a certificate rather than
// about the directory that is missing.
func (d *drill) bootAt(dir, logName string, extraEnv ...string) error {
	d.dir = dir
	d.boots++
	name := fmt.Sprintf("boot%d-%s", d.boots, logName)
	if err := os.MkdirAll(filepath.Join(dir, "data"), 0o700); err != nil {
		return err
	}
	s, err := start(d.bin, dir, name, append([]string{noLiveKitDownload}, extraEnv...)...)
	if err != nil {
		return err
	}
	d.srv = s
	return s.waitHealthy(d.phase)
}

// failures reports a phase's failures: the ones the release path downgrades
// print a ::warning:: and pass, everything else fails the phase with the
// server's log attached — the log is what makes a failure diagnosable from CI.
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

// awaitRestart waits out a restart the server performed on its own, and points
// the harness at whatever comes next.
//
// D9: the replacement is not this harness's child. updater.SpawnDetached starts
// it detached — its own session on Unix, a detached process on Windows — and
// there is no PID file to find it by, so `drain` and `waitErr` are both
// unavailable for it. What IS shared is the log file (the replacement inherits
// the parent's stdout/stderr) and the install directory (it inherits its cwd),
// which is all `server` needs for healthcheck polling. The harness's notion of
// "the running server" is therefore a local `server` value with adopted set,
// not a new method on the target seam: the seam describes an install, and this
// is about one process the harness will never own.
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

// restartOutcome is what a restart this harness did not spawn produced.
type restartOutcome struct {
	booted bool
	tail   string // the log written since the restart was requested
}

// awaitUnwatchedRestart waits for a restart whose processes the harness holds no
// handle on, and reports which of the two things happened: a server answered
// the healthcheck again, or the replacement died on boot and said why.
//
// The port and the log are the only evidence available, which is exactly why
// phases R's last two steps use this: what an operator has after a restore is
// also only the port and the log.
func (d *drill) awaitUnwatchedRestart(logOffset int64) (restartOutcome, error) {
	deadline := time.Now().Add(bootTimeout)
	// The old process has to leave before anything new can bind, and until it
	// does the healthcheck still passes — against the server that is leaving.
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
		// The binary prints [ERROR] and "server exited with error" on any
		// lifecycle return, and a replacement that cannot serve has already
		// gone quiet on the port: the two together are the boot's obituary,
		// well before the full timeout is worth waiting out.
		if strings.Contains(tail, "[ERROR]") || strings.Contains(tail, "server exited with error") {
			return restartOutcome{booted: false, tail: tail}, nil
		}
	}
	return restartOutcome{}, fmt.Errorf("neither a healthy server nor a boot failure appeared within %s", bootTimeout)
}

// logSince reads the log from offset on. The replacement writes to the same
// file the boot wrote to (it inherits the file descriptor), so a step that
// wants to read only what the RESTART said has to remember where the file
// ended before the restart was requested.
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

// logOffset is the log's current size — what logSince wants recorded before a
// restart is requested.
func logOffset(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// ensurePortFree fails a boot fast when something else is already serving the
// port. Without it a leftover replacement from an earlier phase would answer
// every later healthcheck and every later phase would measure that process.
func (d *drill) ensurePortFree() error {
	if serving(d.baseURL()) {
		return fmt.Errorf("something is already serving %s before this phase booted anything — a previous phase left a server behind", d.baseURL())
	}
	return nil
}

// stop drains the server this harness started, when it started it. A
// replacement cannot be drained (see awaitRestart); reporting that is better
// than killing a process this harness cannot address.
func (d *drill) stop() error {
	if d.srv == nil {
		return nil
	}
	if d.srv.adopted {
		return errors.New("the server this phase ended with is a self-restart replacement, which this harness did not spawn and cannot drain")
	}
	return d.srv.drain(d.phase)
}

// ─── HTTP, against the running server ───────────────────────────────────────

// get decodes a 200 response.
func get(path string, token string, out any) error {
	return request(http.MethodGet, defaultBaseURL+path, token, "", nil, http.StatusOK, out)
}

// wantStatus issues a request whose status is the assertion, without decoding a
// body.
func wantStatus(method, path, token string, status int) error {
	return request(method, defaultBaseURL+path, token, "", nil, status, nil)
}

// healthBody is GET /health's shape: unauthenticated, so the reason names a
// subsystem and nothing more.
type healthBody struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

// healthOf reads /health, decoding the body on 200 AND on 503 — a degraded
// server answers 503 with the reason this drill is asserting, so a helper that
// only decoded 200 would report the drill's own expectation as a transport
// failure.
func healthOf() (healthBody, int, error) {
	req, err := http.NewRequest(http.MethodGet, defaultBaseURL+"/health", nil) //nolint:noctx // bounded by the client Timeout
	if err != nil {
		return healthBody{}, 0, err
	}
	resp, err := fixtureClient.Do(req)
	if err != nil {
		return healthBody{}, 0, fmt.Errorf("reading /health: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	var body healthBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return healthBody{}, resp.StatusCode, fmt.Errorf("decoding /health: %w", err)
	}
	return body, resp.StatusCode, nil
}

// auditLog reads the audit log through the same endpoint the admin panel uses.
func auditLog(token string) ([]auditRow, error) {
	var rows []auditRow
	if err := get("/admin/api/audit-log?limit=200", token, &rows); err != nil {
		return nil, fmt.Errorf("reading the audit log: %w", err)
	}
	return rows, nil
}

// auditRow is the part of db.AuditEntry this drill reads.
type auditRow struct {
	Action       string `json:"action"`
	Detail       string `json:"detail"`
	SubjectToken string `json:"subject_token"`
}

// livekitHealth reads the diagnostics endpoint's view of the SFU.
//
// D10: the endpoint is /api/v1/diagnostics/connectivity, NOT /api/v1/diagnostics
// (which does not exist). It is administrator-gated and rate-limited to five
// requests a minute, so it is called once per phase and never in a retry loop —
// a 429 read as "the SFU is down" would invert what phase S asserts. The field
// is voice.livekit_health; livekit_healthy is a different field on the metrics
// endpoint.
func livekitHealth(token string) (bool, error) {
	var diag struct {
		Voice struct {
			LiveKitHealth bool `json:"livekit_health"`
			Enabled       bool `json:"enabled"`
		} `json:"voice"`
	}
	if err := get("/api/v1/diagnostics/connectivity", token, &diag); err != nil {
		return false, fmt.Errorf("reading the SFU's health: %w", err)
	}
	return diag.Voice.LiveKitHealth, nil
}

// ─── the fixture pieces the drills need ─────────────────────────────────────

// channelRow is the part of db.Channel these drills read.
type channelRow struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	Type string `json:"type"`
}

// pickChannel returns the install's channel of a given type. The setup wizard
// creates one of each ("general" text, "General" voice), so a missing one means
// the install is not what the fixture believes it is.
func pickChannel(token, kind string) (channelRow, error) {
	var rows []channelRow
	if err := get("/api/v1/channels", token, &rows); err != nil {
		return channelRow{}, fmt.Errorf("listing channels: %w", err)
	}
	for _, row := range rows {
		if row.Type == kind {
			return row, nil
		}
	}
	return channelRow{}, fmt.Errorf("the install has no %s channel, only %v", kind, rows)
}

// createInvite mints an invite code the drill's extra accounts register with.
func createInvite(baseURL, token string) (string, error) {
	body, err := json.Marshal(map[string]any{"max_uses": 10, "expires_in_hours": 24})
	if err != nil {
		return "", err
	}
	var resp struct {
		Code string `json:"code"`
	}
	if err := request(http.MethodPost, baseURL+"/api/v1/invites", token, "application/json",
		bytes.NewReader(body), http.StatusCreated, &resp); err != nil {
		return "", fmt.Errorf("creating an invite: %w", err)
	}
	if resp.Code == "" {
		return "", errors.New("the invite endpoint returned 201 with no code")
	}
	return resp.Code, nil
}

// registerUser is the second account phase R erases. It is registered through
// the public endpoint an owner's invitee uses, not seeded into the database:
// the erasure has to be exercised against a user the server itself made.
func registerUser(baseURL, invite, username string) (string, int64, error) {
	body, err := json.Marshal(map[string]any{
		"username":    username,
		"password":    drillPassword,
		"invite_code": invite,
	})
	if err != nil {
		return "", 0, err
	}
	var resp struct {
		Token string `json:"token"`
		User  struct {
			ID int64 `json:"id"`
		} `json:"user"`
	}
	if err := request(http.MethodPost, baseURL+"/api/v1/auth/register", "", "application/json",
		bytes.NewReader(body), http.StatusCreated, &resp); err != nil {
		return "", 0, fmt.Errorf("registering %s: %w", username, err)
	}
	if resp.Token == "" || resp.User.ID == 0 {
		return "", 0, fmt.Errorf("registering %s returned 201 with no session token or user id", username)
	}
	return resp.Token, resp.User.ID, nil
}

// authenticated reports whether a session token still works, and as whom.
func authenticated(token string) (bool, string, error) {
	req, err := http.NewRequest(http.MethodGet, defaultBaseURL+"/api/v1/auth/me", nil) //nolint:noctx // bounded by the client Timeout
	if err != nil {
		return false, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := fixtureClient.Do(req)
	if err != nil {
		return false, "", fmt.Errorf("checking a session: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusUnauthorized {
		return false, "", nil
	}
	if resp.StatusCode != http.StatusOK {
		return false, "", fmt.Errorf("GET /api/v1/auth/me: got %s, want 200 or 401", resp.Status)
	}
	var me struct {
		Username string `json:"username"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&me); err != nil {
		return false, "", fmt.Errorf("decoding /api/v1/auth/me: %w", err)
	}
	return true, me.Username, nil
}

// messageCount counts a channel's messages seen through the API, which is the
// question an owner asks ("is what I wrote still there"), not the one the
// database would answer.
func messageCount(token string, channelID int64) (int, error) {
	var resp struct {
		Messages []struct {
			User struct {
				ID int64 `json:"id"`
			} `json:"user"`
		} `json:"messages"`
	}
	if err := get(fmt.Sprintf("/api/v1/channels/%d/messages?limit=100", channelID), token, &resp); err != nil {
		return 0, fmt.Errorf("listing messages: %w", err)
	}
	return len(resp.Messages), nil
}

// ─── out-of-process SQLite ──────────────────────────────────────────────────

// openSQLite opens a database file from THIS process. A check run through the
// server's own API would be the server grading its own homework, which is why
// the integrity checks and the marker reads go through the driver directly —
// the same pure-Go one the server uses, so the file is read the way the server
// reads it.
func openSQLite(path string) (*sql.DB, error) {
	dsn := "file:" + filepath.ToSlash(path) + "?_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening %s: %w", path, err)
	}
	// One connection: these are reads of a file a live server may hold open,
	// and a pool would open several for no reason.
	db.SetMaxOpenConns(1)
	return db, nil
}

// integrityCheck runs PRAGMA integrity_check against a database file and
// returns its answer ("ok" on a healthy file).
func integrityCheck(path string) (string, error) {
	db, err := openSQLite(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = db.Close() }()
	var answer string
	if err := db.QueryRowContext(context.Background(), "PRAGMA integrity_check").Scan(&answer); err != nil {
		return "", fmt.Errorf("integrity_check on %s: %w", filepath.Base(path), err)
	}
	return answer, nil
}

// markerState is what the deletion-marker file says about an installation.
// It is read directly because it is the file a restore cannot touch: it lives
// outside the database, which is the whole reason an erasure survives one.
type markerState struct {
	count int
	token string
}

func readMarkers(dataDir string) (markerState, error) {
	path := filepath.Join(dataDir, filepath.FromSlash(markerRelPath))
	db, err := openSQLite(path)
	if err != nil {
		return markerState{}, err
	}
	defer func() { _ = db.Close() }()
	var state markerState
	if err := db.QueryRowContext(context.Background(),
		`SELECT COUNT(*), COALESCE(MAX(subject_token), '') FROM deletion_markers WHERE state = 'recorded'`,
	).Scan(&state.count, &state.token); err != nil {
		return markerState{}, fmt.Errorf("reading the deletion markers: %w", err)
	}
	return state, nil
}

// messageRows counts the rows the database really holds, for the one assertion
// in phase D that is about acknowledgement rather than about visibility: every
// message the server said it stored must be a row, and every row must be one it
// said it stored.
func messageRows(dataDir string, channelID, userID int64) (int, error) {
	db, err := openSQLite(filepath.Join(dataDir, "chatserver.db"))
	if err != nil {
		return 0, err
	}
	defer func() { _ = db.Close() }()
	var n int
	if err := db.QueryRowContext(context.Background(),
		"SELECT COUNT(*) FROM messages WHERE channel_id = ? AND user_id = ?", channelID, userID).Scan(&n); err != nil {
		return 0, fmt.Errorf("counting message rows: %w", err)
	}
	return n, nil
}

// ─── WebSocket ──────────────────────────────────────────────────────────────

// wsFrame is one server→client frame. Payload stays raw: which structure it
// holds is decided by Type, and decoding it eagerly would turn a frame this
// drill did not expect into a decode error instead of a readable report.
type wsFrame struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// errCode returns the code and message of an error frame, or "" when the frame
// is not one.
func (f wsFrame) errCode() (string, string) {
	if f.Type != "error" {
		return "", ""
	}
	var payload struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(f.Payload, &payload); err != nil {
		return "UNREADABLE", string(f.Payload)
	}
	return payload.Code, payload.Message
}

// wsConn is one authenticated WebSocket session. Frames are read by a pump
// goroutine into a buffered channel, because the interesting ones arrive while
// the harness is doing something else — a server_restart lands during a restore
// that is also being waited on.
type wsConn struct {
	conn   *websocket.Conn
	frames chan wsFrame
	closed sync.Once
}

func wsURL(baseURL string) string {
	return strings.Replace(baseURL, "https://", "wss://", 1) + "/api/v1/ws"
}

// dialWS opens a session and completes the auth handshake: the first frame on
// every connection is the auth frame, and the server answers auth_ok or closes.
// A session that is not authenticated would make every later assertion vacuous
// (a dropped socket looks exactly like a socket that received nothing).
func dialWS(token string) (*wsConn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), fixtureTimeout)
	defer cancel()
	conn, dialResp, err := websocket.Dial(ctx, wsURL(defaultBaseURL), &websocket.DialOptions{HTTPClient: fixtureClient})
	if dialResp != nil && dialResp.Body != nil {
		// Dial has already closed it (coder/websocket v1.8.15); the guard is
		// here because bodyclose cannot see that, and the repo's own websocket
		// proxy closes it the same way (api/livekit_proxy.go).
		defer dialResp.Body.Close() //nolint:errcheck // best-effort close of an already-closed body
	}
	if err != nil {
		return nil, fmt.Errorf("dialling %s: %w", wsURL(defaultBaseURL), err)
	}
	w := &wsConn{conn: conn, frames: make(chan wsFrame, 256)}
	go w.pump()

	payload, err := json.Marshal(map[string]any{"token": token, "last_seq": 0})
	if err != nil {
		w.close()
		return nil, err
	}
	if err := wsjson.Write(ctx, conn, wsFrame{Type: "auth", Payload: payload}); err != nil {
		w.close()
		return nil, fmt.Errorf("authenticating a session: %w", err)
	}
	frame, err := w.await(fixtureTimeout, "auth_ok")
	if err != nil {
		w.close()
		return nil, fmt.Errorf("authenticating a session: %w", err)
	}
	if frame.Type != "auth_ok" {
		w.close()
		return nil, fmt.Errorf("authenticating a session: the server answered %q", frame.Type)
	}
	return w, nil
}

// pump moves frames off the socket into the channel until the socket fails.
// The close is what a server_restart is followed by, so it is an ordinary end
// rather than something to report.
func (w *wsConn) pump() {
	for {
		var frame wsFrame
		err := wsjson.Read(context.Background(), w.conn, &frame)
		if err != nil {
			close(w.frames)
			return
		}
		w.frames <- frame
	}
}

func (w *wsConn) close() {
	w.closed.Do(func() { _ = w.conn.Close(websocket.StatusNormalClosure, "") })
}

// send writes one frame.
func (w *wsConn) send(kind string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), fixtureTimeout)
	defer cancel()
	return wsjson.Write(ctx, w.conn, wsFrame{Type: kind, Payload: raw})
}

// await returns the first frame of one of the wanted types, dropping frames of
// other types.
//
// Dropping rather than failing is deliberate: 20 sockets opened for phase R see
// presence broadcasts and their own replay traffic as well, and a helper that
// treated an unexpected frame as an error would fail the drill for the server
// doing its job. A wanted type that never arrives is the failure.
func (w *wsConn) await(timeout time.Duration, want ...string) (wsFrame, error) {
	deadline := time.After(timeout)
	for {
		select {
		case frame, ok := <-w.frames:
			if !ok {
				return wsFrame{}, errors.New("the connection closed before any of " + strings.Join(want, ", ") + " arrived")
			}
			if slices.Contains(want, frame.Type) {
				return frame, nil
			}
		case <-deadline:
			return wsFrame{}, errors.New("none of " + strings.Join(want, ", ") + " arrived within " + timeout.String())
		}
	}
}

// chatSend sends one message and returns the reply frame — the ok or the error,
// whichever the server answers with. Phase D asks "an error frame, not
// silence"; the fixture asks for the ok; both read the same reply.
func (w *wsConn) chatSend(channelID int64, content string) (wsFrame, error) {
	if err := w.send("chat_send", map[string]any{"channel_id": channelID, "content": content}); err != nil {
		return wsFrame{}, err
	}
	return w.await(fixtureTimeout, "chat_send_ok", "error")
}

// voiceJoin asks to join a voice channel and returns the reply frame.
func (w *wsConn) voiceJoin(channelID int64) (wsFrame, error) {
	if err := w.send("voice_join", map[string]any{"channel_id": channelID}); err != nil {
		return wsFrame{}, err
	}
	return w.await(fixtureTimeout, "voice_token", "error")
}

// wantOK turns a reply frame into an error unless it is the expected type.
func wantOK(frame wsFrame, kind string) error {
	if frame.Type == kind {
		return nil
	}
	if code, message := frame.errCode(); code != "" {
		return fmt.Errorf("the server refused with %s: %s", code, message)
	}
	return fmt.Errorf("the server answered %q, want %s", frame.Type, kind)
}

const (
	// drillPassword is the throwaway accounts' password: an invite-mode install
	// validates its length (8-72) and nothing else. It is a literal on a
	// temporary install that is never reachable off loopback.
	drillPassword = "drill-passphrase" //nolint:gosec // throwaway accounts on a temp-dir server

	// markerRelPath is the deletion-marker file, relative to the data
	// directory (internal/app/erasure.go). It is spelled here rather than
	// imported because importing `app` would drag the whole server into this
	// harness — and the path is one of the things this drill exists to pin.
	markerRelPath = "erasure/markers.sqlite"

	// erasureKeyRelPath is the key the marker file's tokens are HMACed under.
	erasureKeyRelPath = "erasure.key"

	// victimMessages is how many messages the erased subject leaves behind.
	victimMessages = 10

	// restartSockets is how many authenticated sockets phase R holds open
	// across the restore.
	restartSockets = 20
)

// ─── the drill's view of the install ────────────────────────────────────────

// dataDir is where the server's own files live: config's server.data_dir,
// default "data" under the install directory. database.path, backup.dir and
// upload.storage_dir all default to children of it, which is why the drill
// resolves them from here rather than spelling "data" at each call site.
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

// ─── phase R: backup, restore, deletion markers ─────────────────────────────

// rState is what phase R's steps hand each other: the fixture the phase built
// and the handles the later steps need to ask again.
type rState struct {
	token       string
	victimToken string
	victimID    int64
	newcomer    string // the third account, created after the backup
	text        channelRow
	victimFile  string // V's attachment id, and the file name under uploads/
	invite      string // the invite step 3 uses, so the newcomer is created after the backup
	backup      string
	sockets     []*wsConn
	markers     markerState
}

// phaseR is drills 1 and 2 end to end against one live install: a real backup,
// a real erase, a real restore through the admin endpoint's own self-restart,
// and the two ways an operator can lose the erasure history across it.
//
// A step's assertions accumulate rather than stop the phase, because the steps
// after them measure something else and the later measurements are what make a
// failure diagnosable. Only a broken fixture (a request that never arrived, a
// socket that never authenticated) stops the phase early.
func (d *drill) phaseR() error {
	if err := d.ensurePortFree(); err != nil {
		return err
	}
	if err := d.boot("R.log",
		fmt.Sprintf("OWNCORD_SECURITY_AUTH_RATE_LIMIT_MULTIPLIER=%d", drillAuthRateScale)); err != nil {
		return err
	}
	fmt.Printf("%s: booted with the register cap scaled by %d — %d distinct accounts are opened as %d sessions, and the per-IP cap is %d registrations a minute without it\n",
		d.phase, drillAuthRateScale, restartSockets, restartSockets, registerRateLimitPerMinute)
	r := &rState{}
	var problems []failure
	for _, step := range []func(*rState) ([]failure, error){
		d.stepRFix, d.stepRBackup, d.stepRErase, d.stepRRestore, d.stepRInspect,
	} {
		found, err := step(r)
		problems = append(problems, found...)
		if err != nil {
			return err
		}
	}
	found, err := d.stepRNoMarkerFile(r)
	problems = append(problems, found...)
	if err != nil {
		return err
	}
	found, err = d.stepRNoErasureKey(r)
	problems = append(problems, found...)
	if err != nil {
		return err
	}
	// The phase leaves the port free or the next phase measures this one's
	// leftovers. Step 7's boot fails closed and exits, which is what makes that
	// true; saying so here is what turns a mystery port conflict three phases
	// later into a failure at the step that caused it.
	if serving(d.baseURL()) {
		problems = append(problems, failure{what: fmt.Sprintf(
			"phase R ended with something still serving %s — the last step's boot should have failed closed and exited", d.baseURL())})
	}
	return d.failures(problems)
}

// stepRFix builds the install phase R restores: an owner, a second account V
// with ten messages and an upload, a third account created after the backup
// (D3's "restore drops newer data"), and 20 authenticated sockets watching for
// the restart.
func (d *drill) stepRFix(r *rState) ([]failure, error) {
	token, err := runSetup(d.baseURL())
	if err != nil {
		return nil, d.annotate(err)
	}
	r.token = token
	if r.text, err = pickChannel(token, "text"); err != nil {
		return nil, d.annotate(err)
	}
	invite, err := createInvite(d.baseURL(), token)
	if err != nil {
		return nil, d.annotate(err)
	}
	r.invite = invite
	victimToken, victimID, err := registerUser(d.baseURL(), invite, drillVictim)
	if err != nil {
		return nil, d.annotate(err)
	}
	r.victimToken, r.victimID = victimToken, victimID

	victim, err := dialWS(victimToken)
	if err != nil {
		return nil, d.annotate(err)
	}
	defer victim.close()
	for i := range victimMessages {
		frame, err := victim.chatSend(r.text.ID, fmt.Sprintf("victim message %d", i))
		if err != nil {
			return nil, d.annotate(fmt.Errorf("victim sending message %d: %w", i, err))
		}
		if err := wantOK(frame, "chat_send_ok"); err != nil {
			return nil, d.annotate(fmt.Errorf("victim sending message %d: %w", i, err))
		}
	}
	if r.victimFile, err = uploadAttachment(d.baseURL(), victimToken); err != nil {
		return nil, d.annotate(err)
	}

	// 20 sessions that stay authenticated across the restore, one account each.
	// They are the drill's answer to "does every connected client learn the
	// server is going away", which is the only thing an owner sees before the
	// process exits mid-conversation.
	//
	// ONE ACCOUNT EACH, and that is not decoration. The hub's pub/sub subscribes
	// a client under its USER id (ws/pubsub.go's Subscribe: subs[client.userID]
	// = client), so a second socket for the same account REPLACES the first in
	// the global topic — and the older socket, still connected, still answering
	// pings, still counted as a client, receives no global broadcast at all.
	// Measured on this drill's first run, with all 20 sockets on the owner's
	// account: 1 of 20 received server_restart. 20 sockets for 20 accounts is
	// the shape a server with 20 clients actually has.
	//
	// Accounts cost a registration each, and register is capped at 3 a minute
	// per IP (api/constants.go, scaled by security.auth_rate_limit_multiplier),
	// so the boot above scales that cap. Without it the third registration of
	// the run is refused with 429 and the phase cannot be built at all.
	for i := range restartSockets {
		invite, err := createInvite(d.baseURL(), token)
		if err != nil {
			return nil, d.annotate(fmt.Errorf("inviting session %d of %d: %w", i+1, restartSockets, err))
		}
		clientToken, _, err := registerUser(d.baseURL(), invite, fmt.Sprintf("drill-client-%d", i+1))
		if err != nil {
			return nil, d.annotate(fmt.Errorf("registering session %d of %d: %w", i+1, restartSockets, err))
		}
		c, err := dialWS(clientToken)
		if err != nil {
			return nil, d.annotate(fmt.Errorf("opening session %d of %d: %w", i+1, restartSockets, err))
		}
		r.sockets = append(r.sockets, c)
	}
	fmt.Printf("%s: fixture ready — %d messages and one upload from %s, %d sessions open (one account each)\n",
		d.phase, victimMessages, drillVictim, len(r.sockets))
	return nil, nil
}

// stepRBackup takes the backup a restore is made from, and integrity-checks it
// out of process: a backup that fails the check is worse than no backup,
// because the operator believes they have one.
func (d *drill) stepRBackup(r *rState) ([]failure, error) {
	name, err := createBackup(d.baseURL(), r.token)
	if err != nil {
		return nil, d.annotate(err)
	}
	r.backup = name
	path := filepath.Join(d.backupDir(), name)
	answer, err := integrityCheck(path)
	if err != nil {
		return nil, d.annotate(err)
	}
	fmt.Printf("%s: backup %s integrity_checks to %q\n", d.phase, name, answer)
	if answer != "ok" {
		return []failure{{what: fmt.Sprintf("the backup the drill just took (%s) does not integrity_check: %s", name, answer)}}, nil
	}
	return nil, nil
}

// stepRErase erases V through the route B4-9 added, and asserts the marker file
// recorded it: a marker that was never written is a restore that resurrects an
// erased account, and nothing else in the run would notice.
func (d *drill) stepRErase(r *rState) ([]failure, error) {
	if err := wantStatus(http.MethodDelete,
		fmt.Sprintf("/admin/api/users/%d", r.victimID), r.token, http.StatusNoContent); err != nil {
		return nil, d.annotate(err)
	}
	state, err := readMarkers(d.dataDir())
	if err != nil {
		return nil, d.annotate(err)
	}
	r.markers = state
	fmt.Printf("%s: erased %s (user %d); the marker file holds %d marker(s), token %s\n",
		d.phase, drillVictim, r.victimID, state.count, shortToken(state.token))
	if state.count != 1 || state.token == "" {
		return []failure{{what: fmt.Sprintf(
			"erasing a user recorded %d marker(s) with token %q, want exactly one with a token",
			state.count, state.token)}}, nil
	}

	// The newcomer is registered HERE rather than in step 1, and where it sits
	// is the whole assertion: it is created after the backup was taken, so a
	// restore that rolled the install back has to drop it. Created before the
	// backup, "the restore drops newer data" would be asked about an account the
	// backup already contains, and the step could only ever measure a pass.
	if r.newcomer, _, err = registerUser(d.baseURL(), r.invite, drillNewcomer); err != nil {
		return nil, d.annotate(err)
	}

	// The live erase removed V's file, and a backup holds the database rather
	// than the uploads, so without writing it back the post-restore assertion
	// ("V's file is gone") would hold vacuously: it is already gone. Writing it
	// back is what an operator restoring a file set does, and it makes the
	// startup replay's file removal the only thing that can satisfy the check.
	// Recorded here rather than assumed silently.
	if err := os.WriteFile(filepath.Join(d.uploadsDir(), r.victimFile), fixturePayload(), 0o600); err != nil {
		return nil, d.annotate(fmt.Errorf("restoring V's upload file by hand, to give the replay something to remove: %w", err))
	}
	fmt.Printf("%s: wrote V's upload file back (the operator's file set) so the replay has something to remove\n", d.phase)
	return nil, nil
}

// stepRRestore asks for the restore, watches the 20 sockets, and follows the
// self-restart the endpoint performs.
func (d *drill) stepRRestore(r *rState) ([]failure, error) {
	// The reader, issued immediately before the restore POST and collected
	// after it: whichever of the two answers first, the request overlapped the
	// restore. Its outcome is a measurement, not an assertion — the restore
	// closes the database out from under any in-flight read by design, and what
	// the drill asserts is that the server comes back with the restored data.
	reader := readWhileRestoring(r.token, r.text.ID)

	if err := wantStatus(http.MethodPost, "/admin/api/backups/"+r.backup+"/restore",
		r.token, http.StatusOK); err != nil {
		return nil, d.annotate(err)
	}
	fmt.Printf("%s: the restore answered 200; the reader in flight says %s\n", d.phase, <-reader)

	var problems []failure
	silent := 0
	for i, c := range r.sockets {
		if _, err := c.await(restartBroadcastBudget, "server_restart"); err != nil {
			silent++
			if silent == 1 {
				problems = append(problems, failure{what: fmt.Sprintf(
					"session %d of %d never received server_restart before the connection closed: %v",
					i+1, len(r.sockets), err)})
			}
		}
	}
	if silent > 1 {
		problems = append(problems, failure{what: fmt.Sprintf(
			"%d of the %d open sessions never received server_restart (the first is reported above)",
			silent, len(r.sockets))})
	}
	if err := d.awaitRestart(); err != nil {
		return problems, err
	}
	return problems, nil
}

// stepRInspect reads the install the restore produced. Every assertion here is
// one an owner would make after restoring, in the order they would make it —
// which is also why each one is its own function: the sequence is the spec, and
// a reader checking it against the brief follows the list below.
func (d *drill) stepRInspect(r *rState) ([]failure, error) {
	var problems []failure
	fail := func(format string, args ...any) {
		problems = append(problems, failure{what: fmt.Sprintf(format, args...)})
	}
	for _, inspect := range []func() error{
		func() error { return d.inspectSafetyCopies(fail) },
		func() error { return d.inspectLiveDatabase(fail) },
		func() error { return d.inspectErasureHeld(r, fail) },
		func() error { return d.inspectPostBackupDataGone(r, fail) },
		func() error { return d.inspectAuditTrail(r, fail) },
		func() error { return d.inspectUploadGone(r, fail) },
		func() error { return d.inspectMarkerSurvived(r, fail) },
	} {
		if err := inspect(); err != nil {
			return nil, d.annotate(err)
		}
	}
	return problems, nil
}

// inspectSafetyCopies: the safety copy the admin panel promises before an
// irreversible overwrite, and that it is a usable database rather than a file.
func (d *drill) inspectSafetyCopies(fail func(string, ...any)) error {
	copies, err := preRestoreCopies(d.backupDir())
	if err != nil {
		return err
	}
	if len(copies) == 0 {
		fail("the restore left no pre_restore_*.db in %s, and the admin panel promises one before it overwrites", d.backupDir())
		return nil
	}
	for _, name := range copies {
		answer, err := integrityCheck(filepath.Join(d.backupDir(), name))
		if err != nil {
			return err
		}
		if answer != "ok" {
			fail("the pre-restore safety copy %s does not integrity_check: %s", name, answer)
		}
	}
	fmt.Printf("%s: pre-restore safety copy %v integrity_checks to ok\n", d.phase, copies)
	return nil
}

// inspectLiveDatabase: the live database is a valid database. It was written by
// overwriting a file a closed server was holding, which is the one moment a
// restore can corrupt it.
func (d *drill) inspectLiveDatabase(fail func(string, ...any)) error {
	answer, err := integrityCheck(filepath.Join(d.dataDir(), "chatserver.db"))
	if err != nil {
		return err
	}
	if answer != "ok" {
		fail("the restored database does not integrity_check: %s", answer)
	}
	return nil
}

// inspectErasureHeld: the erased account did not come back, and neither did its
// messages. Both were in the backup (it predates the erasure) and only the
// startup replay removes them again — a replay that does nothing leaves V
// serving, which is exactly what drill 2 is for.
func (d *drill) inspectErasureHeld(r *rState, fail func(string, ...any)) error {
	if alive, who, err := authenticated(r.victimToken); err != nil {
		return err
	} else if alive {
		fail("the erased account %s is authenticated again after the restore: the startup replay did not erase it", who)
	}
	count, err := messageCount(r.token, r.text.ID)
	if err != nil {
		return err
	}
	if count != 0 {
		fail("the restored channel shows %d message(s) after the restore; the erased account's %d were restored and not removed again",
			count, victimMessages)
	}
	return nil
}

// inspectPostBackupDataGone: D3, the restore drops what was written after the
// backup. The third account is that data, and it goes through the real path
// rather than a synthetic one.
func (d *drill) inspectPostBackupDataGone(r *rState, fail func(string, ...any)) error {
	if alive, who, err := authenticated(r.newcomer); err != nil {
		return err
	} else if alive {
		fail("the account created after the backup (%s) is still authenticated after the restore — restoring did not roll it back", who)
	}
	return nil
}

// inspectAuditTrail: the audit trail says what happened, including the replay
// under the marker's own token — that token is the only link between the erase
// and the erasure the operator cannot see (the account is gone).
//
// Where each row LIVES is the assertion, and the two halves are in different
// databases by design. The restore writes backup_restore into the live database
// and then overwrites that file with the backup, so the row survives only inside
// the pre-restore safety copy — the handler says so, and
// admin/handlers_backup_test.go asserts it — while the replay runs after the boot
// and lands in the restored database. Measured on the first run of this drill:
// the live log holds no backup_restore row. The brief predicts both in one place;
// this is where they are.
func (d *drill) inspectAuditTrail(r *rState, fail func(string, ...any)) error {
	rows, err := auditLog(r.token)
	if err != nil {
		return err
	}
	if !hasAuditRow(rows, "account_erasure_replayed", r.markers.token) {
		fail("the live audit log holds no account_erasure_replayed entry carrying the marker token %s", shortToken(r.markers.token))
	}
	copies, err := preRestoreCopies(d.backupDir())
	if err != nil {
		return err
	}
	if len(copies) == 0 {
		fail("there is no pre-restore safety copy to hold the backup_restore entry the restore wrote before overwriting the live database")
	}
	for _, name := range copies {
		inside, err := auditRowsOf(filepath.Join(d.backupDir(), name))
		if err != nil {
			return err
		}
		if !hasAuditRow(inside, "backup_restore", "") {
			fail("the pre-restore safety copy %s holds no backup_restore entry, so nothing anywhere records that the restore happened", name)
		}
	}
	return nil
}

// inspectUploadGone: V's file is gone from disk. The replay removes files as well
// as rows, and a restored upload whose row is gone is an orphan nobody can serve.
func (d *drill) inspectUploadGone(r *rState, fail func(string, ...any)) error {
	if _, err := os.Stat(filepath.Join(d.uploadsDir(), r.victimFile)); err == nil {
		fail("the erased account's upload file is still on disk at uploads/%s after the restore: the replay removed the row and not the file", r.victimFile)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// inspectMarkerSurvived: the marker survived the restore. The markers are the one
// thing the restore cannot roll back, and a replay that consumed or discarded the
// marker would erase V once and leave the next restore to resurrect it.
func (d *drill) inspectMarkerSurvived(r *rState, fail func(string, ...any)) error {
	state, err := readMarkers(d.dataDir())
	if err != nil {
		return err
	}
	if state.count != 1 {
		fail("the marker file holds %d marker(s) after the replay, want the one it held before", state.count)
	}
	if state.token != r.markers.token {
		fail("the marker file's token changed across the restore (%s -> %s)", shortToken(r.markers.token), shortToken(state.token))
	}
	return nil
}

// stepRNoMarkerFile is drill 2's first half: the marker file is gone and the
// same backup is restored again. The owner decided (open question 1) that the
// server boots and logs a startup error that its erasure history is absent,
// rather than refusing to boot — so that is what this asserts, and what it
// measures either way is printed: the erased account coming back is the thing
// the operator needs to know about.
//
// The delete is attempted while the replacement runs and the restore is what
// takes the process down: the replacement is not this harness's child (see
// awaitRestart), and this is the one order in which the marker file is absent
// at the moment the next process opens it. The -wal and -shm sidecars go with
// it — a fresh empty file beside a live -wal is not the state an operator who
// deleted the marker file is in.
func (d *drill) stepRNoMarkerFile(r *rState) ([]failure, error) {
	markers := filepath.Join(d.dataDir(), filepath.FromSlash(markerRelPath))
	deleted := 0
	for _, path := range []string{markers, markers + "-wal", markers + "-shm"} {
		err := os.Remove(path)
		switch {
		case err == nil:
			deleted++
		case errors.Is(err, fs.ErrNotExist):
		default:
			// Windows refuses to unlink a file another process holds open, and
			// the running server holds this one open for its whole life. That
			// is a limit of this machine, not a measurement, so the step is
			// recorded as not having run — never as a pass.
			d.skipStep(fmt.Sprintf("step 6 did not run (%v — the running server holds the marker file open; only a stopped server can lose it on this platform)", err))
			return nil, nil
		}
	}
	if deleted == 0 {
		d.skipStep("step 6 did not run (there was no marker file to delete)")
		return nil, nil
	}
	if deleted < 3 {
		// The marker file went but a sidecar did not. The install is already
		// mutated, so this is neither a skip nor a clean run: say which files
		// survived and carry on, so the boot below is measured against the
		// state the operator would actually be in.
		d.skipStep(fmt.Sprintf("step 6 ran on a partially deleted marker set (%d of 3 files removed; SQLite's sidecars are still present)", deleted))
	}
	offset, err := logOffset(d.srv.logPath)
	if err != nil {
		return nil, d.annotate(err)
	}
	if err := wantStatus(http.MethodPost, "/admin/api/backups/"+r.backup+"/restore",
		r.token, http.StatusOK); err != nil {
		return nil, d.annotate(err)
	}
	outcome, err := d.awaitUnwatchedRestart(offset)
	if err != nil {
		return nil, err
	}
	// Whatever comes next owns the port, so the harness points at it: the log
	// is the same file and the directory is the same directory.
	d.srv = &server{bin: d.bin, dir: d.dir, logPath: d.srv.logPath, adopted: true, waitErr: make(chan error, 1)}

	var problems []failure
	alive := false
	if outcome.booted {
		var who string
		var err error
		if alive, who, err = authenticated(r.victimToken); err != nil {
			return nil, d.annotate(err)
		}
		fmt.Printf("%s: with the marker file deleted the install booted and the erased account is %s\n",
			d.phase, erasedPhrase(alive))
		if alive {
			// Recorded, not failed. Open question 1 decided that a missing
			// marker file boots, and the markers are what names an erased
			// account in a restored backup — with them gone nothing is left
			// that could remove it, so the resurrection is the decided
			// behaviour rather than a defect this drill can assert against.
			// It is still the loudest thing step 6 measures.
			fmt.Printf("%s: RESURRECTION — %s authenticated again after the restore and nothing removes it (the markers that named it are gone). Decided behaviour, measured here rather than asserted.\n",
				d.phase, who)
		}
	}
	// The decided behaviour, asserted as a whole: it boots, and it says its
	// erasure history is gone. A boot that refuses is a different behaviour
	// (safer, and still not what was decided), and one that boots silently is
	// the failure the decision exists to prevent.
	switch {
	case !outcome.booted:
		problems = append(problems, failure{what: fmt.Sprintf(
			"the marker file was deleted and the server refused to boot; the decided behaviour (open question 1) is that it boots and logs a startup error that the erasure history is absent. The boot said:\n%s",
			tailExcerpt(outcome.tail))})
	case !saysHistoryGone(outcome.tail):
		problems = append(problems, failure{what: fmt.Sprintf(
			"the marker file was deleted and the boot said nothing about the erasure history it no longer has. Decided behaviour (open question 1): boot, and log a startup error that the erasure history is absent — an operator who deleted the marker file by mistake is otherwise told nothing, and the erased account %s",
			erasedPhrase(alive))})
	}
	return problems, nil
}

// stepRNoErasureKey is drill 2's second half: the key is gone and the marker
// file is intact. The marker file is bound to the key by fingerprint (OC-0388),
// so the boot must fail closed with a named reason rather than serve with
// markers it cannot match.
func (d *drill) stepRNoErasureKey(r *rState) ([]failure, error) {
	if err := os.Remove(filepath.Join(d.dataDir(), erasureKeyRelPath)); err != nil {
		return nil, d.annotate(fmt.Errorf("deleting %s: %w", erasureKeyRelPath, err))
	}
	offset, err := logOffset(d.srv.logPath)
	if err != nil {
		return nil, d.annotate(err)
	}
	if err := wantStatus(http.MethodPost, "/admin/api/backups/"+r.backup+"/restore",
		r.token, http.StatusOK); err != nil {
		return nil, d.annotate(err)
	}
	outcome, err := d.awaitUnwatchedRestart(offset)
	if err != nil {
		return nil, err
	}
	var problems []failure
	switch {
	case outcome.booted:
		problems = append(problems, failure{what: fmt.Sprintf(
			"the erasure key was deleted and the server booted anyway on a marker file created under a different key: its markers name subjects the running key cannot match, so a restored backup leaves erased accounts serving (OC-0388). The boot said:\n%s",
			tailExcerpt(outcome.tail))})
	case !strings.Contains(outcome.tail, "different erasure key"):
		problems = append(problems, failure{what: fmt.Sprintf(
			"the erasure key was deleted and the boot failed, but without naming the reason — a refusal an operator cannot act on is indistinguishable from a crash. The boot said:\n%s",
			tailExcerpt(outcome.tail))})
	default:
		fmt.Printf("%s: with the erasure key deleted the boot failed closed and named the reason\n", d.phase)
	}
	return problems, nil
}

// ─── phase R's small helpers ────────────────────────────────────────────────

// readWhileRestoring issues the paginated messages GET the reader pool serves
// (db's reader, not the single writer), and reports what it got. It runs while
// the restore is being asked for, so the restore is asked for with a reader
// open — which is the handle a restore that waited on readers would block on.
func readWhileRestoring(token string, channelID int64) <-chan string {
	out := make(chan string, 1)
	go func() {
		defer close(out)
		url := fmt.Sprintf("%s/api/v1/channels/%d/messages?limit=100", defaultBaseURL, channelID)
		req, err := http.NewRequest(http.MethodGet, url, nil) //nolint:noctx // bounded by the client Timeout
		if err != nil {
			out <- "the reader never left: " + err.Error()
			return
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := fixtureClient.Do(req)
		if err != nil {
			out <- "the reader was cut off: " + err.Error()
			return
		}
		defer func() { _ = resp.Body.Close() }()
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		out <- "the reader got " + resp.Status
	}()
	return out
}

// preRestoreCopies names the safety copies in the backup directory.
func preRestoreCopies(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "pre_restore_") && filepath.Ext(e.Name()) == ".db" {
			names = append(names, e.Name())
		}
	}
	slices.Sort(names)
	return names, nil
}

// hasAuditRow reports whether the audit log holds an action, under a subject
// token when one is given. The token is what ties a replayed erasure to the
// marker it came from; an empty token asks for the action alone.
func hasAuditRow(rows []auditRow, action, token string) bool {
	for _, row := range rows {
		if row.Action != action {
			continue
		}
		if token == "" || row.SubjectToken == token {
			return true
		}
	}
	return false
}

// auditRowsOf reads the audit_log table out of a database FILE, the way
// integrityCheck reads a file's pages: the pre-restore safety copy is not being
// served by any server, so the endpoint that auditLog uses cannot see the one
// row that only exists inside it.
func auditRowsOf(path string) ([]auditRow, error) {
	db, err := openSQLite(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()
	rows, err := db.QueryContext(context.Background(),
		"SELECT action, COALESCE(detail, ''), COALESCE(subject_token, '') FROM audit_log")
	if err != nil {
		return nil, fmt.Errorf("reading the audit log of %s: %w", filepath.Base(path), err)
	}
	defer func() { _ = rows.Close() }()
	var out []auditRow
	for rows.Next() {
		var row auditRow
		if err := rows.Scan(&row.Action, &row.Detail, &row.SubjectToken); err != nil {
			return nil, fmt.Errorf("reading the audit log of %s: %w", filepath.Base(path), err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("reading the audit log of %s: %w", filepath.Base(path), err)
	}
	return out, nil
}

// saysHistoryGone reports whether a log says the erasure history is absent: one
// line that names the erasure markers AND calls them missing. Two words in one
// line rather than one literal phrasing, because the decided behaviour names a
// behaviour ("log a startup error that the erasure history is absent") and not
// a sentence, and only the tail this step's boot wrote is searched.
func saysHistoryGone(log string) bool {
	for line := range strings.SplitSeq(log, "\n") {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "erasure") &&
			(strings.Contains(lower, "missing") || strings.Contains(lower, "absent") || strings.Contains(lower, "gone")) {
			return true
		}
	}
	return false
}

// erasedPhrase keeps the measurements above readable in a log.
func erasedPhrase(alive bool) string {
	if alive {
		return "BACK (the erasure did not survive the restore)"
	}
	return "still gone"
}

// shortToken prints a subject token without its body: the token is an HMAC the
// operator reads in the audit log, and the drill's log lines only need to say
// which one it is.
func shortToken(token string) string {
	if len(token) <= 12 {
		return token
	}
	return token[:12] + "…"
}

// tailExcerpt bounds a boot's output for an error message.
func tailExcerpt(tail string) string {
	const limit = 4096
	if len(tail) <= limit {
		return tail
	}
	return tail[len(tail)-limit:]
}

// ─── phase C: corrupt operator input ────────────────────────────────────────

// phaseC is drill 5's process half: the two corrupt inputs an operator can hand
// a running server — a damaged backup to restore, and a config.yaml with a
// syntax error. db/b6_11_corrupt_drills_test.go proves the mechanisms on a
// copy; "the live server refused and stayed up" is not a property of a copy.
func (d *drill) phaseC() error {
	if err := d.ensurePortFree(); err != nil {
		return err
	}
	if err := d.boot("C.log"); err != nil {
		return err
	}
	var problems []failure
	found, err := d.stepCCorruptBackup()
	problems = append(problems, found...)
	if err != nil {
		return err
	}
	found, err = d.stepCBrokenConfig()
	problems = append(problems, found...)
	if err != nil {
		return err
	}
	if err := d.failures(problems); err != nil {
		return err
	}
	return d.stop()
}

// stepCCorruptBackup hands the restore a backup with bytes overwritten in it.
// The refusal is what the operator needs: the alternative is a live database
// overwritten with a file SQLite itself rejects, and the pre-restore safety
// copy is the only thing standing between them and a dead install.
func (d *drill) stepCCorruptBackup() ([]failure, error) {
	token, err := runSetup(d.baseURL())
	if err != nil {
		return nil, d.annotate(err)
	}
	name, err := createBackup(d.baseURL(), token)
	if err != nil {
		return nil, d.annotate(err)
	}
	path := filepath.Join(d.backupDir(), name)
	offset, err := corruptDetectably(path)
	if err != nil {
		return nil, d.annotate(err)
	}
	fmt.Printf("%s: corrupted %s at offset %d (integrity_check no longer says ok)\n", d.phase, name, offset)

	dbPath := filepath.Join(d.dataDir(), "chatserver.db")
	before, err := hashFile(dbPath)
	if err != nil {
		return nil, d.annotate(err)
	}
	// wantStatus is the assertion: a 200 here means the restore went ahead on
	// a file SQLite rejects, and the run should stop rather than measure a
	// install that no longer holds what the fixture put there.
	if err := wantStatus(http.MethodPost, "/admin/api/backups/"+name+"/restore",
		token, http.StatusBadRequest); err != nil {
		return nil, d.annotate(fmt.Errorf("restoring a corrupt backup: %w", err))
	}
	after, err := hashFile(dbPath)
	if err != nil {
		return nil, d.annotate(err)
	}
	var problems []failure
	if before != after {
		problems = append(problems, failure{what: fmt.Sprintf(
			"a refused restore still rewrote the live database (%s -> %s): the refusal has to happen before anything touches it",
			before[:12], after[:12])})
	}
	copies, err := preRestoreCopies(d.backupDir())
	if err != nil {
		return nil, d.annotate(err)
	}
	if len(copies) > 0 {
		problems = append(problems, failure{what: fmt.Sprintf(
			"a refused restore left the pre-restore safety copy %v behind: the refusal happened after the copy, not before it", copies)})
	}
	rows, err := auditLog(token)
	if err != nil {
		return nil, d.annotate(err)
	}
	if hasAuditRow(rows, "backup_restore", "") {
		problems = append(problems, failure{what: "a refused restore wrote a backup_restore audit entry: the log now claims a restore that never happened"})
	}
	if !healthy(d.bin, d.dir) {
		problems = append(problems, failure{what: "the server stopped reporting healthy after refusing a corrupt backup"})
	}
	fmt.Printf("%s: the corrupt backup was refused with 400 and the live database is unchanged\n", d.phase)
	return problems, nil
}

// stepCBrokenConfig boots the binary on a config.yaml that does not parse. The
// operator edited the file and needs the FILE and the LINE, in seconds, before
// anything else happened — a server that boots half-configured on a typo is
// worse than one that refuses.
func (d *drill) stepCBrokenConfig() ([]failure, error) {
	dir := filepath.Join(d.dir, "broken-config")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	// A tab where YAML wants a space, which is the shape of a hand-edited file
	// and what an operator produces at least once.
	const broken = "server:\n  name: drill\n\tport: 8443\n"
	if err := os.WriteFile(filepath.Join(dir, "config.yaml"), []byte(broken), 0o600); err != nil {
		return nil, err
	}
	s, err := start(d.bin, dir, "C-broken.log", noLiveKitDownload)
	if err != nil {
		return nil, err
	}
	select {
	case exit := <-s.waitErr:
		s.exited = true
		if exit == nil {
			return []failure{{what: "the binary exited 0 on a config.yaml with a syntax error: a config error that looks like a clean shutdown tells the operator nothing"}}, nil
		}
	case <-time.After(configFailBudget):
		_ = s.cmd.Process.Kill()
		return []failure{{what: fmt.Sprintf(
			"the binary was still running %s after being started on a config.yaml with a syntax error, want a non-zero exit naming the file and the line", configFailBudget)}}, nil
	}
	log, err := os.ReadFile(s.logPath)
	if err != nil {
		return nil, err
	}
	text := string(log)
	var problems []failure
	if !strings.Contains(text, "config.yaml") {
		problems = append(problems, failure{what: fmt.Sprintf(
			"the exit message does not name the config file it refused, so the operator cannot tell which file is broken. It said:\n%s", tailExcerpt(text))})
	}
	if !configLinePattern.MatchString(text) {
		problems = append(problems, failure{what: fmt.Sprintf(
			"the exit message names no LINE, so the operator has to find the typo in a file the server already knows the position of. It said:\n%s", tailExcerpt(text))})
	}
	if _, err := os.Stat(filepath.Join(dir, "data")); !errors.Is(err, fs.ErrNotExist) {
		problems = append(problems, failure{what: fmt.Sprintf(
			"the failed boot created %s: a config that never parsed must not leave a data directory (or anything else) behind", filepath.Join(dir, "data"))})
	}
	fmt.Printf("%s: the broken config was refused in under %s, naming the file and the line\n", d.phase, configFailBudget)
	return problems, nil
}

// corruptDetectably overwrites bytes in a database file until PRAGMA
// integrity_check stops saying ok, and reports the offset it stopped at.
//
// The self-check is what keeps the step from passing vacuously. SQLite reads
// only the pages a query touches, and a byte overwritten in a page's
// unallocated space is never read: a "corrupt" file nothing rejects would make
// the restore's 400 look like a refusal of corruption it never saw. The offsets
// are tried in order and the last one that worked is printed.
func corruptDetectably(path string) (int64, error) {
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	size := info.Size()
	header := make([]byte, 18)
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	_, readErr := io.ReadFull(f, header)
	_ = f.Close()
	if readErr != nil {
		return 0, fmt.Errorf("reading the header of %s: %w", filepath.Base(path), readErr)
	}
	pageSize := int64(binary.BigEndian.Uint16(header[16:18]))
	if pageSize == 1 {
		pageSize = 65536
	}

	for _, offset := range []int64{3*pageSize + 100, size / 2, size - 64, 100} {
		if offset < 100 || offset+64 > size {
			continue
		}
		if err := damageBytes(path, offset, 64); err != nil {
			return 0, err
		}
		// An error from integrity_check is detection too: the pragma reporting
		// "database disk image is malformed" is the file being rejected.
		if answer, err := integrityCheck(path); err != nil || answer != "ok" {
			return offset, nil //nolint:nilerr // an error from integrity_check IS the corruption this loop looks for, not a failure to detect it
		}
	}
	return 0, fmt.Errorf(
		"could not make %s detectably corrupt: 64 bytes were overwritten at four offsets and PRAGMA integrity_check still says ok, so a restore refusing this file would prove nothing",
		filepath.Base(path))
}

// damageBytes overwrites n bytes at offset with a pattern no b-tree page can
// be, past the page header so the damage is in a page's contents rather than in
// its type — the same shape db/b6_11_corrupt_drills_test.go's corruptBytes uses.
func damageBytes(path string, offset int64, n int) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.WriteAt(bytes.Repeat([]byte{0xFF}, n), offset); err != nil {
		_ = f.Close()
		return fmt.Errorf("corrupting %s at %d: %w", filepath.Base(path), offset, err)
	}
	return f.Close()
}

// ─── phase D: headroom, then full, then recovery ────────────────────────────

// diskEnv points every writable path that phase D measures at the size-limited
// filesystem. server.data_dir alone is not enough and the difference is not
// obvious: database.path, backup.dir and upload.storage_dir are separate keys
// whose defaults are relative to the install directory, so a drill that moved
// only data_dir would fill a filesystem the database is not on and never reach
// ENOSPC at all.
//
// The TLS pair is deliberately NOT here. It is written once at boot and never
// again, so it is not something the fill can push to the wall, and moving it
// would move it out from under the healthcheck: that probe is a second process
// reading the same config.yaml and it is not given this environment. See
// bootAt for the directory the pair therefore needs.
func (d *drill) diskEnv() []string {
	fs := d.dataFS
	return []string{
		"OWNCORD_SERVER_DATA_DIR=" + fs,
		"OWNCORD_DATABASE_PATH=" + filepath.Join(fs, "chatserver.db"),
		"OWNCORD_BACKUP_DIR=" + filepath.Join(fs, "backups"),
		"OWNCORD_UPLOAD_STORAGE_DIR=" + filepath.Join(fs, "uploads"),
		fmt.Sprintf("OWNCORD_SERVER_MIN_FREE_DISK_MB=%d", drillMinFreeDiskMB),
	}
}

// dStage is phase D's running state: the socket its messages go through, the
// channel and owner they belong to, and the number of acknowledgements — the
// count the database must hold after the recovery, because an acknowledgement
// and a row are the same promise.
type dStage struct {
	token string
	owner int64
	text  channelRow
	conn  *wsConn
	oks   int
}

// dirFiller is phase D's non-container filesystem: the directory -data-fs names.
// A nil filler means this machine has none to give it — the skip is recorded and
// printed here, never scored as a pass.
func (d *drill) dirFiller() (filler, error) {
	// No -data-fs, or Windows: NTFS has no tmpfs, and the drill's own cap would
	// still be 64 MiB written to somebody's real volume before it gave up.
	if d.dataFS == "" || runtime.GOOS == "windows" {
		// The run's exit status and the phases after this one must not read as
		// "phase D measured nothing and was fine".
		d.skipped = append(d.skipped, 'D')
		fmt.Printf("%s: skipped (no size-limited filesystem)\n", d.phase)
		return nil, nil
	}
	if err := d.boot("D.log", d.diskEnv()...); err != nil {
		return nil, err
	}
	return newDirFiller(d.dataFS)
}

// phaseD is drills 3 and 4: the filesystem under the reserved headroom, then
// full to the wall, then given back. Standalone it runs against whatever
// -data-fs names; with -docker it runs against the tmpfs task 4 mounts at
// /app/data, which is the deployment's own disk-pressure story.
func (d *drill) phaseD() error {
	if err := d.ensurePortFree(); err != nil {
		return err
	}
	var (
		f   filler
		err error
	)
	// Two sibling branches rather than one if/else: each owns its own nesting,
	// and keeping them flat is what holds this function inside its complexity
	// budget without moving a number.
	if !d.docker {
		if f, err = d.dirFiller(); err != nil || f == nil {
			return err
		}
	}
	if d.docker {
		t, err := newDockerTarget(d.bin, d.bin)
		if err != nil {
			return err
		}
		defer t.cleanup()
		t.tmpfs = true
		t.extraEnv = []string{fmt.Sprintf("OWNCORD_SERVER_MIN_FREE_DISK_MB=%d", drillMinFreeDiskMB)}
		if err := t.start("old"); err != nil {
			return err
		}
		d.container = t
		if f, err = newDockerFiller(t); err != nil {
			return err
		}
		// Phase D asserts on a filesystem of a known size, and docker cp is the
		// only way this harness can put bytes into a container (the image is
		// distroless: no shell, no dd), so before measuring anything it asks
		// whether this harness can reach that filesystem at all.
		reachable, err := d.tmpfsReachable(f)
		if err != nil || !reachable {
			return err
		}
	}

	s := &dStage{}
	if s.token, err = runSetup(d.baseURL()); err != nil {
		return d.annotate(err)
	}
	if s.text, err = pickChannel(s.token, "text"); err != nil {
		return d.annotate(err)
	}
	if s.owner, err = ownerID(s.token); err != nil {
		return d.annotate(err)
	}
	if s.conn, err = dialWS(s.token); err != nil {
		return d.annotate(err)
	}
	defer s.conn.close()

	var problems []failure
	for _, stage := range []func(filler, *dStage) ([]failure, error){
		d.dHeadroom, d.dFull, d.dRecover,
	} {
		found, foundErr := stage(f, s)
		problems = append(problems, found...)
		if foundErr != nil {
			return foundErr
		}
	}
	if err := d.failures(problems); err != nil {
		return err
	}
	// dRecover's last step leaves the rebooted server running, and the phases
	// after this one start by asserting nothing is serving :8443 yet. Without
	// this the next phase fails with "a previous phase left a server behind" —
	// a true statement blamed on the wrong phase.
	return d.stop()
}

// tmpfsReachable reports whether this harness can put bytes into the container's
// tmpfs at all.
//
// docker cp resolves its destination in the container's rootfs, BELOW a mount at
// that path, so bytes copied into a --tmpfs mount point land in the layer
// underneath while the filesystem the server writes to stays empty — the copy
// reports success and the tmpfs reports zero used. The probe copies more than the
// mount is declared to hold: if that succeeds, nothing after it would measure
// disk pressure, and a stage that measured nothing must not report anything but a
// skip. A false result has already recorded that skip.
func (d *drill) tmpfsReachable(f filler) (bool, error) {
	probe := uint64(drillTmpfsBytes + drillFillStep)
	n, err := f.fill(probe)
	switch {
	case err == nil && n == probe:
		if err := f.release(); err != nil {
			return false, d.annotate(err)
		}
		d.skipped = append(d.skipped, 'D')
		fmt.Printf("%s: skipped (docker cp put %d MiB into the container's %d MiB tmpfs and the copy succeeded — it writes below the mount, so the filesystem the server writes to never took a byte)\n",
			d.phase, probe>>20, drillTmpfsBytes>>20)
		return false, nil
	case err != nil && !errors.Is(err, errNoSpace):
		// Neither a full filesystem nor a success: this is the harness failing,
		// and the raw error is what a reader needs to tell that from ENOSPC.
		return false, d.annotate(err)
	}
	return true, nil
}

// dHeadroom fills until the product's own health report says the disk is under
// its floor, then asks the three questions drill 3 is about with the disk
// nearly full: health, upload, message.
func (d *drill) dHeadroom(f filler, s *dStage) ([]failure, error) {
	if err := d.fillToHealthFloor(f); err != nil {
		return nil, err
	}
	var problems []failure
	fail := func(format string, args ...any) {
		problems = append(problems, failure{what: fmt.Sprintf(format, args...)})
	}
	body, status, err := healthOf()
	if err != nil {
		return nil, d.annotate(err)
	}
	fmt.Printf("%s: headroom reached — /health %d %s/%s\n", d.phase, status, body.Status, body.Reason)
	if status != http.StatusServiceUnavailable || body.Status != "degraded" || body.Reason != "disk" {
		fail("with the data filesystem under the %d MiB boot floor /health answered %d %s/%s, want 503 degraded/disk",
			drillMinFreeDiskMB, status, body.Status, body.Reason)
	}

	code, detail, err := uploadStatus(s.token)
	if err != nil {
		return nil, d.annotate(err)
	}
	fmt.Printf("%s: an upload under the floor answered %d %s\n", d.phase, code, detail)
	if code != http.StatusInsufficientStorage || !strings.Contains(detail, "STORAGE_LOW_DISK") {
		fail("an upload with the filesystem under its reserved headroom answered %d %s, want 507 STORAGE_LOW_DISK", code, detail)
	}

	frame, err := s.conn.chatSend(s.text.ID, "headroom")
	if err != nil {
		return nil, d.annotate(err)
	}
	if err := wantOK(frame, "chat_send_ok"); err != nil {
		fail("a message sent while the filesystem was under its floor was refused: %v — the floor is the upload path's reserved headroom, not the message path's", err)
	} else {
		s.oks++
	}

	found, err := d.dBackup(s)
	problems = append(problems, found...)
	return problems, err
}

// dBackup takes a backup with the filesystem nearly full and asserts the
// OC-0212 invariant rather than an error. The brief predicts an error; a small
// database may legitimately fit in the window above 2 MiB, so the assertion is
// the one that matters either way: no partial file is left behind, and a 200 is
// a file that integrity_checks. The measured status is printed.
func (d *drill) dBackup(s *dStage) ([]failure, error) {
	before, err := listBackups(d.baseURL(), s.token)
	if err != nil {
		return nil, d.annotate(err)
	}
	code, detail, err := backupStatus(s.token)
	if err != nil {
		return nil, d.annotate(err)
	}
	after, err := listBackups(d.baseURL(), s.token)
	if err != nil {
		return nil, d.annotate(err)
	}
	var problems []failure
	fresh := newNames(before, after)
	fmt.Printf("%s: a backup under the floor answered %d %s, leaving %d new file(s) %v\n",
		d.phase, code, detail, len(fresh), fresh)
	for _, name := range fresh {
		path, err := d.backupFile(name)
		if err != nil {
			return nil, d.annotate(err)
		}
		answer, err := integrityCheck(path)
		if err != nil {
			problems = append(problems, failure{what: fmt.Sprintf(
				"a backup taken under the %d MiB floor left %s behind as a file PRAGMA integrity_check cannot read (%v): an interrupted VACUUM INTO must be removed (OC-0212) rather than offered as a restorable backup",
				drillMinFreeDiskMB, name, err)})
		} else if answer != "ok" {
			problems = append(problems, failure{what: fmt.Sprintf(
				"a backup taken under the %d MiB floor left %s behind with integrity_check %q: the file is listed as a backup an operator can restore, and it is not one (OC-0212)",
				drillMinFreeDiskMB, name, answer)})
		}
	}
	if code == http.StatusOK && len(fresh) == 0 {
		problems = append(problems, failure{what: "the backup endpoint answered 200 with no new file in the backup list"})
	}
	return problems, nil
}

// dFull fills to the wall and asks 50 messages' worth of questions: every send
// must be answered, the server must still be there, and the log must name what
// happened. The paths that go quiet are recorded, because a silent path is a
// candidate finding and the drill is the only thing that can see it.
func (d *drill) dFull(f filler, s *dStage) ([]failure, error) {
	if err := d.fillToWall(f); err != nil {
		return nil, err
	}
	fmt.Printf("%s: full — %d MiB of junk on the filesystem, which now refuses more\n", d.phase, f.total()>>20)
	var problems []failure
	silent, refused, acked := 0, 0, 0
	for i := range drillFullSends {
		frame, err := s.conn.chatSend(s.text.ID, fmt.Sprintf("full %d", i))
		if err != nil {
			silent++
			continue
		}
		switch frame.Type {
		case "chat_send_ok":
			acked++
		case "error":
			refused++
		default:
			silent++
		}
	}
	s.oks += acked
	fmt.Printf("%s: %d sends on a full filesystem — %d acknowledged, %d refused with an error frame, %d unanswered\n",
		d.phase, drillFullSends, acked, refused, silent)
	if silent > 0 {
		problems = append(problems, failure{what: fmt.Sprintf(
			"%d of %d chat_sends on a full filesystem were answered with nothing at all: the server must answer every send with an error frame, and an unanswered send is a client that waits forever",
			silent, drillFullSends)})
	}
	if refused == 0 && silent == 0 {
		// The other half of the same claim, and the one silence cannot catch: if
		// nothing was refused then the filesystem was not actually full, and the
		// drill has measured nothing about the disk path — the fill did not do
		// its job, so it must not report as though it had. Guarded on no silence
		// too, because fifty unanswered sends is a server that stopped
		// answering, and blaming the fill for that would be the wrong sentence
		// in the log an operator reads.
		problems = append(problems, failure{what: fmt.Sprintf(
			"%d chat_sends on a full filesystem and not one was refused: the fixture proves nothing about the disk path, and a pass here would assert that a full disk refuses writes having never seen one refused",
			drillFullSends)})
	}

	body, status, err := healthOf()
	if err != nil {
		return nil, d.annotate(err)
	}
	if status != http.StatusServiceUnavailable || body.Reason != "disk" {
		problems = append(problems, failure{what: fmt.Sprintf(
			"with the filesystem full /health answered %d %s/%s, want 503 degraded/disk: the one endpoint that is supposed to tell an owner what is wrong must still answer when it is wrong",
			status, body.Status, body.Reason)})
	}

	text, err := d.logText()
	if err != nil {
		return nil, d.annotate(err)
	}
	if !mentionsFullDisk(text) {
		problems = append(problems, failure{what: fmt.Sprintf(
			"the log never names the disk being full: neither SQLITE_FULL nor \"database or disk is full\" appears in %d bytes of server output, so an operator reading the log after the fact has nothing to go on",
			len(text))})
	}
	quiet := quietPaths(text)
	fmt.Printf("%s: the log's disk-pressure and background-writer lines (%d):\n", d.phase, len(quiet))
	for i, line := range quiet {
		if i == 40 {
			fmt.Printf("%s: ... and %d more\n", d.phase, len(quiet)-i)
			break
		}
		fmt.Printf("  %s\n", line)
	}
	return problems, nil
}

// dRecover gives the space back and asks the same three questions again, then
// restarts and counts the rows the acknowledgements promised.
func (d *drill) dRecover(f filler, s *dStage) ([]failure, error) {
	if err := f.release(); err != nil {
		return nil, d.annotate(err)
	}
	if err := d.awaitHealthyAgain(); err != nil {
		return nil, err
	}
	var problems []failure
	frame, err := s.conn.chatSend(s.text.ID, "recovered")
	if err != nil {
		return nil, d.annotate(err)
	}
	if err := wantOK(frame, "chat_send_ok"); err != nil {
		problems = append(problems, failure{what: fmt.Sprintf(
			"after the space was given back the server still refuses messages: %v — a server that does not recover when the disk does leaves the operator restarting it for an hour", err)})
	} else {
		s.oks++
	}
	code, detail, err := uploadStatus(s.token)
	if err != nil {
		return nil, d.annotate(err)
	}
	fmt.Printf("%s: after the space was given back an upload answered %d %s\n", d.phase, code, detail)
	if code != http.StatusCreated {
		problems = append(problems, failure{what: fmt.Sprintf(
			"after the space was given back an upload answered %d %s, want 201: the reserved headroom is back, so the upload path has no reason to refuse", code, detail)})
	}

	if d.docker {
		// A container's /app/data is a tmpfs: it is destroyed with the
		// container, so a reboot here would measure a fresh install rather than
		// a recovery. This is the one place the container leg runs, and it runs
		// only this phase, so a plain print here would leave the whole leg
		// reporting a pass over a step that never ran — the exact read the skip
		// machinery exists to prevent.
		d.skipStep("the durability half is standalone-only — /app/data is a tmpfs, destroyed with the container")
		return problems, nil
	}
	found, err := d.dRebootCount(s)
	problems = append(problems, found...)
	return problems, err
}

// dRebootCount restarts the install and asks the question acknowledgements
// exist for: every message the server said it stored is a row, and every row is
// one it said it stored. Both halves are findings — a message kept that was
// never acknowledged, and a message acknowledged and lost.
func (d *drill) dRebootCount(s *dStage) ([]failure, error) {
	if err := d.stop(); err != nil {
		return nil, err
	}
	if err := d.boot("D2.log", d.diskEnv()...); err != nil {
		return nil, err
	}
	var problems []failure
	answer, err := integrityCheck(filepath.Join(d.dataFS, "chatserver.db"))
	if err != nil {
		return nil, d.annotate(err)
	}
	if answer != "ok" {
		problems = append(problems, failure{what: fmt.Sprintf(
			"after a full filesystem was given back and the server restarted, the database does not integrity_check: %s", answer)})
	}
	rows, err := messageRows(d.dataFS, s.text.ID, s.owner)
	if err != nil {
		return nil, d.annotate(err)
	}
	fmt.Printf("%s: after the restart the database holds %d row(s) for %d acknowledged send(s)\n", d.phase, rows, s.oks)
	switch {
	case rows < s.oks:
		problems = append(problems, failure{what: fmt.Sprintf(
			"the database holds %d message row(s) for %d send(s) the server acknowledged: %d message(s) were acknowledged and lost",
			rows, s.oks, s.oks-rows)})
	case rows > s.oks:
		problems = append(problems, failure{what: fmt.Sprintf(
			"the database holds %d message row(s) for %d send(s) the server acknowledged: %d message(s) were stored without an acknowledgement, so the sender was told they failed",
			rows, s.oks, rows-s.oks)})
	}
	return problems, nil
}

// fillToHealthFloor fills until /health reports the disk degradation the drill
// booted the floor for.
//
// The boundary is found through the product's own health report rather than
// from a statfs: /health degrades at the same floor the upload path refuses at,
// so crossing it is exactly the state this stage is about — and a container's
// tmpfs cannot be stat'ed from the host at all. The first fill is computed from
// the declared size and every later one follows the five-second health cache.
func (d *drill) fillToHealthFloor(f filler) error {
	filled, err := f.fill(drillHeadroomFirstFill)
	if err != nil && !errors.Is(err, errNoSpace) {
		return d.annotate(err)
	}
	if filled < drillHeadroomFirstFill {
		return d.annotate(fmt.Errorf(
			"the filesystem took only %d MiB of the %d MiB it was asked for before refusing, so it was nearly full before the drill started",
			filled>>20, drillHeadroomFirstFill>>20))
	}
	deadline := time.Now().Add(healthCacheWait)
	for {
		body, status, err := healthOf()
		if err != nil {
			return d.annotate(err)
		}
		switch {
		case status == http.StatusServiceUnavailable && body.Reason == "disk":
			fmt.Printf("%s: /health reports the disk floor after %d MiB of junk\n", d.phase, f.total()>>20)
			return nil
		case f.total() >= drillFillCap:
			return d.annotate(fmt.Errorf(
				"wrote %d MiB and /health still answers %d %s/%s: this is not the %d MiB filesystem phase D is run against, and the drill will not fill a real one to find out",
				f.total()>>20, status, body.Status, body.Reason, drillTmpfsBytes>>20))
		case time.Now().After(deadline):
			// The answer is cached (healthCacheTTL, 5 s), so a top-up plus a
			// fresh cache window is how the boundary is found without a statfs.
			n, err := f.fill(drillFillStep)
			if errors.Is(err, errNoSpace) {
				return d.annotate(fmt.Errorf(
					"the filesystem refused more at %d MiB, before /health reported the %d MiB floor the drill booted with",
					f.total()>>20, drillMinFreeDiskMB))
			}
			if err != nil {
				return d.annotate(err)
			}
			if n < drillFillStep {
				return d.annotate(fmt.Errorf("the filesystem took only %d of %d bytes before refusing", n, drillFillStep))
			}
			deadline = time.Now().Add(healthCacheWait)
		default:
			time.Sleep(pollInterval)
		}
	}
}

// fillToWall fills until the filesystem refuses more. The loop is bounded by
// drillFillCap across BOTH fills, so a -data-fs that is not a size-limited
// filesystem cannot fill a real disk: it fails instead, which is the only
// honest outcome for a drill that cannot measure what it was pointed at.
func (d *drill) fillToWall(f filler) error {
	for f.total() < drillFillCap {
		n, err := f.fill(drillFillStep)
		switch {
		case errors.Is(err, errNoSpace):
			return nil
		case err != nil:
			return d.annotate(err)
		case n < drillFillStep:
			return d.annotate(fmt.Errorf("the filesystem took only %d of %d bytes before refusing", n, drillFillStep))
		}
	}
	return d.annotate(fmt.Errorf(
		"wrote %d MiB and the filesystem still accepts more: phase D needs a size-limited filesystem and -data-fs is not one",
		f.total()>>20))
}

// awaitHealthyAgain polls until /health says ok again. The answer is cached for
// five seconds, so a single call would read the pre-recovery answer and report
// the recovery as a failure.
func (d *drill) awaitHealthyAgain() error {
	deadline := time.Now().Add(2 * healthCacheWait)
	last := ""
	for time.Now().Before(deadline) {
		body, status, err := healthOf()
		if err != nil {
			return d.annotate(err)
		}
		last = fmt.Sprintf("%d %s/%s", status, body.Status, body.Reason)
		if status == http.StatusOK {
			fmt.Printf("%s: /health is ok again\n", d.phase)
			return nil
		}
		time.Sleep(pollInterval)
	}
	return d.annotate(fmt.Errorf("/health still says %s after the space was given back, want 200 ok", last))
}

// logText is everything the server has said, whichever leg wrote it.
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

// backupFile reads a backup out of the install for an out-of-process integrity
// check: straight off the filesystem on the standalone leg, through docker cp
// on the container one (the file is in the container's tmpfs, which only docker
// can read).
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

// newNames is what appeared in the backup listing across an operation.
func newNames(before, after []string) []string {
	var fresh []string
	for _, name := range after {
		if !slices.Contains(before, name) {
			fresh = append(fresh, name)
		}
	}
	return fresh
}

// mentionsFullDisk reports whether the log names the failure the product's own
// driver reports when the disk is full. Both spellings are accepted because
// either can be the one in the log: the driver's ("Insertion failed because
// database is full (SQLITE_FULL)") and SQLite's own strerror (13).
func mentionsFullDisk(log string) bool {
	return strings.Contains(log, "SQLITE_FULL") || strings.Contains(log, "database or disk is full")
}

// quietPaths are the log lines a candidate finding would be written from: the
// disk-pressure errors themselves and any line from a background path that
// writes (the audit flusher, the persister, session touch). Nothing here is
// asserted — the drill records what the log says, so the candidates are
// readable in the run rather than only in a log somebody greps afterwards.
func quietPaths(log string) []string {
	names := []string{
		"sqlite_full", "disk is full", "disk full", "no space",
		"audit", "persist", "session touch", "session_touch", "flush",
	}
	var lines []string
	for line := range strings.SplitSeq(log, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		lower := strings.ToLower(line)
		for _, name := range names {
			if strings.Contains(lower, name) {
				lines = append(lines, line)
				break
			}
		}
	}
	return lines
}

// ─── the disk fillers ───────────────────────────────────────────────────────

// errNoSpace is what a filler reports when the filesystem refused more bytes.
// It is not one sentinel per platform: the write itself says the same thing
// more portably than any errno (Write returns n < len(p) only when it had to
// stop), and the two legs reach the wall through completely different calls.
var errNoSpace = errors.New("the filesystem refused more bytes")

// filler puts junk on the filesystem phase D is filling and takes it off again.
// Two implementations, because a container's tmpfs is not a path this harness
// can write to: it goes through docker cp.
type filler interface {
	// fill appends up to n bytes and reports how many it managed. A short fill
	// is errNoSpace: that is the state the full stage is looking for.
	fill(n uint64) (uint64, error)
	// release gives the space back.
	release() error
	// total is every byte this filler has put on the filesystem, so the cap
	// bounds the whole phase rather than one loop of it.
	total() uint64
}

// fillerCount is the byte count both fillers keep for total().
type fillerCount struct{ bytes uint64 }

func (c *fillerCount) total() uint64 { return c.bytes }

// dirFiller fills a directory on the size-limited filesystem -data-fs names.
type dirFiller struct {
	fillerCount
	path string
}

func newDirFiller(dir string) (*dirFiller, error) {
	// Truncated rather than appended to: a leftover junk file from an earlier
	// run would silently change how much of the filesystem is left.
	path := filepath.Join(dir, drillJunkName)
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		return nil, fmt.Errorf("creating %s: %w", path, err)
	}
	return &dirFiller{path: path}, nil
}

func (f *dirFiller) fill(n uint64) (uint64, error) {
	file, err := os.OpenFile(f.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return 0, err
	}
	defer func() { _ = file.Close() }()
	buf := make([]byte, drillFillStep)
	written := uint64(0)
	for written < n {
		size := min(n-written, uint64(len(buf)))
		w, err := file.Write(buf[:size])
		written += uint64(w)
		f.bytes += uint64(w)
		if err != nil {
			if uint64(w) < size {
				return written, errNoSpace
			}
			return written, fmt.Errorf("writing to %s: %w", f.path, err)
		}
	}
	return written, nil
}

func (f *dirFiller) release() error { return os.Remove(f.path) }

// dockerFiller fills a container's tmpfs through docker cp. The image is
// distroless: no shell and no rm, so copying a file in is the only way to put
// bytes there and copying a one-byte file over the same path is the only way to
// take them out again.
type dockerFiller struct {
	fillerCount
	t    *dockerTarget
	dir  string   // host staging directory, one name per fill
	junk []string // the names this filler created, in the order it created them
}

func newDockerFiller(t *dockerTarget) (*dockerFiller, error) {
	dir, err := os.MkdirTemp("", "owncord-drill-junk-")
	if err != nil {
		return nil, err
	}
	return &dockerFiller{t: t, dir: dir}, nil
}

func (f *dockerFiller) fill(n uint64) (uint64, error) {
	name := fmt.Sprintf("%s-%d", drillJunkName, len(f.junk)+1)
	stage, err := os.MkdirTemp(f.dir, "fill-")
	if err != nil {
		return 0, err
	}
	if err := os.WriteFile(filepath.Join(stage, name), make([]byte, n), 0o600); err != nil {
		return 0, err
	}
	if err := f.t.copyIn(f.t.name, stage); err != nil {
		if isNoSpace(err) {
			return 0, errNoSpace
		}
		// isNoSpace matches the daemon's wording, not an errno — docker cp
		// extracts inside the daemon, so the ENOSPC it hit is not the error this
		// process can inspect. A daemon that reworded that message therefore
		// lands here, and the raw text is printed as itself: otherwise the run
		// reports a full tmpfs as a harness failure whose message names neither
		// the filesystem nor the missing match.
		fmt.Printf("%s: the container refused %d bytes with an error matching no known ENOSPC wording (%v) — if the tmpfs is full, the daemon's message has changed and isNoSpace needs the new text\n",
			f.t.name, n, err)
		return 0, fmt.Errorf("putting %d bytes into the container: %w", n, err)
	}
	f.junk = append(f.junk, name)
	f.bytes += n
	return n, nil
}

func (f *dockerFiller) release() error {
	stage, err := os.MkdirTemp(f.dir, "release-")
	if err != nil {
		return err
	}
	for _, name := range f.junk {
		if err := os.WriteFile(filepath.Join(stage, name), []byte{0}, 0o600); err != nil {
			return err
		}
	}
	// One copy, one tar: every name this filler created is replaced by a
	// one-byte file, which frees the blocks the big ones held.
	if err := f.t.copyIn(f.t.name, stage); err != nil {
		return fmt.Errorf("releasing the container's junk: %w", err)
	}
	return nil
}

// isNoSpace recognises the daemon's answer to a full tmpfs, which arrives as
// text rather than as an errno: docker cp runs the extraction inside the
// daemon, so the ENOSPC it hit is not the error this process sees.
func isNoSpace(err error) bool {
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "no space left on device") || strings.Contains(lower, "disk full")
}

// ─── phase S: the SFU ───────────────────────────────────────────────────────

// phaseS is drill 6: what a voice join does when the SFU it was told to manage
// dies under it, and what it does when the SFU it was told to use was never
// there.
func (d *drill) phaseS() error {
	if err := d.ensurePortFree(); err != nil {
		return err
	}
	bin, ok := livekitBinary()
	if !ok {
		// A skip, printed, never a pass (see the phase D skip).
		d.skipped = append(d.skipped, 'S')
		fmt.Printf("%s: skipped (no livekit-server binary: set %s, or put one at %s)\n",
			d.phase, livekitBinaryEnv, filepath.Join("tools", "livekit-server"))
		return nil
	}
	if err := d.boot("S.log", "OWNCORD_VOICE_LIVEKIT_BINARY="+bin); err != nil {
		return err
	}
	var problems []failure
	found, err := d.stepSSupervised(bin)
	problems = append(problems, found...)
	if err != nil {
		return err
	}
	found, err = d.stepSExternalAbsent()
	problems = append(problems, found...)
	if err != nil {
		return err
	}
	if err := d.failures(problems); err != nil {
		return err
	}
	return d.stop()
}

// stepSSupervised kills the managed SFU under a live install and watches the
// three things the owner would see: the join refused, the health endpoint
// saying the SFU is down, and the join working again after the supervisor's
// first restart.
func (d *drill) stepSSupervised(bin string) ([]failure, error) {
	token, err := runSetup(d.baseURL())
	if err != nil {
		return nil, d.annotate(err)
	}
	voice, err := pickChannel(token, "voice")
	if err != nil {
		return nil, d.annotate(err)
	}
	conn, err := dialWS(token)
	if err != nil {
		return nil, d.annotate(err)
	}
	defer conn.close()
	joined, err := conn.voiceJoin(voice.ID)
	if err != nil {
		return nil, d.annotate(err)
	}
	if err := wantOK(joined, "voice_token"); err != nil {
		return nil, d.annotate(fmt.Errorf("joining voice with the supervised SFU running: %w", err))
	}
	fmt.Printf("%s: joined voice with the managed SFU running\n", d.phase)

	if err := killLiveKit(bin); err != nil {
		return nil, d.annotate(err)
	}
	// The guard reads IsRunning(), which goes false when the supervisor's
	// Wait() returns — microseconds after the signal, but not necessarily
	// before a join that raced it. So the probe retries, on a FRESH socket
	// each time: a socket that already holds a voice state would get
	// ALREADY_JOINED whatever the SFU is doing, and a minted token from a
	// fresh socket is real evidence of the guard being absent.
	seen, err := probeVoiceJoin(token, voice.ID, restartWindow, pollInterval/4,
		func(f wsFrame) bool { return f.Type == "error" })
	if err != nil {
		return nil, d.annotate(err)
	}
	if len(seen) == 0 {
		return nil, d.annotate(errors.New("the voice_join probe produced no frame at all, so the kill measured nothing"))
	}
	last := seen[len(seen)-1]
	if last.Type != "error" {
		minted := 0
		for _, f := range seen {
			if f.Type != "error" {
				minted++
			}
		}
		return []failure{{what: fmt.Sprintf(
			"the SFU was killed and voice_join still answered with a minted token on all %d attempt(s): a client is handed a LiveKit token for a room nothing is serving (B6-6's disguised success), and it finds out only when the connection fails",
			minted)}}, nil
	}
	code, message := last.errCode()
	fmt.Printf("%s: with the SFU killed voice_join refused with %s: %s\n", d.phase, code, message)

	// The diagnostics endpoint is administrator-gated and rate-limited to five
	// requests a minute on its own key, so it is called once (D10) — a retry
	// loop here would collect 429s, and a 429 read as "the SFU is down" would
	// invert what this step asserts.
	healthy, err := livekitHealth(token)
	if err != nil {
		return nil, d.annotate(err)
	}
	var problems []failure
	fmt.Printf("%s: the diagnostics endpoint says livekit_health=%t with the process dead\n", d.phase, healthy)
	if healthy {
		problems = append(problems, failure{what: "the diagnostics endpoint reports livekit_health=true while the managed SFU's process is dead"})
	}

	// The supervisor's first restart: a 3 second backoff (ws.LiveKitProcess),
	// then the child is back. A fresh socket again — the one that refused holds
	// no voice state (the refusal happens before the join persists), but the
	// first socket is still in the channel and a re-join from it would answer
	// ALREADY_JOINED.
	seen, err = probeVoiceJoin(token, voice.ID, supervisorRestartBudget, pollInterval/2,
		func(f wsFrame) bool { return f.Type == "voice_token" })
	if err != nil {
		return nil, d.annotate(err)
	}
	if len(seen) == 0 || seen[len(seen)-1].Type != "voice_token" {
		problems = append(problems, failure{what: fmt.Sprintf(
			"the managed SFU never came back: voice_join still refuses %s after the supervisor's first restart window", supervisorRestartBudget)})
	} else {
		fmt.Printf("%s: the supervisor restarted the SFU and voice_join mints a token again\n", d.phase)
	}
	return problems, nil
}

// probeVoiceJoin asks to join on a fresh socket until done(frame), or until the
// budget runs out, and returns every frame it saw in order.
//
// A fresh socket per attempt is the point rather than a detail: a socket that
// already holds a voice state answers ALREADY_JOINED whatever the SFU is doing,
// so a re-join from a reused socket would measure the socket and not the guard.
func probeVoiceJoin(token string, voiceID int64, budget, pause time.Duration, done func(wsFrame) bool) ([]wsFrame, error) {
	var seen []wsFrame
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		probe, err := dialWS(token)
		if err != nil {
			return seen, err
		}
		frame, err := probe.voiceJoin(voiceID)
		probe.close()
		if err != nil {
			return seen, err
		}
		seen = append(seen, frame)
		if done(frame) {
			return seen, nil
		}
		time.Sleep(pause)
	}
	return seen, nil
}

// stepSExternalAbsent boots an install pointed at an externally managed SFU
// that is not there and records what a join does.
//
// Recorded rather than asserted: the brief asks for "token minted or error",
// and a minted token is the disguised-success shape B6-6 forbids — a finding
// that needs a ledger row before a drill can fail on it, which R12/R13 say a
// drill does not write. So it prints a ::warning:: that cannot be missed in CI
// and the measurement, and the fix (one HealthCheck before the mint) stays a
// behaviour change with its own PR.
func (d *drill) stepSExternalAbsent() ([]failure, error) {
	if err := d.stop(); err != nil {
		return nil, err
	}
	// Its own install directory: the first boot's config.yaml may have recorded
	// the binary path the drill gave it, and step 2 is exactly the absence of
	// one.
	dir := filepath.Join(d.dir, "external")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := d.bootAt(dir, "S2.log", "OWNCORD_VOICE_LIVEKIT_URL=ws://127.0.0.1:1"); err != nil {
		return nil, err
	}
	token, err := runSetup(d.baseURL())
	if err != nil {
		return nil, d.annotate(err)
	}
	voice, err := pickChannel(token, "voice")
	if err != nil {
		return nil, d.annotate(err)
	}
	conn, err := dialWS(token)
	if err != nil {
		return nil, d.annotate(err)
	}
	defer conn.close()
	frame, err := conn.voiceJoin(voice.ID)
	if err != nil {
		return nil, d.annotate(err)
	}
	if frame.Type != "voice_token" {
		code, message := frame.errCode()
		fmt.Printf("%s: an external SFU that is not there was refused with %s: %s\n", d.phase, code, message)
		return nil, nil
	}
	fmt.Printf("::warning::%s: voice_join minted a token for an externally managed SFU that is not reachable at ws://127.0.0.1:1 — the disguised-success shape B6-6 forbids (the client is handed a token and discovers the failure when the connection fails). Not filed in the ledger: R12/R13 keep a drill out of it, so the run cannot mark it known yet\n", d.phase)
	fmt.Printf("%s: an absent external SFU was recorded as a MINTED TOKEN\n", d.phase)
	return nil, nil
}

// livekitBinaryEnv is how the workflow hands phase S the binary it fetched and
// verified (load-baseline.yml's "Fetch and verify livekit-server" step).
const livekitBinaryEnv = "OWNCORD_DRILL_LIVEKIT_BINARY"

// livekitBinary resolves the livekit-server phase S kills: the path the
// workflow fetched, or a copy where a developer keeps one. The harness never
// downloads it — the workflow verifies the release against the vendor's
// checksums.txt before it gets here, and a harness that fetched its own copy
// would be a second, unverified source of the same binary.
//
// The path comes back absolute because the SERVER starts it, and the server's
// working directory is the install directory rather than this process's.
func livekitBinary() (string, bool) {
	candidates := []string{}
	if p := os.Getenv(livekitBinaryEnv); p != "" {
		candidates = append(candidates, p)
	}
	for _, name := range []string{"livekit-server", "livekit-server.exe"} {
		candidates = append(candidates,
			filepath.Join("tools", name),
			filepath.Join("..", "tools", name),
			name,
			filepath.Join("..", name),
		)
	}
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			if abs, err := filepath.Abs(candidate); err == nil {
				return abs, true
			}
			return candidate, true
		}
	}
	return "", false
}

// killLiveKit kills whatever process is running a given livekit-server binary.
//
// The supervised child belongs to the SERVER, not to this harness: the server
// spawns it (ws.LiveKitProcess.runLoop) and holds the only handle to it, with
// no PID file anywhere. Killing by image is what an operator's own tooling has
// (taskkill, pkill) and is the only handle a process outside the server has;
// on a drill machine nothing else runs under that name.
func killLiveKit(bin string) error {
	switch runtime.GOOS {
	case "windows":
		// Absolute, because taskkill is in the one directory a Git Bash PATH is
		// allowed to be missing: System32 itself, which MSYS leaves out while
		// keeping its subdirectories. PATH lookup here fails with "executable
		// file not found in %PATH%" on a machine that has it.
		root := os.Getenv("SystemRoot")
		if root == "" {
			root = `C:\Windows`
		}
		return runCommand(filepath.Join(root, "System32", "taskkill.exe"), "/F", "/IM", filepath.Base(bin))
	default:
		return runCommand("pkill", "-9", "-f", bin)
	}
}

// runCommand runs a one-shot helper whose exit status is the answer.
func runCommand(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("running %s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// ownerID is the drill owner's user id, read from the session it authenticated
// with: phase D counts the rows THAT user's acknowledged sends must have left.
func ownerID(token string) (int64, error) {
	var me struct {
		ID int64 `json:"id"`
	}
	if err := get("/api/v1/auth/me", token, &me); err != nil {
		return 0, fmt.Errorf("reading the owner's id: %w", err)
	}
	if me.ID == 0 {
		return 0, errors.New("the session reports no user id")
	}
	return me.ID, nil
}

// uploadStatus posts the fixture attachment and reports the status and body the
// server answered with, because phase D's assertion is a refusal (507
// STORAGE_LOW_DISK) that request() would report as a transport failure.
func uploadStatus(token string) (int, string, error) {
	body, contentType, err := multipartUpload()
	if err != nil {
		return 0, "", err
	}
	req, err := http.NewRequest(http.MethodPost, defaultBaseURL+"/api/v1/uploads", bytes.NewReader(body)) //nolint:noctx // bounded by the client Timeout
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", contentType)
	resp, err := fixtureClient.Do(req)
	if err != nil {
		return 0, "", fmt.Errorf("uploading: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	return resp.StatusCode, strings.TrimSpace(string(detail)), nil
}

// backupStatus takes a backup and reports the status and body, for the same
// reason uploadStatus exists.
func backupStatus(token string) (int, string, error) {
	req, err := http.NewRequest(http.MethodPost, defaultBaseURL+"/admin/api/backup", nil) //nolint:noctx // bounded by the client Timeout
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := fixtureClient.Do(req)
	if err != nil {
		return 0, "", fmt.Errorf("taking a backup: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
	return resp.StatusCode, strings.TrimSpace(string(detail)), nil
}

const (
	// drillTmpfsBytes is the filesystem phase D fills: task 4 mounts a 24 MiB
	// tmpfs for the standalone leg and passes --tmpfs size=24m for the
	// container one. The size is declared rather than measured because a
	// container's tmpfs cannot be stat'ed from the host; the first fill is
	// computed from it and every assertion after that is a measurement.
	drillTmpfsBytes = 24 << 20

	// drillMinFreeDiskMB is the floor the drill boots with
	// (server.min_free_disk_mb), the same floor /health reports and the upload
	// path reserves — which is what makes "cross the floor once and both
	// answers are observable" true.
	drillMinFreeDiskMB = 8

	// drillHeadroomFirstFill is the first fill: the tmpfs minus a margin that
	// leaves the free space inside the brief's window (under 8 MiB, above
	// 2 MiB) once the server's own files have taken their share. Later fills
	// top it up a megabyte at a time until /health agrees.
	drillHeadroomFirstFill = 17 << 20

	// drillFillStep is what each later fill adds — one megabyte, because a
	// megabyte is the resolution the headroom window can afford.
	drillFillStep = 1 << 20

	// drillFillCap bounds everything phase D will ever write. It is what keeps
	// a -data-fs mistake (a real disk) from becoming a filled disk: the drill
	// fails instead, which is the honest outcome for a filesystem it cannot
	// fill to a wall.
	drillFillCap = 64 << 20

	// drillJunkName is the junk file (or the name each container junk file
	// starts with). Named rather than random so a leftover from a killed run is
	// recognisable.
	drillJunkName = "drill-junk"

	// drillFullSends is how many messages the full stage sends: the brief's 50,
	// each of which must be answered.
	drillFullSends = 50

	// drillVictim and drillNewcomer are the two accounts phase R registers
	// through an invite: the one it erases, and the one it creates after the
	// backup so the restore has newer data to drop.
	drillVictim   = "drill-victim"
	drillNewcomer = "drill-newcomer"

	// healthCacheWait bounds a wait for /health to answer with the state the
	// disk is in. The endpoint caches its answer for five seconds
	// (api/router.go's healthCacheTTL), so this must exceed it.
	healthCacheWait = 8 * time.Second

	// pollInterval is the drill's own poll, four times finer than the harness's
	// pollEvery: the states phase D and S wait for change within a second of an
	// event the drill just caused.
	pollInterval = 250 * time.Millisecond

	// configFailBudget is how long a boot on a broken config.yaml may take
	// before the delay itself is the finding: an operator who just edited the
	// file is waiting for it.
	configFailBudget = 5 * time.Second

	// restartBroadcastBudget is how long the open sessions are given to receive
	// server_restart. It is generous because the frame is sent before the
	// process exits and is buffered per connection, so the wait is for the
	// harness's own bookkeeping rather than for anything on the wire.
	restartBroadcastBudget = 10 * time.Second

	// restartWindow is how long the post-kill probe may keep asking while the
	// managed SFU is down. The supervisor's first restart is after a 3 second
	// backoff (ws.LiveKitProcess's baseDelay), so the window stays inside it.
	restartWindow = 2500 * time.Millisecond

	// supervisorRestartBudget is how long the managed SFU's first restart is
	// given: the 3 second backoff plus the child's own boot, with room for a
	// loaded CI machine.
	supervisorRestartBudget = 30 * time.Second

	// registerRateLimitPerMinute is what the API caps registrations at per IP
	// per minute (api/constants.go) — quoted in phase R's own output, so the
	// scaling below reads as a deliberate override rather than a mystery.
	registerRateLimitPerMinute = 3

	// drillAuthRateScale is security.auth_rate_limit_multiplier for phase R's
	// boot. The phase needs 20 accounts and the register cap is 3 a minute per
	// IP, so a run that stayed inside it would need seven minutes of waiting to
	// build its fixture. The multiplier is the documented knob for a deployment
	// where many users share one address, and nothing phase R asserts — a
	// backup, a restore, a marker replay, a restart notice — goes through the
	// auth rate limiter.
	drillAuthRateScale = 40
)

// configLinePattern is the file-and-line the broken-config step asserts. YAML's
// own error is "yaml: line 3: ...", and the number is what the operator needs.
var configLinePattern = regexp.MustCompile(`(?i)\bline \d+`)
