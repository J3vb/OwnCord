package ws

import (
	"bytes"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/config"
)

func TestWrapWithSeq(t *testing.T) {
	if got := string(wrapWithSeq([]byte(`{"type":"x"}`), 7)); got != `{"seq":7,"type":"x"}` {
		t.Errorf("wrapWithSeq = %s", got)
	}
	// The largest frame still in bounds is sequenced.
	atLimit := bytes.Repeat([]byte(" "), config.MaxMessageBytes)
	atLimit[0] = '{'
	if got := wrapWithSeq(atLimit, 1); !bytes.HasPrefix(got, []byte(`{"seq":1,`)) {
		t.Error("frame of exactly MaxMessageBytes was not sequenced")
	}
	// One byte over the size guard passes through untouched.
	overLimit := slices.Concat(atLimit, []byte(" "))
	if got := wrapWithSeq(overLimit, 1); !bytes.Equal(got, overLimit) {
		t.Error("frame above MaxMessageBytes was modified")
	}
}
