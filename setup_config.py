#!/usr/bin/env python3
"""Generate config.json from config.json.example + ~/Documents/HiveMQ.txt.

Runs ON THE PI ONLY. Secrets never leave the Pi: this script reads the
HiveMQ credential file and writes config.json (mode 0600). It prints only
the broker host and whether username/password were found, never values.
"""

import json
import os
import re
import sys

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
CRED_PATH = os.path.expanduser("~/Documents/HiveMQ.txt")


def parse_hivemq(path):
    info = {}
    with open(path) as f:
        for line in f:
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            info[k.strip().lower()] = v.strip()
    url = info.get("tls mqtt url") or info.get("mqtt url", "")
    url = re.sub(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", "", url).strip()
    if ":" in url:
        host, port_s = url.rsplit(":", 1)
        port = int(port_s)
    else:
        host, port = url, 8883
    return {"host": host, "port": port,
            "username": info.get("username", ""),
            "password": info.get("password", "")}


def main():
    example = os.path.join(PROJECT_DIR, "config.json.example")
    with open(example) as f:
        cfg = json.load(f)
    if not os.path.exists(CRED_PATH):
        print(f"credential file not found: {CRED_PATH}", file=sys.stderr)
        sys.exit(1)
    creds = parse_hivemq(CRED_PATH)
    if not creds["host"] or not creds["username"] or not creds["password"]:
        print("could not parse host/username/password from credential file",
              file=sys.stderr)
        sys.exit(1)
    cfg["mqtt"]["host"] = creds["host"]
    cfg["mqtt"]["port"] = creds["port"]
    cfg["mqtt"]["username"] = creds["username"]
    cfg["mqtt"]["password"] = creds["password"]
    out = os.path.join(PROJECT_DIR, "config.json")
    with open(out, "w") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(out, 0o600)
    print(f"wrote {out} (0600): host={creds['host']} port={creds['port']} "
          f"username=set password=set")


if __name__ == "__main__":
    main()
