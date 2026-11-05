package livekitproc

import (
	"context"
	"log/slog"
)

// runOnce starts one companion and waits for it to exit; err is why it exited.
// live is false when the manager was stopped or cancelled, so runLoop must
// return without restarting.
func (p *Process) runOnce(ctx context.Context, cfgPath, binPath string) (live bool, err error) {
	cmd := newLiveKitCmd(ctx, cfgPath, binPath)
	p.mu.Lock()
	if p.stopped {
		p.mu.Unlock()
		return false, nil
	}
	// Start inside the critical section that publishes p.cmd: Start writes cmd.Process,
	// which IsRunning and Stop read under p.mu; started after the unlock, that write
	// races every such read.
	err = cmd.Start()
	if err == nil {
		if jobErr := containLiveKitProcess(cmd.Process); jobErr != nil {
			slog.Warn("livekit: companion may outlive this process if it exits without shutting down",
				"error", jobErr)
		}
		p.cmd = cmd
		p.runDone = make(chan struct{})
	}
	p.mu.Unlock()

	if err == nil {
		err = cmd.Wait()
	}

	p.mu.Lock()
	p.cmd = nil
	if p.runDone != nil {
		close(p.runDone)
		p.runDone = nil
	}
	stopped := p.stopped
	p.mu.Unlock()

	if stopped || ctx.Err() != nil {
		slog.Info("livekit: process stopped")
		return false, err
	}
	return true, err
}
