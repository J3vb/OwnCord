package updater

import "testing"

func TestIsDevelopmentBuild(t *testing.T) {
	cases := map[string]bool{
		"dev":                      true,
		"":                         true,
		"local":                    true,
		"v2.8.0-4-g1a2b3c4":        true,
		"2.8.0-12-g1a2b3c4d-dirty": true,
		"v2.8.0-dirty":             true,
		"v2.8.0":                   false,
		"2.8.0":                    false,
		"v2.8.0-beta.3":            false,
		"1.0.0":                    false,
	}
	for in, want := range cases {
		if got := IsDevelopmentBuild(in); got != want {
			t.Errorf("IsDevelopmentBuild(%q) = %v, want %v", in, got, want)
		}
	}
	if !NewUpdater("dev", "", "o", "r").DevelopmentBuild() {
		t.Error("an Updater built for version dev should report a development build")
	}
}
