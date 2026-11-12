package updater

import (
	"regexp"

	"golang.org/x/mod/semver"
)

// gitDescribeSuffix matches what `git describe` appends past a tag (-<count>-g<hash>, -dirty).
var gitDescribeSuffix = regexp.MustCompile(`-\d+-g[0-9a-f]{7,}(-dirty)?$|-dirty$`)

// IsDevelopmentBuild reports whether version is a source build, not a release:
// "dev", a non-semver string, or a git describe string past a tag. The updater never replaces one.
func IsDevelopmentBuild(version string) bool {
	v := ensureVPrefix(version)
	return !semver.IsValid(v) || gitDescribeSuffix.MatchString(version)
}

// DevelopmentBuild reports whether the running server is a development build.
func (u *Updater) DevelopmentBuild() bool {
	return IsDevelopmentBuild(u.currentVersion)
}
