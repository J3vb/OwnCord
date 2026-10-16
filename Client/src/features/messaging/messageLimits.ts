// Server/service/message.go's maxMessageLen refuses content past 4000 code
// points (utf8.RuneCountInString). Mirror it here so an over-long send fails
// visibly instead of producing an optimistic row whose retry fails identically.
// Counted in code points, not UTF-16 units -- see the guard in handleSend and
// the inline editor's save. A module of its own so the lazy inline editor can
// read it without importing the composer.
export const MAX_MESSAGE_LEN = 4000;
