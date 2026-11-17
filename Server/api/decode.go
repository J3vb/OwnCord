package api

import (
	"net/http"

	"github.com/J3vb/OwnCord/Server/httperr"
)

// badBody is the code a body that does not decode gets on api routes (400 INVALID_INPUT).
const badBody = httperr.CodeInvalidInput

// decodeJSON reads one JSON value from r.Body into v; see httperr.DecodeJSON.
// It returns false after writing the reply.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	return httperr.DecodeJSON(w, r, v, badBody)
}

// decodeOptionalJSON is decodeJSON for a body that may be left out.
func decodeOptionalJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	return httperr.DecodeOptionalJSON(w, r, v, badBody)
}

// decodeStrictJSON is decodeJSON that also refuses unknown fields and
// anything after the first value.
func decodeStrictJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	return httperr.DecodeStrictJSON(w, r, v, badBody)
}
