package main

// deploy/owncord.service is hand-written and copied by operators, so a wrong
// path or a dropped directive only shows up on someone's server. This pins
// the parts that must agree: the binary is not writable by the service, the
// state directory is the working directory, no capability is granted by
// default, and the supervision contract the server relies on is intact.

import (
	"path"
	"strings"
	"testing"
)

// systemdUnit maps "Section/Key" to every value set, in file order. Comment
// lines (# and ;) and blanks are ignored.
func systemdUnit(t *testing.T) map[string][]string {
	t.Helper()
	unit := map[string][]string{}
	section := ""
	for raw := range strings.SplitSeq(readFile(t, "../deploy/owncord.service"), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = line[1 : len(line)-1]
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			t.Fatalf("unit line %q is not Key=Value", line)
		}
		k := section + "/" + strings.TrimSpace(key)
		unit[k] = append(unit[k], strings.TrimSpace(val))
	}
	return unit
}

func unitSingle(t *testing.T, unit map[string][]string, key string) string {
	t.Helper()
	vals := unit[key]
	if len(vals) != 1 {
		t.Fatalf("%s must be set exactly once, got %q", key, vals)
	}
	return vals[0]
}

// under reports whether p is dir or inside it.
func under(p, dir string) bool {
	dir = strings.TrimRight(dir, "/")
	return p == dir || strings.HasPrefix(p, dir+"/")
}

func TestSystemdUnit_BinaryOutsideWritablePaths(t *testing.T) {
	unit := systemdUnit(t)
	binDir := path.Dir(unitSingle(t, unit, "Service/ExecStart"))
	if wd := unitSingle(t, unit, "Service/WorkingDirectory"); under(binDir, wd) || under(wd, binDir) {
		t.Errorf("binary directory %q overlaps WorkingDirectory %q", binDir, wd)
	}
	var writable []string
	for _, v := range unit["Service/ReadWritePaths"] {
		writable = append(writable, strings.Fields(v)...)
	}
	for _, v := range unit["Service/StateDirectory"] {
		for name := range strings.FieldsSeq(v) {
			writable = append(writable, "/var/lib/"+name)
		}
	}
	if len(writable) == 0 {
		t.Fatal("unit lists no writable path; the state directory must be writable")
	}
	for _, w := range writable {
		if under(binDir, w) || under(w, binDir) {
			t.Errorf("binary directory %q is writable through %q: the service could replace its own binary", binDir, w)
		}
	}
}

func TestSystemdUnit_StateDirectoryIsWorkingDirectory(t *testing.T) {
	unit := systemdUnit(t)
	if got := unitSingle(t, unit, "Service/StateDirectory"); got != "owncord" {
		t.Errorf("StateDirectory = %q, want owncord", got)
	}
	if got := unitSingle(t, unit, "Service/WorkingDirectory"); got != "/var/lib/owncord" {
		t.Errorf("WorkingDirectory = %q, want /var/lib/owncord", got)
	}
	if got := unitSingle(t, unit, "Service/StateDirectoryMode"); got != "0750" {
		t.Errorf("StateDirectoryMode = %q, want 0750", got)
	}
}

func TestSystemdUnit_NoActiveAmbientCapabilities(t *testing.T) {
	unit := systemdUnit(t)
	if got := unit["Service/AmbientCapabilities"]; len(got) != 0 {
		t.Errorf("AmbientCapabilities must be commented out by default, got %q", got)
	}
	raw := readFile(t, "../deploy/owncord.service")
	if !strings.Contains(raw, "#AmbientCapabilities=CAP_NET_BIND_SERVICE") {
		t.Error("the commented #AmbientCapabilities=CAP_NET_BIND_SERVICE hint for tls.mode: acme is missing")
	}
	if !strings.Contains(raw, "tls.mode: acme") {
		t.Error("the capability hint must say it is for tls.mode: acme")
	}
}

func TestSystemdUnit_KeepsSupervisionContract(t *testing.T) {
	unit := systemdUnit(t)
	for key, want := range map[string]string{
		"Service/Restart":        "always",
		"Service/TimeoutStopSec": "60",
		"Service/LimitNOFILE":    "65536",
		"Unit/AssertPathExists":  "!/opt/owncord/data",
	} {
		if got := unitSingle(t, unit, key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
}
