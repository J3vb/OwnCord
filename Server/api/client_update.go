// Package api provides the HTTP router and handlers for the OwnCord server.
//
// client_update.go serves Tauri-compatible update metadata so the desktop client
// can self-update. Linux .deb targets ("linux-*-deb") are served only to clients
// sending ?deb_install=pkexec; everyone else gets 204. An opted-in client also
// gets a 200 with the latest version when already current, so it can tell
// "current" from "this server cannot serve me".
package api

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
	"golang.org/x/mod/semver"
)

type tauriPlatformResponse struct {
	Signature string `json:"signature"`
	URL       string `json:"url"`
}

type tauriUpdateResponse struct {
	Version   string                           `json:"version"`
	Notes     string                           `json:"notes,omitempty"`
	PubDate   string                           `json:"pub_date,omitempty"`
	Platforms map[string]tauriPlatformResponse `json:"platforms"`
}

// MountClientUpdateRoute adds the unauthenticated client-update endpoint; it is
// outside the auth middleware because the client checks for updates before (or
// without) logging in.
func MountClientUpdateRoute(r chi.Router, u *updater.Updater) {
	r.Get("/api/v1/client-update/{target}/{current_version}", handleClientUpdate(u))
}

func handleClientUpdate(u *updater.Updater) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		target := chi.URLParam(r, "target")
		currentVersion := chi.URLParam(r, "current_version")

		if target == "" || currentVersion == "" {
			writeErr(w, http.StatusBadRequest, httperr.CodeInvalidInput, "missing target or current_version")
			return
		}

		// A .deb client that has not opted in cannot install the package, so
		// it gets 204 before any lookup and keeps its "cannot update itself"
		// banner. Opted-in clients are answered below.
		isDeb := strings.HasSuffix(target, "-deb")
		optedIn := debOptIn(target, r.URL.Query())
		if isDeb && !optedIn {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		info, err := u.CheckForUpdate(r.Context())
		if err != nil {
			writeErr(w, http.StatusBadGateway, httperr.CodeUpdateCheckFailed, "failed to check for updates")
			return
		}

		// Return 204 if no update is available, except for an opted-in .deb
		// client: the plugin resolves the platform entry before comparing
		// versions, so the entry must be sent even when current, and its own
		// comparator then reports "no update" knowing the server can serve the
		// package.
		cv := ensureV(currentVersion)
		lv := ensureV(info.Latest)
		if semver.Compare(cv, lv) >= 0 && !optedIn {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Server first, clients second: never advertise a client that speaks a
		// newer wire epoch than this server, or it would auto-update into a
		// refused handshake. The epoch comes from the release's signed manifest;
		// a manifest that does not verify is withheld the same way.
		epoch, err := u.ReleaseProtocolEpoch(r.Context(), info)
		if err != nil || epoch > ws.ProtocolEpoch {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Find the updater artifact and signature for the target
		// ("{os}-{arch}-{installer}", e.g. "windows-x86_64-nsis"). Targets
		// without a published updater artifact get 204, never a foreign OS's or
		// installer's artifact.
		clientAssets := u.FindClientAssets(target)
		installerURL := clientAssets.InstallerURL
		sigURL := clientAssets.SignatureURL
		if installerURL == "" || sigURL == "" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Fetch the signature file (small text), cached with the release info's
		// TTL so this unauthenticated endpoint does not make an outbound fetch
		// per request.
		sigContent, err := u.FetchTextAssetCached(r.Context(), sigURL)
		if err != nil {
			writeErr(w, http.StatusBadGateway, httperr.CodeUpdateCheckFailed, "failed to fetch signature")
			return
		}

		resp := tauriUpdateResponse{
			Version: strings.TrimPrefix(info.Latest, "v"),
			Notes:   info.ReleaseNotes,
			Platforms: map[string]tauriPlatformResponse{
				target: {
					Signature: strings.TrimSpace(sigContent),
					URL:       installerURL,
				},
			},
		}

		writeJSON(w, http.StatusOK, resp)
	}
}

// debOptIn reports whether the request is from a .deb client that asked to be
// offered the .deb package: the target ends in "-deb" and the query carries
// deb_install=pkexec (exact, case-sensitive). Clients that predate the helper
// that installs a .deb never send it.
func debOptIn(target string, q url.Values) bool {
	return strings.HasSuffix(target, "-deb") && q.Get("deb_install") == "pkexec"
}

func ensureV(v string) string {
	if strings.HasPrefix(v, "v") {
		return v
	}
	return "v" + v
}
