package invariants

import (
	"go/token"
	"testing"
)

func dbTimeLayoutViolations(t *testing.T, rel, src string) []Violation {
	t.Helper()
	return checkSourceWith([]Rule{dbTimeLayouts}, token.NewFileSet(), rel, []byte(src))
}

func TestDBTimeLayouts_HandWrittenLayoutIsFlagged(t *testing.T) {
	for name, src := range map[string]string{
		"space layout in a call": "package db\nimport \"time\"\nfunc f(t time.Time) string { return t.Format(\"2006-01-02 15:04:05\") }\n",
		"ISO layout in a call":   "package db\nimport \"time\"\nfunc f(t time.Time) string { return t.Format(\"2006-01-02T15:04:05Z\") }\n",
		"named constant":         "package service\nconst myLayout = \"2006-01-02 15:04:05\"\n",
		"raw string":             "package ws\nvar layouts = []string{`2006-01-02T15:04:05Z`}\n",
		"stdlib time.DateTime":   "package db\nimport \"time\"\nfunc f(t time.Time) string { return t.Format(time.DateTime) }\n",
		"aliased time import":    "package db\nimport tm \"time\"\nfunc f(t tm.Time) string { return t.Format(tm.DateTime) }\n",
		"dot-imported time":      "package db\nimport . \"time\"\nfunc f(t Time) string { return t.Format(DateTime) }\n",
		"build-tagged file":      "//go:build otel\n\npackage telemetry\nconst l = \"2006-01-02 15:04:05\"\n",
	} {
		t.Run(name, func(t *testing.T) {
			got := dbTimeLayoutViolations(t, "pkg/file.go", src)
			if len(got) != 1 || got[0].Rule != dbTimeLayoutsID {
				t.Fatalf("violations = %v, want exactly one %s", got, dbTimeLayoutsID)
			}
		})
	}
}

func TestDBTimeLayouts_OtherLayoutsAndTheHomePackageAreClean(t *testing.T) {
	other := "package service\nimport \"time\"\nconst d = \"2006-01-02\"\nvar r = time.RFC3339\nfunc f(t time.Time) string { return t.Format(\"2006-01-02 15:04\") }\n"
	if got := dbTimeLayoutViolations(t, "service/x.go", other); len(got) != 0 {
		t.Errorf("other layouts: %v, want none", got)
	}
	home := "package dbtime\nconst SQLiteLayout = \"2006-01-02 15:04:05\"\n"
	if got := dbTimeLayoutViolations(t, "dbtime/dbtime.go", home); len(got) != 0 {
		t.Errorf("dbtime itself: %v, want none", got)
	}
	// A package whose path merely ends in dbtime is not the home.
	if got := dbTimeLayoutViolations(t, "internal/dbtime/x.go", home); len(got) != 1 {
		t.Errorf("internal/dbtime: %v, want one violation", got)
	}
	// A DateTime selector on something other than package time is not the layout.
	sel := "package db\nimport . \"time\"\nvar _ Time\nfunc f() { _ = row.DateTime }\n"
	if got := dbTimeLayoutViolations(t, "db/x.go", sel); len(got) != 0 {
		t.Errorf("row.DateTime: %v, want none", got)
	}
}

func TestDBTimeLayouts_RealTreeIsClean(t *testing.T) {
	violations, err := runWith([]Rule{dbTimeLayouts}, serverRoot(t))
	if err != nil {
		t.Fatalf("walking the server tree: %v", err)
	}
	for _, v := range violations {
		t.Errorf("%s", v)
	}
}
