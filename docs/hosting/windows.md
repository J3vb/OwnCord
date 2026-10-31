# Windows service

On Windows you can run the server three ways. A service (NSSM) is best: it
starts at boot, comes back after a crash and keeps a log.

## NSSM (recommended)

NSSM runs any program as a Windows service. In PowerShell, as administrator:

```powershell
choco install nssm    # or download it from nssm.cc

nssm install OwnCord "C:\OwnCord\chatserver.exe"
nssm set OwnCord AppDirectory "C:\OwnCord"
nssm set OwnCord DisplayName "OwnCord Chat Server"
nssm set OwnCord Start SERVICE_AUTO_START

# Required, see below.
nssm set OwnCord AppEnvironmentExtra OWNCORD_SERVER_RESTART_MODE=supervised

# Keep the log. Create C:\OwnCord\logs first.
nssm set OwnCord AppStdout "C:\OwnCord\logs\server.log"
nssm set OwnCord AppStderr "C:\OwnCord\logs\server.log"
nssm set OwnCord AppRotateFiles 1

nssm start OwnCord
```

Two lines matter most:

- **`OWNCORD_SERVER_RESTART_MODE=supervised`** tells the server that NSSM looks
  after it. After an update or restore the server then stops and lets NSSM
  start the new version. Without it, the server and NSSM both try to start it.
- **`AppStdout` and `AppStderr`** keep the log. Without them every log line is
  thrown away.

Stop and restart with `nssm stop OwnCord` and `nssm restart OwnCord`.

## Task Scheduler

1. Create a new task.
2. Trigger: **At startup**.
3. Action: start `chatserver.exe`, with **Start in** set to the folder that
   holds `config.yaml`.
4. Tick **Run whether user is logged on or not** and **Run with highest
   privileges**.

Task Scheduler starts the server but does not watch it, so leave
`server.restart_mode` on `auto`. It also drops the log. To keep it, make the
action:

```powershell
cmd /c chatserver.exe >> logs\server.log 2>&1
```

## From a console window

Double-click `chatserver.exe`, or start it from PowerShell. Fine for trying it
out. Nothing restarts it if it crashes.

- After an update or restore, the new version keeps printing in the same
  window. An idle copy of the old one stays until the window closes.
- **Ctrl+C** stops the server. Closing the window stops everything, voice too.

The technical detail of how the restart hands over is in the
[reference](reference.md#how-a-self-restart-works).
