package ws_test

import (
	"testing"

	"github.com/J3vb/OwnCord/Server/ws"
)

// The ring-buffer twins of the persisted predicates must also name a reply
// frame by the parent embedded in it.
func TestEventNames_ReferencedParent(t *testing.T) {
	frame := []byte(`{"seq":1,"type":"chat_message","payload":{"id":300,"user":{"id":2},` +
		`"referenced_message":{"id":100,"user":{"id":42},"content":"old"}}}`)
	if !ws.EventNamesMessageForTest(frame, map[int64]struct{}{100: {}}) {
		t.Error("eventNamesMessage must match the referenced parent id")
	}
	if ws.EventNamesMessageForTest(frame, map[int64]struct{}{101: {}}) {
		t.Error("eventNamesMessage matched an unrelated id")
	}
	if !ws.EventNamesUserForTest(frame, 42) {
		t.Error("eventNamesUser must match the referenced parent's author")
	}
	if ws.EventNamesUserForTest(frame, 43) {
		t.Error("eventNamesUser matched an unrelated user")
	}
}
