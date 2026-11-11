package main

import (
	"fmt"
	"io"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strings"

	"github.com/J3vb/OwnCord/Server/config"
)

// genConfig lists every dotted yaml key and the reference section that
// documents it. A key documented nowhere fails the run by name rather than
// getting an "undocumented" row that would record the drift.
func genConfig(w io.Writer) error {
	raw, err := os.ReadFile(configDoc)
	if err != nil {
		return err
	}
	sections := docSections(string(raw))
	keys := configKeys(reflect.TypeFor[config.Config](), "")
	slices.Sort(keys)

	var missing []string
	rows := make([][]string, 0, len(keys))
	for _, k := range keys {
		section, ok := sections[k]
		if !ok {
			missing = append(missing, k)
			continue
		}
		rows = append(rows, []string{code(k), section})
	}
	if len(missing) > 0 {
		return fmt.Errorf("%d config key(s) are documented nowhere under \"## Config Key Reference\" in %s — document them, then re-run:\n  %s",
			len(missing), configDoc, strings.Join(missing, "\n  "))
	}

	printf(w, "Generated from the `yaml` tags of `config.Config` by %s — do not edit by hand; `make docs-verify` fails when it drifts, and the tool exits non-zero when a key is documented nowhere above. %d keys.\n\n",
		code(regenCmd), len(rows))
	writeTable(w, []string{"Key", "Documented in"}, rows)
	return nil
}

var dottedKey = regexp.MustCompile("`([a-z0-9_]+(?:\\.[a-z0-9_]+)+)`")

// docSections maps each config key in the "## Config Key Reference" section to its "### " heading; the scan
// stops at the next "## " heading, where the generated index lives, so the index is never its own evidence.
func docSections(doc string) map[string]string {
	out := map[string]string{}
	inReference, heading := false, ""
	for line := range strings.Lines(doc) {
		line = strings.TrimRight(line, "\n")
		switch {
		case strings.HasPrefix(line, "## "):
			inReference = line == "## Config Key Reference"
			heading = ""
			continue
		case strings.HasPrefix(line, "### "):
			heading = strings.TrimPrefix(line, "### ")
			continue
		}
		if !inReference || heading == "" {
			continue
		}
		for _, m := range dottedKey.FindAllStringSubmatch(line, -1) {
			if _, seen := out[m[1]]; !seen {
				out[m[1]] = heading
			}
		}
	}
	return out
}

// configKeys returns every dotted yaml key reachable from t, recursing into
// nested structs as yaml.v3 does. Copied from api/absence_contract_test.go:
// config.Config's tags are the only enumeration of the keys.
func configKeys(t reflect.Type, prefix string) []string {
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t.Kind() != reflect.Struct {
		return nil
	}
	var keys []string
	for f := range t.Fields() {
		tag, ok := f.Tag.Lookup("yaml")
		if !ok || tag == "" || tag == "-" {
			continue
		}
		key := tag
		if prefix != "" {
			key = prefix + "." + tag
		}
		ft := f.Type
		for ft.Kind() == reflect.Pointer {
			ft = ft.Elem()
		}
		if ft.Kind() == reflect.Struct {
			keys = append(keys, configKeys(ft, key)...)
			continue
		}
		keys = append(keys, key)
	}
	return keys
}
