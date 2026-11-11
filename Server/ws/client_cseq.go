package ws

import (
	"bytes"
	"strconv"
	"sync/atomic"
)

// cseqBufKeep is the largest stamping buffer kept between frames; a bigger one is
// dropped after use so an idle connection does not pin it.
const cseqBufKeep = 64 << 10

var seqFramePrefix = []byte(`{"seq":`)

// cseqState counts sequenced frames written to a connection's socket. out and buf
// belong to whichever goroutine writes the socket (the handshake during replay,
// then writePump); lossPending is set by markLoss on the dispatch goroutine and
// consumed by the writer, so it is atomic.
type cseqState struct {
	out         uint64
	buf         []byte
	lossPending atomic.Bool
}

// stampCseq returns msg with "cseq" as its first field when msg is a sequenced
// frame, unchanged otherwise. A pending loss makes the count skip one so the
// client sees a gap and resumes. The result is valid only until the next call.
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
