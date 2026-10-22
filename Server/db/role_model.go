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
	// member ping it (WP 6.3). Both ride roles[] and roles_update.
	Hoist       bool `json:"hoist"`
	Mentionable bool `json:"mentionable"`
}
