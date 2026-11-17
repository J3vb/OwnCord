package ws

import (
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// Every frame type that carries or names a message's content must be removed from the
// persisted replay tier by a retention sweep and by an account erasure, or the content of
// a removed message stays replayable until the event pruner reaches it.
func TestMessageFamily_CoveredByPersistedCleanup(t *testing.T) {
	t.Parallel()
	retention, erasure := db.EventNamesMessagePredicate, db.EventNamesOwnMessagePredicate
	for frameType := range messageFamily {
		quoted := "'" + frameType + "'"
		if !strings.Contains(retention, quoted) {
			t.Errorf("retention clean-up (db.EventNamesMessagePredicate) misses %s", frameType)
		}
		// Bulk deletes carry only ids, never content, so the erasure drain does not need them.
		if frameType == MsgTypeChatBulkDeleted {
			continue
		}
		if !strings.Contains(erasure, quoted) {
			t.Errorf("erasure clean-up (db.EventNamesOwnMessagePredicate) misses %s", frameType)
		}
	}
}
