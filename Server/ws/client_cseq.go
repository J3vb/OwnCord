package ws

import (
	"bytes"
	"strconv"
	"sync/atomic"
)

// cseqBufKeep is the largest stamping buffer a client keeps between frames;
// a bigger one (a frame near config.MaxMessageBytes) is dropped after use so
// an idle connection does not pin it.
const cseqBufKeep = 64 << 10

var seqFramePrefix = []byte(`{"seq":`)

// cseqState is a connection's count of sequenced frames written to its
// socket. out and buf belong to whichever goroutine writes the
// socket: the handshake while it replays, then writePump, which starts after
// it. lossPending is set by markLoss (hub_loss.go) on the dispatch goroutine
// and consumed by the writer, so it is atomic.
type cseqState struct {
	out         uint64
	buf         []byte
	lossPending atomic.Bool
}

// stampCseq returns msg with "cseq" as its first field when msg is a
// sequenced frame (wrapWithSeq always writes seq first), and msg unchanged
// otherwise. A pending loss makes the count skip one, so the client sees a
// gap and resumes. The returned slice is only valid until the next call.
func (c *Client) stampCseq(msg []byte) []byte {
	if !bytes.HasPrefix(msg, seqFramePrefix) {
		return msg
	}
	s := &c.cseq
	s.out++
	if s.lossPending.Swap(false) {
		s.out++
	}
	b := s.buf[:0]
	b = append(b, `{"cseq":`...)
	b = strconv.AppendUint(b, s.out, 10)
	b = append(b, ',')
	b = append(b, msg[1:]...)
	if cap(b) > cseqBufKeep {
		s.buf = nil
	} else {
		s.buf = b
	}
	return b
}
