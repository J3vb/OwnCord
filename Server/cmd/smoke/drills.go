package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	_ "modernc.org/sqlite" // the same pure-Go driver the server uses, registered as "sqlite"
)

// phase is one drill phase: the letter -phases selects it by, and what it covers (printed so a green run says
// what it ran). The phases are R (backup, restore, deletion markers; drills 1, 2), C (corrupt operator input;
// drill 5), D (headroom, full, recovery; drills 3, 4) and S (the SFU; drill 6). Nothing relaunches the
// server: a phase that needs a restart asks for one through the owner's endpoint, so the restart is the
// behaviour under test.
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

// parsePhases turns -phases into the phases to run, in numbered order (a phase may depend on an earlier one's
// leftovers). Empty means all; a spec with no letters is an error, because a run that executes no drill exits
// 0 and reads like a pass.
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

type ledgerRow struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type ledger struct {
	Findings []ledgerRow `json:"findings"`
}

// ledgerPaths is where the tracked ledger is looked for: the workflow runs from Server/, a developer may run
// from the repository root. A path that quietly resolved to nothing would disable the flag's validation (see
// newKnown).
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

// known is the -known-findings flag: ledger ids this run may downgrade a failure to a warning for. Currently
// inert: triage downgrades only a failure that carries an id, and none here sets one.
type known struct {
	ids map[string]bool
	// release reports whether this is the release (workflow_call) path; only there is a known id downgraded, so
	// nightly and dispatch runs cannot hide a finding behind the flag.
	release bool
}

// newKnown validates the flag against the ledger. An id the ledger lacks or lists as anything but open is
// refused: ignored, it would read like a working flag, and a fixed finding left in the list would become a
// permanent hole in the gate.
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

// knownFindings is -known-findings as used. The ledger is read only when the flag names something, so a run
// without it cannot fail on a missing ledger.
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

func releasePath() bool { return os.Getenv("GITHUB_EVENT_NAME") == "workflow_call" }

// failure is one thing a drill measured that must not happen. id names the ledger finding it instances, when
// known; a failure with no id is new by definition and always fails.
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

// triage splits a phase's failures into those that fail the run and those the release path downgrades to a
// ::warning:: (only a failure whose id the flag named).
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

// runDrills runs the selected phases in one process, in numbered order, each in its own install directory so
// a broken credential or full filesystem is not left for the next.
func runDrills(binRef string, useDocker bool, phases []phase, dataFS string, k known) error {
	d := &drill{bin: binRef, dataFS: dataFS, known: k, docker: useDocker}

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

	// Every requested phase runs even after a failure (stopping hid the later ones). A failed phase may leave a
	// server on the port, so it is reclaimed before the next phase.
	results := runEach(phases, func(p phase) error {
		err := d.runPhase(p)
		if err != nil {
			fmt.Printf("::error::%v\n", err)
			if !d.docker {
				d.reclaimPort()
			}
		}
		return err
	})
	fmt.Print(d.table(results))
	if err := failedPhases(results); err != nil {
		return err
	}
	// Printed here, not by main: a skipped phase is not a pass, and the run's
	// last line must say so.
	fmt.Println(d.summary(phases))
	return nil
}

type phaseResult struct {
	phase phase
	err   error
}

func runEach(phases []phase, run func(phase) error) []phaseResult {
	results := make([]phaseResult, 0, len(phases))
	for _, p := range phases {
		results = append(results, phaseResult{phase: p, err: run(p)})
	}
	return results
}

func failedPhases(results []phaseResult) error {
	var failed []string
	for _, r := range results {
		if r.err != nil {
			failed = append(failed, string(r.phase.letter))
		}
	}
	if len(failed) == 0 {
		return nil
	}
	return fmt.Errorf("failure and recovery drills failed: %d of %d phases (%s), see the summary above",
		len(failed), len(results), strings.Join(failed, ", "))
}

// table is the per-phase summary printed after every run: result and, for anything but a clean pass, why
// (first line of the error; the full error and server log were printed at the failure).
func (d *drill) table(results []phaseResult) string {
	var b strings.Builder
	b.WriteString("drills summary:\n")
	fmt.Fprintf(&b, "  %-6s %-8s %s\n", "phase", "result", "reason")
	for _, r := range results {
		result, reason := "passed", ""
		switch {
		case r.err != nil:
			result = "FAILED"
			reason, _, _ = strings.Cut(r.err.Error(), "\n")
		case slices.Contains(d.skipped, r.phase.letter):
			result, reason = "skipped", "no measurement was made"
		case len(d.partial[r.phase.letter]) > 0:
			reason = "except " + strings.Join(d.partial[r.phase.letter], "; except ")
		}
		fmt.Fprintf(&b, "  %-6c %-8s %s\n", r.phase.letter, result, reason)
	}
	return b.String()
}

// reclaimPort frees the port after a failed phase so the next measures its own server. annotate kills the
// server this harness spawned; what can remain is a self-restart replacement (not this harness's child, see
// awaitRestart) that may still be booting. It is found by its working directory inside this run's install
// directories, so nothing outside the run is touched. Where that lookup is unavailable the next phase fails
// on ensurePortFree, which names the cause.
func (d *drill) reclaimPort() {
	if d.srv != nil && !d.srv.adopted && !d.srv.exited && d.srv.cmd != nil {
		_ = d.srv.cmd.Process.Kill()
	}
	d.srv = nil
	pids := strayServers(d.dirs)
	if len(pids) == 0 {
		if serving(d.baseURL()) {
			fmt.Printf("%s: something is still serving %s and no process from this run's install directories was found to stop\n", d.phase, d.baseURL())
		}
		return
	}
	for _, sig := range []func(int) error{terminate, kill} {
		for _, pid := range pids {
			_ = sig(pid)
		}
		deadline := time.Now().Add(drainBudget)
		for time.Now().Before(deadline) {
			if len(strayServers(d.dirs)) == 0 && !serving(d.baseURL()) {
				fmt.Printf("%s: stopped the %d process(es) the failed phase left behind\n", d.phase, len(pids))
				return
			}
			time.Sleep(pollEvery)
		}
	}
	fmt.Printf("%s: %s is still served after stopping this run's leftover processes %v\n", d.phase, d.baseURL(), pids)
}

// summary is the run's last line. A reader skimming past the per-phase lines reads only this one, so a step
// that did not run must be legible here, and a green run is exactly when nobody notices.
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
	// A step-level skip is not a pass, so the last line carries it too: a reader of only this line still learns
	// part of a phase never ran.
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
	// Each phase owns its install directory and it is not removed here: phase R's restores leave a replacement
	// process holding the directory and port, possibly still writing. It is under the OS temp directory and the
	// next run uses a fresh one.
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
		// parsePhases yields only letters in drillPhases, so this is a bug, not input; fail loudly.
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

// verdict is the line a completed phase prints, or "" for none. Every branch keeps "passed" off work that did
// not run; a function so a test can hold that, since nothing in a green run can.
func (d *drill) verdict(p phase) string {
	if slices.Contains(d.skipped, p.letter) {
		// No line: the phase measured nothing; the run's summary says so.
		return ""
	}
	if steps := d.partial[p.letter]; len(steps) > 0 {
		// Neither word alone is true: name the step and the reason.
		return fmt.Sprintf("phase %c (%s): passed, except %s", p.letter, p.what, strings.Join(steps, "; except "))
	}
	return fmt.Sprintf("phase %c (%s): passed", p.letter, p.what)
}

// skipStep records a step that did not run and prints why; without the record the verdict would count it as
// passed.
func (d *drill) skipStep(reason string) {
	if d.partial == nil {
		d.partial = make(map[byte][]string)
	}
	d.partial[d.letter] = append(d.partial[d.letter], reason)
	fmt.Printf("%s: skipped — %s\n", d.phase, reason)
}
