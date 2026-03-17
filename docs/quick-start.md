# Quick Start Guide

## Step 1: Download

Get the latest release from GitHub Releases.
Download `chatserver.exe` and the `OwnCord`
installer.

## Step 2: Run the Server

Run `chatserver.exe`. On first run it generates
`config.yaml` and a self-signed TLS certificate.
The server starts on `https://0.0.0.0:8443`.

## Step 3: Admin Setup

Open `https://localhost:8443/admin` in a browser.
The first registered user with the Owner role can
manage the server.

## Step 4: Create Invites

In the admin panel, go to invite management and
generate invite codes for your friends.

## Step 5: Connect Clients

Friends install OwnCord, enter your server address
(IP or domain + port 8443), and redeem their invite
code to register.

## Networking

If friends are outside your local network, see the
[Port Forwarding Guide](port-forwarding.md) or use
[Tailscale](tailscale.md) for zero-config networking.
