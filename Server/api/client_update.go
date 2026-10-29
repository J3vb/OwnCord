// Package api provides the HTTP router and handlers for the OwnCord server.
//
// client_update.go serves Tauri-compatible update metadata so the desktop
// client can check for new versions and self-update.
//
// Linux .deb targets ("linux-*-deb") are served only to clients that send
// ?deb_install=pkexec; everyone else gets 204. An opted-in client also gets a
// 200 with the latest version when it is already current (or newer), so it can
// tell "current" from "this server cannot serve me".
package api

import (
	"net/http"
	"net/url"
	"strings"

	"github.com/J3vb/OwnCord/Server/updater"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/go-chi/chi/v5"
	"golang.org/x/mod/semver"
)

// tauriPlatformResponse is the per-platform entry in the Tauri updater JSON.
type tauriPlatformResponse struct {
	Signature string `json:"signature"`
	URL       string `json:"url"`
}

// tauriUpdateResponse is the JSON shape the Tauri updater plugin expects.
type tauriUpdateResponse struct {
	Version   string                           `json:"version"`
	Notes     string                           `json:"notes,omitempty"`
	PubDate   string                           `json:"pub_date,omitempty"`
	Platforms map[string]tauriPlatformResponse `json:"platforms"`
}

// MountClientUpdateRoute adds the unauthenticated client-update endpoint.
// The route is outside the auth middleware because the client needs to check
// for updates before (or without) logging in.
func MountClientUpdateRoute(r chi.Router, u *updater.Updater) {
	r.Get("/api/v1/client-update/{target}/{current_version}", handleClientUpdate(u))
}

func handleClientUpdate(u *updater.Updater) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		target := chi.URLParam(r, "target")
		currentVersion := chi.URLParam(r, "current_version")

		if target == "" || currentVersion == "" {
			writeErr(w, http.StatusBadRequest, "INVALID_INPUT", "missing target or current_version")
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
			writeErr(w, http.StatusBadGateway, "UPDATE_CHECK_FAILED", "failed to check for updates")
			return
		}

		// Compare versions — return 204 if no update available. An opted-in
		// .deb client is the exception: the plugin resolves the platform
		// entry before it compares versions, so the entry must be sent even
		// when the client is current; its own comparator then reports "no
		// update" while knowing the server can serve the package.
		cv := ensureV(currentVersion)
		lv := ensureV(info.Latest)
		if semver.Compare(cv, lv) >= 0 && !optedIn {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Server first, clients second: never advertise a client that speaks
		// a newer wire epoch than this server — it would auto-update straight
		// into a refused handshake. The epoch comes from the release's signed
		// manifest; a manifest that does not verify is withheld the same way.
		epoch, err := u.ReleaseProtocolEpoch(r.Context(), info)
		if err != nil || epoch > ws.ProtocolEpoch {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Find the updater artifact and its signature for the requested
		// target ("{os}-{arch}-{installer}", e.g. "windows-x86_64-nsis").
		// Targets without a published updater artifact get 204 — never a
		// foreign OS's or foreign installer's artifact.
		clientAssets := u.FindClientAssets(target)
		installerURL := clientAssets.InstallerURL
		sigURL := clientAssets.SignatureURL
		if installerURL == "" || sigURL == "" {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		// Fetch the signature file content (small text file). Cached with the
		// same TTL as the release info so this unauthenticated endpoint does not
		// perform an outbound fetch on every request (DoS hardening).
		sigContent, err := u.FetchTextAssetCached(r.Context(), sigURL)
		if err != nil {
			writeErr(w, http.StatusBadGateway, "UPDATE_CHECK_FAILED", "failed to fetch signature")
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

// ensureV returns a version string with a "v" prefix for semver comparison.
func ensureV(v string) string {
	if strings.HasPrefix(v, "v") {
		return v
	}
	return "v" + v
}
