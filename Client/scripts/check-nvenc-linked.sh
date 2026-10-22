#!/usr/bin/env bash
# Fail if a Linux release binary was built without the NVIDIA hardware video
# encoder. webrtc-sys compiles NVENC only when cuda.h was visible at build time
# (see linux-webrtc-toolchain.sh) and otherwise says so in a cargo warning
# nobody reads, so check the artefact: the encoder names itself in its
# src/nvidia/h264_encoder_impl.cpp.
#
#   Client/scripts/check-nvenc-linked.sh src-tauri/target/release/owncord-client
set -euo pipefail

bin="${1:?usage: check-nvenc-linked.sh <binary>}"
marker="NVIDIA H264 Encoder"

if [ "$(grep -c -a -F "$marker" "$bin" || true)" -eq 0 ]; then
  echo "::error::$bin has no '$marker': webrtc-sys was built without cuda.h, so this build has no NVENC. Check CUDA_HOME and the rust-cache key." >&2
  exit 1
fi
echo "NVENC present in $bin"
