#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/andrey/pi-tv-ui"
AUTOSTART_DIR="${HOME}/.config/autostart"
AUTOSTART_FILE="${AUTOSTART_DIR}/pi-tv-kiosk.desktop"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"
SERVICE_FILE="${SYSTEMD_USER_DIR}/pi-tv-server.service"

cmd="${1:-status}"

enable_kiosk() {
  mkdir -p "$AUTOSTART_DIR" "$SYSTEMD_USER_DIR"

  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Pi TV Kiosk Local Web Server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=PATH=${HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/games:/usr/games
ExecStart=/usr/bin/python3 ${APP_DIR}/server.py
KillMode=process
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now pi-tv-server.service

  cat > "$AUTOSTART_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=Pi TV Kiosk
Comment=Auto-launch Pi TV UI in Chromium Kiosk Mode
Exec=${APP_DIR}/scripts/start-tv.sh
X-GNOME-Autostart-enabled=true
EOF

  echo "Enabled Pi TV boot kiosk mode!"
  echo "  - Backend service: ${SERVICE_FILE} (enabled & running)"
  echo "  - Desktop autostart: ${AUTOSTART_FILE}"
}

disable_kiosk() {
  rm -f "$AUTOSTART_FILE"
  if systemctl --user is-enabled pi-tv-server.service >/dev/null 2>&1 || systemctl --user is-active pi-tv-server.service >/dev/null 2>&1; then
    systemctl --user disable --now pi-tv-server.service || true
  fi
  echo "Disabled Pi TV boot kiosk mode."
  echo "  - Removed: ${AUTOSTART_FILE}"
  echo "  - Stopped & disabled: pi-tv-server.service"
}

show_status() {
  echo "=== Pi TV Kiosk Boot Status ==="
  if [[ -f "$AUTOSTART_FILE" ]]; then
    echo "Desktop Autostart: ENABLED (${AUTOSTART_FILE})"
  else
    echo "Desktop Autostart: DISABLED"
  fi
  if systemctl --user is-active pi-tv-server.service >/dev/null 2>&1; then
    echo "Backend Service:   RUNNING (pi-tv-server.service)"
  else
    echo "Backend Service:   STOPPED"
  fi
  echo ""
  echo "Usage: $0 [enable|disable|status]"
}

case "$cmd" in
  enable)  enable_kiosk ;;
  disable) disable_kiosk ;;
  status)  show_status ;;
  *)
    echo "Usage: $0 [enable|disable|status]" >&2
    exit 1
    ;;
esac
