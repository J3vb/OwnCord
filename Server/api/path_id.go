package api

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
)

// pathID reads a numeric id from the URL without writing a reply, for the
// route that answers a bad id its own way (a 404, a plain-text 400). Ids
// start at 1, so anything else, 0 and negative values included, returns
// false. Every path id is read through it or parseIDParam (the path-id
// invariant keeps a raw strconv.ParseInt(chi.URLParam(...)) out of api).
func pathID(r *http.Request, param string) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, param), 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}
