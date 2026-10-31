package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// ErrStickerGone means the sticker a send named no longer exists by the time
// the message is written (it was deleted after the service looked it up). No
// message is stored.
var ErrStickerGone = errors.New("sticker no longer exists")

// Sticker is one row of the stickers table: a server-wide custom sticker.
// StoredAs is the storage-layer id of the image bytes (the column is named
// filename); it never reaches a client.
type Sticker struct {
	ID         int64
	Name       string
	Emoji      *string
	StoredAs   string
	MimeType   string
	UploadedBy int64
	CreatedAt  string
}

func stickerFromGen(r dbgen.Sticker) *Sticker {
	return &Sticker{
		ID: r.ID, Name: r.Name, Emoji: r.Emoji, StoredAs: r.Filename,
		MimeType: r.MimeType, UploadedBy: r.UploadedBy, CreatedAt: r.CreatedAt,
	}
}

// StickerImageURL is the server-relative path the image bytes of a sticker are
// served from.
func StickerImageURL(id int64) string {
	return fmt.Sprintf("/api/v1/stickers/%d/image", id)
}

// MessageStickerInfo is the sticker block of a sticker message. ID and URL are
// null once the sticker has been deleted; Name is the label kept from send
// time.
type MessageStickerInfo struct {
	ID   *int64  `json:"id"`
	Name string  `json:"name"`
	URL  *string `json:"url"`
}

// NewMessageStickerInfo builds the sticker block of a message. A nil stickerID
// means the sticker was deleted, and the block carries no id or url.
func NewMessageStickerInfo(stickerID *int64, name string) *MessageStickerInfo {
	info := &MessageStickerInfo{Name: name}
	if stickerID != nil {
		id := *stickerID
		url := StickerImageURL(id)
		info.ID, info.URL = &id, &url
	}
	return info
}

// StickerRef names the sticker a send carries. Name is the snapshot stored with
// the message.
type StickerRef struct {
	ID   int64
	Name string
}

// GetSticker returns the sticker with the given id, or (nil, nil).
func (d *DB) GetSticker(ctx context.Context, id int64) (*Sticker, error) {
	r, err := d.q.GetStickerByID(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetSticker: %w", err)
	}
	return stickerFromGen(r), nil
}

// GetStickerByName returns the sticker with the given name (compared ignoring
// case), or (nil, nil).
func (d *DB) GetStickerByName(ctx context.Context, name string) (*Sticker, error) {
	r, err := d.q.GetStickerByName(ctx, name)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetStickerByName: %w", err)
	}
	return stickerFromGen(r), nil
}

// ListStickers returns every sticker ordered by name, ignoring case.
func (d *DB) ListStickers(ctx context.Context) ([]*Sticker, error) {
	rows, err := d.q.ListStickers(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListStickers: %w", err)
	}
	out := make([]*Sticker, 0, len(rows))
	for i := range rows {
		out = append(out, stickerFromGen(rows[i]))
	}
	return out, nil
}

// CountStickers returns how many stickers exist.
func (d *DB) CountStickers(ctx context.Context) (int64, error) {
	n, err := d.q.CountStickers(ctx)
	if err != nil {
		return 0, fmt.Errorf("CountStickers: %w", err)
	}
	return n, nil
}

// CreateSticker inserts a sticker. A name clash surfaces as a unique-constraint
// error (IsUniqueConstraintError).
func (d *DB) CreateSticker(ctx context.Context, name string, emoji *string, storedAs, mimeType string, uploadedBy int64) (*Sticker, error) {
	r, err := d.q.CreateSticker(ctx, dbgen.CreateStickerParams{
		Name: name, Emoji: emoji, Filename: storedAs, MimeType: mimeType, UploadedBy: uploadedBy,
	})
	if err != nil {
		return nil, fmt.Errorf("CreateSticker: %w", err)
	}
	return stickerFromGen(r), nil
}

// UpdateSticker renames a sticker and sets its related emoji. It returns
// (nil, nil) when the sticker does not exist.
func (d *DB) UpdateSticker(ctx context.Context, id int64, name string, emoji *string) (*Sticker, error) {
	r, err := d.q.UpdateSticker(ctx, dbgen.UpdateStickerParams{Name: name, Emoji: emoji, ID: id})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("UpdateSticker: %w", err)
	}
	return stickerFromGen(r), nil
}

// DeleteSticker removes a sticker and reports whether a row was deleted.
// Messages that used it keep their name and lose the link (ON DELETE SET NULL).
func (d *DB) DeleteSticker(ctx context.Context, id int64) (bool, error) {
	res, err := d.q.DeleteSticker(ctx, id)
	if err != nil {
		return false, fmt.Errorf("DeleteSticker: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("DeleteSticker rows affected: %w", err)
	}
	return n > 0, nil
}

// insertStickerRow is the sticker step of CreateMessageDelivery: the
// message_stickers row, after the message exists, in the same transaction. A
// sticker deleted since the service looked it up inserts nothing, and the send
// fails with ErrStickerGone.
func insertStickerRow(ctx context.Context, q *dbgen.Queries, messageID int64, s *StickerRef) error {
	res, err := q.InsertMessageSticker(ctx, dbgen.InsertMessageStickerParams{
		MessageID: messageID, Name: s.Name, StickerID: s.ID,
	})
	if err != nil {
		return fmt.Errorf("sticker row insert: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("sticker row rows affected: %w", err)
	}
	if n == 0 {
		return ErrStickerGone
	}
	return nil
}

// GetMessageSticker returns the sticker block of one message, or (nil, nil)
// when the message is not a sticker message.
func (d *DB) GetMessageSticker(ctx context.Context, messageID int64) (*MessageStickerInfo, error) {
	infos, err := d.stickerInfos(ctx, []int64{messageID})
	if err != nil {
		return nil, err
	}
	return infos[messageID], nil
}

// stickerInfos builds the sticker block of each id that is a sticker message.
// Ids that are not are absent from the result.
func (d *DB) stickerInfos(ctx context.Context, ids []int64) (map[int64]*MessageStickerInfo, error) {
	rows, err := d.q.GetMessageStickersByMessageIDs(ctx, padIDs(ids))
	if err != nil {
		return nil, fmt.Errorf("message stickers: %w", err)
	}
	out := make(map[int64]*MessageStickerInfo, len(rows))
	for i := range rows {
		out[rows[i].MessageID] = NewMessageStickerInfo(rows[i].StickerID, rows[i].Name)
	}
	return out, nil
}

// attachStickers fills Sticker on every ordinary, live row in msgs that is a
// sticker message, with one batched read. A page with no candidate rows costs
// no query.
func (d *DB) attachStickers(ctx context.Context, msgs []MessageAPIResponse) error {
	var ids []int64
	for i := range msgs {
		if msgs[i].Kind == "" && !msgs[i].Deleted {
			ids = append(ids, msgs[i].ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	infos, err := d.stickerInfos(ctx, ids)
	if err != nil {
		return err
	}
	for i := range msgs {
		if msgs[i].Kind == "" && !msgs[i].Deleted {
			msgs[i].Sticker = infos[msgs[i].ID]
		}
	}
	return nil
}

// attachSearchStickers fills Sticker on the search hits that are sticker
// messages, with one batched read.
func (d *DB) attachSearchStickers(ctx context.Context, results []MessageSearchResult) ([]MessageSearchResult, error) {
	if len(results) == 0 {
		return results, nil
	}
	ids := make([]int64, 0, len(results))
	for i := range results {
		ids = append(ids, results[i].MessageID)
	}
	infos, err := d.stickerInfos(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range results {
		results[i].Sticker = infos[results[i].MessageID]
	}
	return results, nil
}
