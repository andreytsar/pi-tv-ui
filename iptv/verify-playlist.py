#!/usr/bin/env python3
"""Re-verify all channels in /home/andrey/iptv/playlist.m3u using ffprobe.

Usage:
  python3 ~/iptv/verify-playlist.py            # check status only
  python3 ~/iptv/verify-playlist.py --prune    # remove dead channels (keeps a .bak backup)
"""
import argparse
import concurrent.futures
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import urllib.parse
import urllib.request

PLAYLIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "playlist.m3u")
UA = "VLC/3.0.24 LibVLC/3.0.24"
SSL_CTX = ssl.create_default_context()
SSL_CTX.check_hostname = False
SSL_CTX.verify_mode = ssl.CERT_NONE


def parse_playlist(path):
    headers = []
    channels = []
    with open(path, "r", encoding="utf-8") as f:
        lines = [l.rstrip("\r\n") for l in f]
    i = 0
    while i < len(lines) and not lines[i].startswith("#EXTINF:"):
        headers.append(lines[i])
        i += 1
    while i < len(lines):
        if lines[i].startswith("#EXTINF:"):
            block = [lines[i]]
            i += 1
            while i < len(lines) and lines[i].startswith("#"):
                block.append(lines[i])
                i += 1
            if i < len(lines):
                url = lines[i]
                i += 1
                title = block[0].rsplit(",", 1)[-1].strip()
                channels.append({"block": block, "url": url, "title": title})
                continue
        i += 1
    return headers, channels


def resolve_single_variant(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=8, context=SSL_CTX) as resp:
        final_url = resp.geturl()
        text = resp.read(262144).decode("utf-8", errors="ignore")
    if "#EXT-X-STREAM-INF" not in text:
        return final_url
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    variants = []
    for idx, line in enumerate(lines):
        if line.startswith("#EXT-X-STREAM-INF"):
            bw_m = re.search(r"BANDWIDTH=(\d+)", line)
            bw = int(bw_m.group(1)) if bw_m else 0
            nxt = idx + 1
            while nxt < len(lines) and lines[nxt].startswith("#"):
                nxt += 1
            if nxt < len(lines):
                variants.append((bw, urllib.parse.urljoin(final_url, lines[nxt])))
    if not variants:
        return final_url
    variants.sort(key=lambda x: x[0])
    return variants[len(variants) // 2][1]


def probe(ch):
    try:
        target = resolve_single_variant(ch["url"])
        cmd = [
            "ffprobe", "-v", "error",
            "-user_agent", UA,
            "-rw_timeout", "8000000",
            "-analyzeduration", "3000000",
            "-probesize", "800000",
            "-show_entries", "stream=codec_type,width,height",
            "-of", "json",
            target,
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=14)
        if proc.returncode != 0:
            return ch, False
        streams = json.loads(proc.stdout or "{}").get("streams", [])
        has_video = any(s.get("codec_type") == "video" and s.get("width", 0) > 0 for s in streams)
        return ch, has_video
    except Exception:
        return ch, False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prune", action="store_true", help="Remove offline channels from playlist.m3u")
    ap.add_argument("--playlist", default=PLAYLIST)
    args = ap.parse_args()

    headers, channels = parse_playlist(args.playlist)
    print(f"Checking {len(channels)} channels in {args.playlist}...")
    working, dead = [], []
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        for ch, ok in ex.map(probe, channels):
            status = "OK  " if ok else "DEAD"
            print(f"  [{status}] {ch['title']}")
            (working if ok else dead).append(ch)

    print(f"\nSummary: {len(working)} working, {len(dead)} dead.")
    if args.prune and dead:
        bak = args.playlist + ".bak"
        shutil.copy2(args.playlist, bak)
        out = list(headers)
        for ch in working:
            out.extend(ch["block"])
            out.append(ch["url"])
        with open(args.playlist, "w", encoding="utf-8") as f:
            f.write("\n".join(out) + "\n")
        print(f"Pruned {len(dead)} dead channel(s). Backup saved to {bak}.")


if __name__ == "__main__":
    sys.exit(main())
