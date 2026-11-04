//go:build !linux && !windows

package sysstats

func readProcess(int) (ProcessReading, bool) {
	return ProcessReading{}, false
}
