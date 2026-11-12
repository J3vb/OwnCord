package discordimport

import (
	"strconv"

	"github.com/J3vb/OwnCord/Server/db"
)

// knownIDs maps Discord message ids to stored row ids across chunks. A snowflake is kept as a uint64 so a
// long export does not hold a string per message; an id that is not a canonical decimal number goes in the
// small fallback map and still links.
type knownIDs struct {
	num   map[uint64]int64
	other map[string]int64
}

func newKnownIDs() *knownIDs {
	return &knownIDs{num: map[uint64]int64{}, other: map[string]int64{}}
}

func snowflake(key string) (uint64, bool) {
	n, err := strconv.ParseUint(key, 10, 64)
	if err != nil || strconv.FormatUint(n, 10) != key {
		return 0, false
	}
	return n, true
}

func (k *knownIDs) put(key string, id int64) {
	if n, ok := snowflake(key); ok {
		k.num[n] = id
		return
	}
	k.other[key] = id
}

func (k *knownIDs) get(key string) (int64, bool) {
	if n, ok := snowflake(key); ok {
		id, found := k.num[n]
		return id, found
	}
	id, found := k.other[key]
	return id, found
}

// forReplies returns the entries the chunk's replies point at, the only ones the store looks up.
func (k *knownIDs) forReplies(msgs []db.ImportMessage) map[string]int64 {
	out := map[string]int64{}
	for i := range msgs {
		key := msgs[i].ReplyKey
		if key == "" {
			continue
		}
		if id, ok := k.get(key); ok {
			out[key] = id
		}
	}
	return out
}
