package ws

// raceScaled returns n, or a quarter of it under the race detector. The load
// tests size their herds with it: a race needs concurrency, not a thousand
// clients, and at full size those tests cost minutes under -race. Full size
// still runs in the plain and deadlock passes.
func raceScaled(n int) int {
	if raceEnabled {
		return max(n/4, 1)
	}
	return n
}

// RaceScaled is raceScaled for package ws_test.
func RaceScaled(n int) int { return raceScaled(n) }
