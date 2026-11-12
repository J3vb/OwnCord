package main

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
)

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

// writeTar walks root and writes a tar rooted at prefix, owned by the image's user. Modes are the server's
// own (0700 dirs, 0600 files); the host archive was already tightened and Windows cannot report them.
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
