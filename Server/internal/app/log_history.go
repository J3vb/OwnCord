package app

import (
	"context"
	"time"

	"github.com/J3vb/OwnCord/Server/admin"
)

// startLogHistory saves log lines to disk for the admin panel's log history.
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
