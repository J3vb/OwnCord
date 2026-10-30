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
// phases in upgrade.go run unchanged against it through the target seam. It
// mirrors Server/scripts/docker-smoke.sh (run flags, health probe, drain
// assertions) so the two cannot drift.

const (
	// containerData is the mount point the Dockerfile declares as VOLUME; the
	// default data_dir resolves to it (cwd /app + "data").
	containerData = "/app/data"
	// containerConfig is where the server loads its configuration from
	// (config.DefaultPath resolved against WORKDIR). It is not in the volume,
	// so it is handled separately: this leg shadows the image's own with the
	// operator-owned bind mount the compose file describes (see
	// writeMountedConfig).
	containerConfig = "/app/config.yaml"
	// containerUser is the image's USER; files pushed into the volume must be
	// owned by it.
	containerUser = 65532
	// containerPublish publishes the fixture's port on loopback only: its owner
	// password is a literal in this repository, so a 0.0.0.0 publish would put a
	// throwaway owner account on the LAN.
	containerPublish = "127.0.0.1:8443:8443"
)

// dockerTarget rehearses the same upgrade as containers on a named volume: the
// deployment Server/docker-compose.yml describes, with the minimal privilege
// posture docs/deployment.md tells owners to run. As in the compose file,
// owncord-data:/app/data carries the state (what archive/restore copy) and
// ./config.yaml:/app/config.yaml is an operator-owned host file.
type dockerTarget struct {
	oldImage string
	newImage string
	vol      string // named volume mapped at containerData; docker creates it on the first mount
	// dir is the host side of the install: the bind-mounted config.yaml plus a
	// snapshot of the volume under data/ (see installDir).
	dir     string
	name    string // the container that exists right now; "" = none
	image   string // the image that container runs
	version string // "old" | "new"
	running bool
	runs    int // one container name per launch, so a stale one cannot be reused
	// tmpfs mounts a size-limited tmpfs at containerData instead of the named
	// volume (an explicit mount overrides the Dockerfile VOLUME), so phase D
	// can fill a filesystem without filling the runner's disk.
	tmpfs bool
	// extraEnv is appended to the container's environment as -e pairs: the
	// container half of start()'s extraEnv, so a phase changes a setting
	// without rewriting the bind-mounted config.yaml.
	extraEnv []string
}

// newDockerTarget prepares the operator-owned config.yaml and the volume name
// start() will mount. The images are checked here, as serverBinary stats the
// binaries, so "no such image" does not read like a rehearsal finding. Building
// or pulling them is the caller's job.
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
	// No volume is created here: docker run -v creates one on first mount and
	// restore() recreates it anyway; the tmpfs leg mounts no volume at all.
	return t, nil
}

// writeMountedConfig writes the config.yaml the containers bind-mount. It is
// minimal, as docs/deployment.md tells a Docker owner; everything else comes
// from the compiled-in defaults, and copying the generated template would
// drift from config.defaultYAML.
//
// 0644, not the harness's usual 0600: the container runs as uid 65532 and
// cannot read a file the harness user owns 0600. These lines hold no secret
// (copyFile keeps the standalone leg's generated config.yaml at 0600).
//
// This weakens the config assertion: compare() fails on "config.yaml changed",
// which in the standalone leg catches any rewrite. Here config.Save writes a
// temp file and renames it over the target, and a rename over a single-file
// bind mount is refused by the kernel, so only an in-place rewrite is caught
// and a green phase 5 is not evidence that the upgrade left config.yaml alone.
//
// That follows the documented deployment, whose compose file mounts the file
// :ro so a Docker owner cannot save settings either (the setup wizard shows a
// 201 with a warning and one ERROR line). The mount here is read-write anyway:
// :ro would move the weakening to the mount, where nothing could be caught.
// This leg also never hashes a config.yaml the server itself wrote.
func writeMountedConfig(path string) error {
	const minimal = "# OwnCord upgrade rehearsal — the operator-owned config.yaml that\n" +
		"# Server/docker-compose.yml bind-mounts at /app/config.yaml.\n" +
		"server:\n" +
		"  name: \"Upgrade Rehearsal\"\n"
	return os.WriteFile(path, []byte(minimal), 0o644) //nolint:gosec // G306: must be readable by uid 65532 inside the container; no secrets in it
}

func (t *dockerTarget) configPath() string { return filepath.Join(t.dir, "config.yaml") }

func (t *dockerTarget) baseURL() string { return defaultBaseURL }

// start runs the requested version as a new container on the same volume.
//
// Swapping versions replaces the container (docker rm plus docker run, never
// docker start). docker start reuses the container's writable layer, so the
// rehearsal would pass even if the volume were never mounted, which phases 4-5
// exist to prove; and replacement is the only upgrade path OwnCord supports in
// Docker (docs/deployment.md), since the self-update endpoint answers 503
// CONTAINER_DEPLOYMENT.
func (t *dockerTarget) start(version string) error {
	image, err := pickVersion(version, t.oldImage, t.newImage)
	if err != nil {
		return err
	}
	if t.running {
		return fmt.Errorf("start %s: the %s container has not been drained", version, t.version)
	}
	if err := t.removeContainer(); err != nil {
		return err
	}
	t.runs++
	// Recorded before the run: docker run -d creates the container and only
	// then fails (a port conflict on 8443 is the likeliest), and a name this
	// target never learned is a container cleanup() cannot remove.
	t.name = fmt.Sprintf("owncord-upgrade-%d-%d-%s", os.Getpid(), t.runs, version)
	// The flags are docker-smoke.sh's start() plus the published port and the
	// LiveKit override; more would test a posture no owner is told to run.
	data := []string{"-v", t.vol + ":" + containerData}
	if t.tmpfs {
		// The tmpfs the standalone leg mounts (24 MiB), owned by the image's
		// user so the server can write its database into it.
		data = []string{"--tmpfs", containerData + ":size=24m,uid=" + strconv.Itoa(containerUser) + ",gid=" + strconv.Itoa(containerUser)}
	}
	args := []string{"run", "-d", "--name", t.name}
	args = append(args, data...)
	args = append(args,
		"-v", filepath.ToSlash(t.configPath())+":"+containerConfig,
		"-p", containerPublish,
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges:true",
		"-e", noLiveKitDownload,
		// The image bundles LiveKit; the rehearsal compares data-dir state byte
		// for byte, so keep voice off.
		"-e", "OWNCORD_VOICE_LIVEKIT_BINARY=")
	for _, kv := range t.extraEnv {
		args = append(args, "-e", kv)
	}
	if _, err := docker(append(args, image)...); err != nil {
		return err
	}
	t.image, t.version, t.running = image, version, true
	return t.waitHealthy(version + " boot")
}

// waitHealthy mirrors docker-smoke.sh's wait_healthy: the binary's own
// healthcheck subcommand (the only probe a distroless image answers) plus
// docker inspect, so a container that died during boot is reported at once.
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

// drain stops the container as an owner does and makes docker-smoke.sh's two
// assertions: docker stop escalates to SIGKILL (exit 137), so exit code 0
// proves the server shut itself down, and the elapsed time keeps a drain that
// merely crawls under the wire from passing.
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
	// The standalone leg's "healthcheck stops passing", asked through the
	// published port: docker exec into a stopped container cannot succeed. A
	// leftover container or the standalone leg's server holding 8443 would let
	// later phases measure the wrong server and still pass.
	if serving(t.baseURL()) {
		return t.annotate(phase, errors.New("something still answers /health on "+t.baseURL()+" after the container stopped"))
	}
	fmt.Printf("%s: drained cleanly in %s\n", phase, elapsed.Round(time.Millisecond))
	return nil
}

// serving reports whether anything answers /health at baseURL.
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

// installDir hands captureState a host directory shaped like an install,
// config.yaml at its root and data/ beneath, since a named volume is not a
// walkable path.
//
// config.yaml is the live bind-mounted file. data/ is a snapshot for
// inspection, refreshed on every call: each phase calls installDir()
// immediately before capturing with the container running, so a snapshot
// taken once and reused would compare phase 1's bytes with themselves.
//
// The copy is taken while the server runs, which is safe: captureState hashes
// config.yaml, the three credential files and data/uploads, never
// data/chatserver.db (see fixture.token). The archive, which does carry the
// database, is taken from a stopped container.
//
// A failed snapshot fails the phase rather than being reported elsewhere: if
// the removal below fails (a Windows file lock, an antivirus scanner) the
// directory still holds the previous phase's snapshot, and a capture from it
// would compare earlier bytes with themselves and pass.
func (t *dockerTarget) installDir() (string, error) {
	// Removed rather than copied over, so a file the container deleted
	// disappears from the snapshot too.
	if err := os.RemoveAll(filepath.Join(t.dir, "data")); err != nil {
		return "", fmt.Errorf("clearing the previous state snapshot: %w", err)
	}
	if err := t.copyOut(containerData, t.dir); err != nil {
		return "", fmt.Errorf("snapshotting the container's data directory: %w", err)
	}
	return t.dir, nil
}

// archive copies out what the rollback documentation tells an owner to keep.
// The container must be stopped, as for standaloneTarget.archive: this carries
// data/chatserver.db, and a hot copy of a live SQLite database and its WAL is
// not consistent. /app/data is copied wholesale, so anything living only in
// the volume cannot be silently missed.
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
	// config.yaml is archived separately because it is not volume content (the
	// compose file replaces the image's copy with a host file); a backup that
	// forgot it would restore a server with somebody else's configuration.
	if err := copyFile(t.configPath(), filepath.Join(dir, "config.yaml"), 0o600); err != nil {
		return fmt.Errorf("archiving config.yaml: %w", err)
	}
	return nil
}

// restore puts the archive back. The container must be stopped and the volume
// is replaced, not merged, as for standaloneTarget.restore.
//
// docker cp can only add files, so the volume is recreated to empty it. That
// costs a container: a volume with a container attached cannot be removed, and
// an empty volume needs one for docker cp to extract into. The scratch
// container is created, never started, and removed immediately; the restored
// data stays in the volume.
func (t *dockerTarget) restore(dir string) error {
	if t.running {
		return errors.New("restore: the container is still running")
	}
	if err := t.removeContainer(); err != nil {
		return err
	}
	if _, err := docker("volume", "rm", "-f", t.vol); err != nil {
		return err
	}
	if _, err := docker("volume", "create", t.vol); err != nil {
		return err
	}
	// The container never runs, so the last container's image is reused.
	// Docker seeds an empty named volume from the image's directory on first
	// mount, so this is safe only because Server/Dockerfile ships /app/data
	// empty; seed content would silently merge image content into the restore.
	scratch := fmt.Sprintf("owncord-upgrade-%d-%d-restore", os.Getpid(), t.runs)
	if _, err := docker("create", "--name", scratch, "-v", t.vol+":"+containerData, t.image); err != nil {
		return err
	}
	defer func() { _, _ = docker("rm", "-f", scratch) }()
	if err := t.copyIn(scratch, filepath.Join(dir, "data")); err != nil {
		return fmt.Errorf("restoring the data directory: %w", err)
	}
	// The host side of the mount, restored as a plain file as archive() copied
	// it. 0o644, not the standalone leg's 0o600: the next container bind-mounts
	// this path and reads it as uid 65532.
	if err := copyFile(filepath.Join(dir, "config.yaml"), t.configPath(), 0o644); err != nil {
		return fmt.Errorf("restoring config.yaml: %w", err)
	}
	return nil
}

// removeContainer drops the container this target owns, if any, and forgets
// its name; start() and restore() (detaching from the volume) begin with it.
func (t *dockerTarget) removeContainer() error {
	if t.name == "" {
		return nil
	}
	if _, err := docker("rm", "-f", t.name); err != nil {
		return err
	}
	t.name = ""
	return nil
}

// annotate attaches the container's log to a phase failure, as server.annotate
// does for a process. A stopped container keeps its logs until removed, but
// restore() removes it and clears t.name before touching the volume, so a
// phase-7 failure arrives bare; phases 3 and 6 keep their tail.
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

// copyOut streams a container path into dstDir. The tar the daemon produces is
// rooted at the source's base name, so copying /app/data yields dstDir/data/…
//
// copyOut and copyIn stream a tar through docker's stdin/stdout so docker is
// only ever given a container path, never a host path: that sidesteps docker
// cp's host-side semantics (drive letters, ownership mapping) and the Git Bash
// path conversion that turns `c:/f` into a false "directory does not exist".
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
	// Drain the rest before waiting, or docker blocks on a full pipe when
	// extraction stopped early.
	_, _ = io.Copy(io.Discard, stdout)
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("docker cp %s: %w: %s", containerPath, err, strings.TrimSpace(stderr.String()))
	}
	return extractErr
}

// copyIn streams srcDir into the container as /app/data. -a preserves the
// image user's uid/gid written into the tar headers.
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
		// The stream comes from the local daemon, so this guards against a bug
		// rather than an attacker.
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
			// A silent skip is how an archive quietly loses something.
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
// image's user. Modes are the server's own (0700 directories, 0600 files); the
// host archive was already tightened and Windows cannot report them.
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

// log is everything the container has printed, stdout and stderr together; the
// setup token is on stderr, which docker() drops.
func (t *dockerTarget) log() (string, error) {
	out, err := exec.Command("docker", "logs", t.name).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("docker logs %s: %w: %s", t.name, err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
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
