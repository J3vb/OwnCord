package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/db"
)

type restartCompanionListeners struct {
	TCP string
	UDP string
}

// The application launches this test binary through its real LiveKit process
// manager. Dispatch before testing parses LiveKit's --config argument.
func init() {
	if os.Getenv("OWNCORD_APP_RESTART_COMPANION") == "1" && len(os.Args) == 3 && os.Args[1] == "--config" {
		os.Exit(runRestartCompanion(filepath.Dir(os.Args[2])))
	}
}

func runRestartCompanion(dir string) int {
	tcp, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return 2
	}
	defer tcp.Close()
	udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		return 3
	}
	defer udp.Close()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stop)
	data, err := json.Marshal(restartCompanionListeners{TCP: tcp.Addr().String(), UDP: udp.LocalAddr().String()})
	if err != nil {
		return 4
	}
	path := filepath.Join(dir, "restart-listeners.json")
	if err := os.WriteFile(path+".tmp", data, 0o600); err != nil {
		return 5
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		return 6
	}
	<-stop
	return 0
}

func waitForRestartCompanion(t *testing.T, path string) restartCompanionListeners {
	t.Helper()
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		if data, err := os.ReadFile(path); err == nil {
			var listeners restartCompanionListeners
			if err := json.Unmarshal(data, &listeners); err != nil {
				t.Fatal(err)
			}
			return listeners
		}
		select {
		case <-deadline.C:
			t.Fatal("managed companion never opened its TCP and UDP listeners")
		case <-tick.C:
		}
	}
}

// Exercise the composition that unit tests of Stop and the coordinator alone
// cannot: App.Run owns a real listening child, and its restart must release
// every resource before the replacement spawner is invoked.
func TestAppRun_RestartReleasesManagedCompanionBeforeHandoff(t *testing.T) {
	port := freePort(t)
	a := bootTestApp(t, fmt.Sprint(port), "")
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("OWNCORD_APP_RESTART_COMPANION", "1")
	a.cfg.Voice.LiveKitBinaryPath = bin
	rc := a.deps.Restart
	rc.SetMode(restartModeSpawn)
	defer rc.Disarm()

	ctx, cancel := context.WithCancel(context.Background())
	runErr := make(chan error, 1)
	runDone := make(chan struct{})
	go func() {
		defer close(runDone)
		runErr <- a.Run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-runDone:
		case <-time.After(15 * time.Second):
			t.Error("application failed to finish shutdown during test cleanup")
		}
	})

	waitForHealth(t, port, runErr)
	listeners := waitForRestartCompanion(t, filepath.Join(a.cfg.Server.DataDir, "restart-listeners.json"))
	spawns := 0
	prev := spawnReplacement
	spawnReplacement = func(string, []string) error {
		spawns++
		if err := a.database.PingRead(t.Context()); err == nil {
			t.Error("replacement spawned before the previous database handle closed")
		}
		nextDB, err := db.Open(a.cfg.Database.Path)
		if err != nil {
			t.Errorf("replacement cannot acquire the database process lock: %v", err)
			return err
		}
		defer nextDB.Close()
		for _, addr := range []string{fmt.Sprintf("127.0.0.1:%d", port), listeners.TCP} {
			next, err := net.Listen("tcp4", addr)
			if err != nil {
				t.Errorf("replacement cannot bind previous TCP listener %s: %v", addr, err)
				return err
			}
			if err := next.Close(); err != nil {
				t.Errorf("closing replacement TCP listener: %v", err)
				return err
			}
		}
		nextUDP, err := net.ListenPacket("udp4", listeners.UDP)
		if err != nil {
			t.Errorf("replacement cannot bind previous companion UDP listener: %v", err)
			return err
		}
		return nextUDP.Close()
	}
	defer func() { spawnReplacement = prev }()

	rc.Request("update")
	select {
	case err := <-runErr:
		if err != nil {
			t.Fatalf("application restart drain: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("application did not finish its restart drain")
	}
	rc.PerformHandoff(a.log)
	rc.PerformHandoff(a.log)
	if spawns != 1 {
		t.Fatalf("replacement spawns = %d; want exactly one", spawns)
	}
}
