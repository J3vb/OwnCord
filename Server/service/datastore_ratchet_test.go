package service

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// Baselines for the two ratchets in this file. Both are exact pins, not
// ceilings: a change in either direction fails until the constant is edited,
// so a shrink has to lower the pin in the same change and a growth has to be
// argued for in review.
//
// To lower a pin: shrink the surface, run the test, and set the constant to
// the "got" value it reports. To raise one, do not; move the new method behind
// a small slice interface the new service declares, or put the new response
// type in api or service rather than db/models.go.
const (
	// storeMethodBaseline is the number of distinct methods in Store, counting
	// transitively through embedded interfaces declared in this package (each
	// service's own interface, and the slices those embed). Methods promoted
	// from the cross-package embeds in storeCrossPackageEmbeds are not counted
	// here.
	//
	// Store is the union of what the services call, so this only moves when a
	// service starts or stops calling a method. It was 309 while Store listed
	// its methods itself; it fell to 288 when each service declared its own
	// interface and the methods no service calls left Store.
	storeMethodBaseline = 288

	// modelsJSONTagBaseline is the number of struct fields in db/models.go
	// whose tag carries a json: key, json:"-" included.
	//
	// 16 of these were added after the 2026-10-10 architecture audit
	// (113 tags) and are accepted debt: 3D-5b (113 to 114), 3B-9a (114 to 120)
	// 3B-10a (120 to 124), 6.10a (124 to 125, channels.afk), 6.9a (125 to 126,
	// MessageAPIResponse.Forward). The 6.9a tag is unavoidable: the history row
	// is this struct and its forward block is a field of it. ForwardInfo and
	// ForwardRow live in db/message_forwards.go, outside the count, and Store
	// did not grow (ForwardStore is a slice interface in service). 6.5a adds
	// two (126 to 128): Channel.CategoryID and Channel.CategoryPosition, which
	// the admin channel list and the create/PATCH responses serialize straight
	// from this struct. ChannelCategory lives in db/category_queries.go,
	// outside the count, and Store did not grow (CategoryStore is a slice
	// interface in service). 6.9b adds one (128 to 129):
	// MessageAPIResponse.Poll, for the same reason as 6.9a's. The poll types
	// live in db/polls.go and PollStore is a slice interface in service.
	// 6.9c-a1 adds one (129 to 130): Channel.Thread, json:"-", a single
	// nested struct so the thread columns stay off the wire; ChannelThread
	// lives in db/channel_thread.go, outside the count. 6.9d-a1 adds one (130
	// to 131): Channel.Forum, a pointer set on a forum row only so the admin
	// channel list and the create and PUT responses carry the forum's settings
	// and tags straight from this struct. ChannelForum and ForumTag live in
	// db/channel_forum.go, outside the count, and Store did not grow
	// (ForumStore is a slice interface in service).
	// 6.9c-a2 adds one (131 to 132): MessageAPIResponse.Thread, the optional
	// thread summary on a starter message. 6.3c moves db.Role out of models.go
	// into db/role_model.go (its six tags leave the count; it also gains the
	// two hoist/mentionable wire tags, outside it), 132 to 126. 8.8a adds two
	// (126 to 128): MessageAPIResponse.Sticker and MessageSearchResult.Sticker,
	// the optional sticker block on history rows and search hits, for the same
	// reason as 6.9a's. MessageStickerInfo lives in db/stickers.go, outside the
	// count.
	// WP 8.9 gives AttachmentInfo two voice message tags and moves it into
	// db/attachment_model.go (models.go hit its line limit), so its tags
	// leave the count: 128 to 121. Any further tag fails.
	modelsJSONTagBaseline = 121

	// storeFullSurfaceBaseline is the compiler's own method count for Store,
	// promoted methods from the cross-package embeds included. It closes the
	// gap the source count leaves for growth inside a cross-package embed.
	storeFullSurfaceBaseline = 299
)

// storeCrossPackageEmbeds names every interface embedded in Store that is
// declared in another package, with the reason it is there. Their methods are
// outside the same-package count, so a new cross-package embed must be added
// here deliberately.
var storeCrossPackageEmbeds = map[string]string{
	"auth.SecondFactorPersister": "durable second-factor state; stdlib types only because auth cannot import db",
	"db.Auditor":                 "the audit write db.WriteAudit takes",
	"db.EntryAuditor":            "the whole-entry audit write db.WriteAuditEntry takes",
	"permissions.DB":             "the override and timeout reads permissions.NewChecker takes",
}

// storeSurface is the result of counting one interface.
type storeSurface struct {
	direct       int      // methods written in the interface body itself
	transitive   int      // distinct methods including same-package embeds
	crossPackage []string // embeds declared in another package, sorted
}

// measureInterface counts the methods of the interface named root across the
// given sources (file name to source text), all treated as one package.
func measureInterface(root string, sources map[string]string) (storeSurface, error) {
	fset := token.NewFileSet()
	ifaces := map[string]*ast.InterfaceType{}
	names := make([]string, 0, len(sources))
	for name := range sources {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		f, err := parser.ParseFile(fset, name, sources[name], parser.SkipObjectResolution)
		if err != nil {
			return storeSurface{}, fmt.Errorf("parse %s: %w", name, err)
		}
		for _, d := range f.Decls {
			gd, ok := d.(*ast.GenDecl)
			if !ok || gd.Tok != token.TYPE {
				continue
			}
			for _, s := range gd.Specs {
				ts, ok := s.(*ast.TypeSpec)
				if !ok {
					continue
				}
				if it, ok := ts.Type.(*ast.InterfaceType); ok {
					ifaces[ts.Name.Name] = it
				}
			}
		}
	}
	top, ok := ifaces[root]
	if !ok {
		return storeSurface{}, fmt.Errorf("interface %s not found", root)
	}

	var out storeSurface
	methods := map[string]struct{}{}
	cross := map[string]struct{}{}
	visiting := map[string]bool{}
	var walk func(name string, it *ast.InterfaceType, isRoot bool) error
	walk = func(name string, it *ast.InterfaceType, isRoot bool) error {
		if visiting[name] {
			return fmt.Errorf("embed cycle through %s", name)
		}
		visiting[name] = true
		defer delete(visiting, name)
		for _, fld := range it.Methods.List {
			if len(fld.Names) > 0 {
				for _, n := range fld.Names {
					methods[n.Name] = struct{}{}
					if isRoot {
						out.direct++
					}
				}
				continue
			}
			switch t := fld.Type.(type) {
			case *ast.Ident:
				sub, ok := ifaces[t.Name]
				if !ok {
					return fmt.Errorf("%s embeds %s, which is not an interface declared in this package", name, t.Name)
				}
				if err := walk(t.Name, sub, false); err != nil {
					return err
				}
			case *ast.SelectorExpr:
				x, ok := t.X.(*ast.Ident)
				if !ok {
					return fmt.Errorf("%s has an unsupported embed", name)
				}
				cross[x.Name+"."+t.Sel.Name] = struct{}{}
			default:
				return fmt.Errorf("%s has an unsupported embed of type %T", name, fld.Type)
			}
		}
		return nil
	}
	if err := walk(root, top, true); err != nil {
		return storeSurface{}, err
	}
	out.transitive = len(methods)
	for c := range cross {
		out.crossPackage = append(out.crossPackage, c)
	}
	sort.Strings(out.crossPackage)
	return out, nil
}

// countJSONTags returns how many struct fields in src carry a tag with a
// json: key. It inspects field tags, so a comment or a string that merely
// contains the text is not counted, and json:"-" is.
func countJSONTags(src string) (int, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "models.go", src, parser.ParseComments|parser.SkipObjectResolution)
	if err != nil {
		return 0, fmt.Errorf("parse models.go: %w", err)
	}
	n := 0
	var tagErr error
	ast.Inspect(f, func(node ast.Node) bool {
		fld, ok := node.(*ast.Field)
		if !ok || fld.Tag == nil {
			return true
		}
		raw, err := strconv.Unquote(fld.Tag.Value)
		if err != nil {
			tagErr = fmt.Errorf("unquote tag %s: %w", fld.Tag.Value, err)
			return false
		}
		if _, ok := reflect.StructTag(raw).Lookup("json"); ok {
			n++
		}
		return true
	})
	if tagErr != nil {
		return 0, tagErr
	}
	return n, nil
}

// readServerFile reads a file relative to the Server tree. Tests run in the
// package directory, so Server/ is one level up (as in Server/invariants/).
func readServerFile(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(b)
}

func TestStoreMethodRatchet(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read service dir: %v", err)
	}
	sources := map[string]string{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		b, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		sources[name] = string(b)
	}

	got, err := measureInterface("Store", sources)
	if err != nil {
		t.Fatalf("measure Store: %v", err)
	}

	for _, c := range got.crossPackage {
		if _, ok := storeCrossPackageEmbeds[c]; !ok {
			t.Errorf("Store embeds %s from another package; its methods are not counted. Add it to storeCrossPackageEmbeds with a reason, or declare a slice interface instead", c)
		}
	}
	for c := range storeCrossPackageEmbeds {
		found := false
		for _, g := range got.crossPackage {
			if g == c {
				found = true
			}
		}
		if !found {
			t.Errorf("storeCrossPackageEmbeds lists %s but Store no longer embeds it; remove the entry", c)
		}
	}

	if full := reflect.TypeFor[Store]().NumMethod(); full != storeFullSurfaceBaseline {
		t.Errorf("Store has %d methods in total including cross-package embeds, pinned at %d. A method added to an embedded interface from another package grows the surface too; if the surface shrank, set storeFullSurfaceBaseline to %d", full, storeFullSurfaceBaseline, full)
	}

	t.Logf("Store: %d methods written directly, %d including same-package embeds", got.direct, got.transitive)
	if got.transitive != storeMethodBaseline {
		t.Errorf("Store has %d methods (transitive, same package), pinned at %d. A new method belongs on a slice interface the new service declares; if the surface shrank, set storeMethodBaseline to %d", got.transitive, storeMethodBaseline, got.transitive)
	}
}

func TestModelsJSONTagRatchet(t *testing.T) {
	got, err := countJSONTags(readServerFile(t, "db/models.go"))
	if err != nil {
		t.Fatalf("count tags: %v", err)
	}
	if got != modelsJSONTagBaseline {
		t.Errorf("db/models.go has %d json: tags, pinned at %d. New REST response types live in api or service, not db/models.go; if tags were removed, set modelsJSONTagBaseline to %d", got, modelsJSONTagBaseline, got)
	}
}

func TestMeasureInterface(t *testing.T) {
	const store = `package p
type Store interface {
	Inner
	Other
	pkg.Ext
	A(x int) error
	B() (n int, err error)
}
`
	cases := []struct {
		name    string
		sources map[string]string
		direct  int
		trans   int
		cross   []string
		wantErr bool
	}{
		{"direct methods only", map[string]string{"s.go": "package p\ntype Store interface {\n\tA()\n\tB()\n}\n"}, 2, 2, nil, false},
		{"embedded interface is counted", map[string]string{
			"s.go": store,
			"i.go": "package p\ntype Inner interface {\n\tC()\n\tD()\n}\ntype Other interface{ E() }\n",
		}, 2, 5, []string{"pkg.Ext"}, false},
		{"a new method on the embedded interface is counted", map[string]string{
			"s.go": store,
			"i.go": "package p\ntype Inner interface {\n\tC()\n\tD()\n\tNew()\n}\ntype Other interface{ E() }\n",
		}, 2, 6, []string{"pkg.Ext"}, false},
		{"a new method on Store is counted", map[string]string{
			"s.go": "package p\ntype Store interface {\n\tA()\n\tB()\n\tNew()\n}\n",
		}, 3, 3, nil, false},
		{"an overlapping method counts once", map[string]string{
			"s.go": "package p\ntype Store interface {\n\tInner\n\tC()\n}\ntype Inner interface{ C() }\n",
		}, 1, 1, nil, false},
		{"an unknown local embed is an error", map[string]string{
			"s.go": "package p\ntype Store interface {\n\tMissing\n}\n",
		}, 0, 0, nil, true},
		{"an embed cycle is an error", map[string]string{
			"s.go": "package p\ntype Store interface{ Inner }\ntype Inner interface{ Store }\n",
		}, 0, 0, nil, true},
		{"a missing root is an error", map[string]string{"s.go": "package p\ntype Other interface{ A() }\n"}, 0, 0, nil, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := measureInterface("Store", tc.sources)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want an error, got %+v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("measureInterface: %v", err)
			}
			if got.direct != tc.direct || got.transitive != tc.trans {
				t.Fatalf("direct/transitive = %d/%d, want %d/%d", got.direct, got.transitive, tc.direct, tc.trans)
			}
			if strings.Join(got.crossPackage, ",") != strings.Join(tc.cross, ",") {
				t.Fatalf("crossPackage = %v, want %v", got.crossPackage, tc.cross)
			}
		})
	}
}

func TestCountJSONTags(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want int
	}{
		{"no tags", "package p\ntype T struct{ A int }\n", 0},
		{"one json tag", "package p\ntype T struct {\n\tA int `json:\"a\"`\n}\n", 1},
		{"json dash is counted", "package p\ntype T struct {\n\tA int `json:\"-\"`\n}\n", 1},
		{"json with options is counted once", "package p\ntype T struct {\n\tA int `json:\"a,omitempty\" db:\"a\"`\n}\n", 1},
		{"a key that merely ends in json is not counted", "package p\ntype T struct {\n\tA int `myjson:\"a\"`\n}\n", 0},
		{"a non-json tag is not counted", "package p\ntype T struct {\n\tA int `db:\"a\"`\n}\n", 0},
		{"a comment containing json: is not counted", "package p\n// A is tagged json:\"a\" elsewhere.\ntype T struct {\n\t// json:\"b\" would be wrong here\n\tA int // json:\"c\"\n}\n", 0},
		{"a string literal containing json: is not counted", "package p\nvar s = `json:\"a\"`\ntype T struct{ A int }\n", 0},
		{"several structs", "package p\ntype T struct {\n\tA int `json:\"a\"`\n\tB int `json:\"b\"`\n}\ntype U struct {\n\tC int `json:\"-\"`\n}\n", 3},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := countJSONTags(tc.src)
			if err != nil {
				t.Fatalf("countJSONTags: %v", err)
			}
			if got != tc.want {
				t.Fatalf("tags = %d, want %d", got, tc.want)
			}
		})
	}
}
