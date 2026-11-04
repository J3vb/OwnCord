# Docker in detail

The short Docker steps are in [Run your server](../deployment.md#docker-linux).
This page explains the choices and the details.

## Two ways to run it

- **The compose stack** (`Server/docker-compose.yml`). Runs the chat server and
  LiveKit as two containers. Use it when you want to restart or upgrade voice
  on its own. This is what the quick steps use.
- **One container.** The image has LiveKit built in, so one container does chat
  and voice:

  ```bash
  docker run -d -v owncord-data:/app/data \
    -p 8443:8443 -p 7881:7881 -p 7882:7882/udp \
    --restart unless-stopped --cap-drop=ALL --security-opt=no-new-privileges:true \
    ghcr.io/j3vb/owncord-server:latest
  ```

Both use the same ports: `8443/TCP`, `7881/TCP` and `7882/UDP`.

## About the image

- One tag works on both x64 and ARM64 (a Raspberry Pi 4 or 5 too).
- It has no shell and no extra tools, which keeps it small and hard to attack.
  For anything that needs a shell, use a throwaway `alpine` container on the
  same volume.
- It runs as a normal user (ID `65532`), not as root.
- It has its own health check, so `docker ps` shows `healthy` or `unhealthy`.
  Docker only reports this. It does not restart a hung container by itself.

## Settings in a container

The compose file already sets the voice settings for you: the LiveKit key and
secret (from `.env`), the LiveKit address and the UDP port. These win over
anything in `config.yaml`, so:

- **do not** put `voice.livekit_api_key` or `voice.livekit_api_secret` in
  `config.yaml`. Keeping secrets out of it is what `.env` is for.
- **do not** set `voice.livekit_binary`.
- set everything else in `config.yaml` as normal.

**`config.yaml` is read-only inside the container.** When you change a setting
in the admin panel or the setup wizard, the server saves it in the data volume
instead (`config-overrides.json`). Only the settings you changed are saved
there. The panel's **Reset** button goes back to what `config.yaml` says.

To change the port, change the port mapping in your compose file. To change
anything else from the file, edit `config.yaml` on the host and recreate the
container.

Locked yourself out with a panel setting? Stop the server and run:

```bash
docker compose run --rm --no-deps owncord config reset-overrides
```

## Your data

The volume `owncord-data` holds the database, certificates, uploads and
backups. It survives restarts and upgrades. Backups from the admin panel land
inside the same volume, so also keep a copy elsewhere. See
[Backups and restore](backups.md).

## Upgrading

```bash
docker compose pull
docker compose up -d
```

This is the only way to upgrade in Docker. The admin panel's **Update** button
is turned off in a container, because the program is part of the image. Take an
archive first: [Upgrades](upgrades.md).

**Keep `restart: unless-stopped`.** The shipped compose file has it. A restore,
a **Restart server** click or a setup-wizard restart stops the server and
expects Docker to start it again. Without the restart policy it stays stopped.

## Voice in Docker

- **One container:** the built-in LiveKit starts by itself and uses UDP port
  `7882` for all voice. Its keys are saved in the data volume after the setup
  wizard runs.
- **Compose stack:** LiveKit runs in its own container, with the key and secret
  from `.env`. Leave `use_external_ip: true` in `livekit.yaml` so LiveKit finds
  your public address. Only on a Tailscale-only host do you replace it with
  `node_ip`.

More in [LiveKit setup](../livekit-setup.md#docker).

## Unraid

There is a template at `deploy/unraid/owncord.xml`. It runs one container, with
the built-in LiveKit.

1. Add the template's raw URL under **Docker > Template repositories**, or copy
   the file into `/boot/config/plugins/dockerMan/templates-user/`.
2. Choose **Add Container > OwnCord** and start it.
3. Read the setup token from the container log.
4. Open `https://<unraid-ip>:8443/admin` and create the Owner account.

Forward `7881/tcp` and `7882/udp` on your router for voice from outside your
home ([Port forwarding](../port-forwarding.md)).

Good to know:

- **File owner.** Unraid folders belong to `99:100`, so the template runs the
  container as that user. When you move an install between Unraid and plain
  Docker, run `chown -R` on the folder for the new owner.
- **Where `config.yaml` is.** The template mounts the whole folder
  (`/mnt/user/appdata/owncord` by default). The server writes `config.yaml`
  there on first start. Edit it, then restart the container.
- **Data** is a second mount, for the database and uploads.

## Privileges

The compose file drops every Linux capability and blocks privilege escalation.
When you run the container by hand, pass the same:
`--cap-drop=ALL --security-opt=no-new-privileges:true`.

A read-only root filesystem is not supported: the server writes its default
`config.yaml` on first start.
