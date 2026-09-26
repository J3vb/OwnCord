// Test-only release signer. Run from Server/ so its pinned minisign dependency is used.
package main

import (
	"aead.dev/minisign"
	"bytes"
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
)

func main() {
	dir := os.Args[1]
	if os.Args[2] == "keygen" {
		pub, key, err := minisign.GenerateKey(nil)
		must(err)
		public, err := pub.MarshalText()
		must(err)
		private, err := key.MarshalText()
		must(err)
		must(os.WriteFile(filepath.Join(dir, "public.key"), []byte(base64.StdEncoding.EncodeToString(public)), 0600))
		must(os.WriteFile(filepath.Join(dir, "private.key"), private, 0600))
		return
	}
	raw, err := os.ReadFile(filepath.Join(dir, "private.key"))
	must(err)
	var key minisign.PrivateKey
	must(key.UnmarshalText(raw))
	for _, name := range os.Args[2:] {
		data, err := os.ReadFile(filepath.Join(dir, name))
		must(err)
		reader := minisign.NewReader(bytes.NewReader(data))
		_, err = io.Copy(io.Discard, reader)
		must(err)
		must(os.WriteFile(filepath.Join(dir, name+".sig"), reader.Sign(key), 0600))
	}
}
func must(err error) {
	if err != nil {
		panic(err)
	}
}
