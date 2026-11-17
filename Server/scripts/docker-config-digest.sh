#!/usr/bin/env bash
# Prints "imageid=sha256:<hex>" for the config digest of a locally loaded image.
# Works with both Docker image stores: `docker save` writes the config blob
# path into manifest.json as "blobs/sha256/<hex>" (OCI layout) or "<hex>.json".
set -euo pipefail

image="${1:?usage: docker-config-digest.sh <image>}"
config=$(docker save "$image" | tar -xOf - manifest.json | jq -r '.[0].Config')
hex=$(basename "$config" .json)
if [[ ! "$hex" =~ ^[0-9a-f]{64}$ ]]; then
  echo "::error::could not read the config digest of $image (manifest.json Config: $config)" >&2
  exit 1
fi
echo "imageid=sha256:${hex}"
