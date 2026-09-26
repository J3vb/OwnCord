package db

import "github.com/J3vb/OwnCord/Server/db/dbgen"

// This file holds the conversions from sqlc-generated row/model types
// (db/dbgen) to the domain model types this package exposes. sqlc emits int64
// for integer columns and *string for nullable text; the domain models use
// narrower Go types (int, bool, non-pointer string) for ergonomics, so each
// delegating read maps through one of these helpers. See docs/plans/sqlc-adoption.md.

// derefString returns the pointed-to string, or "" when the pointer is nil.
// Used for columns the schema allows to be NULL but the domain model exposes
// as a plain string (device, ip_address).
func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// ptrI64toI narrows a *int64 (sqlc's nullable-integer type) to a *int, which
// the domain models use for optional counts (e.g. invite max_uses).
func ptrI64toI(p *int64) *int {
	if p == nil {
		return nil
	}
	v := int(*p)
	return &v
}

// ptrItoI64 widens a *int to a *int64 for passing into a generated params
// struct (the inverse of ptrI64toI).
func ptrItoI64(p *int) *int64 {
	if p == nil {
		return nil
	}
	v := int64(*p)
	return &v
}

// b2i64 converts a bool to sqlc's int64 representation of a SQLite boolean.
func b2i64(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

// strToNullPtr returns nil for an empty string, else a pointer to it — so
// empty strings are written as NULL in optional TEXT columns (matches the
// former nullableString helper).
func strToNullPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// userFromGen maps a generated user row to the domain User model.
func userFromGen(u dbgen.User) *User {
	return &User{
		ID:                 u.ID,
		Username:           u.Username,
		PasswordHash:       u.Password,
		Avatar:             u.Avatar,
		RoleID:             u.RoleID,
		TOTPSecret:         u.TotpSecret,
		Status:             u.Status,
		CreatedAt:          u.CreatedAt,
		LastSeen:           u.LastSeen,
		Banned:             u.Banned != 0,
		BanReason:          u.BanReason,
		BanExpires:         u.BanExpires,
		IdentityPublicKey:  u.IdentityPublicKey,
		DisplayName:        u.DisplayName,
		About:              u.About,
		CustomStatus:       u.CustomStatus,
		RegistrationStatus: u.RegistrationStatus,
	}
}

// apiTokenFromGen maps a generated api_tokens row to the domain APIToken model.
func apiTokenFromGen(t dbgen.ApiToken) *APIToken {
	return &APIToken{
		ID:        t.ID,
		UserID:    t.UserID,
		TokenHash: t.TokenHash,
		Label:     t.Label,
		CreatedAt: t.CreatedAt,
		LastUsed:  t.LastUsedAt,
		ExpiresAt: t.ExpiresAt,
		RevokedAt: t.RevokedAt,
	}
}

// sessionFromGen maps a generated session row to the domain Session model.
func sessionFromGen(s dbgen.Session) Session {
	return Session{
		ID:        s.ID,
		UserID:    s.UserID,
		TokenHash: s.Token,
		Device:    derefString(s.Device),
		IP:        derefString(s.IpAddress),
		CreatedAt: s.CreatedAt,
		LastUsed:  s.LastUsed,
		ExpiresAt: s.ExpiresAt,
		Unseen:    s.Unseen != 0,
	}
}
