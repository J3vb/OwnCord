package imgthumb

import (
	"bytes"
	"image"
	"image/color"
	"image/gif"
	"testing"
)

func testGIF(t *testing.T, frames int) []byte {
	t.Helper()
	pal := color.Palette{color.Black, color.White}
	g := &gif.GIF{}
	for i := range frames {
		img := image.NewPaletted(image.Rect(0, 0, 4, 4), pal)
		img.SetColorIndex(i%4, 0, 1)
		g.Image = append(g.Image, img)
		g.Delay = append(g.Delay, 5)
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, g); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestGIFAnimated(t *testing.T) {
	two, one := testGIF(t, 2), testGIF(t, 1)
	cases := []struct {
		name string
		data []byte
		want bool
	}{
		{"two frames", two, true},
		{"three frames", testGIF(t, 3), true},
		{"one frame", one, false},
		{"truncated", two[:len(two)/2], false},
		{"empty", nil, false},
		{"not a gif", []byte("\x89PNG\r\n\x1a\nxxxxxxxxxxxxxxxx"), false},
	}
	for _, c := range cases {
		if got := GIFAnimated(bytes.NewReader(c.data)); got != c.want {
			t.Errorf("%s: GIFAnimated = %v, want %v", c.name, got, c.want)
		}
	}
}
