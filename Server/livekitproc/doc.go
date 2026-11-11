// Package livekitproc supervises the companion livekit-server process: config
// generation, binary download, restart and health checks. It knows nothing of
// the hub; ws holds a *Process and only reads its state and stops it.
package livekitproc
