#!/usr/bin/env bash
set -euo pipefail

IPTV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR="${IPTV_DIR}/smplayer-config"
INI_FILE="${CONF_DIR}/smplayer.ini"
PLAYLIST="${IPTV_DIR}/playlist.m3u"
DARK_THEME_DIR="${CONF_DIR}/themes/Dark"

mkdir -p "$DARK_THEME_DIR"

# Ensure system Dark icon bundle symlink exists for our custom Dark stylesheet override
if [ -f /usr/share/smplayer/themes/Dark/Dark.rcc ] && [ ! -e "${DARK_THEME_DIR}/Dark.rcc" ]; then
  ln -sf /usr/share/smplayer/themes/Dark/Dark.rcc "${DARK_THEME_DIR}/Dark.rcc"
fi

# Ensure custom Dark IPTV theme (dark mode + hidden playlist bottom toolbar & menu bar) & 720p cap stay active
if [ -f "$INI_FILE" ]; then
  sed -i 's/^iconset=.*/iconset=Dark/' "$INI_FILE"
  sed -i "s|^mplayer_additional_options=.*|mplayer_additional_options=\"--demuxer-max-bytes=32MiB --ytdl=no --script=${IPTV_DIR}/max720p.lua\"|" "$INI_FILE"
fi

# SMPlayer embeds mpv via X11/XWayland window ID (single unified window, no detached popups)
export QT_QPA_PLATFORM=xcb

exec /usr/bin/smplayer \
  -config-path "$CONF_DIR" \
  -defaultgui \
  -actions "show_main_toolbar false show_playlist true" \
  "$PLAYLIST"
