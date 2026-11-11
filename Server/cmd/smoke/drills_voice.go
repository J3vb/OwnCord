package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// phaseS is drill 6: what a voice join does when the managed SFU dies under it, and when the external SFU it
// was told to use was never there.
func (d *drill) phaseS() error {
	if err := d.ensurePortFree(); err != nil {
		return err
	}
	bin, ok := livekitBinary()
	if !ok {
		// A skip, printed, never a pass.
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

// stepSSupervised kills the managed SFU under a live install and watches what the owner would see: the join
// refused, health saying the SFU is down, and the join working again after the supervisor's first restart.
func (d *drill) stepSSupervised(bin string) ([]failure, error) {
	token, err := d.setup()
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
	// The guard reads IsRunning(), which goes false when the supervisor's Wait() returns, microseconds after the
	// signal but possibly after a racing join, so the probe retries, each time on a fresh socket (one already
	// holding a voice state would get ALREADY_JOINED whatever the SFU does). It stops only on the guard's own
	// refusal: voice_join is capped at five attempts per user per second (ws.voiceJoinRateLimit), checked before
	// the guard (ws.voiceJoinPrecheck), so a predicate accepting any error frame would stop on the probe's own
	// RATE_LIMITED and pass a broken guard that mints on every attempt.
	seen, err := probeVoiceJoin(token, voice.ID, restartWindow, voiceProbePause, voiceGuardRefused)
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
	if code != errCodeVoiceError {
		return []failure{{what: fmt.Sprintf(
			"the SFU was killed and voice_join refused with %s (%s) rather than %s: the refusal did not come from the LiveKit-process guard, so this step measured something other than the guard and must not report a pass",
			code, message, errCodeVoiceError)}}, nil
	}
	fmt.Printf("%s: with the SFU killed voice_join refused with %s: %s\n", d.phase, code, message)

	// Administrator-gated and rate-limited to five requests a minute, so called once: a 429 read as "the SFU is
	// down" would invert the step.
	healthy, err := livekitHealth(token)
	if err != nil {
		return nil, d.annotate(err)
	}
	var problems []failure
	fmt.Printf("%s: the diagnostics endpoint says livekit_health=%t with the process dead\n", d.phase, healthy)
	if healthy {
		problems = append(problems, failure{what: "the diagnostics endpoint reports livekit_health=true while the managed SFU's process is dead"})
	}

	// The supervisor's first restart comes after a 3 second backoff (livekitproc.Process), on a fresh socket
	// again: the first is still in the channel and would answer ALREADY_JOINED.
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

// probeVoiceJoin asks to join on a fresh socket until done(frame) or the budget runs out, returning every
// frame seen in order. A reused socket holding a voice state would answer ALREADY_JOINED and measure the
// socket, not the guard.
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

// stepSExternalAbsent boots an install pointed at an externally managed SFU that is not there and records
// what a join does. Recorded, not asserted: a minted token there is the disguised-success shape the
// connectivity check forbids, but a drill cannot fail on a finding without a ledger row and does not write
// ledger rows. It prints a ::warning:: and the measurement; the fix (one HealthCheck before the mint) is a
// behaviour change with its own PR.
func (d *drill) stepSExternalAbsent() ([]failure, error) {
	if err := d.stop(); err != nil {
		return nil, err
	}
	// Its own install directory: the first boot's config.yaml may have
	// recorded the binary path, and this step is its absence.
	dir := filepath.Join(d.dir, "external")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := d.bootAt(dir, "S2.log", "OWNCORD_VOICE_LIVEKIT_URL=ws://127.0.0.1:1"); err != nil {
		return nil, err
	}
	token, err := d.setup()
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

const livekitBinaryEnv = "OWNCORD_DRILL_LIVEKIT_BINARY"

// livekitBinary resolves the livekit-server phase S kills: the workflow's fetched path, or a copy where a
// developer keeps one. The harness never downloads it: the workflow verifies the release against the vendor's
// checksums, and a second fetch would be an unverified source. The path comes back absolute because the
// server starts it with the install directory as working directory.
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

// killLiveKit kills whatever process runs a given livekit-server binary. The supervised child belongs to the
// server (livekitproc.Process.runLoop), which holds the only handle and writes no PID file; killing by image
// is what operator tooling has (taskkill, pkill) and nothing else on a drill machine runs under that name.
func killLiveKit(bin string) error {
	switch runtime.GOOS {
	case "windows":
		// Absolute: taskkill is in System32, which a Git Bash PATH may omit.
		root := os.Getenv("SystemRoot")
		if root == "" {
			root = `C:\Windows`
		}
		return runCommand(filepath.Join(root, "System32", "taskkill.exe"), "/F", "/IM", filepath.Base(bin))
	default:
		return runCommand("pkill", "-9", "-f", bin)
	}
}

func runCommand(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("running %s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}
