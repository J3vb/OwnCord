package db

import (
	"context"
	"fmt"
)

// ImportedAuthor is who wrote an imported message. The hidden import account
// owns every such message, so this is what a client shows instead of it.
// Color is a Discord role colour as exported and is not validated here.
type ImportedAuthor struct {
	Name  string  `json:"name"`
	Color *string `json:"color,omitempty"`
}

// ImportedBy is the wire field that marks a message as imported. Embedded in
// the message payload shapes; nil (and omitted) for an ordinary message.
type ImportedBy struct {
	ImportedAuthor *ImportedAuthor `json:"imported_author,omitempty"`
}

// importedAuthors returns the author of each id that is an imported message,
// in one batched read. Ids that are not are absent.
func (d *DB) importedAuthors(ctx context.Context, ids []int64) (map[int64]*ImportedAuthor, error) {
	out := make(map[int64]*ImportedAuthor)
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := d.q.GetImportAuthorsByMessageIDs(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("imported authors: %w", err)
	}
	for i := range rows {
		out[rows[i].MessageID] = &ImportedAuthor{Name: rows[i].Name, Color: rows[i].Color}
	}
	return out, nil
}

// attachImportedAuthors fills ImportedAuthor on the rows of msgs that are
// imported messages.
func (d *DB) attachImportedAuthors(ctx context.Context, msgs []MessageAPIResponse) error {
	ids := make([]int64, len(msgs))
	for i := range msgs {
		ids[i] = msgs[i].ID
	}
	authors, err := d.importedAuthors(ctx, ids)
	if err != nil {
		return err
	}
	for i := range msgs {
		msgs[i].ImportedAuthor = authors[msgs[i].ID]
	}
	return nil
}

// attachSearchImportedAuthors fills ImportedAuthor on the search hits that are
// imported messages.
func (d *DB) attachSearchImportedAuthors(ctx context.Context, results []MessageSearchResult) ([]MessageSearchResult, error) {
	ids := make([]int64, len(results))
	for i := range results {
		ids[i] = results[i].MessageID
	}
	authors, err := d.importedAuthors(ctx, ids)
	if err != nil {
		return nil, err
	}
	for i := range results {
		results[i].ImportedAuthor = authors[results[i].MessageID]
	}
	return results, nil
}

// attachReferencedImportedAuthors fills ImportedAuthor on the reply snippets
// whose parent is an imported message.
func (d *DB) attachReferencedImportedAuthors(ctx context.Context, refs map[int64]*ReferencedMessage) error {
	ids := make([]int64, 0, len(refs))
	for id, r := range refs {
		if !r.Deleted {
			ids = append(ids, id)
		}
	}
	authors, err := d.importedAuthors(ctx, ids)
	if err != nil {
		return err
	}
	for id, a := range authors {
		refs[id].ImportedAuthor = a
	}
	return nil
}
