package db

import (
	"context"
	"fmt"
)

// isGroupEventKindName reports whether a wire kind name is a group event row.
func isGroupEventKindName(kind string) bool {
	switch kind {
	case "group_add", "group_remove", "group_leave", "group_rename", "group_icon":
		return true
	}
	return false
}

// attachGroupEvents fills GroupEvent on every group event row in msgs with one
// batched read of message_group_events. Rows of other kinds are untouched, and
// a page with no group event rows costs no query. A group event row always
// gets a block, even when its detail row is missing, so a client can rely on
// the block being present for these kinds.
func (d *DB) attachGroupEvents(ctx context.Context, msgs []MessageAPIResponse) error {
	var ids []int64
	for i := range msgs {
		if isGroupEventKindName(msgs[i].Kind) {
			ids = append(ids, msgs[i].ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := d.q.GetMessageGroupEventsByMessageIDs(ctx, padIDs(ids))
	if err != nil {
		return fmt.Errorf("group events: %w", err)
	}
	byMsg := make(map[int64]int, len(rows))
	for i := range rows {
		byMsg[rows[i].MessageID] = i
	}
	for i := range msgs {
		if !isGroupEventKindName(msgs[i].Kind) {
			continue
		}
		info := &GroupEventInfo{}
		if at, ok := byMsg[msgs[i].ID]; ok {
			row := rows[at]
			switch msgs[i].Kind {
			case "group_add", "group_remove":
				if row.TargetUserID != nil {
					info.TargetUserID = *row.TargetUserID
				}
			case "group_rename":
				name := ""
				if row.Name != nil {
					name = *row.Name
				}
				info.Name = &name
			case "group_icon":
				removed := row.IconRemoved != 0
				info.IconRemoved = &removed
			}
		}
		msgs[i].GroupEvent = info
	}
	return nil
}
