package db

// SearchThreadRef names the parent of a hit's channel when that channel is a thread or
// forum post, so a client can open it in the thread panel.
type SearchThreadRef struct {
	ThreadParentID int64 `json:"thread_parent_id,omitempty"`
}
