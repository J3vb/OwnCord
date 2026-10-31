package app

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/metrics"
	"github.com/J3vb/OwnCord/Server/sysstats"
	"github.com/J3vb/OwnCord/Server/ws"
)

// Windowed metrics: a 10 s sampler over a 15 minute horizon. The two windows
// the endpoint reports (1m, 15m) are cut from one ring of horizon/tick + 2 = 92
// samples, about 120 KB allocated once.
const (
	metricsWindowTick    = 10 * time.Second
	metricsWindowHorizon = 15 * time.Minute
)

// newMetricsWindows builds the ring over the hub's sources and the two database
// pools' wait figures. It starts nothing: startHub runs the sampler under the
// app's lifecycle context and stops it before the hub, since tests also call
// StartRuntime directly and own no goroutine to stop.
func newMetricsWindows(hub *ws.Hub, writerStats, readerStats func() sql.DBStats) (*metrics.Windows, error) {
	hists, gauges, counters := hub.WindowSources()
	counters = append(counters, dbWaitCounters(writerStats, readerStats)...)
	w, err := metrics.NewWindows(metrics.WindowSpec{
		Tick:       metricsWindowTick,
		Horizon:    metricsWindowHorizon,
		Histograms: hists,
		MaxGauges:  gauges,
		Counters:   counters,
	}, nil)
	if err != nil {
		return nil, fmt.Errorf("app: building metrics windows: %w", err)
	}
	return w, nil
}

// dbWaitCounters is the four database wait counters. Their names are read back
// by api.NewWindowMetrics; metrics_sampler_test.go pins the pair.
func dbWaitCounters(writerStats, readerStats func() sql.DBStats) []metrics.NamedCounter {
	return append(
		poolWait("db_writer_wait_count", "db_writer_wait_nanos", writerStats),
		poolWait("db_reader_wait_count", "db_reader_wait_nanos", readerStats)...)
}

// poolWait returns the cumulative wait count and wait time (nanoseconds) of one
// connection pool as two counters, clamping negative values to zero. The two
// reads are separate Stats() calls, each atomic on its own.
func poolWait(countName, nanosName string, stats func() sql.DBStats) []metrics.NamedCounter {
	return []metrics.NamedCounter{
		{Name: countName, Read: func() uint64 { return nonNegative(stats().WaitCount) }},
		{Name: nanosName, Read: func() uint64 { return nonNegative(int64(stats().WaitDuration)) }},
	}
}

func nonNegative(v int64) uint64 {
	if v < 0 {
		return 0
	}
	return uint64(v)
}

// startMetricsWindows runs the sampler under a child of bgCtx and registers its
// close step: cancel, then wait for the goroutine to exit within the step's
// budget (the db-optimize shape).
func (a *App) startMetricsWindows(w *metrics.Windows) {
	ctx, cancel := context.WithCancel(a.bgCtx)
	done := w.Run(ctx)
	a.onClose("metrics-windows", func(stepCtx context.Context) error {
		cancel()
		select {
		case <-done:
		case <-stepCtx.Done():
			a.log.Warn("metrics sampler did not stop before the close budget ran out")
		}
		return nil
	})
}

// startSystemStats runs the Dashboard health row's sampler under a child of
// bgCtx and registers its close step, the same shape as startMetricsWindows.
func (a *App) startSystemStats(s *sysstats.Sampler) {
	ctx, cancel := context.WithCancel(a.bgCtx)
	done := s.Run(ctx)
	a.onClose("system-stats", func(stepCtx context.Context) error {
		cancel()
		select {
		case <-done:
		case <-stepCtx.Done():
			a.log.Warn("system stats sampler did not stop before the close budget ran out")
		}
		return nil
	})
}
