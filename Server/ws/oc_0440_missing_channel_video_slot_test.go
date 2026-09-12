package ws

// OC-0440: enableVideoSlot's GetChannel error branch fails closed with an
// explicit comment that an unreadable row is not "no cap configured" — but
// GetChannel also returns (nil, nil) for a channel that simply no longer
// exists (db.DB.GetChannel translates sql.ErrNoRows to a nil row and a nil
// error), and that case was never handled: `ch != nil && ch.VoiceMaxVideo > 0`
// is false, so the code falls straight through to the unconditional enable,
// bypassing the shared voice_max_video budget entirely. A channel deleted
// while a user is still in its voice room reproduces this exactly.

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/service"
)

// nilChannelReader wraps a real DispatchReader and makes GetChannel report a
// missing row (nil, nil) — the same outcome db.DB.GetChannel gives for a
// channel id that has been deleted — regardless of what channel id is asked
// for. Every other method passes through to the wrapped reader.
type nilChannelReader struct {
	DispatchReader
}

func (nilChannelReader) GetChannel(context.Context, int64) (*db.Channel, error) {
	return nil, nil
}

// TestEnableVideoSlot_MissingChannelFailsClosed pins enableVideoSlot's
// contract directly: a channel that GetChannel cannot resolve must refuse the
// enable exactly like a GetChannel error does, never fall through to
// unconditionalSet. Today it returns nil (success) and invokes
// unconditionalSet without ever consulting tryReserve/the cap.
func TestEnableVideoSlot_MissingChannelFailsClosed(t *testing.T) {
	ctx := context.Background()
	database := newOC0023VideoLimitDB(t)
	d := VoiceDeps{Reader: nilChannelReader{DispatchReader: database}}

	var tryReserveCalled, unconditionalSetCalled bool
	tryReserve := func(ctx context.Context, userID, channelID int64, maxVideo int) (bool, error) {
		tryReserveCalled = true
		return true, nil
	}
	unconditionalSet := func(ctx context.Context, userID int64, enabled bool) error {
		unconditionalSetCalled = true
		return nil
	}

	res := enableVideoSlot(ctx, d, 1, 2, tryReserve, unconditionalSet, "TestEnableVideoSlot_MissingChannelFailsClosed", "camera")
	if res == nil {
		t.Fatal("enableVideoSlot returned nil (success) for a channel GetChannel could not resolve — the voice_max_video budget was never consulted")
	}
	var ce ClientError
	if !errors.As(res.Error, &ce) || ce.Code != ErrCodeInternal {
		t.Errorf("error = %+v, want ClientError{Code: %q}", res.Error, ErrCodeInternal)
	}
	if unconditionalSetCalled {
		t.Error("unconditionalSet was invoked for an unresolvable channel — camera/screenshare was enabled with no cap check at all")
	}
	if tryReserveCalled {
		t.Error("tryReserve should not run either: there is no channel row to read a cap from")
	}
}

// TestHandleVoiceCameraV2_DeletedChannel_RefusesEnable exercises the same bug
// end-to-end through the real handler and a real deleted-channel row (rather
// than a fake reader), matching the finding's repro: a user still shows
// VoiceChannelID pointing at a channel that has since been deleted (e.g. an
// admin removed it while the user's voice connection was still open), and
// then sends voice_camera{enabled:true}.
func TestHandleVoiceCameraV2_DeletedChannel_RefusesEnable(t *testing.T) {
	ctx := context.Background()
	database := newOC0023VideoLimitDB(t)
	chID := mustCreateVideoCappedChannel(t, database, "soon-deleted", 2)
	userID := seedOC0023VideoLimitUser(t, database, "cam-after-delete")
	if err := database.JoinVoiceChannel(ctx, userID, chID); err != nil {
		t.Fatalf("JoinVoiceChannel: %v", err)
	}
	if err := database.DeleteChannel(ctx, chID); err != nil {
		t.Fatalf("DeleteChannel: %v", err)
	}

	d := VoiceDeps{Voice: service.NewVoiceService(database), Reader: database, Permissions: permissions.NewChecker(database)}

	res := handleVoiceCameraV2(ctx, VoiceCameraCmd{userID: userID, enabled: true}, ClientInfo{UserID: userID, VoiceChannelID: chID}, d)
	if res.Error == nil {
		t.Fatal("voice_camera enable succeeded against a deleted channel — the voice_max_video cap was bypassed entirely")
	}
	var ce ClientError
	if !errors.As(res.Error, &ce) || ce.Code != ErrCodeInternal {
		t.Errorf("error = %+v, want ClientError{Code: %q}", res.Error, ErrCodeInternal)
	}
}
