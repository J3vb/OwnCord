package db

import "github.com/J3vb/OwnCord/Server/db/dbgen"

// Conversions from sqlc-generated row types (db/dbgen) to the domain models: sqlc
// emits int64 and *string where the models use int, bool and plain string.

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func ptrI64toI(p *int64) *int {
	if p == nil {
		return nil
	}
	v := int(*p)
	return &v
}

func ptrItoI64(p *int) *int64 {
	if p == nil {
		return nil
	}
	v := int64(*p)
	return &v
}

func b2i64(b bool) int64 {
	if b {
		return 1
	}
	return 0
}

func strToNullPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

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

		CustomStatusExpiresAt: u.CustomStatusExpiresAt,
		BannerID:              u.BannerID,
		BannerColor:           u.BannerColor,
	}
}

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

func sessionFromColumns(id, userID int64, token string, device, ip *string, createdAt, lastUsed, expiresAt string, unseen int64) Session {
	return Session{
		ID:        id,
		UserID:    userID,
		TokenHash: token,
		Device:    derefString(device),
		IP:        derefString(ip),
		CreatedAt: createdAt,
		LastUsed:  lastUsed,
		ExpiresAt: expiresAt,
		Unseen:    unseen != 0,
	}
}
