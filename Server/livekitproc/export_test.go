package livekitproc

import (
	"net/http"
	"os"
	"os/exec"
)

// GenerateConfigForTest exposes Process.generateConfig for external tests.
func (p *Process) GenerateConfigForTest() (string, error) {
	return p.generateConfig()
}

// HTTPTransportForTest exposes the health-check client's transport so tests can
// assert it does not share http.DefaultTransport's connection pool.
func (p *Process) HTTPTransportForTest() http.RoundTripper {
	return p.httpClient.Transport
}

// SetProcessCmdForTest sets cmd to a non-nil value to simulate "already running".
func (p *Process) SetProcessCmdForTest() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cmd = &exec.Cmd{}
}

// SetProcessPIDForTest simulates a running companion with the given pid.
func (p *Process) SetProcessPIDForTest(pid int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cmd = &exec.Cmd{Process: &os.Process{Pid: pid}}
}

// SetProcessStoppedForTest sets stopped=true to simulate a stopped process.
func (p *Process) SetProcessStoppedForTest() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.stopped = true
}
