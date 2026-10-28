package admin

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// decodeJSON reads one JSON value from r.Body into v, so the same bad body
// gets the same reply on every admin route: 413 PAYLOAD_TOO_LARGE when it
// runs past the route's http.MaxBytesReader cap, 400 BAD_REQUEST for anything
// else that does not decode, an empty body included. It returns false after
// writing the reply.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	return decodeBody(w, json.NewDecoder(r.Body), v, false)
}

// decodeOptionalJSON is decodeJSON for a route whose body may be left out:
// an empty body leaves v as it was and returns true. No admin route takes an
// optional body yet; it is kept so admin offers the same three forms as api.
func decodeOptionalJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	return decodeBody(w, json.NewDecoder(r.Body), v, true)
}

// decodeStrictJSON is decodeJSON that also refuses unknown fields and
// anything after the first value.
func decodeStrictJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if !decodeBody(w, dec, v, false) {
		return false
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeBodyErr(w, err)
		return false
	}
	return true
}

func decodeBody(w http.ResponseWriter, dec *json.Decoder, v any, optional bool) bool {
	err := dec.Decode(v)
	if err == nil || (optional && errors.Is(err, io.EOF)) {
		return true
	}
	writeBodyErr(w, err)
	return false
}

// writeBodyErr answers a body that failed to decode. err is the decoder's
// error, or nil when a second JSON value followed the first.
func writeBodyErr(w http.ResponseWriter, err error) {
	if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
		writeErr(w, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "request body is too large")
		return
	}
	writeErr(w, http.StatusBadRequest, "BAD_REQUEST", "malformed request body")
}
