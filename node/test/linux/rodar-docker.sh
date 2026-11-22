#!/usr/bin/env bash
# Roda a validação de mídia do Linux num contêiner (Docker): PulseAudio virtual + D-Bus de sessão + player MPRIS falso. Uso: bash test/linux/rodar-docker.sh   (dentro de node)
set -euo pipefail
cd "$(dirname "$0")/../.."
docker run --rm -v "$PWD":/src:ro node:24-bookworm bash -c '
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq pulseaudio pulseaudio-utils playerctl dbus xdotool python3-pip python3-venv >/dev/null
  python3 -m venv /opt/v && /opt/v/bin/pip install -q dbus-next
  mkdir /w && cd /src && tar --exclude=node_modules --exclude=out -cf - . | tar -xf - -C /w && cd /w
  npm ci --no-audit --no-fund >/dev/null
  PYBIN=/opt/v/bin/python dbus-run-session -- bash test/linux/executar.sh
'
