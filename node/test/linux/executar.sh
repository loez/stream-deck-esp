#!/usr/bin/env bash
# Roda DENTRO de um barramento D-Bus de sessão (dbus-run-session): sobe um PulseAudio com saída virtual e o player MPRIS falso e executa test/linux-media.ts. PYBIN = python com dbus-next.
set -e
cd "$(dirname "$0")/../.."
pulseaudio --start --exit-idle-time=-1 --disallow-exit --load="module-null-sink sink_name=virt" >/dev/null 2>&1 || pulseaudio -D --exit-idle-time=-1
sleep 1; pactl set-default-sink virt || true
"${PYBIN:-python3}" test/linux/mpris_mock.py & sleep 2
node test/linux-media.ts
