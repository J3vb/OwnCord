package admin

import (
	"net/http"

	"github.com/J3vb/OwnCord/Server/httperr"
	"github.com/J3vb/OwnCord/Server/service"
)

// handleGetAttention serves the admin attention panel's state: the
// current signals and the deduplicated warnings. It only reads what the
// sampler already holds, so a dashboard refresh costs no measurement.
func handleGetAttention(attention *service.AttentionService) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		if attention == nil {
			writeErr(w, http.StatusInternalServerError, httperr.CodeInternalError, "attention service unavailable")
			return
		}
		writeJSON(w, http.StatusOK, attention.Report())
	}
}
