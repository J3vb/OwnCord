package db

// Role represents a row in the roles table.
type Role struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	Color       *string `json:"color"`
	Permissions int64   `json:"permissions"`
	Position    int     `json:"position"`
	IsDefault   bool    `json:"is_default"`
	// Hoist makes the role its own member-list group; Mentionable lets any
	// member ping it. Both ride roles[] and roles_update.
	Hoist       bool `json:"hoist"`
	Mentionable bool `json:"mentionable"`
}

// RoleMentions is the wire field for the roles a message pinged. Embedded in
// MessageAPIResponse; never nil once a row has been enriched.
type RoleMentions struct {
	MentionRoles []int64 `json:"mention_roles"`
}
