package api_test

import (
	"bytes"
	"encoding/binary"
	"image"
	"net/http"
	"runtime"
	"testing"

	"github.com/J3vb/OwnCord/Server/api"
	"github.com/J3vb/OwnCord/Server/storage"
	"github.com/gen2brain/h265/heic"
)

// hitem is an entry of a HEIC's item list.
type hitem struct {
	id  uint16
	typ string
}

// hlayout is a HEIC built from its parts, so a test can change one part of the
// plain still-image layout. The file is ftyp, mdat, meta: the item data comes
// before the boxes that point at it, so no offset depends on their size.
type hlayout struct {
	data    []byte                      // the mdat payload
	items   []hitem                     // infe entries
	iloc    func(dataOff uint32) []byte // the whole iloc box
	props   [][]byte                    // whole property boxes, in ipco order
	ipma    []byte                      // the whole ipma box
	iref    []byte                      // the whole iref box, or nil
	idat    []byte                      // the body of an idat box, or nil
	primary uint16
	extra   [][]byte // further top-level boxes, after meta
	inMeta  [][]byte // further boxes inside meta
}

func u16(v int) []byte { return binary.BigEndian.AppendUint16(nil, uint16(v)) }

// ilocV0 is a version 0 iloc with 4-byte offsets and lengths: {id, offset, length} each.
func ilocV0(entries ...[3]uint32) func(uint32) []byte {
	return func(dataOff uint32) []byte {
		body := append(be32(0), 0x44, 0x00)
		body = append(body, u16(len(entries))...)
		for _, e := range entries {
			body = append(body, u16(int(e[0]))...)
			body = append(body, u16(0)...) // data reference
			body = append(body, u16(1)...) // one extent
			body = append(body, be32(dataOff+e[1])...)
			body = append(body, be32(e[2])...)
		}
		return isoBox("iloc", body)
	}
}

func ipmaV0(entries ...[]int) []byte { // each: item id, then its property indices
	body := append(be32(0), be32(uint32(len(entries)))...)
	for _, e := range entries {
		body = append(body, u16(e[0])...)
		body = append(body, byte(len(e)-1))
		for _, i := range e[1:] {
			body = append(body, byte(i))
		}
	}
	return isoBox("ipma", body)
}

func infeBox(id uint16, typ string) []byte {
	return isoBox("infe", []byte{2, 0, 0, 0}, u16(int(id)), u16(0), []byte(typ), []byte{0})
}

// plainLayout is the plain one-picture still, built from an encoded 16x16 image.
func plainLayout(t *testing.T) hlayout {
	t.Helper()
	still := testHEIC(t, 16, 16)
	data := boxOf(t, still, "mdat")[8:]
	return hlayout{
		data:    bytes.Clone(data),
		items:   []hitem{{1, "hvc1"}},
		iloc:    ilocV0([3]uint32{1, 0, uint32(len(data))}),
		props:   [][]byte{boxOf(t, still, "ispe"), boxOf(t, still, "hvcC")},
		ipma:    ipmaV0([]int{1, 1, 2}),
		primary: 1,
	}
}

func auxC(urn string) []byte {
	return isoBox("auxC", be32(0), append([]byte(urn), 0))
}

// ilocV1 is a version 1 iloc with 4-byte offsets and lengths: {id, method,
// offset, length} each. An offset is in the file (method 0) or in the idat body (1).
func ilocV1(entries ...[4]uint32) func(uint32) []byte {
	return func(dataOff uint32) []byte {
		body := append(be32(1<<24), 0x44, 0x00)
		body = append(body, u16(len(entries))...)
		for _, e := range entries {
			body = append(body, u16(int(e[0]))...)
			body = append(body, u16(int(e[1]))...)
			body = append(body, u16(0)...)
			body = append(body, u16(1)...)
			off := e[2]
			if e[1] == 0 {
				off += dataOff
			}
			body = append(body, be32(off)...)
			body = append(body, be32(e[3])...)
		}
		return isoBox("iloc", body)
	}
}

func (l hlayout) build() []byte {
	ftyp := isoBox("ftyp", []byte("heic"), be32(0), []byte("mif1heic"))
	mdat := isoBox("mdat", l.data)
	var iinf []byte
	for _, it := range l.items {
		iinf = append(iinf, infeBox(it.id, it.typ)...)
	}
	iinfBox := isoBox("iinf", be32(0), u16(len(l.items)), iinf)
	iprp := isoBox("iprp", isoBox("ipco", l.props...), l.ipma)
	parts := [][]byte{be32(0), isoBox("pitm", be32(0), u16(int(l.primary))), iinfBox, l.iloc(uint32(len(ftyp) + 8)), iprp}
	if l.iref != nil {
		parts = append(parts, l.iref)
	}
	if l.idat != nil {
		parts = append(parts, isoBox("idat", l.idat))
	}
	parts = append(parts, l.inMeta...)
	out := append(bytes.Clone(ftyp), mdat...)
	out = append(out, isoBox("meta", parts...)...)
	for _, x := range l.extra {
		out = append(out, x...)
	}
	return out
}

// gridLayout is a rows x cols grid of 16x16 tiles, each with its own copy of
// the picture data, and the grid's descriptor after them in mdat.
func gridLayout(t *testing.T, rows, cols int, canvasW, canvasH int) hlayout {
	t.Helper()
	l := plainLayout(t)
	tile := l.data
	n := rows * cols
	l.data = nil
	var entries [][3]uint32
	l.items = nil
	var to []byte
	var ids []int
	for i := range n {
		l.data = append(l.data, tile...)
		id := i + 1
		l.items = append(l.items, hitem{uint16(id), "hvc1"})
		entries = append(entries, [3]uint32{uint32(id), uint32(i * len(tile)), uint32(len(tile))})
		to = append(to, u16(id)...)
		ids = append(ids, id)
	}
	gridID := n + 1
	desc := []byte{0, 0, byte(rows - 1), byte(cols - 1)}
	desc = append(desc, u16(canvasW)...)
	desc = append(desc, u16(canvasH)...)
	entries = append(entries, [3]uint32{uint32(gridID), uint32(len(l.data)), uint32(len(desc))})
	l.data = append(l.data, desc...)
	l.items = append(l.items, hitem{uint16(gridID), "grid"})
	l.iloc = ilocV0(entries...)
	l.iref = isoBox("iref", be32(0), isoBox("dimg", u16(gridID), u16(n), to))
	l.props = append(l.props, isoBox("ispe", be32(0), be32(uint32(canvasW)), be32(uint32(canvasH))))
	assoc := [][]int{}
	for _, id := range ids {
		assoc = append(assoc, []int{id, 1, 2})
	}
	assoc = append(assoc, []int{gridID, 3})
	l.ipma = ipmaV0(assoc...)
	l.primary = uint16(gridID)
	return l
}

// appleLayout is the layout a phone writes: a grid primary whose descriptor
// is in the idat box (construction method 1), hvc1 tiles, and items that are
// never decoded: Exif, a tone map, a thumbnail (thmb) and an auxiliary image
// that is not alpha (a gain map), the last two with properties outside the
// allowed set.
func appleLayout(t *testing.T) hlayout {
	t.Helper()
	l := gridLayout(t, 1, 2, 32, 16)
	tile := l.data[:len(l.data)-8]
	oneTile := len(tile) / 2
	desc := bytes.Clone(l.data[len(l.data)-8:])
	l.idat = desc
	// iloc: tiles 1, 2 and the extra images in the file body; the grid (3) in idat.
	entries := [][4]uint32{{1, 0, 0, uint32(oneTile)}, {2, 0, uint32(oneTile), uint32(oneTile)}, {3, 1, 0, 8}}
	l.data = bytes.Clone(tile)
	add := func(id uint32, data []byte) {
		entries = append(entries, [4]uint32{id, 0, uint32(len(l.data)), uint32(len(data))})
		l.data = append(l.data, data...)
	}
	add(20, []byte("Exif\x00\x00MM\x00*\x00\x00\x00\x08\x00\x00"))
	add(21, tile[:oneTile]) // a thumbnail
	add(23, tile[:oneTile]) // a gain map
	l.iloc = ilocV1(entries...)
	l.items = append(l.items, hitem{20, "Exif"}, hitem{21, "hvc1"}, hitem{22, "tmap"}, hitem{23, "hvc1"})
	l.props = append(l.props,
		isoBox("clli", be32(0)),                         // 4: not an allowed property
		isoBox("mdcv", make([]byte, 24)),                // 5
		auxC("urn:com:apple:photo:2020:aux:hdrgainmap")) // 6
	// Items 21 and 23 are small images; their ispe must not matter: they are not decoded.
	l.ipma = ipmaV0([]int{1, 1, 2}, []int{2, 1, 2}, []int{3, 3}, []int{21, 1, 2, 4, 5}, []int{22, 4}, []int{23, 1, 2, 6, 4})
	l.iref = isoBox("iref", be32(0),
		isoBox("dimg", u16(3), u16(2), append(u16(1), u16(2)...)),
		isoBox("thmb", u16(21), u16(1), u16(3)),
		isoBox("auxl", u16(23), u16(1), u16(3)),
		isoBox("cdsc", u16(20), u16(1), u16(3)))
	return l
}

// heicRefused uploads content and asserts that it is stored without
// dimensions, that its preview is a 404 once with the empty marker kept, and
// that nothing of the original is served in its place.
func heicRefused(t *testing.T, content []byte) {
	t.Helper()
	database := newUploadTestDB(t)
	dir := t.TempDir()
	store, err := storage.New(dir, 10)
	if err != nil {
		t.Fatal(err)
	}
	router := buildUploadRouter(database, store, nil)
	token := uploadCreateToken(t, database, "heicrefused", 4)
	id, mime, w, h := uploadFull(t, router, token, "x.heic", content)
	if mime != "image/heic" || w != 0 || h != 0 {
		t.Errorf("upload: %s %dx%d, want image/heic with no dimensions", mime, w, h)
	}
	for range 2 {
		rr := doServeThumb(t, router, id, token)
		if rr.Code != http.StatusNotFound {
			t.Fatalf("preview: %d, want 404", rr.Code)
		}
	}
	marker, err := store.OpenThumb(id)
	if err != nil {
		t.Fatalf("the refusal was not kept: %v", err)
	}
	defer marker.Close() //nolint:errcheck
	if info, err := marker.Stat(); err != nil || info.Size() != 0 {
		t.Fatalf("kept marker: %v, %v", info, err)
	}
}

func TestHEICLayout_PlainStillAndGridConvert(t *testing.T) {
	for name, content := range map[string][]byte{
		"hand-built still":  plainLayout(t).build(),
		"hand-built grid":   gridLayout(t, 1, 2, 32, 16).build(),
		"phone layout":      appleLayout(t).build(),
		"encoder-made grid": testHEICTiled(t, 130, 70),
	} {
		t.Run(name, func(t *testing.T) {
			database := newUploadTestDB(t)
			router := buildUploadRouter(database, newUploadTestStorage(t), nil)
			token := uploadCreateToken(t, database, "heicok", 4)
			id, mime, w, h := uploadFull(t, router, token, "x.heic", content)
			if mime != "image/heic" || w == 0 || h == 0 {
				t.Fatalf("upload: %s %dx%d", mime, w, h)
			}
			rr := doServeThumb(t, router, id, token)
			assertPreviewJPEG(t, rr, w, h)
		})
	}
}

func testHEICTiled(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := heic.Encode(&buf, image.Image(solidImage(w, h)), heic.EncodeOptions{Quality: 60, Tile: 64}); err != nil {
		t.Fatalf("heic.Encode: %v", err)
	}
	if !bytes.Contains(buf.Bytes(), []byte("grid")) {
		t.Fatal("the encoder made no grid")
	}
	return buf.Bytes()
}

func TestHEICLayout_Refusals(t *testing.T) {
	plain := func() hlayout { return plainLayout(t) }
	// extraExtents is an iloc whose item 1 lists n extents over the same data.
	extents := func(n int) func(uint32) []byte {
		return func(off uint32) []byte {
			l := plain()
			body := append(be32(0), 0x44, 0x00)
			body = append(body, u16(1)...)
			body = append(body, u16(1)...)
			body = append(body, u16(0)...)
			body = append(body, u16(n)...)
			for range n {
				body = append(body, be32(off)...)
				body = append(body, be32(uint32(len(l.data)))...)
			}
			return isoBox("iloc", body)
		}
	}
	cases := map[string]func() []byte{
		"a movie box after the picture": func() []byte {
			l := plain()
			l.extra = [][]byte{isoBox("moov")}
			return l.build()
		},
		"a movie fragment box": func() []byte {
			l := plain()
			l.extra = [][]byte{isoBox("moof")}
			return l.build()
		},
		"a primary item that is not a coded image": func() []byte {
			l := plain()
			l.items = []hitem{{1, "iovl"}}
			return l.build()
		},
		"an alpha item of a type the layout does not allow": func() []byte {
			l := plain()
			l.items = append(l.items, hitem{2, "hvc2"})
			l.props = append(l.props, auxC("urn:mpeg:mpegB:cicp:systems:auxiliary:alpha"))
			l.ipma = ipmaV0([]int{1, 1, 2}, []int{2, 3})
			l.iref = isoBox("iref", be32(0), isoBox("auxl", u16(2), u16(1), u16(1)))
			return l.build()
		},
		"a coded image whose data is in the idat box": func() []byte {
			l := plain()
			l.idat = l.data
			l.iloc = ilocV1([4]uint32{1, 1, 0, uint32(len(l.data))})
			return l.build()
		},
		"a grid descriptor that runs past the idat box": func() []byte {
			l := appleLayout(t)
			l.idat = l.idat[:5]
			return l.build()
		},
		"a second idat box": func() []byte {
			l := appleLayout(t)
			l.inMeta = [][]byte{isoBox("idat", l.idat)}
			return l.build()
		},
		"an essential association to a property that does not exist": func() []byte {
			l := plain()
			l.ipma = ipmaV0([]int{1, 1, 2, 0x80 | 0x7f})
			return l.build()
		},
		"an association to a property outside the allowed set": func() []byte {
			l := plain()
			l.props = append(l.props, isoBox("rloc", be32(0), be32(0), be32(0)))
			l.ipma = ipmaV0([]int{1, 1, 2, 3})
			return l.build()
		},
		"a repeated item in the item list": func() []byte {
			l := plain()
			l.items = append(l.items, hitem{1, "Exif"})
			return l.build()
		},
		"a repeated item in the locations": func() []byte {
			l := plain()
			n := uint32(len(l.data))
			l.iloc = ilocV0([3]uint32{1, 0, n}, [3]uint32{1, 0, n})
			return l.build()
		},
		"a repeated item in the associations": func() []byte {
			l := plain()
			l.ipma = ipmaV0([]int{1, 1, 2}, []int{1, 1, 2})
			return l.build()
		},
		"a uuid box among the properties": func() []byte {
			l := plain()
			l.props = append([][]byte{isoBox("uuid", make([]byte, 16))}, l.props...)
			return l.build()
		},
		"more items than the layout allows": func() []byte {
			l := plain()
			for i := 2; i < 5000; i++ {
				l.items = append(l.items, hitem{uint16(i), "Exif"})
			}
			return l.build()
		},
		"locations with zero-size fields": func() []byte {
			l := plain()
			l.iloc = func(uint32) []byte {
				body := []byte{1, 0, 0, 0, 0x00, 0x00, 0, 200}
				for i := range 200 {
					body = append(body, u16(i+1)...)
					body = append(body, 0, 0, 0, 0, 0xff, 0xff)
				}
				return isoBox("iloc", body)
			}
			return l.build()
		},
		"more extents than the layout allows": func() []byte { l := plain(); l.iloc = extents(65); return l.build() },
		"item data in a construction method the layout does not allow": func() []byte {
			l := plain()
			l.iloc = func(uint32) []byte {
				body := []byte{1, 0, 0, 0, 0x44, 0x00, 0, 1, 0, 1, 0, 2, 0, 0, 0, 1}
				body = append(body, be32(0)...)
				body = append(body, be32(8)...)
				return isoBox("iloc", body)
			}
			return l.build()
		},
		"slice units on a layer above the base layer": func() []byte {
			l := plain()
			for p := 0; p+4 < len(l.data); {
				n := int(binary.BigEndian.Uint32(l.data[p:]))
				l.data[p+4] |= 0x01
				p += 4 + n
			}
			return l.build()
		},
		"several pictures in one coded image": func() []byte {
			l := plain()
			l.data = bytes.Repeat(l.data, 3)
			l.iloc = ilocV0([3]uint32{1, 0, uint32(len(l.data))})
			return l.build()
		},
		"a parameter set inside the item data": func() []byte {
			l := plain()
			sps := []byte{0, 0, 0, 4, 0x42, 0x01, 0xAA, 0xBB}
			l.data = append(sps, l.data...)
			l.iloc = ilocV0([3]uint32{1, 0, uint32(len(l.data))})
			return l.build()
		},
		"a grid that repeats one tile": func() []byte {
			l := gridLayout(t, 2, 2, 32, 32)
			l.iref = isoBox("iref", be32(0), isoBox("dimg", u16(5), u16(4), bytes.Repeat(u16(1), 4)))
			return l.build()
		},
		"a grid whose tiles are smaller than its cells": func() []byte {
			return gridLayout(t, 1, 2, 80, 16).build()
		},
		"a grid whose tile list does not match its rows and columns": func() []byte {
			l := gridLayout(t, 1, 2, 32, 16)
			l.iref = isoBox("iref", be32(0), isoBox("dimg", u16(3), u16(1), u16(1)))
			return l.build()
		},
		"a grid with more tiles than allowed": func() []byte {
			l := gridLayout(t, 1, 2, 32, 16)
			l.iref = isoBox("iref", be32(0), isoBox("dimg", u16(3), u16(1100), bytes.Repeat(u16(1), 1100)))
			return l.build()
		},
		"a grid larger than the pixel bound": func() []byte {
			return gridLayout(t, 1, 2, 30000, 30000).build()
		},
		"a grid without tiles": func() []byte {
			l := gridLayout(t, 1, 2, 32, 16)
			l.iref = nil
			return l.build()
		},
		"an image sequence with no primary item": func() []byte { return sequenceOnlyHEIC(t, 3) },
		"a truncated file":                       func() []byte { b := plain().build(); return b[:len(b)/2] },
	}
	for name, build := range cases {
		t.Run(name, func(t *testing.T) {
			heicRefused(t, build())
		})
	}
}

func TestValidateHEIC_NeverPanicsOnMutations(t *testing.T) {
	base := plainLayout(t).build()
	for i := range base {
		for _, v := range []byte{0x00, 0xff, 0x7f} {
			c := bytes.Clone(base)
			c[i] = v
			_, _ = api.ValidateHEICForTest(bytes.NewReader(c), int64(len(c)))
		}
	}
}

// FuzzValidateHEIC: any input is accepted or refused without a panic, and the
// check allocates no more than a small multiple of the input.
func FuzzValidateHEIC(f *testing.F) {
	t := &testing.T{}
	f.Add(plainLayout(t).build())
	f.Add(gridLayout(t, 1, 2, 32, 16).build())
	f.Add(appleLayout(t).build())
	f.Add(testHEIC(t, 16, 16))
	f.Add(sequenceOnlyHEIC(t, 2))
	f.Add([]byte("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic"))
	f.Fuzz(func(t *testing.T, data []byte) {
		var before, after runtime.MemStats
		runtime.ReadMemStats(&before)
		_, _ = api.ValidateHEICForTest(bytes.NewReader(data), int64(len(data)))
		runtime.ReadMemStats(&after)
		if got, budget := after.TotalAlloc-before.TotalAlloc, uint64(1<<20+100*len(data)); got > budget {
			t.Fatalf("allocated %d bytes for a %d byte input, budget %d", got, len(data), budget)
		}
	})
}
