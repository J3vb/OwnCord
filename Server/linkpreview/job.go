package linkpreview

// Job names a committed message whose links should get cards.
type Job struct {
	MessageID int64
	ChannelID int64
	AuthorID  int64
	// Content is the message text exactly as stored.
	Content string
	// Version is the message's edited_at, else its timestamp, exactly as stored. A result is
	// applied only while the message still has this version and Content.
	Version string
	// Edited marks an edit: cards the message had are cleared when its new text has no links.
	Edited bool
}

// Unfurler is what a message service hands committed messages to. Every method returns at
// once and never blocks a send; a full queue drops the work.
type Unfurler interface {
	// Enqueue queues a message just sent or edited.
	Enqueue(job Job)
	// EnqueueBackfill queues old messages that were never unfurled, at a lower priority than
	// Enqueue, and returns how many it accepted.
	EnqueueBackfill(jobs []Job) int
	// NoteShown records cards and thumbnails a reader was just given, for a later batched
	// last-used update.
	NoteShown(urlHashes, imageHashes []string)
}
