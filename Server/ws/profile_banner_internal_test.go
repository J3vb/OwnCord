package ws

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// Profile banners on the wire (WP 6.11b).

func TestEncodeRoster_SplicesWithBanner(t *testing.T) {
	about := `"status":"" and "custom_status":null} tricks`
	custom := "busy"
	banner, color := "/api/v1/files/abc", "#112233"
	members := []db.MemberSummary{
		{ID: 1, Username: "alice", Status: db.StatusOnline, MemberRoleSet: &db.MemberRoleSet{Role: "member"}, About: &about,
			CreatedAt: "2026-10-15T13:04:05Z", MemberBanner: &db.MemberBanner{Banner: &banner, BannerColor: &color}, CustomStatus: &custom},
		{ID: 2, Username: "bob", Status: db.StatusOnline, MemberRoleSet: &db.MemberRoleSet{Role: "member"}, CreatedAt: "2026-10-15T13:04:05Z"},
	}
	roster, err := encodeRoster(members)
	if err != nil {
		t.Fatalf("encodeRoster: %v", err)
	}
	splice := func(i int, status string) map[string]any {
		var b strings.Builder
		b.Write(roster.enc[i].head)
		b.WriteString(`"` + status + `"`)
		b.Write(roster.enc[i].mid)
		if roster.enc[i].custom != nil {
			b.Write(roster.enc[i].custom)
		} else {
			b.WriteString("null")
		}
		b.WriteString("}")
		var got map[string]any
		if err := json.Unmarshal([]byte(b.String()), &got); err != nil {
			t.Fatalf("spliced member is not JSON: %v\n%s", err, b.String())
		}
		return got
	}
	a := splice(0, "online")
	if a["banner"] != banner || a["banner_color"] != color || a["custom_status"] != "busy" || a["status"] != "online" || a["about"] != about {
		t.Errorf("alice = %v", a)
	}
	bob := splice(1, "offline")
	for _, k := range []string{"banner", "banner_color"} {
		if _, ok := bob[k]; ok {
			t.Errorf("a member with no banner carries %q: %v", k, bob)
		}
	}
}

func TestBuildMemberJoin_BannerOmittedWhenUnset(t *testing.T) {
	decode := func(u *db.User) map[string]any {
		raw := buildMemberJoin(u, "member", nil)
		var env struct {
			Payload struct {
				User map[string]any `json:"user"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		return env.Payload.User
	}
	bare := decode(&db.User{ID: 1, Username: "a", CreatedAt: "2026-10-15 13:04:05"})
	for _, k := range []string{"banner", "banner_color"} {
		if _, ok := bare[k]; ok {
			t.Errorf("member_join.user carries %q with no banner set", k)
		}
	}
	id, color := "file-1", "#fff"
	set := decode(&db.User{ID: 2, Username: "b", CreatedAt: "2026-10-15 13:04:05", BannerID: &id, BannerColor: &color})
	if set["banner"] != "/api/v1/files/file-1" || set["banner_color"] != "#fff" {
		t.Errorf("member_join.user = %v", set)
	}
}

// user_update replaces the client's copy, so the banner keys are present even
// when unset (null = cleared).
func TestUserUpdate_BannerFieldsAlwaysPresent(t *testing.T) {
	payload := func(u UserUpdate) map[string]any {
		var env struct {
			Payload map[string]any `json:"payload"`
		}
		if err := json.Unmarshal(buildUserUpdate(u), &env); err != nil {
			t.Fatal(err)
		}
		return env.Payload
	}
	cleared := payload(UserUpdate{UserID: 1, Username: "a"})
	for _, k := range []string{"banner", "banner_color"} {
		if v, ok := cleared[k]; !ok || v != nil {
			t.Errorf("%s = %v (present %v), want present and null", k, v, ok)
		}
	}
	b, c := "/api/v1/files/x", "#000"
	set := payload(UserUpdate{UserID: 1, Username: "a", Banner: &b, BannerColor: &c})
	if set["banner"] != b || set["banner_color"] != c {
		t.Errorf("payload = %v", set)
	}
}
