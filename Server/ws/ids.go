package ws

import (
	"encoding/json"
	"fmt"
)

// positiveID reads a required positive integer id from a payload. It is the only place in ws
// converting a json.Number to an int64 id (invariants rule ws-payload-ids), so every command
// refuses an absent, fractional, out-of-range, zero or negative id the same way. An id that may be
// absent is read through *json.Number and passed here only when present (see parseMarkRead).
func positiveID(n json.Number, field string) (int64, error) {
	v, err := n.Int64()
	if err != nil || v <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", field)
	}
	return v, nil
}
