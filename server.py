#!/usr/bin/env python3
"""Pi TV Kiosk Interface — Local Backend Server (Python 3 stdlib only)."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
CONFIG_PATH = BASE_DIR / "config.json"
KIOSK_PROFILE_MARKER = "pi-tv-kiosk-profile"

ICON_SEARCH_ROOTS = [
    Path.home() / ".local/share/icons",
    Path("/usr/share/icons/hicolor"),
    Path("/usr/share/icons/PiXtrix"),
    Path("/usr/share/icons/Adwaita"),
    Path("/usr/share/icons/Papirus"),
    Path("/usr/share/icons"),
    Path("/usr/share/pixmaps"),
    Path("/var/lib/flatpak/exports/share/icons"),
]

ALLOWED_ICON_EXTS = {".png", ".svg", ".jpg", ".jpeg", ".webp", ".ico", ".xpm"}
PREFERRED_SIZES = ["scalable", "512x512", "256x256", "128x128", "96x96", "64x64", "48x48", "32x32"]

# WMO Weather interpretation codes (Open-Meteo)
WMO_CODES: dict[int, tuple[str, str]] = {
    0: ("Clear Sky", "clear"),
    1: ("Mainly Clear", "partly-cloudy"),
    2: ("Partly Cloudy", "partly-cloudy"),
    3: ("Overcast", "cloudy"),
    45: ("Fog", "fog"),
    48: ("Depositing Rime Fog", "fog"),
    51: ("Light Drizzle", "drizzle"),
    53: ("Drizzle", "drizzle"),
    55: ("Dense Drizzle", "drizzle"),
    56: ("Freezing Drizzle", "drizzle"),
    57: ("Dense Freezing Drizzle", "drizzle"),
    61: ("Light Rain", "rain"),
    63: ("Rain", "rain"),
    65: ("Heavy Rain", "rain"),
    66: ("Freezing Rain", "rain"),
    67: ("Heavy Freezing Rain", "rain"),
    71: ("Light Snow", "snow"),
    73: ("Snow", "snow"),
    75: ("Heavy Snow", "snow"),
    77: ("Snow Grains", "snow"),
    80: ("Light Showers", "rain"),
    81: ("Rain Showers", "rain"),
    82: ("Heavy Showers", "rain"),
    85: ("Snow Showers", "snow"),
    86: ("Heavy Snow Showers", "snow"),
    95: ("Thunderstorm", "storm"),
    96: ("Thunderstorm + Hail", "storm"),
    99: ("Severe Thunderstorm", "storm"),
}

_config_lock = threading.Lock()
_weather_lock = threading.Lock()
_weather_cache: dict[str, Any] = {"timestamp": 0.0, "key": None, "data": None}
_icon_cache: dict[str, Path | None] = {}


def load_config() -> dict[str, Any]:
    with _config_lock:
        with CONFIG_PATH.open("r", encoding="utf-8") as fh:
            return json.load(fh)


def save_config(cfg: dict[str, Any]) -> None:
    with _config_lock:
        tmp = CONFIG_PATH.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        tmp.replace(CONFIG_PATH)


def http_get_json(url: str, timeout: float = 6.0) -> Any:
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "PiTV-Kiosk/1.0 (+http://127.0.0.1)"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def detect_location_by_ip() -> dict[str, Any] | None:
    providers = [
        ("https://ipwho.is/", lambda d: (d.get("city") or d.get("region") or "Local", d.get("latitude"), d.get("longitude")) if d.get("success", True) else None),
        ("https://get.geojs.io/v1/ip/geo.json", lambda d: (d.get("city") or d.get("region") or "Local", float(d["latitude"]), float(d["longitude"])) if "latitude" in d else None),
    ]
    for url, parser in providers:
        try:
            data = http_get_json(url, timeout=5.0)
            parsed = parser(data)
            if parsed and parsed[1] is not None and parsed[2] is not None:
                return {"city": parsed[0], "latitude": float(parsed[1]), "longitude": float(parsed[2])}
        except Exception:
            continue
    return None


def geocode_city(city: str) -> dict[str, Any] | None:
    qs = urllib.parse.urlencode({"name": city, "count": 1, "language": "en", "format": "json"})
    url = f"https://geocoding-api.open-meteo.com/v1/search?{qs}"
    data = http_get_json(url, timeout=6.0)
    results = data.get("results") or []
    if not results:
        return None
    top = results[0]
    label = top.get("name", city)
    if top.get("country_code"):
        label = f"{label}, {top['country_code']}"
    return {
        "city": label,
        "latitude": float(top["latitude"]),
        "longitude": float(top["longitude"]),
    }


def fetch_weather(force: bool = False) -> dict[str, Any]:
    cfg = load_config()
    wcfg = cfg.get("weather", {})
    city_pref = (wcfg.get("city") or "").strip()
    unit = "F" if str(wcfg.get("unit", "C")).upper() == "F" else "C"
    refresh_sec = max(60, int(wcfg.get("refreshMinutes", 15)) * 60)
    cache_key = (city_pref, wcfg.get("latitude"), wcfg.get("longitude"), unit)

    with _weather_lock:
        now = time.time()
        if (
            not force
            and _weather_cache["data"] is not None
            and _weather_cache["key"] == cache_key
            and (now - _weather_cache["timestamp"]) < refresh_sec
        ):
            return _weather_cache["data"]

    try:
        lat = wcfg.get("latitude")
        lon = wcfg.get("longitude")
        city_label = city_pref

        if city_pref:
            geo = geocode_city(city_pref)
            if geo:
                lat, lon, city_label = geo["latitude"], geo["longitude"], geo["city"]
            else:
                return {"ok": False, "error": f"City '{city_pref}' not found", "unit": unit}
        elif lat is None or lon is None:
            geo = detect_location_by_ip()
            if geo:
                lat, lon, city_label = geo["latitude"], geo["longitude"], geo["city"]
            else:
                # Fallback to timezone-derived default (Jerusalem) if offline/geo unavailable
                lat, lon, city_label = 31.7683, 35.2137, "Local"

        temp_unit_param = "fahrenheit" if unit == "F" else "celsius"
        qs = urllib.parse.urlencode(
            {
                "latitude": lat,
                "longitude": lon,
                "current": "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
                "daily": "weather_code,temperature_2m_max,temperature_2m_min",
                "temperature_unit": temp_unit_param,
                "wind_speed_unit": "kmh",
                "timezone": "auto",
                "forecast_days": 4,
            }
        )
        url = f"https://api.open-meteo.com/v1/forecast?{qs}"
        raw = http_get_json(url, timeout=7.0)
        cur = raw.get("current", {})
        daily = raw.get("daily", {})

        code = int(cur.get("weather_code", 0))
        condition, icon_kind = WMO_CODES.get(code, ("Unknown", "cloudy"))
        is_day = bool(cur.get("is_day", 1))

        forecast = []
        dates = daily.get("time") or []
        d_codes = daily.get("weather_code") or []
        d_max = daily.get("temperature_2m_max") or []
        d_min = daily.get("temperature_2m_min") or []
        for idx in range(min(4, len(dates))):
            c_idx = int(d_codes[idx]) if idx < len(d_codes) else 0
            cond_txt, kind = WMO_CODES.get(c_idx, ("", "cloudy"))
            forecast.append(
                {
                    "date": dates[idx],
                    "condition": cond_txt,
                    "icon": kind,
                    "max": round(d_max[idx]) if idx < len(d_max) and d_max[idx] is not None else None,
                    "min": round(d_min[idx]) if idx < len(d_min) and d_min[idx] is not None else None,
                }
            )

        result = {
            "ok": True,
            "city": city_label,
            "unit": unit,
            "temperature": round(cur.get("temperature_2m", 0)),
            "feelsLike": round(cur.get("apparent_temperature", cur.get("temperature_2m", 0))),
            "humidity": cur.get("relative_humidity_2m"),
            "windKmh": round(cur.get("wind_speed_10m", 0)),
            "code": code,
            "condition": condition,
            "icon": icon_kind,
            "isDay": is_day,
            "forecast": forecast,
            "updatedAt": int(time.time()),
        }
        with _weather_lock:
            _weather_cache["timestamp"] = time.time()
            _weather_cache["key"] = cache_key
            _weather_cache["data"] = result
        return result
    except Exception as exc:
        with _weather_lock:
            if _weather_cache["data"] is not None:
                stale = dict(_weather_cache["data"])
                stale["stale"] = True
                return stale
        return {"ok": False, "error": str(exc), "unit": unit}


def resolve_icon_path(icon_name: str) -> Path | None:
    if not icon_name:
        return None
    if icon_name in _icon_cache:
        cached = _icon_cache[icon_name]
        if cached is None or cached.exists():
            return cached

    # Direct absolute file path (only allowed if inside home or /usr/share)
    if icon_name.startswith("/"):
        p = Path(icon_name).resolve()
        allowed_prefixes = [Path.home().resolve(), Path("/usr/share").resolve(), Path("/var/lib/flatpak").resolve()]
        if (
            p.is_file()
            and p.suffix.lower() in ALLOWED_ICON_EXTS
            and any(str(p).startswith(str(pref)) for pref in allowed_prefixes)
        ):
            _icon_cache[icon_name] = p
            return p
        _icon_cache[icon_name] = None
        return None

    # Sanitize theme icon name
    if not re.match(r"^[A-Za-z0-9._-]+$", icon_name):
        return None

    candidates: list[tuple[int, Path]] = []
    size_rank = {s: i for i, s in enumerate(PREFERRED_SIZES)}

    def score_path(path: Path) -> int:
        parts = path.parts
        rank = 50
        for part in parts:
            if part in size_rank:
                rank = min(rank, size_rank[part])
        if path.suffix.lower() == ".svg":
            rank -= 2
        elif path.suffix.lower() == ".png":
            rank -= 1
        return rank

    for root in ICON_SEARCH_ROOTS:
        if not root.exists():
            continue
        # Fast direct checks for common XDG layouts
        for size in PREFERRED_SIZES:
            for sub in ("apps", "categories", "places", ""):
                d = root / size / sub if sub else root / size
                if not d.is_dir():
                    continue
                for ext in (".svg", ".png", ".webp", ".jpg"):
                    candidate = d / f"{icon_name}{ext}"
                    if candidate.is_file():
                        candidates.append((score_path(candidate), candidate))
        for ext in (".svg", ".png", ".webp", ".jpg", ".xpm"):
            direct = root / f"{icon_name}{ext}"
            if direct.is_file():
                candidates.append((score_path(direct) + 5, direct))
        if candidates:
            break

    # Fallback deeper scan in hicolor / local icons if not found in fast paths
    if not candidates:
        for root in (Path.home() / ".local/share/icons", Path("/usr/share/icons"), Path("/var/lib/flatpak/exports/share/icons")):
            if not root.exists():
                continue
            for ext in ("svg", "png"):
                for match in root.rglob(f"{icon_name}.{ext}"):
                    if match.is_file():
                        candidates.append((score_path(match), match))
                        if len(candidates) >= 8:
                            break
            if candidates:
                break

    best = min(candidates, key=lambda item: item[0])[1] if candidates else None
    _icon_cache[icon_name] = best
    return best


def get_desktop_env() -> dict[str, str]:
    env = os.environ.copy()
    uid = os.getuid()
    runtime_dir = env.get("XDG_RUNTIME_DIR") or f"/run/user/{uid}"
    env["XDG_RUNTIME_DIR"] = runtime_dir

    if not env.get("WAYLAND_DISPLAY"):
        rt = Path(runtime_dir)
        for sock_name in ("wayland-0", "wayland-1"):
            if (rt / sock_name).exists():
                env["WAYLAND_DISPLAY"] = sock_name
                break

    if not env.get("DISPLAY"):
        if Path("/tmp/.X11-unix/X0").exists():
            env["DISPLAY"] = ":0"

    if not env.get("DBUS_SESSION_BUS_ADDRESS"):
        bus = Path(runtime_dir) / "bus"
        if bus.exists():
            env["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={bus}"

    return env


def get_system_status() -> dict[str, Any]:
    cpu_temp_c = None
    thermal = Path("/sys/class/thermal/thermal_zone0/temp")
    try:
        if thermal.is_file():
            cpu_temp_c = round(int(thermal.read_text().strip()) / 1000.0, 1)
    except Exception:
        pass

    volume = None
    muted = False
    if shutil.which("wpctl"):
        try:
            out = subprocess.check_output(
                ["wpctl", "get-volume", "@DEFAULT_AUDIO_SINK@"],
                env=get_desktop_env(),
                text=True,
                timeout=1.5,
            ).strip()
            # Example: "Volume: 0.65" or "Volume: 0.65 [MUTED]"
            m = re.search(r"Volume:\s*([0-9.]+)", out)
            if m:
                volume = round(float(m.group(1)) * 100)
            muted = "MUTED" in out.upper()
        except Exception:
            pass

    online = False
    try:
        with socket.create_connection(("1.1.1.1", 53), timeout=1.0):
            online = True
    except Exception:
        pass

    return {
        "cpuTempC": cpu_temp_c,
        "volume": volume,
        "muted": muted,
        "online": online,
        "hostname": socket.gethostname(),
    }


def launch_item(item_id: str) -> tuple[bool, str]:
    cfg = load_config()
    target = None
    for section in cfg.get("sections", []):
        for item in section.get("items", []):
            if item.get("id") == item_id:
                target = item
                break
        if target:
            break

    if not target:
        return False, f"Unknown item id: {item_id}"

    cmd = target.get("command")
    if not isinstance(cmd, list) or not cmd or not all(isinstance(c, str) for c in cmd):
        return False, "Invalid command configuration"

    cwd = target.get("cwd") or str(Path.home())
    env = get_desktop_env()

    try:
        subprocess.Popen(
            cmd,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        return True, f"Launched {target.get('name', item_id)}"
    except FileNotFoundError:
        return False, f"Executable not found: {cmd[0]}"
    except Exception as exc:
        return False, f"Launch failed: {exc}"


def handle_power_action(action: str) -> tuple[bool, str]:
    env = get_desktop_env()
    if action == "volume_up":
        if shutil.which("wpctl"):
            subprocess.run(["wpctl", "set-volume", "-l", "1.5", "@DEFAULT_AUDIO_SINK@", "5%+"], env=env, check=False)
            return True, "Volume increased"
        return False, "Audio control unavailable"

    if action == "volume_down":
        if shutil.which("wpctl"):
            subprocess.run(["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", "5%-"], env=env, check=False)
            return True, "Volume decreased"
        return False, "Audio control unavailable"

    if action == "volume_mute":
        if shutil.which("wpctl"):
            subprocess.run(["wpctl", "set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"], env=env, check=False)
            return True, "Mute toggled"
        return False, "Audio control unavailable"

    if action == "exit_kiosk":
        # Close only the dedicated Pi TV kiosk Chromium instance
        subprocess.Popen(
            ["pkill", "-f", KIOSK_PROFILE_MARKER],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return True, "Exiting kiosk mode"

    if action == "reboot":
        subprocess.Popen(["systemctl", "reboot"], env=env)
        return True, "Rebooting Raspberry Pi..."

    if action == "shutdown":
        subprocess.Popen(["systemctl", "poweroff"], env=env)
        return True, "Shutting down Raspberry Pi..."

    return False, f"Unsupported action: {action}"


class PiTVHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, format: str, *args: Any) -> None:
        # Compact server logs
        sys.stderr.write(f"[pi-tv] {self.address_string()} - {format % args}\n")

    def send_json(self, payload: Any, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 1_000_000:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/api/config":
            self.send_json(load_config())
            return

        if path == "/api/weather":
            force = query.get("force", ["0"])[0] in ("1", "true", "yes")
            self.send_json(fetch_weather(force=force))
            return

        if path == "/api/system":
            self.send_json(get_system_status())
            return

        if path == "/api/icon":
            icon_name = query.get("name", [""])[0]
            icon_path = resolve_icon_path(icon_name)
            if not icon_path or not icon_path.is_file():
                self.send_response(HTTPStatus.NOT_FOUND)
                self.end_headers()
                return
            ctype, _ = mimetypes.guess_type(str(icon_path))
            if icon_path.suffix.lower() == ".svg":
                ctype = "image/svg+xml"
            data = icon_path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "public, max-age=3600")
            self.end_headers()
            self.wfile.write(data)
            return

        if path == "/":
            self.path = "/index.html"
        super().do_GET()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        try:
            body = self.read_json_body()
        except Exception as exc:
            self.send_json({"ok": False, "error": f"Invalid JSON: {exc}"}, status=HTTPStatus.BAD_REQUEST)
            return

        if path == "/api/launch":
            item_id = str(body.get("id", "")).strip()
            ok, msg = launch_item(item_id)
            self.send_json({"ok": ok, "message": msg}, status=HTTPStatus.OK if ok else HTTPStatus.BAD_REQUEST)
            return

        if path == "/api/power":
            action = str(body.get("action", "")).strip()
            ok, msg = handle_power_action(action)
            self.send_json({"ok": ok, "message": msg}, status=HTTPStatus.OK if ok else HTTPStatus.BAD_REQUEST)
            return

        if path == "/api/settings":
            cfg = load_config()
            if "weather" in body and isinstance(body["weather"], dict):
                w = cfg.setdefault("weather", {})
                if "city" in body["weather"]:
                    w["city"] = str(body["weather"]["city"]).strip()
                    w["latitude"] = None
                    w["longitude"] = None
                if "unit" in body["weather"]:
                    w["unit"] = "F" if str(body["weather"]["unit"]).upper() == "F" else "C"
            if "clock" in body and isinstance(body["clock"], dict):
                c = cfg.setdefault("clock", {})
                if "hour24" in body["clock"]:
                    c["hour24"] = bool(body["clock"]["hour24"])
                if "showSeconds" in body["clock"]:
                    c["showSeconds"] = bool(body["clock"]["showSeconds"])
            if "title" in body and isinstance(body["title"], str) and body["title"].strip():
                cfg["title"] = body["title"].strip()[:40]
            save_config(cfg)
            weather_data = fetch_weather(force=True)
            self.send_json({"ok": True, "config": cfg, "weather": weather_data})
            return

        self.send_json({"ok": False, "error": "Not found"}, status=HTTPStatus.NOT_FOUND)


def main() -> None:
    cfg = load_config()
    host = os.environ.get("PITV_HOST", "127.0.0.1")
    port = int(os.environ.get("PITV_PORT", cfg.get("port", 8787)))
    ThreadingHTTPServer.allow_reuse_address = True
    server = ThreadingHTTPServer((host, port), PiTVHandler)
    print(f"Pi TV server listening on http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
