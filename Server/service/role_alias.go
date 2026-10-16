package service

import "github.com/J3vb/OwnCord/Server/db"

// Role re-exports the db role row so a caller outside db/ and service/ (the
// ws hub's channel-level private flag) can name it in a signature without
// importing the db package.
type Role = db.Role
