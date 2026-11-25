package main

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"
)

// fillToHealthFloor fills until /health reports the disk degradation the drill booted the floor for. The
// boundary is found through the product's own health report, not statfs: /health degrades at the same floor
// the upload path refuses at, and a container's tmpfs cannot be stat'ed from the host. The first fill is
// computed from the declared size; later ones follow the five-second health cache.
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
			// fresh cache window finds the boundary without statfs.
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

// fillToWall fills until the filesystem refuses more. The loop is bounded by drillFillCap across both fills,
// so a -data-fs that is not size-limited cannot fill a real disk; it fails instead.
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

// awaitHealthyAgain polls until /health says ok again; the answer is cached for
// five seconds, so a single call would read the pre-recovery answer.
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

func newNames(before, after []string) []string {
	var fresh []string
	for _, name := range after {
		if !slices.Contains(before, name) {
			fresh = append(fresh, name)
		}
	}
	return fresh
}

// mentionsFullDisk reports whether the log names the failure the driver
// reports when the disk is full: its own ("database is full (SQLITE_FULL)") or
// SQLite's strerror (13).
func mentionsFullDisk(log string) bool {
	return strings.Contains(log, "SQLITE_FULL") || strings.Contains(log, "database or disk is full")
}

// quietPaths are the log lines a candidate finding is written from: disk-pressure errors and any line from a
// background path that writes. Nothing is asserted; they are printed so candidates are readable in the run.
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

// errNoSpace is what a filler reports when the filesystem refused more bytes: one sentinel, since the two
// legs reach the wall through different calls.
var errNoSpace = errors.New("the filesystem refused more bytes")

// filler puts junk on the filesystem phase D fills and takes it off again; two implementations because a
// container's volume is only reachable through a helper container.
type filler interface {
	// fill appends up to n bytes and reports how many; a short fill is errNoSpace.
	fill(n uint64) (uint64, error)
	release() error
	// total is every byte this filler has put on the filesystem, so the cap bounds the whole phase.
	total() uint64
}

type fillerCount struct{ bytes uint64 }

func (c *fillerCount) total() uint64 { return c.bytes }

type dirFiller struct {
	fillerCount
	path string
}

func newDirFiller(dir string) (*dirFiller, error) {
	// Truncated, not appended: leftovers from an earlier run would change how much of the filesystem is left.
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

// volumeFiller fills the tmpfs volume through a long-lived helper container that mounts it: the server's
// image is distroless (no shell, no dd) and docker cp resolves below a mount, so the fill has to be a process
// inside a container that shares the mount.
type volumeFiller struct {
	fillerCount
	junk []string // the names this filler created, in the order it created them
	// exec runs a command inside the helper; newVolumeFiller sets it to docker exec.
	exec func(args ...string) (string, error)
}

const fillerMount = "/data"

// fillerRunArgs starts the helper: no network, read-only root, no capabilities, the image's user, and a sleep
// that bounds it if the harness is killed before it can remove it.
func fillerRunArgs(name, vol, image string) []string {
	return []string{"run", "-d", "--name", name,
		"--label", drillLabel,
		"--user", fmt.Sprintf("%d:%d", containerUser, containerUser),
		"--network", "none",
		"--read-only",
		"--cap-drop=ALL",
		"--security-opt=no-new-privileges:true",
		"--mount", "type=volume,src=" + vol + ",dst=" + fillerMount,
		image, "sleep", "900"}
}

func fillerName() string { return fmt.Sprintf("owncord-drill-filler-%d", os.Getpid()) }

// newVolumeFiller starts the helper on vol. The volume must already exist.
func newVolumeFiller(vol, image string) (*volumeFiller, error) {
	name := fillerName()
	if _, err := docker(fillerRunArgs(name, vol, image)...); err != nil {
		return nil, fmt.Errorf("starting the filler container: %w", err)
	}
	return &volumeFiller{exec: func(args ...string) (string, error) {
		return docker(append([]string{"exec", name}, args...)...)
	}}, nil
}

// fill writes up to n bytes as one new file and reports the bytes that really landed (stat after the write),
// so a fill that ran into the wall still counts its partial file.
func (f *volumeFiller) fill(n uint64) (uint64, error) {
	name := fmt.Sprintf("%s-%d", drillJunkName, len(f.junk)+1)
	path := fillerMount + "/" + name
	f.junk = append(f.junk, name)
	const block = 64 << 10
	_, ddErr := f.exec("dd", "if=/dev/zero", "of="+path, "bs=64k", fmt.Sprintf("count=%d", (n+block-1)/block), "conv=fsync")
	size, statErr := f.size(path)
	if statErr != nil && ddErr == nil {
		return 0, fmt.Errorf("measuring %s after the write: %w", path, statErr)
	}
	f.bytes += size
	switch {
	case ddErr == nil:
		return size, nil
	case isNoSpace(ddErr):
		return size, errNoSpace
	default:
		return size, fmt.Errorf("writing %s in the filler container: %w", path, ddErr)
	}
}

func (f *volumeFiller) size(path string) (uint64, error) {
	out, err := f.exec("stat", "-c", "%s", path)
	if err != nil {
		return 0, err
	}
	n, err := strconv.ParseUint(strings.TrimSpace(out), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parsing stat output %q: %w", strings.TrimSpace(out), err)
	}
	return n, nil
}

// release removes exactly the files this filler made (no shell, so no glob).
func (f *volumeFiller) release() error {
	if len(f.junk) == 0 {
		return nil
	}
	args := []string{"rm", "-f"}
	for _, name := range f.junk {
		args = append(args, fillerMount+"/"+name)
	}
	if _, err := f.exec(args...); err != nil {
		return fmt.Errorf("releasing the filler container's junk: %w", err)
	}
	f.junk = nil
	return nil
}

// df reports the volume's total and available bytes as the helper sees them.
func (f *volumeFiller) df() (total, avail uint64, err error) {
	out, err := f.exec("df", "-P", fillerMount)
	if err != nil {
		return 0, 0, err
	}
	return parseDF(out)
}

// free is the bytes still available on the volume.
func (f *volumeFiller) free() (uint64, error) {
	_, avail, err := f.df()
	return avail, err
}

// removeFiller removes the helper. Errors are dropped: this runs from cleanup paths that have already decided
// the outcome.
func removeFiller() { _, _ = docker("rm", "-f", fillerName()) }

// parseDF reads `df -P` (POSIX format, 1024-byte blocks) for one filesystem.
func parseDF(out string) (total, avail uint64, err error) {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) < 2 {
		return 0, 0, fmt.Errorf("unexpected df output %q", out)
	}
	cols := strings.Fields(lines[len(lines)-1])
	if len(cols) < 4 {
		return 0, 0, fmt.Errorf("unexpected df row %q", lines[len(lines)-1])
	}
	tk, err := strconv.ParseUint(cols[1], 10, 64)
	if err != nil {
		return 0, 0, fmt.Errorf("parsing df total %q: %w", cols[1], err)
	}
	ak, err := strconv.ParseUint(cols[3], 10, 64)
	if err != nil {
		return 0, 0, fmt.Errorf("parsing df available %q: %w", cols[3], err)
	}
	return tk << 10, ak << 10, nil
}

func isNoSpace(err error) bool {
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "no space left on device") || strings.Contains(lower, "disk full")
}
