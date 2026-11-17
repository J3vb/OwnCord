package httperr

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
)

// WriteJSON answers status with v encoded as JSON.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("writeJSON: failed to encode response", "error", err)
	}
}

// DecodeJSON reads one JSON value from r.Body into v, so the same bad body
// gets the same reply on every route: 413 PAYLOAD_TOO_LARGE past the route's
// http.MaxBytesReader cap, 400 with badBody for anything else that does not
// decode, an empty body included. It returns false after writing the reply.
func DecodeJSON(w http.ResponseWriter, r *http.Request, v any, badBody Code) bool {
	return decodeBody(w, json.NewDecoder(r.Body), v, false, badBody)
}

// DecodeOptionalJSON is DecodeJSON for a body that may be left out: an empty
// body leaves v as it was and returns true.
func DecodeOptionalJSON(w http.ResponseWriter, r *http.Request, v any, badBody Code) bool {
	return decodeBody(w, json.NewDecoder(r.Body), v, true, badBody)
}

// DecodeStrictJSON is DecodeJSON that also refuses unknown fields and
// anything after the first value.
func DecodeStrictJSON(w http.ResponseWriter, r *http.Request, v any, badBody Code) bool {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if !decodeBody(w, dec, v, false, badBody) {
		return false
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeBodyErr(w, err, badBody)
		return false
	}
	return true
}

func decodeBody(w http.ResponseWriter, dec *json.Decoder, v any, optional bool, badBody Code) bool {
	err := dec.Decode(v)
	if err == nil || (optional && errors.Is(err, io.EOF)) {
		return true
	}
	writeBodyErr(w, err, badBody)
	return false
}

// writeBodyErr answers a body that failed to decode. err is the decoder's
// error, or nil when a second JSON value followed the first.
func writeBodyErr(w http.ResponseWriter, err error, badBody Code) {
	if _, ok := errors.AsType[*http.MaxBytesError](err); ok {
		WriteJSON(w, http.StatusRequestEntityTooLarge, body{Error: string(CodePayloadTooLarge), Message: "request body is too large"})
		return
	}
	WriteJSON(w, http.StatusBadRequest, body{Error: string(badBody), Message: "malformed request body"})
}
