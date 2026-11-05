package updater

import (
	"regexp"

	"golang.org/x/mod/semver"
)

// gitDescribeSuffix matches what `git describe` appends to a tag for a commit
// past it (-<count>-g<hash>) and the -dirty mark for uncommitted changes.
var gitDescribeSuffix = regexp.MustCompile(`-\d+-g[0-9a-f]{7,}(-dirty)?$|-dirty$`)

// IsDevelopmentBuild reports whether version names a build from source rather
// than a release: "dev" (the default when no version is stamped), anything
// that is not a semantic version, or a git describe string for a commit past
// a tag. Such a build is never replaced with a release by the updater.
func IsDevelopmentBuild(version string) bool {
	v := ensureVPrefix(version)
	return !semver.IsValid(v) || gitDescribeSuffix.MatchString(version)
}

// DevelopmentBuild reports whether the running server is a development build
// (see IsDevelopmentBuild).
func (u *Updater) DevelopmentBuild() bool {
	return IsDevelopmentBuild(u.currentVersion)
}
