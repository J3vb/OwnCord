package api

import (
	"context"
	"testing"
	"time"
)

func TestThumbSlotCount_HalfTheCPUsBetweenOneAndFour(t *testing.T) {
	for cpus, want := range map[int]int{0: 1, 1: 1, 2: 1, 3: 1, 4: 2, 6: 3, 8: 4, 64: 4} {
		if got := thumbSlotCount(cpus); got != want {
			t.Errorf("thumbSlotCount(%d) = %d, want %d", cpus, got, want)
		}
	}
}

// Two slots let two thumbnails run side by side; a third waits only as long
// as the slot wait and then gives up.
func TestThumbSlots_TwoRunAtOnceAndAThirdWaitIsBounded(t *testing.T) {
	slots := makeThumbSlots(2, 30*time.Millisecond)
	first, ok := slots.acquire(context.Background(), 1)
	if !ok {
		t.Fatal("first slot not granted")
	}
	second, ok := slots.acquire(context.Background(), 1)
	if !ok {
		t.Fatal("second slot not granted while one was free")
	}
	start := time.Now()
	if _, ok := slots.acquire(context.Background(), 1); ok {
		t.Fatal("a third slot was granted with both held")
	}
	if waited := time.Since(start); waited > 2*time.Second {
		t.Errorf("the third request waited %v, want about the 30 ms slot wait", waited)
	}
	first()
	second()
	if _, ok := slots.acquire(context.Background(), 2); !ok {
		t.Error("both slots not free after release")
	}
}

// A HEIC conversion asks for more slots than a one-slot machine has; it takes
// the one there is instead of never starting.
func TestThumbSlots_HEICWeightIsCappedAtTheSlotCount(t *testing.T) {
	slots := makeThumbSlots(1, 30*time.Millisecond)
	release, ok := slots.acquire(context.Background(), heicSlotWeight)
	if !ok {
		t.Fatal("a HEIC conversion never starts on a one-slot machine")
	}
	release()
	if heicSlotWeight != 3 {
		t.Errorf("heicSlotWeight = %d, want 3 (256 MiB over 96 MiB slots)", heicSlotWeight)
	}
}

// A request that ends while it waits stops waiting.
func TestThumbSlots_WaitEndsWithTheRequest(t *testing.T) {
	slots := makeThumbSlots(1, time.Minute)
	release, _ := slots.acquire(context.Background(), 1)
	defer release()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, ok := slots.acquire(ctx, 1); ok {
		t.Fatal("granted a slot to a request that had ended")
	}
}
