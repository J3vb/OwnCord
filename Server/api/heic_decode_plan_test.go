package api_test

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/gen2brain/h265/heic"
	"github.com/gen2brain/h265/hevc"
)

const alphaURN = "urn:mpeg:mpegB:cicp:systems:auxiliary:alpha"

// Property indices of heicParts: the 16x16 picture's ispe and hvcC, an alpha
// auxC, and the ispe of a 32x16 canvas.
const (
	pISPE  = 1
	pHVCC  = 2
	pAlpha = 3
	pWide  = 4
)

// layoutPart is one item of a layout built by layoutOf.
type layoutPart struct {
	id    uint16
	typ   string
	data  []byte
	props []int // 1-based indices into the layout's properties
}

// heicParts is the coded 16x16 picture of plainLayout and the properties the
// layouts below share.
func heicParts(t *testing.T) (pic []byte, props [][]byte) {
	t.Helper()
	l := plainLayout(t)
	return l.data, append(l.props, auxC(alphaURN), isoBox("ispe", be32(0), be32(32), be32(16)))
}

// layoutOf builds a layout from its items, each with its data in mdat in
// turn, and the references that link them.
func layoutOf(primary uint16, props [][]byte, parts []layoutPart, refs ...[]byte) hlayout {
	l := hlayout{props: props, primary: primary}
	entries := make([][3]uint32, 0, len(parts))
	assoc := make([][]int, 0, len(parts))
	for _, p := range parts {
		l.items = append(l.items, hitem{p.id, p.typ})
		entries = append(entries, [3]uint32{uint32(p.id), uint32(len(l.data)), uint32(len(p.data))})
		l.data = append(l.data, p.data...)
		if len(p.props) > 0 {
			assoc = append(assoc, append([]int{int(p.id)}, p.props...))
		}
	}
	l.iloc = ilocV0(entries...)
	l.ipma = ipmaV0(assoc...)
	if len(refs) > 0 {
		l.iref = isoBox("iref", be32(0), bytes.Join(refs, nil))
	}
	return l
}

// iref is one reference box of an iref with 16-bit item ids.
func iref(typ string, from uint16, to ...uint16) []byte {
	body := append(u16(int(from)), u16(len(to))...)
	for _, id := range to {
		body = append(body, u16(int(id))...)
	}
	return isoBox(typ, body)
}

func gridDesc(rows, cols, w, h int) []byte {
	return append([]byte{0, 0, byte(rows - 1), byte(cols - 1)}, append(u16(w), u16(h)...)...)
}

// stillWithAlphaGrid is a 16x16 still whose alpha plane is a one-tile grid of
// a side x side canvas, the tile's data being its coded picture repeat times.
func stillWithAlphaGrid(t *testing.T, side, repeat int) []byte {
	t.Helper()
	pic, props := heicParts(t)
	big := pic
	if side != 16 {
		enc := testHEIC(t, side, side)
		big = boxOf(t, enc, "mdat")[8:]
		props = append(props, isoBox("ispe", be32(0), be32(uint32(side)), be32(uint32(side))), boxOf(t, enc, "hvcC"))
	} else {
		props = append(props, props[pISPE-1], props[pHVCC-1])
	}
	return layoutOf(1, props, []layoutPart{
		{1, "hvc1", pic, []int{pISPE, pHVCC}},
		{2, "grid", gridDesc(1, 1, side, side), []int{pAlpha, 5}},
		{3, "hvc1", bytes.Repeat(big, repeat), []int{5, 6}},
	}, iref("auxl", 2, 1), iref("dimg", 2, 3)).build()
}

// alphaLayouts are the layouts with an alpha plane that the check accepts.
func alphaLayouts(t *testing.T) map[string]hlayout {
	t.Helper()
	pic, props := heicParts(t)
	tile := []int{pISPE, pHVCC}
	alpha := []int{pISPE, pHVCC, pAlpha}
	return map[string]hlayout{
		"a still with a coded alpha plane": layoutOf(1, props, []layoutPart{
			{1, "hvc1", pic, tile}, {2, "hvc1", pic, alpha},
		}, iref("auxl", 2, 1)),
		"a grid whose alpha plane is a grid": layoutOf(3, props, []layoutPart{
			{1, "hvc1", pic, tile}, {2, "hvc1", pic, tile},
			{3, "grid", gridDesc(1, 2, 32, 16), []int{pWide}},
			{4, "hvc1", pic, tile}, {5, "hvc1", pic, tile},
			{6, "grid", gridDesc(1, 2, 32, 16), []int{pWide, pAlpha}},
		}, iref("dimg", 3, 1, 2), iref("dimg", 6, 4, 5), iref("auxl", 6, 3)),
		"a grid with an alpha plane on every tile": layoutOf(3, props, []layoutPart{
			{1, "hvc1", pic, tile}, {2, "hvc1", pic, tile},
			{3, "grid", gridDesc(1, 2, 32, 16), []int{pWide}},
			{4, "hvc1", pic, alpha}, {5, "hvc1", pic, alpha},
		}, iref("dimg", 3, 1, 2), iref("auxl", 4, 1), iref("auxl", 5, 2)),
		// Item 3 is the alpha of the alpha plane, which nothing decodes.
		"an alpha plane with an alpha item of its own": layoutOf(1, props, []layoutPart{
			{1, "hvc1", pic, tile}, {2, "hvc1", pic, alpha}, {3, "hvc1", pic, alpha},
		}, iref("auxl", 2, 1), iref("auxl", 3, 2)),
	}
}

// alphaRefusals are layouts whose alpha planes or grids the check refuses.
func alphaRefusals(t *testing.T) map[string]func() []byte {
	t.Helper()
	pic, props := heicParts(t)
	tile := []int{pISPE, pHVCC}
	alpha := []int{pISPE, pHVCC, pAlpha}
	one := gridDesc(1, 1, 16, 16)
	grid := []layoutPart{{1, "hvc1", pic, tile}, {2, "hvc1", pic, tile}, {3, "grid", gridDesc(1, 2, 32, 16), []int{pWide}}}
	tiles := iref("dimg", 3, 1, 2)
	build := func(primary uint16, parts []layoutPart, refs ...[]byte) func() []byte {
		return func() []byte { return layoutOf(primary, props, parts, refs...).build() }
	}
	return map[string]func() []byte{
		"an alpha grid tile holding several pictures": func() []byte { return stillWithAlphaGrid(t, 32, 3) },
		"an alpha grid whose tile is a grid": build(1, []layoutPart{
			{1, "hvc1", pic, tile}, {2, "grid", one, []int{pISPE, pAlpha}},
			{3, "grid", one, []int{pISPE}}, {4, "hvc1", pic, tile},
		}, iref("auxl", 2, 1), iref("dimg", 2, 3), iref("dimg", 3, 4)),
		"a grid tile that is a grid": build(2, []layoutPart{
			{2, "grid", one, []int{pISPE}}, {3, "grid", one, []int{pISPE}}, {4, "hvc1", pic, tile},
		}, iref("dimg", 2, 3), iref("dimg", 3, 4)),
		"two alpha items for one image": build(1, []layoutPart{
			{1, "hvc1", pic, tile}, {2, "hvc1", pic, alpha}, {3, "hvc1", pic, alpha},
		}, iref("auxl", 2, 1), iref("auxl", 3, 1)),
		"alpha on a grid and on its tiles": build(3, append(grid,
			layoutPart{4, "hvc1", pic, alpha}, layoutPart{5, "hvc1", pic, alpha}, layoutPart{6, "hvc1", pic, alpha}),
			tiles, iref("auxl", 4, 3), iref("auxl", 5, 1), iref("auxl", 6, 2)),
		"alpha on some tiles only": build(3, append(grid, layoutPart{4, "hvc1", pic, alpha}),
			tiles, iref("auxl", 4, 1)),
		"an alpha grid made of the colour tiles": build(3, append(grid,
			layoutPart{4, "grid", gridDesc(1, 2, 32, 16), []int{pWide, pAlpha}}),
			tiles, iref("dimg", 4, 1, 2), iref("auxl", 4, 3)),
		"an image that is its own alpha": build(1, []layoutPart{
			{1, "hvc1", pic, alpha},
		}, iref("auxl", 1, 1)),
		"a tile whose alpha is a grid": build(3, append(grid,
			layoutPart{4, "grid", one, []int{pISPE, pAlpha}}, layoutPart{5, "hvc1", pic, tile},
			layoutPart{6, "hvc1", pic, alpha}),
			tiles, iref("dimg", 4, 5), iref("auxl", 4, 1), iref("auxl", 6, 2)),
		"an alpha item that is an overlay": build(1, []layoutPart{
			{1, "hvc1", pic, tile}, {2, "iovl", pic, []int{pAlpha}},
		}, iref("auxl", 2, 1)),
	}
}

func TestHEICLayout_AlphaGridTilesAreChecked(t *testing.T) {
	for name, build := range alphaRefusals(t) {
		t.Run(name, func(t *testing.T) { heicRefused(t, build()) })
	}
	// The same layout with one picture in the tile is accepted.
	one := stillWithAlphaGrid(t, 32, 1)
	if _, err := api.ValidateHEICForTest(bytes.NewReader(one), int64(len(one))); err != nil {
		t.Fatalf("one picture per alpha tile: %v", err)
	}
}

func TestHEICLayout_AlphaPlanesConvert(t *testing.T) {
	for name, l := range alphaLayouts(t) {
		t.Run(name, func(t *testing.T) { heicConverts(t, l.build()) })
	}
}

// translucentHEIC encodes a w x h image with an alpha channel, tiled when
// tile is not zero (the encoder then codes one alpha item per tile).
func translucentHEIC(t *testing.T, w, h, tile int) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := range h {
		for x := range w {
			img.SetNRGBA(x, y, color.NRGBA{R: 200, G: 40, B: 90, A: uint8(x * 255 / w)})
		}
	}
	var buf bytes.Buffer
	if err := heic.Encode(&buf, img, heic.EncodeOptions{Quality: 60, Tile: tile}); err != nil {
		t.Fatalf("heic.Encode: %v", err)
	}
	if !bytes.Contains(buf.Bytes(), []byte("auxl")) {
		t.Fatal("the encoder wrote no alpha plane")
	}
	return buf.Bytes()
}

// readLog records the ranges the decoder reads from the file.
type readLog struct {
	*bytes.Reader
	mu    sync.Mutex
	reads [][2]uint64
}

func (r *readLog) ReadAt(p []byte, off int64) (int, error) {
	r.mu.Lock()
	r.reads = append(r.reads, [2]uint64{uint64(off), uint64(len(p))}) //nolint:gosec // test offsets are small
	r.mu.Unlock()
	return r.Reader.ReadAt(p, off)
}

// structureReads are the ranges the decoder may read that hold no item data:
// each top-level box's header, and the payload of ftyp and meta.
func structureReads(t *testing.T, b []byte) map[[2]uint64]bool {
	t.Helper()
	out := map[[2]uint64]bool{}
	for off := uint64(0); off+8 <= uint64(len(b)); {
		size, hdr := uint64(binary.BigEndian.Uint32(b[off:])), uint64(8)
		if size == 1 {
			size, hdr = binary.BigEndian.Uint64(b[off+8:]), 16
			out[[2]uint64{off + 8, 8}] = true
		}
		if size == 0 {
			size = uint64(len(b)) - off
		}
		if size < hdr {
			t.Fatalf("malformed box at %d", off)
		}
		out[[2]uint64{off, 8}] = true
		if typ := string(b[off+4 : off+8]); typ == "ftyp" || typ == "meta" {
			out[[2]uint64{off + hdr, size - hdr}] = true
		}
		off += size
	}
	return out
}

// hvccPictures decodes one coded item's data with its decoder configuration
// and returns how many pictures the decoder produces.
func hvccPictures(t *testing.T, cfg, data []byte) int {
	t.Helper()
	if len(cfg) < 23 {
		t.Fatal("short decoder configuration")
	}
	var d hevc.Decoder
	feed := func(u hevc.NALUnit) int {
		pics, err := d.DecodeNAL(u)
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		for _, p := range pics {
			p.Release()
		}
		return len(pics)
	}
	n, rest := 0, cfg[23:]
	for range int(cfg[22]) {
		count := int(binary.BigEndian.Uint16(rest[1:]))
		rest = rest[3:]
		for range count {
			l := int(binary.BigEndian.Uint16(rest))
			u, ok := hevc.ParseNAL(rest[2 : 2+l])
			if !ok {
				t.Fatal("parameter set")
			}
			n += feed(u)
			rest = rest[2+l:]
		}
	}
	for _, u := range hevc.SplitHVCC(data, int(cfg[21]&3)+1) {
		n += feed(u)
	}
	return n + len(d.Flush())
}

func itemBytes(b []byte, it api.HEICItemForTest) []byte {
	var out []byte
	for _, e := range it.Extents {
		out = append(out, b[e[0]:e[0]+e[1]]...)
	}
	return out
}

// TestHEICLayout_EveryDecodedItemIsCounted decodes every layout the check
// accepts and compares what the decoder reads with what the check walked:
// every item data range it reads belongs to a grid or coded item the check
// counted, it reads each coded item exactly once, and each holds exactly one
// picture, so the decoder makes as many pictures as the check counted.
func TestHEICLayout_EveryDecodedItemIsCounted(t *testing.T) {
	files := map[string][]byte{
		"plain still":              plainLayout(t).build(),
		"grid":                     gridLayout(t, 1, 2, 32, 16).build(),
		"phone layout":             appleLayout(t).build(),
		"encoder-made still":       testHEIC(t, 16, 16),
		"encoder-made grid":        testHEICTiled(t, 130, 70),
		"encoder-made alpha":       translucentHEIC(t, 40, 24, 0),
		"encoder-made tiled alpha": translucentHEIC(t, 130, 70, 64),
		"still with an alpha grid": stillWithAlphaGrid(t, 32, 1),
	}
	for name, l := range alphaLayouts(t) {
		files[name] = l.build()
	}
	for name, b := range files {
		t.Run(name, func(t *testing.T) {
			grids, coded, err := api.HEICPlanForTest(bytes.NewReader(b), int64(len(b)))
			if err != nil {
				t.Fatalf("the check refused it: %v", err)
			}
			log := &readLog{Reader: bytes.NewReader(b)}
			if _, err := heic.Decode(log, heic.Options{AutoRotate: true, Threads: 1}); err != nil {
				t.Fatalf("decode: %v", err)
			}
			allowed := structureReads(t, b)
			for _, g := range grids {
				for _, e := range g.Extents {
					allowed[e] = true
				}
			}
			want := map[[2]uint64]int{}
			for _, c := range coded {
				for _, e := range c.Extents {
					want[e]++
				}
				if n := hvccPictures(t, c.HvcC, itemBytes(b, c)); n != 1 {
					t.Errorf("coded item %d holds %d pictures", c.ID, n)
				}
			}
			got := map[[2]uint64]int{}
			for _, r := range log.reads {
				switch {
				case want[r] > 0:
					got[r]++
				case !allowed[r]:
					t.Errorf("the decoder read %v, which the check did not count", r)
				}
			}
			for e, n := range want {
				if got[e] != n {
					t.Errorf("extent %v: read %d times, counted %d", e, got[e], n)
				}
			}
		})
	}
}
