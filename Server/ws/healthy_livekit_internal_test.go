package ws

import "testing"

// healthyTestLiveKit returns a LiveKit client pointed at a stub room service
// that answers the RPCs the hub makes: ListRooms for the externally managed
// reachability probe voice_join now runs before minting a token, and the
// participant RPCs for eviction paths. A join test must point at a reachable
// address — the old bare "ws://127.0.0.1:1" fixtures were never dialed before
// the probe existed, and now they fail the join by design.
func healthyTestLiveKit(t *testing.T) *LiveKitClient {
	t.Helper()
	return newFakeSFU().serve(t)
}
