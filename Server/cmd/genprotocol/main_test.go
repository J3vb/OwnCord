package main

import (
	"strings"
	"testing"
)

func validSchema() schema {
	return schema{
		ProtocolEpoch:  1,
		ClientToServer: []message{{Wire: "ping", Go: "TypePing", TS: "Ping"}},
		ServerToClient: []message{{Wire: "pong", Go: "TypePong", TS: "Pong"}},
		Enums: []enum{{
			Name: "state", Go: "State", TS: "State",
			Values: []message{{Wire: "ready", Go: "StateReady", TS: "Ready"}},
		}},
		ErrorCodes: errorCodes{
			WS:   []message{{Wire: "INVALID_INPUT", Go: "ErrInvalidInput", TS: "INVALID_INPUT"}},
			REST: []message{{Wire: "INVALID_INPUT", Go: "InvalidInput", TS: "INVALID_INPUT"}},
		},
	}
}

func TestValidateGoIdentifierNamespaces(t *testing.T) {
	tests := []struct {
		name   string
		change func(*schema)
		want   string
	}{
		{"distinct names", func(*schema) {}, ""},
		{"message directions share Go names", func(s *schema) {
			s.ServerToClient[0].Go = "TypePing"
		}, `duplicate Go constant "TypePing"`},
		{"enum type shares message names", func(s *schema) {
			s.Enums[0].Go = "TypePing"
		}, `duplicate Go identifier "TypePing"`},
		{"enum value shares message names", func(s *schema) {
			s.Enums[0].Values[0].Go = "TypePong"
		}, `duplicate Go identifier "TypePong"`},
		{"websocket error shares enum names", func(s *schema) {
			s.ErrorCodes.WS[0].Go = "StateReady"
		}, `duplicate Go identifier "StateReady"`},
		{"rest errors have a separate Go namespace", func(s *schema) {
			s.ErrorCodes.REST[0].Go = "ErrInvalidInput"
		}, ""},
		{"message directions have separate TS namespaces", func(s *schema) {
			s.ServerToClient[0].TS = "Ping"
		}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := validSchema()
			tt.change(&s)
			err := validate(s)
			if tt.want == "" {
				if err != nil {
					t.Fatalf("valid schema rejected: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("validate() = %v, want %q", err, tt.want)
			}
		})
	}
}

func TestValidateErrorCodeKeysMatchWireValues(t *testing.T) {
	for _, list := range []string{"ws", "rest"} {
		t.Run(list, func(t *testing.T) {
			s := validSchema()
			if err := validate(s); err != nil {
				t.Fatalf("matching error code rejected: %v", err)
			}
			codes := s.ErrorCodes.WS
			if list == "rest" {
				codes = s.ErrorCodes.REST
			}
			codes[0].TS = "OTHER_CODE"
			want := `error_codes.` + list + ` "INVALID_INPUT": ts must equal wire, got "OTHER_CODE"`
			if err := validate(s); err == nil || err.Error() != want {
				t.Fatalf("validate() = %v, want %q", err, want)
			}
			codes[0].TS = codes[0].Wire
			if err := validate(s); err != nil {
				t.Fatalf("corrected error code rejected: %v", err)
			}
		})
	}
}
