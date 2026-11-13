package unfurl

import (
	"net/url"
	"regexp"
	"strings"
)

// youtubeHosts are the hosts whose links name a video, as in mediaYouTube.ts.
var youtubeHosts = map[string]struct{}{
	"www.youtube.com": {}, "youtube.com": {}, "m.youtube.com": {}, "music.youtube.com": {},
	"www.youtube-nocookie.com": {}, "youtube-nocookie.com": {},
}

var youtubeIDPattern = regexp.MustCompile(`^[\w-]{1,20}$`)

// youtubeID is the video id of a YouTube link, or "" for any other link or an id the client
// would not embed. It mirrors extractYouTubeId and the id check of renderYouTubeEmbed.
func youtubeID(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	var id string
	switch host := u.Hostname(); {
	case host == "youtu.be":
		id = strings.TrimPrefix(u.Path, "/")
	default:
		if _, ok := youtubeHosts[host]; !ok {
			return ""
		}
		if u.Path == "/watch" {
			id = u.Query().Get("v")
			break
		}
		for _, prefix := range []string{"/embed/", "/shorts/", "/live/"} {
			if rest, found := strings.CutPrefix(u.Path, prefix); found {
				id, _, _ = strings.Cut(rest, "/")
				break
			}
		}
	}
	if !youtubeIDPattern.MatchString(id) {
		return ""
	}
	return id
}
