package api

import (
	"fmt"
	"net/http"

	"github.com/klauspost/compress/gzhttp"
)

// REST compression is opt-in per route. A route joins compressedRESTRoutes only
// after a review that its reply never puts a credential or other secret next
// to text the requester controls (sign-in, tokens, invites, voice grants and
// file bodies stay plain), and its mount wraps the handler in compressJSON.
// api/rest_compress_test.go fails when the two disagree, so a new route is
// plain until someone reviews it. Mount compression only through
// compressJSON, never restGzip or gzhttp directly, so that test sees it.

// restCompressMinSize skips replies too small to gain from gzip.
const restCompressMinSize = 1024

// compressedRESTRoutes is the reviewed allow-list, as "METHOD /pattern" the
// way chi.Walk reports it. All are member-facing JSON lists that grow with a
// server's size.
var compressedRESTRoutes = map[string]string{
	"GET /api/v1/channels/":                                                  "channel list",
	"GET /api/v1/channels/{id}/messages":                                     "message history page",
	"GET /api/v1/channels/{id}/messages/around/{messageId}":                  "message history around a jump target",
	"GET /api/v1/channels/{id}/messages/{messageId}/reactions/{emoji}/users": "reaction user list",
	"GET /api/v1/channels/{id}/pins":                                         "pinned messages",
	"GET /api/v1/channels/{id}/threads":                                      "thread list",
	"GET /api/v1/channels/{id}/media":                                        "media gallery page",
	"GET /api/v1/search":                                                     "search results",
	"GET /api/v1/dms/":                                                       "DM list",
	"GET /api/v1/dm-requests/":                                               "message request list",
	"GET /api/v1/emoji/":                                                     "custom emoji list",
	"GET /api/v1/stickers/":                                                  "sticker list",
	"GET /api/v1/gif/search":                                                 "GIF search results",
	"GET /api/v1/gif/trending":                                               "trending GIFs",
	"GET /api/v1/gif/favorites":                                              "saved GIFs",
	"GET /api/v1/users/me/uploads":                                           "own uploads page",
}

var restGzip = mustRESTGzip()

func mustRESTGzip() func(http.Handler) http.HandlerFunc {
	wrap, err := gzhttp.NewWrapper(
		gzhttp.MinSize(restCompressMinSize),
		gzhttp.ContentTypes([]string{"application/json"}),
		// gzhttp also offers zstd by default; only gzip was reviewed and tested.
		gzhttp.EnableZstd(false),
	)
	if err != nil {
		panic(fmt.Errorf("rest gzip wrapper: %w", err))
	}
	return wrap
}

// compressJSON gzips a JSON reply of at least restCompressMinSize bytes when
// the request accepts gzip, and adds Vary: Accept-Encoding. Mount it only on a
// route listed in compressedRESTRoutes.
func compressJSON(next http.Handler) http.Handler {
	return restGzip(next)
}
