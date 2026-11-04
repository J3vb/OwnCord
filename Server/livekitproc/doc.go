// Package livekitproc supervises the companion livekit-server process: it
// writes the generated livekit.yaml, fetches the pinned binary when
// auto-download is on, starts and restarts the process, health-checks it and
// stops it. It knows nothing about the WebSocket hub: ws holds a *Process
// and only reads its state and stops it on shutdown.
package livekitproc
