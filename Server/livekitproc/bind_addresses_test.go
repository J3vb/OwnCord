package livekitproc_test

import (
	"slices"
	"testing"

	"gopkg.in/yaml.v3"
)

type generatedListeners struct {
	Port          int      `yaml:"port"`
	BindAddresses []string `yaml:"bind_addresses"`
	RTC           struct {
		PortRangeStart int `yaml:"port_range_start"`
	} `yaml:"rtc"`
}

func parseListeners(t *testing.T, url string) generatedListeners {
	t.Helper()
	_, content := generatedConfig(t, newProcess(t, testVoiceConfigAt(url)))
	var got generatedListeners
	mustDo(t, "yaml.Unmarshal", yaml.Unmarshal(content, &got))
	if got.Port != 7880 || got.RTC.PortRangeStart != 50000 {
		t.Fatalf("listeners changed: port %d, rtc range start %d\n%s", got.Port, got.RTC.PortRangeStart, content)
	}
	return got
}

// A loopback voice.livekit_url binds the signalling port to loopback, while
// the media ports stay as they were.
func TestGenerateConfig_LoopbackURLBindsSignallingToLoopback(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		url  string
		want []string
	}{
		{"ws://127.0.0.1:7880", []string{"127.0.0.1"}},
		{"ws://[::1]:7880", []string{"::1"}},
		{"http://LOCALHOST:7880/", []string{"127.0.0.1"}},
	} {
		got := parseListeners(t, tc.url).BindAddresses
		for _, w := range tc.want {
			if !slices.Contains(got, w) {
				t.Errorf("%s: bind_addresses = %v, want it to hold %s", tc.url, got, w)
			}
		}
		for _, a := range got {
			if a != "127.0.0.1" && a != "::1" {
				t.Errorf("%s: bind_addresses holds non-loopback %q", tc.url, a)
			}
		}
	}
}

// Any other voice.livekit_url (a LAN or container address) keeps the
// all-interfaces listener, so nothing that reaches 7880 there today breaks.
func TestGenerateConfig_NonLoopbackURLKeepsEveryInterface(t *testing.T) {
	t.Parallel()
	for _, url := range []string{"ws://livekit:7880", "ws://192.168.1.5:7880", "ws://[2001:db8::1]:7880", "::bad url"} {
		if got := parseListeners(t, url).BindAddresses; len(got) != 0 {
			t.Errorf("%s: bind_addresses = %v, want none", url, got)
		}
	}
}
