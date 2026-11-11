package main

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
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
// container's tmpfs is only reachable through docker cp.
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

// dockerFiller fills a container's tmpfs through docker cp. The image is distroless (no shell, no rm), so
// copying a file in adds bytes and copying a one-byte file over the same path frees them.
type dockerFiller struct {
	fillerCount
	t    *dockerTarget
	dir  string   // host staging directory, one name per fill
	junk []string // the names this filler created, in the order it created them
	// copyIn is a seam so a test can fake the copy; newDockerFiller sets it to t.copyIn.
	copyIn func(container, dir string) error
}

func newDockerFiller(t *dockerTarget) (*dockerFiller, error) {
	dir, err := os.MkdirTemp("", "owncord-drill-junk-")
	if err != nil {
		return nil, err
	}
	return &dockerFiller{t: t, dir: dir, copyIn: t.copyIn}, nil
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
	if err := f.copyIn(f.t.name, stage); err != nil {
		if isNoSpace(err) {
			// docker cp may have extracted most of the file before ENOSPC, so release() must still overwrite it;
			// f.bytes stays put as the partial size is unknown.
			f.junk = append(f.junk, name)
			return 0, errNoSpace
		}
		// isNoSpace matches the daemon's wording, not an errno; a reworded message lands here with the raw text
		// printed, so a full tmpfs is not reported as a nameless harness failure.
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
	// One copy, one tar: each name is replaced by a one-byte file, freeing the blocks the big ones held.
	if err := f.copyIn(f.t.name, stage); err != nil {
		return fmt.Errorf("releasing the container's junk: %w", err)
	}
	return nil
}

func isNoSpace(err error) bool {
	lower := strings.ToLower(err.Error())
	return strings.Contains(lower, "no space left on device") || strings.Contains(lower, "disk full")
}
