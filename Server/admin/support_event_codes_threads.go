package admin

// support_event_codes_threads.go - the event codes for the thread feature's
// Warn/Error literals.

import "maps"

func init() {
	maps.Copy(supportEventCodes, map[string]string{
		"thread-archiver: boot sweep failed":                                            "thread_archiver_boot_sweep_failed",
		"thread deleted":                                                                "thread_deleted",
		"thread archiver: sweep failed":                                                 "thread_archiver_sweep_failed",
		"thread archiver: read next due failed":                                         "thread_archiver_next_due_failed",
		"hub: parent thread list failed, resolving per socket":                          "hub_parent_thread_list_failed",
		"ws: thread_changed read failed, dropping frame":                                "ws_thread_changed_read_failed",
		"ws: thread follow read failed, dropping follow updates":                        "ws_thread_follow_read_failed",
		"ws: thread read failed, dropping follow updates":                               "ws_thread_follow_thread_read_failed",
		"ws: ready followed threads read failed, omitting":                              "ws_ready_followed_threads_failed",
		"thread delete: follower read failed, followers will learn at their next ready": "thread_delete_followers_read_failed",
	})
}
