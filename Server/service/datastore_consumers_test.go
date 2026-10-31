package service

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// storeConsumersAllowed is every production declaration allowed to take the
// whole Store. New builds every service, so it needs the union; everything
// else takes the interface its own type declares.
var storeConsumersAllowed = map[string]bool{
	"func New": true,
}

// serviceStoreBaselines pins how many methods a standalone fake for each
// service needs: the method count of the type of its st field, promoted methods
// included. Exact pins, like the ratchets in datastore_ratchet_test.go: a
// shrink lowers the number in the same change, and a growth is argued for in
// review. Lower one when a service stops calling a method; never raise one to
// fit a new feature without asking whether the call belongs in another service.
// MessageService is pinned by part: its write path (st) and the three parts it
// embeds, each with its own st.
var serviceStoreBaselines = map[reflect.Type]int{
	reflect.TypeFor[AppealService]():         11,
	reflect.TypeFor[AuthService]():           55,
	reflect.TypeFor[BlockService]():          4,
	reflect.TypeFor[CallLogService]():        13,
	reflect.TypeFor[ChannelService]():        32,
	reflect.TypeFor[ConnWrites]():            4,
	reflect.TypeFor[DMService]():             23,
	reflect.TypeFor[GIFFavoriteService]():    3,
	reflect.TypeFor[InviteService]():         6,
	reflect.TypeFor[MessageRequestService](): 7,
	reflect.TypeFor[MessageService]():        27,
	reflect.TypeFor[messageReads]():          17,
	reflect.TypeFor[mentionState]():          18,
	reflect.TypeFor[dmDelivery]():            7,
	reflect.TypeFor[ModerationService]():     24,
	reflect.TypeFor[NSFWService]():           8,
	reflect.TypeFor[PermissionService]():     4,
	reflect.TypeFor[PushDispatcher]():        11,
	reflect.TypeFor[PushService]():           4,
	reflect.TypeFor[ReportService]():         18,
	reflect.TypeFor[RoleService]():           11,
	reflect.TypeFor[SessionService]():        9,
	reflect.TypeFor[SettingsService]():       9,
	reflect.TypeFor[SetupService]():          9,
	reflect.TypeFor[ThreadService]():         7,
	reflect.TypeFor[TokenService]():          7,
	reflect.TypeFor[UploadService]():         15,
	reflect.TypeFor[UserService]():           23,
	reflect.TypeFor[VoiceService]():          18,
	reflect.TypeFor[WelcomeService]():        4,
}

// findStoreConsumers returns every parameter, result, struct field and
// variable declared with the type Store across the given sources, as "func
// Name", "type Name" or "var Name".
func findStoreConsumers(sources map[string]string) ([]string, error) {
	fset := token.NewFileSet()
	found := map[string]bool{}
	isStore := func(e ast.Expr) bool {
		id, ok := e.(*ast.Ident)
		return ok && id.Name == "Store"
	}
	names := make([]string, 0, len(sources))
	for name := range sources {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		f, err := parser.ParseFile(fset, name, sources[name], parser.SkipObjectResolution)
		if err != nil {
			return nil, fmt.Errorf("parse %s: %w", name, err)
		}
		for _, d := range f.Decls {
			var owner string
			switch decl := d.(type) {
			case *ast.FuncDecl:
				owner = "func " + decl.Name.Name
				if decl.Recv != nil {
					owner = "func " + recvName(decl.Recv.List[0].Type) + "." + decl.Name.Name
				}
			case *ast.GenDecl:
				for _, s := range decl.Specs {
					switch spec := s.(type) {
					case *ast.TypeSpec:
						if spec.Name.Name == "Store" {
							continue
						}
						if consumes(spec.Type, isStore) {
							found["type "+spec.Name.Name] = true
						}
					case *ast.ValueSpec:
						if spec.Type != nil && consumes(spec.Type, isStore) {
							found["var "+spec.Names[0].Name] = true
						}
					}
				}
				continue
			}
			if consumes(d, isStore) {
				found[owner] = true
			}
		}
	}
	out := make([]string, 0, len(found))
	for k := range found {
		out = append(out, k)
	}
	sort.Strings(out)
	return out, nil
}

// consumes reports whether n mentions this package's Store anywhere a type can
// appear: a field, parameter, result or variable type at any depth ([]Store,
// *Store, map[int]Store, Box[Store]), a type assertion or conversion to Store,
// or a composite literal of it. Declared names and other packages' Store
// (other.Store) do not count.
func consumes(n ast.Node, isStore func(ast.Expr) bool) bool {
	names := map[*ast.Ident]bool{}
	ast.Inspect(n, func(node ast.Node) bool {
		switch x := node.(type) {
		case *ast.Field:
			for _, id := range x.Names {
				names[id] = true
			}
		case *ast.ValueSpec:
			for _, id := range x.Names {
				names[id] = true
			}
		case *ast.FuncDecl:
			names[x.Name] = true
		case *ast.TypeSpec:
			names[x.Name] = true
		case *ast.AssignStmt:
			if x.Tok == token.DEFINE {
				for _, l := range x.Lhs {
					if id, ok := l.(*ast.Ident); ok {
						names[id] = true
					}
				}
			}
		case *ast.KeyValueExpr:
			if id, ok := x.Key.(*ast.Ident); ok {
				names[id] = true
			}
		}
		return true
	})
	hit := false
	ast.Inspect(n, func(node ast.Node) bool {
		if hit {
			return false
		}
		switch x := node.(type) {
		case *ast.SelectorExpr:
			ast.Inspect(x.X, func(inner ast.Node) bool {
				if id, ok := inner.(*ast.Ident); ok && !names[id] && isStore(id) {
					hit = true
				}
				return !hit
			})
			return false
		case *ast.Ident:
			if !names[x] && isStore(x) {
				hit = true
			}
		}
		return !hit
	})
	return hit
}

func recvName(e ast.Expr) string {
	switch x := e.(type) {
	case *ast.StarExpr:
		return recvName(x.X)
	case *ast.IndexExpr:
		return recvName(x.X)
	case *ast.Ident:
		return x.Name
	}
	return "?"
}

func TestStoreConsumers(t *testing.T) {
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
	got, err := findStoreConsumers(sources)
	if err != nil {
		t.Fatalf("find consumers: %v", err)
	}
	seen := map[string]bool{}
	for _, c := range got {
		seen[c] = true
		if !storeConsumersAllowed[c] {
			t.Errorf("%s takes the whole Store. Declare the methods it calls in its own interface beside it (blockStore in block.go is the pattern) and take that instead", c)
		}
	}
	for c := range storeConsumersAllowed {
		if !seen[c] {
			t.Errorf("storeConsumersAllowed lists %s but it no longer takes Store; remove the entry", c)
		}
	}
}

func TestServiceStoreSizes(t *testing.T) {
	services := make([]reflect.Type, 0, len(serviceStoreBaselines))
	for svc := range serviceStoreBaselines {
		services = append(services, svc)
	}
	sort.Slice(services, func(i, j int) bool { return services[i].Name() < services[j].Name() })
	for _, svc := range services {
		want := serviceStoreBaselines[svc]
		f, ok := svc.FieldByName("st")
		if !ok {
			t.Errorf("%s has no st field; point its pin at the field that holds its store", svc.Name())
			continue
		}
		got := f.Type.NumMethod()
		t.Logf("%s: a fake needs %d methods (%s)", svc.Name(), got, f.Type.Name())
		if got != want {
			t.Errorf("%s takes %s with %d methods, pinned at %d. If it shrank, set the pin to %d; if it grew, say why in review", svc.Name(), f.Type.Name(), got, want, got)
		}
	}
}

func TestFindStoreConsumers(t *testing.T) {
	cases := []struct {
		name string
		src  string
		want []string
	}{
		{"a parameter", "package p\nfunc F(st Store) {}\n", []string{"func F"}},
		{"a method parameter", "package p\nfunc (s *S) F(st Store) {}\n", []string{"func S.F"}},
		{"a result", "package p\nfunc F() Store { return nil }\n", []string{"func F"}},
		{"a struct field", "package p\ntype S struct {\n\tst Store\n}\n", []string{"type S"}},
		{"an embedded field", "package p\ntype S struct{ Store }\n", []string{"type S"}},
		{"a package variable", "package p\nvar v Store\n", []string{"var v"}},
		{"a local variable", "package p\nfunc F() {\n\tvar st Store\n\t_ = st\n}\n", []string{"func F"}},
		{"a function literal parameter", "package p\nfunc F() {\n\t_ = func(st Store) {}\n}\n", []string{"func F"}},
		{"the Store declaration itself", "package p\ntype Store interface{ A() }\n", nil},
		{"a narrow interface", "package p\ntype S struct {\n\tst blockStore\n}\nfunc F(st blockStore) {}\n", nil},
		{"a slice field", "package p\ntype S struct {\n\tst []Store\n}\n", []string{"type S"}},
		{"a pointer parameter", "package p\nfunc F(st *Store) {}\n", []string{"func F"}},
		{"a map parameter", "package p\nfunc F(m map[int]Store) {}\n", []string{"func F"}},
		{"a generic argument", "package p\nfunc F(b Box[Store]) {}\n", []string{"func F"}},
		{"a type assertion", "package p\nfunc F(x any) {\n\tst := x.(Store)\n\t_ = st\n}\n", []string{"func F"}},
		{"a conversion", "package p\nfunc F(x blockStore) {\n\t_ = Store(nil)\n}\n", []string{"func F"}},
		{"another package's Store is not ours", "package p\nfunc F(st other.Store) {}\n", nil},
		{"a method named Store is not a consumer", "package p\nfunc F(v *atomic.Bool) {\n\tv.Store(true)\n}\n", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := findStoreConsumers(map[string]string{"s.go": tc.src})
			if err != nil {
				t.Fatalf("findStoreConsumers: %v", err)
			}
			if strings.Join(got, ",") != strings.Join(tc.want, ",") {
				t.Fatalf("consumers = %v, want %v", got, tc.want)
			}
		})
	}
}
