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

# Prevent "Restore pages?" bubble after an unclean power-off
PREFS_FILE="${KIOSK_PROFILE}/Default/Preferences"
if [[ -f "$PREFS_FILE" ]]; then
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/g; s/"exit_type":"Crashed"/"exit_type":"Normal"/g' "$PREFS_FILE" || true
fi

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

# Invoke the Chromium binary directly when present to avoid /etc/chromium.d/00-rpi-vars
# forcing --force-renderer-accessibility and /etc/chromium.d/dev-shm shell warnings.
if [[ -x /usr/lib/chromium/chromium ]]; then
  CHROMIUM_BIN="/usr/lib/chromium/chromium"
else
  CHROMIUM_BIN="/usr/bin/chromium"
fi

EXTRA_FLAGS=(
  "--user-data-dir=${KIOSK_PROFILE}"
  # Hardware acceleration & Raspberry Pi 4 memory stability
  "--enable-gpu-rasterization"
  "--ignore-gpu-blocklist"
  "--enable-low-res-tiling"
  "--num-raster-threads=4"
  "--disable-dev-shm-usage"
  # Snappy TV remote scrolling & kiosk lock-in
  "--cc-scroll-animation-duration-in-seconds=0.22"
  "--disable-pinch"
  "--overscroll-history-navigation=0"
  "--autoplay-policy=no-user-gesture-required"
  # Lean kiosk shell (lower RAM & faster startup; desktop browser profile untouched)
  "--disable-extensions"
  "--disable-sync"
  "--disable-background-networking"
  "--disable-component-update"
  "--disable-default-apps"
  "--disable-pings"
  "--metrics-recording-only"
  "--no-first-run"
  "--no-default-browser-check"
  "--noerrdialogs"
  "--disable-session-crashed-bubble"
  "--password-store=basic"
  "--check-for-update-interval=31536000"
  "--disable-features=Translate,OptimizationHints,MediaRouter,UseChromeOSDirectVideoDecoder"
)

if [[ "${XDG_SESSION_TYPE:-}" == "wayland" || -n "${WAYLAND_DISPLAY:-}" ]]; then
  EXTRA_FLAGS+=("--ozone-platform=wayland")
fi

if [[ "$WINDOWED" -eq 1 ]]; then
  exec "$CHROMIUM_BIN" "${EXTRA_FLAGS[@]}" "--app=${URL}" --window-size=1280,720
else
  exec "$CHROMIUM_BIN" "${EXTRA_FLAGS[@]}" --kiosk "${URL}"
fi
