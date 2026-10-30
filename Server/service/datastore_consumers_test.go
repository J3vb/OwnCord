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
// service needs: the method count of the interface it takes, promoted
// methods included. Exact pins, like the ratchets in datastore_ratchet_test.go:
// a shrink lowers the number in the same change, and a growth is argued for in
// review. Lower one when a service stops calling a method; never raise one to
// fit a new feature without asking whether the call belongs in another service.
var serviceStoreBaselines = map[string]struct {
	typ  reflect.Type
	want int
}{
	"AppealService":         {reflect.TypeFor[appealStore](), 11},
	"AuthService":           {reflect.TypeFor[authStore](), 55},
	"BlockService":          {reflect.TypeFor[blockStore](), 4},
	"CallLogService":        {reflect.TypeFor[callLogServiceStore](), 13},
	"ChannelService":        {reflect.TypeFor[channelStore](), 32},
	"ConnWrites":            {reflect.TypeFor[connWritesStore](), 4},
	"DMService":             {reflect.TypeFor[dmStore](), 23},
	"GIFFavoriteService":    {reflect.TypeFor[gifFavoriteStore](), 3},
	"InviteService":         {reflect.TypeFor[inviteStore](), 6},
	"MessageRequestService": {reflect.TypeFor[messageRequestStore](), 7},
	"MessageService":        {reflect.TypeFor[messageStore](), 54},
	"ModerationService":     {reflect.TypeFor[moderationStore](), 24},
	"NSFWService":           {reflect.TypeFor[nsfwStore](), 8},
	"PermissionService":     {reflect.TypeFor[permissionStore](), 4},
	"PushDispatcher":        {reflect.TypeFor[pushDispatchStore](), 11},
	"PushService":           {reflect.TypeFor[pushStore](), 4},
	"ReportService":         {reflect.TypeFor[reportStore](), 18},
	"RoleService":           {reflect.TypeFor[roleStore](), 11},
	"SessionService":        {reflect.TypeFor[sessionStore](), 9},
	"SettingsService":       {reflect.TypeFor[settingsStore](), 9},
	"SetupService":          {reflect.TypeFor[setupStore](), 9},
	"ThreadService":         {reflect.TypeFor[threadServiceStore](), 7},
	"TokenService":          {reflect.TypeFor[tokenStore](), 7},
	"UploadService":         {reflect.TypeFor[uploadStore](), 15},
	"UserService":           {reflect.TypeFor[userStore](), 23},
	"VoiceService":          {reflect.TypeFor[voiceStore](), 18},
	"WelcomeService":        {reflect.TypeFor[welcomeServiceStore](), 4},
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
						if isStore(spec.Type) || consumes(spec.Type, isStore) {
							found["type "+spec.Name.Name] = true
						}
					case *ast.ValueSpec:
						if spec.Type != nil && (isStore(spec.Type) || consumes(spec.Type, isStore)) {
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

// consumes reports whether n declares a field, parameter, result or variable
// whose type is Store, at any depth (function literals and nested structs
// included). A type assertion or conversion to Store is not a declaration and
// does not count.
func consumes(n ast.Node, isStore func(ast.Expr) bool) bool {
	hit := false
	ast.Inspect(n, func(node ast.Node) bool {
		switch x := node.(type) {
		case *ast.Field:
			if isStore(x.Type) {
				hit = true
			}
		case *ast.ValueSpec:
			if x.Type != nil && isStore(x.Type) {
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
	names := make([]string, 0, len(serviceStoreBaselines))
	for name := range serviceStoreBaselines {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		b := serviceStoreBaselines[name]
		got := b.typ.NumMethod()
		t.Logf("%s: a fake needs %d methods (%s)", name, got, b.typ.Name())
		if got != b.want {
			t.Errorf("%s takes %s with %d methods, pinned at %d. If it shrank, set the pin to %d; if it grew, say why in review", name, b.typ.Name(), got, b.want, got)
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
		{"a type assertion is not a consumer", "package p\nfunc F(x any) {\n\t_, _ = x.(Store)\n}\n", nil},
		{"another package's Store is not ours", "package p\nfunc F(st other.Store) {}\n", nil},
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
