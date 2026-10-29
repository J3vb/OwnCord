package db

// The stored values of messages.kind. 0 is a message a user wrote, 1 a call
// log row (WP 3B-9) and 2 to 6 the group DM event rows (WP 3B-10), 7 a pin row (WP 6.12), 8 a welcome row (WP 8.6).
// MessageKindName gives their wire names (protocol enum chat_message.kind).
const (
	MessageKindUser        int64 = 0
	MessageKindCall        int64 = 1
	MessageKindGroupAdd    int64 = 2
	MessageKindGroupRemove int64 = 3
	MessageKindGroupLeave  int64 = 4
	MessageKindGroupRename int64 = 5
	MessageKindGroupIcon   int64 = 6
	MessageKindPinAdd      int64 = 7
	MessageKindMemberJoin  int64 = 8

	MessageKindNameCall = "call"
)

// MessageKindName is the wire name of a stored kind: "" for an ordinary
// message (the field is omitted) and for a value this server does not know.
func MessageKindName(kind int64) string {
	switch kind {
	case MessageKindCall:
		return MessageKindNameCall
	case MessageKindGroupAdd:
		return "group_add"
	case MessageKindGroupRemove:
		return "group_remove"
	case MessageKindGroupLeave:
		return "group_leave"
	case MessageKindGroupRename:
		return "group_rename"
	case MessageKindGroupIcon:
		return "group_icon"
	case MessageKindPinAdd:
		return "pin_add"
	case MessageKindMemberJoin:
		return "member_join"
	}
	return ""
}
