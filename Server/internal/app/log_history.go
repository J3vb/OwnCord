package app

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
)

// startLogHistory starts saving log lines to disk for the admin panel's log
// history. It starts right after the data directory exists so start-up lines
// are saved, and its close step runs near the end of teardown so shutdown
// lines are too. The writer stops on its own close step, not on bgCtx, so
// it can write what is still queued after the other stages are gone.
func (a *App) startLogHistory() error {
	dir := a.cfg.LogHistoryDir()
	if a.deps.LogBuf == nil || dir == "" {
		return nil
	}
	lf := admin.StartLogFile(context.WithoutCancel(a.bgCtx), admin.LogFileOptions{
		Dir:      dir,
		MaxAge:   time.Duration(a.cfg.Logging.HistoryDays) * 24 * time.Hour,
		MaxBytes: int64(a.cfg.Logging.HistoryMaxMB) << 20,
	})
	a.deps.LogBuf.SetHistory(lf)
	a.onClose("log-history", func(ctx context.Context) error {
		a.deps.LogBuf.SetHistory(nil)
		lf.Stop(ctx)
		return nil
	})
	return nil
}
