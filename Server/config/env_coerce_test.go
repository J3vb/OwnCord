package config

import (
	"reflect"
	"slices"
	"testing"
)

func TestCoerceEnvListDropsBlankEntries(t *testing.T) {
	got, err := coerceEnv("a, ,b,", reflect.Slice)
	if err != nil {
		t.Fatalf("coerceEnv: %v", err)
	}
	if list, _ := got.([]string); !slices.Equal(list, []string{"a", "b"}) {
		t.Errorf("got %#v, want [a b]", got)
	}
}
