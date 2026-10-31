package service

import (
	"context"

	"github.com/J3vb/OwnCord/Server/db"
)

// GIFFavorite is one saved GIF; the api layer uses this name rather than db's.
type GIFFavorite = db.GIFFavorite

// ErrGIFFavoritesFull is returned when a new favorite would exceed the
// per-user cap.
var ErrGIFFavoritesFull = db.ErrGIFFavoritesFull

// gifFavoriteStore is what GIFFavoriteService reads and writes. *db.DB satisfies it.
type gifFavoriteStore interface {
	AddGIFFavorite(ctx context.Context, userID int64, f db.GIFFavorite) error
	RemoveGIFFavorite(ctx context.Context, userID int64, url string) error
	ListGIFFavorites(ctx context.Context, userID int64) ([]db.GIFFavorite, error)
}

// GIFFavoriteService is the per-user saved-GIF list.
type GIFFavoriteService struct {
	st gifFavoriteStore
}

// NewGIFFavoriteService creates a GIFFavoriteService.
func NewGIFFavoriteService(st gifFavoriteStore) *GIFFavoriteService {
	return &GIFFavoriteService{st: st}
}

// Add saves f for userID; re-adding an existing URL is a no-op.
func (s *GIFFavoriteService) Add(ctx context.Context, userID int64, f GIFFavorite) error {
	return s.st.AddGIFFavorite(ctx, userID, f)
}

// Remove deletes userID's favorite with the given URL.
func (s *GIFFavoriteService) Remove(ctx context.Context, userID int64, url string) error {
	return s.st.RemoveGIFFavorite(ctx, userID, url)
}

// List returns userID's favorites, newest first.
func (s *GIFFavoriteService) List(ctx context.Context, userID int64) ([]GIFFavorite, error) {
	return s.st.ListGIFFavorites(ctx, userID)
}
