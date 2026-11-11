package main

import (
	"errors"
	"fmt"
	"mime"
	"net/http"
	"regexp"
	"strings"
)

// browserClientEnv switches the server's browser client on. The setting is off
// by default (a server must never serve a web client the owner did not ask
// for), so the smoke has to turn it on to see what the binary embeds.
const browserClientEnv = "OWNCORD_SERVER_BROWSER_CLIENT_ENABLED=true"

const maxClientBody = 16 << 20

var assetScriptPattern = regexp.MustCompile(`/assets/[A-Za-z0-9._\-/]+\.js`)

func firstAssetScript(index string) (string, bool) {
	p := assetScriptPattern.FindString(index)
	return p, p != ""
}

// checkClientIndex asserts the page a browser would be handed: HTML, with a
// module script from /assets/. A placeholder-only build answers GET / with a
// not-found note instead, which is exactly what this exists to catch.
func checkClientIndex(status int, contentType, body string) (string, error) {
	if status != http.StatusOK {
		return "", fmt.Errorf("GET / answered %d, want 200 (is the web bundle embedded in this binary?)", status)
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil || mediaType != "text/html" {
		return "", fmt.Errorf("GET / has Content-Type %q, want text/html", contentType)
	}
	if !strings.Contains(body, `<script type="module"`) {
		return "", errors.New(`GET / has no <script type="module"`)
	}
	script, ok := firstAssetScript(body)
	if !ok {
		return "", errors.New("GET / references no /assets/*.js script")
	}
	return script, nil
}

// runBrowserClient is phase 5: boot a third time with the browser client on and fetch what a browser would;
// phases 1-4 prove the asset runs, this proves it ships the client.
func runBrowserClient(bin, dir string) error {
	third, err := start(bin, dir, "boot3.log", browserClientEnv)
	if err != nil {
		return err
	}
	if err := third.waitHealthy("browser client boot"); err != nil {
		return err
	}
	status, contentType, body, err := getClient("/")
	if err != nil {
		return third.annotate("browser client", err)
	}
	script, err := checkClientIndex(status, contentType, body)
	if err != nil {
		return third.annotate("browser client", err)
	}
	status, _, _, err = getClient(script)
	if err != nil {
		return third.annotate("browser client", err)
	}
	if status != http.StatusOK {
		return third.annotate("browser client", fmt.Errorf("GET %s answered %d, want 200", script, status))
	}
	fmt.Println("browser client: / serves the bundle index and", script)
	return third.drain("browser client drain")
}
