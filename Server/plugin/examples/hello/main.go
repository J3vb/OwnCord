// Hello plugin — Phase C Step 9 proof-of-life.
//
// Build with TinyGo:
//
//	tinygo build -o hello.wasm -target wasi ./main.go
//
// The module exports the five functions the OwnCord plugin ABI requires:
//
//	allocate(size)          → ptr        — host writes input into module memory
//	deallocate(ptr, size)               — host signals it's done with a buffer
//	list_commands()         → (ptr, len) — JSON array of command names
//	command_dispatch(p, l)  → (ptr, len) — handle a slash command, return JSON reply
//	on_event(ptr, len)                  — receive a broadcast event (no-op here)
package main

import (
	"encoding/json"
	"unsafe"
)

func main() {}

// allocations keeps live references so the GC does not reclaim buffers the
// host is still holding a pointer to.
var allocations [][]byte

//export allocate
func allocate(size uint32) uint32 {
	buf := make([]byte, size)
	allocations = append(allocations, buf)
	return uint32(uintptr(unsafe.Pointer(&buf[0])))
}

//export deallocate
func deallocate(ptr uint32, size uint32) {
	for i, b := range allocations {
		if uint32(len(b)) == size && uint32(uintptr(unsafe.Pointer(&b[0]))) == ptr {
			allocations = append(allocations[:i], allocations[i+1:]...)
			return
		}
	}
}

// listCommandsJSON is the static payload returned by list_commands.
var listCommandsJSON = []byte(`["hello"]`)

//export list_commands
func listCommands() (uint32, uint32) {
	return uint32(uintptr(unsafe.Pointer(&listCommandsJSON[0]))), uint32(len(listCommandsJSON))
}

type dispatchInput struct {
	UserID    int64    `json:"user_id"`
	ChannelID int64    `json:"channel_id"`
	Command   string   `json:"command"`
	Args      []string `json:"args"`
}

type dispatchOutput struct {
	Reply string `json:"reply"`
}

// resultBuf holds the most recent command_dispatch result. Safe because the
// host is single-threaded within a plugin invocation.
var resultBuf []byte

//export command_dispatch
func commandDispatch(ptr uint32, length uint32) (uint32, uint32) {
	raw := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), length)

	var in dispatchInput
	if err := json.Unmarshal(raw, &in); err != nil {
		resultBuf = []byte(`{"reply":"hello: malformed payload"}`)
	} else {
		reply := "Hello from the hello plugin!"
		if len(in.Args) > 0 {
			reply = "Hello, " + in.Args[0] + "!"
		}
		out, _ := json.Marshal(dispatchOutput{Reply: reply})
		resultBuf = out
	}

	return uint32(uintptr(unsafe.Pointer(&resultBuf[0]))), uint32(len(resultBuf))
}

//export on_event
func onEvent(_ uint32, _ uint32) {}
