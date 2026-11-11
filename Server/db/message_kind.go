package db

// The stored values of messages.kind: 0 user message, 1 call log, 2 to 6 group DM
// events, 7 pin, 8 welcome. MessageKindName gives the wire names (protocol enum
// chat_message.kind).
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

// MessageKindName is a stored kind's wire name; "" (omitted) for an ordinary or unknown kind.
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
