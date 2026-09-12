package main

import (
	"archive/tar"
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// The container leg of the rehearsal. Only this file knows Docker exists: the
// phases in upgrade.go run unchanged against it through the target seam, with
// the same fixture and the same assertions as the standalone leg.
//
// Server/scripts/docker-smoke.sh already solves the container lifecycle for the
// boot smoke, and this leg mirrors it deliberately — the same run flags, the
// same health probe, the same two drain assertions — rather than re-deriving a
// second set of answers that could drift from it.

const (
	// containerData is the mount point the Dockerfile declares as VOLUME and
	// the default data_dir resolves to (cwd /app + data_dir "data").
	containerData = "/app/data"
	// containerConfig is where the server loads its configuration from:
	// config.DefaultPath is "config.yaml", resolved against the image's
	// WORKDIR. It is NOT in the volume, so a copy of the volume does not
	// contain it — which is why it is handled separately everywhere below.
	// The image would put its own there on first boot; this leg shadows that
	// with the operator-owned bind mount the compose file describes (see
	// writeMountedConfig), so the file at this path is a host file.
	containerConfig = "/app/config.yaml"
	// containerUser is the image's USER. Files this harness pushes into the
	// volume must be owned by it or the server cannot read its own data.
	containerUser = 65532
	// containerPublish publishes the port defaultBaseURL names, on loopback
	// only. The fixture's owner password is a literal in this repository, so
	// a 0.0.0.0 publish would put a throwaway owner account on the LAN for
	// the length of the run; docker-smoke.sh needs no publish at all because
	// it never speaks HTTP.
	containerPublish = "127.0.0.1:8443:8443"
)

// dockerTarget rehearses the same upgrade as containers on a named volume: the
// deployment Server/docker-compose.yml describes, with the same minimal
// privilege posture docs/deployment.md tells owners to run.
//
// The split between the volume and config.yaml is the compose file's, not an
// invention of this harness: owncord-data:/app/data carries the state, and
// ./config.yaml:/app/config.yaml is an operator-owned host file. So the volume
// is what archive/restore copy, and config.yaml is a host file this harness
// writes, mounts and copies directly.
type dockerTarget struct {
	oldImage string
	newImage string
	vol      string // named volume mapped at containerData, created per run
	// dir is the host side of the install: the bind-mounted config.yaml plus
	// a snapshot of the volume under data/. See installDir.
	dir     string
	name    string // the container that exists right now; "" = none
	image   string // the image that container runs
	version string // "old" | "new"
	running bool
	runs    int // one container name per launch, so a stale one cannot be reused
}

// newDockerTarget prepares the volume and the operator-owned config.yaml. The
// images are checked here rather than at first use, for the same reason
// serverBinary stats the binaries: "no such image" arriving as a failed phase 1
// reads like the rehearsal found something.
//
// Building or pulling the images is the caller's job (the workflow's), not
// this harness's: it rehearses two given images and never decides what they
// should contain.
func newDockerTarget(oldImage, newImage string) (*dockerTarget, error) {
	for _, ref := range []string{oldImage, newImage} {
		if _, err := docker("image", "inspect", ref); err != nil {
			return nil, fmt.Errorf("image %s is not available locally (build or pull it first): %w", ref, err)
		}
	}
	dir, err := os.MkdirTemp("", "owncord-upgrade-docker-")
	if err != nil {
		return nil, err
	}
	t := &dockerTarget{
		oldImage: oldImage,
		newImage: newImage,
		vol:      fmt.Sprintf("owncord-upgrade-vol-%d", os.Getpid()),
		dir:      dir,
	}
	if err := writeMountedConfig(t.configPath()); err != nil {
		t.cleanup()
		return nil, err
	}
	if _, err := docker("volume", "create", t.vol); err != nil {
		t.cleanup()
		return nil, err
	}
	return t, nil
}

// writeMountedConfig writes the config.yaml the containers bind-mount.
//
// It is hand-written and minimal because that is what docs/deployment.md tells
// a Docker owner to do ("Create a minimal config.yaml") and what the compose
// file mounts. Everything else comes from the compiled-in defaults: port 8443,
// self-signed TLS, data_dir "data" — which resolves to the volume — and
// voice.auto_download_livekit off. Copying the generated default template
// instead would make this file a second copy of config.defaultYAML, drifting
// the first time that template changes.
//
// 0644, not the 0600 the rest of this harness uses: the container runs as uid
// 65532 and cannot read a file the harness user owns 0600. These four lines
// hold no secret — the generated config.yaml of the standalone leg does, and
// copyFile keeps that one at 0600.
//
// WHAT THIS COSTS THE ASSERTION, because a reader of compare() cannot see it
// from there. compare() fails on "config.yaml changed: <hash> -> <hash>", and
// in the STANDALONE leg that catches any rewrite: the file is the server's own
// generated default and config.Save can replace it. In THIS leg it cannot
// fail for a rename: config.Save writes a temp file and renames it over the
// target, and a rename over a single-file bind mount is refused by the kernel
// ("device or resource busy"). So the container leg's config assertion catches
// an in-place rewrite and nothing else, and a green phase 5 here is NOT
// evidence that the upgrade left config.yaml alone.
//
// That is a property of the documented deployment rather than of this
// harness — Server/docker-compose.yml mounts the file :ro, so a Docker owner
// cannot save settings into it either, and the setup wizard's attempt shows up
// as a 201 with a warning and one ERROR line in the container log. The mount
// here is deliberately read-WRITE anyway: :ro would move the weakening from
// the assertion to the mount, where nothing could ever be caught. Note too
// that this leg therefore never hashes a config.yaml the server itself wrote;
// it hashes these four lines.
func writeMountedConfig(path string) error {
	const minimal = "# OwnCord upgrade rehearsal — the operator-owned config.yaml that\n" +
		"# Server/docker-compose.yml bind-mounts at /app/config.yaml.\n" +
		"server:\n" +
		"  name: \"Upgrade Rehearsal\"\n"
	return os.WriteFile(path, []byte(minimal), 0o644) //nolint:gosec // G306: must be readable by uid 65532 inside the container; no secrets in it
}

func (t *dockerTarget) configPath() string { return filepath.Join(t.dir, "config.yaml") }

func (t *dockerTarget) baseURL() string { return defaultBaseURL }

// start runs the requested version as a NEW container on the same volume.
//
// Swapping the version REPLACES the container — docker rm plus docker run,
// never docker start — for two reasons. First, `docker start` reuses the
// container's own writable layer, so the rehearsal would pass even if the
// volume were never mounted, which is the property phases 4-5 exist to prove
// (docker-smoke.sh phase 5 replaces for exactly this reason). Second,
// replacement is the only upgrade path OwnCord supports in Docker: the binary
// is image content, `docker compose pull && up -d` is the documented upgrade
// (docs/deployment.md:160), and the in-place self-update endpoint answers 503
// CONTAINER_DEPLOYMENT in a container.
func (t *dockerTarget) start(version string) error {
	image, err := t.imageFor(version)
	if err != nil {
		return err
	}
	if t.running {
		return fmt.Errorf("start %s: the %s container has not been drained", version, t.version)
	}
	if t.name != "" {
		if _, err := docker("rm", "-f", t.name); err != nil {
			return err
		}
		t.name = ""
	}
	t.runs++
	// Recorded BEFORE the run, not after it: `docker run -d` creates the
	// container and only then fails — a port conflict on 8443 is the case
	// this harness is most exposed to, with both legs binding it — and a name
	// this target never learned is a container cleanup() cannot remove.
	t.name = fmt.Sprintf("owncord-upgrade-%d-%d-%s", os.Getpid(), t.runs, version)
	// The flags are docker-smoke.sh's start(), plus the published port the
	// fixture needs and the LiveKit override every launch in this rehearsal
	// gets. Anything more (a user override, an extra capability) would test a
	// posture no owner is told to run.
	if _, err := docker("run", "-d", "--name", t.name,
		"-v", t.vol+":"+containerData,
		"-v", filepath.ToSlash(t.configPath())+":"+containerConfig,
		"-p", containerPublish,
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges:true",
		"-e", noLiveKitDownload,
		image); err != nil {
		return err
	}
	t.image, t.version, t.running = image, version, true
	return t.waitHealthy(version + " boot")
}

// waitHealthy mirrors docker-smoke.sh's wait_healthy: the binary's own
// healthcheck subcommand, which is the only probe a distroless image can
// answer, plus docker inspect so a container that died during boot is reported
// immediately instead of after the whole timeout.
func (t *dockerTarget) waitHealthy(phase string) error {
	deadline := time.Now().Add(bootTimeout)
	for attempt := 1; time.Now().Before(deadline); attempt++ {
		time.Sleep(pollEvery)
		if running, err := docker("inspect", "-f", "{{.State.Running}}", t.name); err != nil {
			return t.annotate(phase, err)
		} else if strings.TrimSpace(running) != "true" {
			return t.annotate(phase, errors.New("the container exited before reporting healthy"))
		}
		if _, err := docker("exec", t.name, "/chatserver", "healthcheck"); err == nil {
			fmt.Printf("%s: healthy after %ds\n", phase, attempt)
			return nil
		}
	}
	return t.annotate(phase, fmt.Errorf("never reported healthy within %s", bootTimeout))
}

// drain stops the container the way an owner does and makes docker-smoke.sh's
// two assertions, for the reason its drain() states: docker stop escalates to
// SIGKILL after the timeout and a killed container exits 137, so the exit code
// is what proves the server shut itself down; the elapsed time keeps a drain
// that merely crawls under the wire from passing.
func (t *dockerTarget) drain() error {
	if !t.running {
		return errors.New("drain: no container is running")
	}
	phase := "drain " + t.version
	started := time.Now()
	if _, err := docker("stop", "-t", strconv.Itoa(int(drainBudget.Seconds())), t.name); err != nil {
		return t.annotate(phase, err)
	}
	elapsed := time.Since(started)
	t.running = false
	code, err := docker("inspect", "-f", "{{.State.ExitCode}}", t.name)
	if err != nil {
		return t.annotate(phase, err)
	}
	if got := strings.TrimSpace(code); got != "0" {
		return t.annotate(phase, fmt.Errorf(
			"exited %s after SIGTERM, want 0 (137 = killed after the %s budget)", got, drainBudget))
	}
	if elapsed > drainBudget {
		return t.annotate(phase, fmt.Errorf("took %s, budget is %s", elapsed.Round(time.Millisecond), drainBudget))
	}
	// The standalone leg's "the healthcheck stops passing", asked through the
	// published port instead of the binary: `docker exec` into a stopped
	// container cannot succeed, so asserting it there would be theatre. The
	// port is where it can still fail for a real reason — a leftover container
	// from an earlier run, or the standalone leg's own server, holding 8443
	// would let every later phase measure the wrong server and still pass.
	if serving(t.baseURL()) {
		return t.annotate(phase, errors.New("something still answers /health on "+t.baseURL()+" after the container stopped"))
	}
	fmt.Printf("%s: drained cleanly in %s\n", phase, elapsed.Round(time.Millisecond))
	return nil
}

// serving reports whether anything answers /health at baseURL. Unauthenticated
// and side-effect free, the same endpoint the binary's healthcheck probes.
func serving(baseURL string) bool {
	req, err := http.NewRequest(http.MethodGet, baseURL+"/health", nil) //nolint:noctx // bounded by the client Timeout
	if err != nil {
		return false
	}
	resp, err := fixtureClient.Do(req)
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode == http.StatusOK
}

// installDir hands captureState a host directory shaped like an install —
// config.yaml at its root, data/ beneath — because a named volume is not such
// a path and captureState walks a real filesystem.
//
// config.yaml is the live bind-mounted file, not a copy: the container reads
// the very bytes hashed here, so that half cannot go stale at all.
//
// data/ is a SNAPSHOT FOR INSPECTION, not the live install: nothing written
// here reaches the volume. It is refreshed on every call, and that is the
// invariant the phases depend on — each of them calls installDir() immediately
// before capturing, with the container running, so the capture is of the state
// the container has at that moment. A snapshot taken once and reused would
// make phase 5 and phase 8 compare phase 1's bytes with themselves and pass
// over nothing.
//
// The copy is taken while the server is running, and that is safe for what is
// read from it: captureState hashes config.yaml, the three credential files
// and data/uploads. It never hashes data/chatserver.db — by design (see
// fixture.token) — so a torn copy of a live SQLite database is not something
// any assertion reads. The archive, which does carry the database, is taken
// from a STOPPED container instead.
//
// A snapshot that fails FAILS THE PHASE, and that is why this returns an
// error rather than reporting one somewhere. The dangerous case is the quiet
// one: if the removal below fails — a Windows file lock, an antivirus scanner
// — the directory still holds the previous phase's snapshot, and a capture
// taken from it would compare an earlier phase's bytes with themselves and
// pass every assertion. Re-taking the copy would not help; the operation that
// failed IS the removal.
func (t *dockerTarget) installDir() (string, error) {
	// Removed rather than copied over: a file the container deleted must
	// disappear from the snapshot too, or the capture reports state that no
	// longer exists.
	if err := os.RemoveAll(filepath.Join(t.dir, "data")); err != nil {
		return "", fmt.Errorf("clearing the previous state snapshot: %w", err)
	}
	if err := t.copyOut(containerData, t.dir); err != nil {
		return "", fmt.Errorf("snapshotting the container's data directory: %w", err)
	}
	return t.dir, nil
}

// archive copies out what the rollback documentation tells an owner to keep.
// THE CONTAINER MUST BE STOPPED, for the reason standaloneTarget.archive
// states: this carries data/chatserver.db, and a hot copy of a live SQLite
// database and its WAL is not a consistent snapshot.
//
// /app/data is copied WHOLESALE rather than as a list of names, so anything
// that lives only in the volume — a file a later version adds, a directory
// this harness has never heard of — cannot be silently missed.
func (t *dockerTarget) archive(dir string) error {
	if t.running {
		return errors.New("archive: the container is still running")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := t.copyOut(containerData, dir); err != nil {
		return fmt.Errorf("archiving the data directory: %w", err)
	}
	if err := tightenModes(filepath.Join(dir, "data")); err != nil {
		return fmt.Errorf("archiving the data directory: %w", err)
	}
	// config.yaml is archived separately because it is not volume content:
	// the image puts it at /app/config.yaml, in the container layer, and the
	// compose file replaces that with an operator-owned host file. A copy of
	// the volume therefore does not contain it, and an owner's backup that
	// forgot it would restore a server with somebody else's configuration.
	if err := copyFile(t.configPath(), filepath.Join(dir, "config.yaml")); err != nil {
		return fmt.Errorf("archiving config.yaml: %w", err)
	}
	return nil
}

// restore puts the archive back. Same precondition as archive — THE CONTAINER
// MUST BE STOPPED — and the same no-merge rule as standaloneTarget.restore:
// the volume is REPLACED, not copied into.
//
// docker cp can only add files, so the volume is recreated to empty it. That
// costs a container: a volume with any container attached cannot be removed,
// and an empty volume needs a container for docker cp to extract into. The
// scratch container is created and never started — it exists only so the
// daemon has a mount namespace to write through — and is removed immediately;
// the restored data stays in the volume, which is the whole point.
func (t *dockerTarget) restore(dir string) error {
	if t.running {
		return errors.New("restore: the container is still running")
	}
	if t.name != "" {
		if _, err := docker("rm", "-f", t.name); err != nil {
			return err
		}
		t.name = ""
	}
	if _, err := docker("volume", "rm", "-f", t.vol); err != nil {
		return err
	}
	if _, err := docker("volume", "create", t.vol); err != nil {
		return err
	}
	// The image is irrelevant here — the container never runs — so the one
	// the last container used is reused rather than picking a version and
	// implying it matters. It is not entirely inert, though: Docker seeds an
	// EMPTY named volume from the image's directory when a container mounts
	// it, so this create would merge image content into the restore. It is
	// safe only because Server/Dockerfile:33 ships /app/data empty. If that
	// directory ever gains seed content, this becomes the half-alpha.4,
	// half-HEAD merge Ruling C forbids, silently.
	scratch := fmt.Sprintf("owncord-upgrade-%d-%d-restore", os.Getpid(), t.runs)
	if _, err := docker("create", "--name", scratch, "-v", t.vol+":"+containerData, t.image); err != nil {
		return err
	}
	defer func() { _, _ = docker("rm", "-f", scratch) }()
	if err := t.copyIn(scratch, filepath.Join(dir, "data")); err != nil {
		return fmt.Errorf("restoring the data directory: %w", err)
	}
	// The host side of the mount, restored as a plain file for the same
	// reason archive() copied it that way — the next container bind-mounts
	// this path, so writing it here is what puts it back.
	return copyRestoredConfig(filepath.Join(dir, "config.yaml"), t.configPath())
}

// copyRestoredConfig is copyFile at 0644 rather than 0600: this file is
// bind-mounted into the next container and has to stay readable by uid 65532.
func copyRestoredConfig(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("restoring config.yaml: %w", err)
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil { //nolint:gosec // G306: bind-mounted into the container and read by uid 65532
		return fmt.Errorf("restoring config.yaml: %w", err)
	}
	return nil
}

// annotate attaches the container's log to a phase failure, the way
// server.annotate does for a process. Between a drain and the next boot the
// container still exists, so unlike the standalone leg there is a log to read
// even then — a stopped container keeps its logs until it is removed.
//
// Which is the limit of it: restore() removes the container and clears t.name
// before it touches the volume, so a phase-7 failure on this leg arrives bare
// too. Phases 3 and 6 are the ones that keep their tail here.
func (t *dockerTarget) annotate(phase string, cause error) error {
	if t.name == "" {
		return fmt.Errorf("%s: %w", phase, cause)
	}
	logs, err := docker("logs", t.name)
	if err != nil {
		logs = "(no log: " + err.Error() + ")"
	}
	return fmt.Errorf("%s: %w\n--- container log (%s) ---\n%s", phase, cause, phase, logs)
}

// cleanup removes the container before the volume: a volume any container
// still references cannot be removed, so the reverse order would leak it.
func (t *dockerTarget) cleanup() {
	if t.name != "" {
		_, _ = docker("rm", "-f", t.name)
	}
	if t.vol != "" {
		_, _ = docker("volume", "rm", "-f", t.vol)
	}
	if t.dir != "" {
		_ = os.RemoveAll(t.dir)
	}
}

func (t *dockerTarget) imageFor(version string) (string, error) {
	switch version {
	case "old":
		return t.oldImage, nil
	case "new":
		return t.newImage, nil
	}
	return "", fmt.Errorf("unknown version %q, want \"old\" or \"new\"", version)
}

// --- docker cp, without ever handing docker a host path ----------------------
//
// MSYS_NO_PATHCONV=1 is what docker-smoke.sh needs for the CONTAINER side of
// every docker argument, and its have_file comment records the trap: the
// setting is global to a command, so it also stops Git Bash converting the HOST
// side, and `docker cp c:/f /tmp/x` then reaches the native Windows docker.exe
// as `D:\tmp\x` and fails with "directory does not exist" — a false negative
// indistinguishable from a missing file.
//
// This harness calls docker from Go, so os/exec hands argv to CreateProcess
// with no MSYS layer in between and no conversion happens in either direction.
// That removes the trap; it does not remove the reason to avoid host paths.
// The two functions below stream a tar through docker's stdin/stdout, so the
// only path docker is ever given is a container path — which keeps this code
// correct if it is ever invoked from a shell, and sidesteps docker cp's own
// host-side semantics (drive letters, ownership mapping) entirely.
//
// The one host path docker does get is the config.yaml bind mount in start():
// a mount has no tar equivalent, it is the mount the compose file documents,
// and os/exec passes it through untouched.

// copyOut streams a container path into dstDir. The tar the daemon produces is
// rooted at the source's base name, so copying /app/data yields dstDir/data/…
func (t *dockerTarget) copyOut(containerPath, dstDir string) error {
	cmd := exec.Command("docker", "cp", t.name+":"+containerPath, "-")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	extractErr := extractTar(stdout, dstDir)
	// Drain whatever is left before waiting, or docker blocks on a full pipe
	// when extraction stopped early and this deadlocks instead of reporting.
	_, _ = io.Copy(io.Discard, stdout)
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("docker cp %s: %w: %s", containerPath, err, strings.TrimSpace(stderr.String()))
	}
	return extractErr
}

// copyIn streams srcDir into the container as /app/data. -a preserves the
// uid/gid this harness writes into the tar headers, which must be the image's
// user: a data directory the server cannot read is not a restore.
func (t *dockerTarget) copyIn(container, srcDir string) error {
	cmd := exec.Command("docker", "cp", "-a", "-", container+":/app")
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	tarErr := writeTar(stdin, srcDir, "data")
	if err := stdin.Close(); err != nil && tarErr == nil {
		tarErr = err
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("docker cp into %s: %w: %s", container, err, strings.TrimSpace(stderr.String()))
	}
	return tarErr
}

// extractTar writes a tar stream into dst as owner-only files, for the reason
// tightenModes gives: a data directory is a bundle of credentials.
func extractTar(r io.Reader, dst string) error {
	tr := tar.NewReader(r)
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		// The stream comes from the local daemon, so this is a guard against
		// a bug rather than an attacker — but an extractor that can write
		// outside its destination is a bug class not worth carrying.
		rel, err := filepath.Localize(path.Clean(header.Name))
		if err != nil {
			return fmt.Errorf("refusing tar entry %q: %w", header.Name, err)
		}
		target := filepath.Join(dst, rel)
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := writeTarFile(tr, target); err != nil {
				return err
			}
		default:
			// Anything else is state this harness would copy wrong, and a
			// silent skip is how an archive quietly loses something.
			return fmt.Errorf("%s is a tar type %q, which this copy does not handle", header.Name, header.Typeflag)
		}
	}
}

func writeTarFile(r io.Reader, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil { //nolint:gosec // G110: the stream is this run's own data directory, from the local daemon
		_ = f.Close()
		return err
	}
	return f.Close()
}

// writeTar walks root and writes it as a tar rooted at prefix, owned by the
// image's user. Modes are the server's own: 0700 for directories, 0600 for
// files — the archive on the host was already tightened to those, and Windows
// cannot report them anyway.
func writeTar(w io.Writer, root, prefix string) error {
	tw := tar.NewWriter(w)
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		name := path.Join(prefix, filepath.ToSlash(rel))
		if d.IsDir() {
			return tw.WriteHeader(&tar.Header{
				Name: name + "/", Typeflag: tar.TypeDir, Mode: 0o700,
				Uid: containerUser, Gid: containerUser,
			})
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("%s is not a regular file, and this copy does not handle it", name)
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if err := tw.WriteHeader(&tar.Header{
			Name: name, Typeflag: tar.TypeReg, Mode: 0o600, Size: info.Size(),
			Uid: containerUser, Gid: containerUser,
		}); err != nil {
			return err
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer func() { _ = f.Close() }()
		_, err = io.Copy(tw, f)
		return err
	})
	if err != nil {
		return err
	}
	return tw.Close()
}

// docker runs one docker command and returns its stdout. A failure carries the
// command and docker's own stderr: "exit status 1" alone is not a reason.
func docker(args ...string) (string, error) {
	var stdout, stderr bytes.Buffer
	cmd := exec.Command("docker", args...)
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return stdout.String(), fmt.Errorf("docker %s: %w: %s",
			strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}
