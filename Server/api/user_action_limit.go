package api

import (
	"net/http"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/httperr"
)

// userActionRateLimitPerMinute bounds, per account, the small toggle writes (block and
// unblock, the NSFW acknowledgement, closing a DM), the same order as the group DM
// mutations (dmGroupRateLimitPerMinute).
const userActionRateLimitPerMinute = 20

// perUserActionLimit spends one call of the signed-in account's budget under prefix and
// answers 429 RATE_LIMITED once it is spent. It mounts after AuthMiddleware; a nil limiter
// allows every call.
func perUserActionLimit(limiter *auth.RateLimiter, prefix, message string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			user, ok := requireUser(w, r)
			if !ok {
				return
			}
			if limiter != nil && !limiter.Allow(auth.Key(prefix, user.ID), userActionRateLimitPerMinute, time.Minute) {
				writeErr(w, http.StatusTooManyRequests, httperr.CodeRateLimited, message)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
