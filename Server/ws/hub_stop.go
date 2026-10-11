package ws

// Stop signals Run to exit. Safe to call multiple times.
func (h *Hub) Stop() {
	h.stopOnce.Do(h.closeStop)
}

// closeStop signals Run to exit and cancels the in-flight sweeps. Only ever
// run under stopOnce.
func (h *Hub) closeStop() {
	close(h.stop)
	if h.stopLife != nil {
		h.stopLife()
	}
}

// Done returns a channel that closes once Run has returned, with
// DispatchAlive already false and every sweep Run started finished. Stop and
// GracefulStopContext do not wait for that, so a caller that must know the
// loop is gone waits here.
func (h *Hub) Done() <-chan struct{} {
	return h.runDone
}
