package main

import (
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
)

// compare asserts that everything in before survived into after, byte for byte, naming whatever did not. It
// does not assert the reverse: an item only in after is new and informational. alpha.4 has no
// Server/auth/erasure_key.go or push_vapid_key.go, so HEAD legitimately creates data/erasure.key,
// data/push_vapid.key and data/erasure/markers.sqlite on first boot; a lost or mutated item still fails. The
// version is not compared: the upgrade phase expects it to differ and the rollback phase to match, so the
// caller asserts it.
func compare(before, after state) error {
	problems := make([]error, 0, 4)
	if before.config != after.config {
		problems = append(problems, fmt.Errorf("config.yaml changed: %s -> %s", before.config, after.config))
	}
	problems = append(problems, lostOrChanged("credential file", before.keys, after.keys)...)
	problems = append(problems, lostOrChanged("upload", before.uploads, after.uploads)...)
	for _, name := range before.backups {
		if !slices.Contains(after.backups, name) {
			problems = append(problems, fmt.Errorf("backup %s is gone from the backup list", name))
		}
	}
	// Digest and length only: the id is an input, and including it would
	// print a mismatched id as though the bytes had changed.
	if before.download.digest != after.download.digest || before.download.length != after.download.length {
		problems = append(problems, fmt.Errorf(
			"the download of attachment %s changed: %s (%d bytes) -> %s (%d bytes)",
			before.download.id, before.download.digest, before.download.length,
			after.download.digest, after.download.length))
	}
	if line := additions(before, after); line != "" {
		fmt.Println(line)
	}
	return errors.Join(problems...)
}

// lostOrChanged reports every entry of before that after lost or altered, sorted so divergence prints the
// same on every run.
func lostOrChanged(kind string, before, after map[string]string) []error {
	problems := make([]error, 0, len(before))
	for _, name := range slices.Sorted(maps.Keys(before)) {
		switch got, ok := after[name]; {
		case !ok:
			problems = append(problems, fmt.Errorf("%s %s is gone", kind, name))
		case got != before[name]:
			problems = append(problems, fmt.Errorf("%s %s changed: %s -> %s", kind, name, before[name], got))
		}
	}
	return problems
}

// additions is compare's other half: what the newer version created that the older never had; informational,
// "" when none.
func additions(before, after state) string {
	added := slices.Concat(
		onlyIn("credential file", before.keys, after.keys),
		onlyIn("upload", before.uploads, after.uploads),
	)
	for _, name := range after.backups {
		if !slices.Contains(before.backups, name) {
			added = append(added, "backup "+name)
		}
	}
	if len(added) == 0 {
		return ""
	}
	slices.Sort(added)
	return "added since the pre-upgrade capture: " + strings.Join(added, ", ")
}

func onlyIn(kind string, before, after map[string]string) []string {
	var names []string
	for name := range after {
		if _, ok := before[name]; !ok {
			names = append(names, kind+" "+name)
		}
	}
	return names
}
