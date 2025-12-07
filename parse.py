#!/usr/bin/env python3
"""
Parse hanzi nginx access logs and emit a JSON dataset with geo info for the globe view.
Uses mmdblookup (already installed) against /usr/share/GeoIP/GeoLite2-City.mmdb.
No external Python deps required.
"""
import argparse
import datetime as dt
import json
import os
import re
import subprocess
from typing import Dict, Optional

LOG_PATH = "/var/log/nginx/hanzi.access.log"
GEO_DB = "/usr/share/GeoIP/GeoLite2-City.mmdb"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_PATH = os.path.join(BASE_DIR, "web", "data.json")

# Matches current nginx log lines with cf-ip / cf-country fields
LOG_RE = re.compile(
    r'^(?P<ip>\S+)\s+\S+\s+\S+\s+\[(?P<ts>[^\]]+)\]\s+"(?P<req>[^"]+)"\s+'
    r'(?P<status>\d{3})\s+(?P<bytes>\d+)\s+"(?P<ref>[^"]*)"\s+"(?P<ua>[^"]*)"\s+'
    r'cf-ip=(?P<cf_ip>\S+)\s+xfwd=(?P<xfwd>.*?)\s+host=(?P<host>\S+)\s+sn=(?P<sn>\S+)\s+cf-country=(?P<cf_country>\S+)\s+cache=(?P<cache>\S+)'
)


def parse_timestamp(raw: str) -> str:
    """Return ISO8601 string from nginx time."""
    try:
        dt_obj = dt.datetime.strptime(raw, "%d/%b/%Y:%H:%M:%S %z")
        return dt_obj.isoformat()
    except Exception:
        return raw  # keep raw if parsing fails


def lookup_geo(ip: str, geo_db_path: str) -> Optional[Dict]:
    """Lookup geo info via mmdblookup. Returns None on failure."""
    if not os.path.exists(geo_db_path):
        return None
    try:
        res = subprocess.run(
            ["mmdblookup", "--file", geo_db_path, "--ip", ip],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return None
    if res.returncode != 0 or not res.stdout:
        return None
    blob = res.stdout
    def rex(pattern: str):
        m = re.search(pattern, blob, re.S)
        return m.group(1) if m else None
    country = rex(r'"country":\s*{.*?"iso_code":\s*"([^"]+)"')
    city = rex(r'"city":\s*{.*?"en":\s*"([^"]+)"')
    lat = rex(r'"latitude":\s*\n\s*([0-9\.\-]+)')
    lon = rex(r'"longitude":\s*\n\s*([0-9\.\-]+)')
    try:
        lat_f = float(lat) if lat is not None else None
        lon_f = float(lon) if lon is not None else None
    except ValueError:
        lat_f = lon_f = None
    return {
        "country": country,
        "city": city,
        "lat": lat_f,
        "lon": lon_f,
    }


def classify_device(ua: str) -> str:
    """Return a simple device/client label from user agent."""
    ua_lower = ua.lower()
    if any(token in ua_lower for token in ["bot", "crawl", "spider"]):
        return "Bot"
    if "edg" in ua_lower:
        return "Edge"
    if "chrome" in ua_lower or "crios" in ua_lower or "chromium" in ua_lower:
        return "Chrome"
    if "safari" in ua_lower and "chrome" not in ua_lower:
        return "Safari"
    if "firefox" in ua_lower:
        return "Firefox"
    if "msie" in ua_lower or "trident" in ua_lower:
        return "IE"
    return "Other"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Parse nginx logs and emit geo data JSON")
    parser.add_argument("--log-path", default=LOG_PATH, help="Path to nginx access log")
    parser.add_argument("--geo-db", default=GEO_DB, help="Path to GeoLite2-City mmdb file")
    return parser.parse_args()


def main():
    args = parse_args()
    log_path = args.log_path
    geo_db_path = args.geo_db

    if not os.path.exists(log_path):
        raise SystemExit(f"Log not found: {log_path}")
    web_dir = os.path.dirname(OUTPUT_PATH)
    os.makedirs(web_dir, exist_ok=True)

    hits = []
    ip_info: Dict[str, Dict] = {}
    with open(log_path) as f:
        for line in f:
            m = LOG_RE.match(line.strip())
            if not m:
                continue
            data = m.groupdict()
            ts_iso = parse_timestamp(data["ts"])
            cf_ip = data.get("cf_ip") or data["ip"]
            host = data.get("host")
            path = data["req"].split(" ")[1] if " " in data["req"] else data["req"]
            ua_type = classify_device(data["ua"])
            hit = {
                "ip": cf_ip,
                "orig_ip": data["ip"],
                "ts": ts_iso,
                "request": data["req"],
                "path": path,
                "status": int(data["status"]),
                "bytes": int(data["bytes"]),
                "referer": data["ref"] if data["ref"] != "-" else None,
                "ua": data["ua"],
                "ua_type": ua_type,
                "host": host,
                "country_hint": data.get("cf_country"),
            }
            hits.append(hit)

    unique_ips = {h["ip"] for h in hits}
    geo_cache: Dict[str, Dict] = {}
    for ip in unique_ips:
        geo_cache[ip] = lookup_geo(ip, geo_db_path) or {}

    for h in hits:
        info = geo_cache.get(h["ip"], {})
        h.update({
            "country": info.get("country") or h.get("country_hint"),
            "city": info.get("city"),
            "lat": info.get("lat"),
            "lon": info.get("lon"),
        })
        ip_entry = ip_info.setdefault(h["ip"], {
            "ip": h["ip"],
            "count": 0,
            "first_seen": h["ts"],
            "last_seen": h["ts"],
            "country": h.get("country"),
            "city": h.get("city"),
            "lat": h.get("lat"),
            "lon": h.get("lon"),
            "ua_type": h.get("ua_type"),
        })
        ip_entry["count"] += 1
        ip_entry["last_seen"] = h["ts"]
        if h.get("country"):
            ip_entry["country"] = h["country"]
        if h.get("city"):
            ip_entry["city"] = h["city"]
        if h.get("lat") is not None and h.get("lon") is not None:
            ip_entry["lat"] = h["lat"]
            ip_entry["lon"] = h["lon"]
        if h.get("ua_type"):
            ip_entry["ua_type"] = h["ua_type"]

    payload = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "total_hits": len(hits),
        "unique_ips": len(unique_ips),
        "ips": sorted(ip_info.values(), key=lambda x: x["count"], reverse=True),
        "hits": hits[-1000:],  # keep recent slice for table
    }
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        f.write(json.dumps(payload, indent=2))
    print(f"Wrote {OUTPUT_PATH} (hits: {len(payload['hits'])}, unique IPs: {len(unique_ips)})")


if __name__ == "__main__":
    main()
