#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/andrey/pi-tv-ui"
PORT="${PITV_PORT:-8787}"
URL="http://127.0.0.1:${PORT}"
KIOSK_PROFILE="${HOME}/.local/share/pi-tv-kiosk-profile"
LOG_FILE="${HOME}/.local/share/pi-tv-server.log"

WINDOWED=0
for arg in "$@"; do
  if [[ "$arg" == "--windowed" ]]; then
    WINDOWED=1
  fi
done

mkdir -p "$(dirname "$LOG_FILE")" "$KIOSK_PROFILE"

# Start backend server if not already listening
if ! curl -fsS "${URL}/api/config" >/dev/null 2>&1; then
  nohup /usr/bin/python3 "${APP_DIR}/server.py" >>"$LOG_FILE" 2>&1 &
  for _ in $(seq 1 30); do
    if curl -fsS "${URL}/api/config" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

EXTRA_FLAGS=(
  "--user-data-dir=${KIOSK_PROFILE}"
  "--noerrdialogs"
  "--disable-infobars"
  "--no-first-run"
  "--disable-session-crashed-bubble"
  "--disable-features=TranslateUI"
  "--check-for-update-interval=31536000"
  "--password-store=basic"
  "--autoplay-policy=no-user-gesture-required"
)

if [[ "${XDG_SESSION_TYPE:-}" == "wayland" || -n "${WAYLAND_DISPLAY:-}" ]]; then
  EXTRA_FLAGS+=("--ozone-platform=wayland")
fi

if [[ "$WINDOWED" -eq 1 ]]; then
  exec /usr/bin/chromium "${EXTRA_FLAGS[@]}" "--app=${URL}" --window-size=1280,720
else
  exec /usr/bin/chromium "${EXTRA_FLAGS[@]}" --kiosk "${URL}"
fi
