"""Jaeger web UI (v0.2.1): embedded HTTP server for muse-pi-yolo-mqtt.

Serves the static UI plus a small JSON API backed by the live YoloSensor
object. Stdlib only. No auth: LAN-only by Scott's decision (DESIGN.md §13).

The sensor owns all config writes: UI config/capture requests are routed
through the sensor's message queue so the main loop stays the single
config writer (same path as MQTT config/set).
"""

import base64
import json
import os
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import cv2

VERSION_FALLBACK = "unknown"
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
ALLOWED_STATIC = {"index.html", "app.js", "style.css", "logo.png"}
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
}
MAX_BODY_BYTES = 65536



class StreamHub:
    """Fan-out for server-sent events.

    The sensor publishes a small JSON message whenever something the UI
    shows changes (new event stored, new frame captured, config changed).
    Each SSE client gets its own bounded queue; a slow client drops
    messages (it resyncs on reconnect) instead of blocking the sensor.
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._subs = set()

    def subscribe(self):
        q = queue.Queue(maxsize=32)
        with self._lock:
            self._subs.add(q)
        return q

    def unsubscribe(self, q):
        with self._lock:
            self._subs.discard(q)

    def publish(self, payload):
        with self._lock:
            subs = list(self._subs)
        for q in subs:
            try:
                q.put_nowait(payload)
            except queue.Full:
                pass


def _utcnow_iso():
    import datetime
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace(
        "+00:00", "Z")


def _valid_event_id(event_id):
    return bool(event_id) and all(
        c.isalnum() or c in "-_TZ" for c in event_id)


def _ts_from_filename(stem):
    """Parse 'YYYYMMDDTHHMMSSZ_xxxx' -> ISO-8601 UTC, or None."""
    try:
        ts = stem[:15]
        return (f"{ts[0:4]}-{ts[4:6]}-{ts[6:8]}"
                f"T{ts[9:11]}:{ts[11:13]}:{ts[13:15]}Z")
    except (IndexError, ValueError):
        return None


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class JaegerWebServer:
    """Owns the ThreadingHTTPServer bound to a YoloSensor instance."""

    def __init__(self, sensor, host="0.0.0.0", port=8082):
        self.sensor = sensor
        self.host = host
        self.port = port
        self.hub = StreamHub()
        sensor_ref = sensor
        hub = self.hub

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            # ---- plumbing ----
            def log_message(self, *args):
                pass

            def _send_bytes(self, data, content_type, status=200):
                body = data if isinstance(data, bytes) else data.encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            def _send_json(self, obj, status=200):
                self._send_bytes(json.dumps(obj), "application/json",
                                 status=status)

            def _send_error_json(self, status, message):
                self._send_json({"error": message}, status=status)

            def _read_json_body(self):
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                except ValueError:
                    return None
                if length <= 0 or length > MAX_BODY_BYTES:
                    return None
                raw = self.rfile.read(length)
                try:
                    data = json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    return None
                return data if isinstance(data, dict) else None

            def _camera_or_400(self, params):
                cam_id = params.get("camera", [None])[0]
                if cam_id is None:
                    cams = sensor_ref.cameras
                    return cams[0] if cams else None
                cam = next((c for c in sensor_ref.cameras
                            if c["id"] == cam_id), None)
                if cam is None:
                    self._send_error_json(400, f"unknown camera {cam_id}")
                    return False
                return cam

            # ---- routing ----
            def do_GET(self):
                parsed = urlparse(self.path)
                path = parsed.path
                params = parse_qs(parsed.query)
                try:
                    if path == "/":
                        self._serve_static("index.html")
                    elif path.startswith("/static/"):
                        name = path[len("/static/"):]
                        if name in ALLOWED_STATIC:
                            self._serve_static(name)
                        else:
                            self._send_error_json(404, "not found")
                    elif path == "/api/status":
                        self._api_status()
                    elif path == "/api/cameras":
                        self._api_cameras()
                    elif path == "/api/counts":
                        self._api_counts(params)
                    elif path == "/api/events":
                        self._api_events(params)
                    elif path == "/api/image":
                        self._api_image(params)
                    elif path == "/api/latest":
                        self._api_latest(params)
                    elif path == "/api/stream":
                        self._api_stream()
                    elif path == "/api/config":
                        self._api_config_get(params)
                    elif path == "/api/classes":
                        self._api_classes(params)
                    else:
                        self._send_error_json(404, "not found")
                except BrokenPipeError:
                    pass
                except Exception as e:  # never crash the server thread
                    try:
                        self._send_error_json(500, f"internal error: {e}")
                    except Exception:
                        pass

            def do_POST(self):
                parsed = urlparse(self.path)
                try:
                    if parsed.path == "/api/config":
                        self._api_config_post()
                    elif parsed.path == "/api/capture_now":
                        self._api_capture_now()
                    else:
                        self._send_error_json(404, "not found")
                except BrokenPipeError:
                    pass
                except Exception as e:
                    try:
                        self._send_error_json(500, f"internal error: {e}")
                    except Exception:
                        pass

            # ---- static ----
            def _serve_static(self, name):
                p = os.path.join(STATIC_DIR, name)
                try:
                    with open(p, "rb") as f:
                        data = f.read()
                except OSError:
                    self._send_error_json(404, "static file missing")
                    return
                ext = os.path.splitext(name)[1]
                self._send_bytes(data,
                                 CONTENT_TYPES.get(ext, "application/octet-stream"))

            # ---- API ----
            def _api_status(self):
                s = sensor_ref
                total_files = total_bytes = 0
                for cam in s.cameras:
                    f, b = s.buffer_stats(cam["id"])
                    total_files += f
                    total_bytes += b
                uptime = round(
                    __import__("time").time() - s.started_monotonic, 1)
                self._send_json({
                    "service": "jaeger",
                    "version": getattr(s, "version", VERSION_FALLBACK),
                    "cpu_serial": s.serial,
                    "mqtt_connected": bool(s.mqtt_connected),
                    "uptime_seconds": uptime,
                    "started_at": s.started_at,
                    "last_cycle_seconds": s.last_cycle_seconds,
                    "last_cycle_at": s.last_cycle_at,
                    "cameras": [c["id"] for c in s.cameras],
                    "buffer": {
                        "files": total_files,
                        "bytes": total_bytes,
                        "cap_bytes": s.config["buffer"].get(
                            "cap_bytes", 2 ** 30),
                    },
                })

            def _api_cameras(self):
                s = sensor_ref
                self._send_json({
                    "cameras": [s.camera_config_payload(cam)
                                for cam in s.cameras],
                })

            def _api_counts(self, params):
                cam = self._camera_or_400(params)
                if cam is False:
                    return
                if cam is None:
                    self._send_error_json(404, "no cameras configured")
                    return
                counts = {cam["id_to_name"][cid]: cam["last_counts"].get(cid, 0)
                          for cid in cam["watch_ids"]}
                self._send_json({
                    "camera_id": cam["id"],
                    "timestamp": _utcnow_iso(),
                    "counts": counts,
                })

            def _api_classes(self, params):
                cam = self._camera_or_400(params)
                if cam is False:
                    return
                if cam is None:
                    self._send_error_json(404, "no cameras configured")
                    return
                names = sorted(set(cam["id_to_name"].values()))
                self._send_json({
                    "camera_id": cam["id"],
                    "classes": names,
                    "watchlist": list(cam["cfg"].get("watchlist", [])),
                })

            def _api_events(self, params):
                s = sensor_ref
                cam_id = params.get("camera", [None])[0]
                class_filter = params.get("class", [None])[0]
                before = params.get("before", [None])[0]
                try:
                    limit = int(params.get("limit", ["25"])[0])
                except ValueError:
                    limit = 25
                limit = max(1, min(100, limit))
                if cam_id is not None and not any(
                        c["id"] == cam_id for c in s.cameras):
                    self._send_error_json(400, f"unknown camera {cam_id}")
                    return
                buf_root = os.path.join(
                    os.path.dirname(os.path.abspath(__file__)),
                    s.config["buffer"].get("dir", "buffer"))
                cam_ids = [cam_id] if cam_id else [c["id"] for c in s.cameras]
                entries = []
                for cid in cam_ids:
                    d = os.path.join(buf_root, cid)
                    if not os.path.isdir(d):
                        continue
                    jpgs = set()
                    for fn in os.listdir(d):
                        if fn.lower().endswith(".jpg"):
                            jpgs.add(fn[:-4])
                    for fn in os.listdir(d):
                        if not fn.lower().endswith(".json"):
                            continue
                        stem = fn[:-5]
                        try:
                            with open(os.path.join(d, fn)) as f:
                                data = json.load(f)
                        except (OSError, ValueError):
                            continue
                        if not isinstance(data, dict):
                            continue
                        entry = {
                            "event_id": data.get("event_id", stem),
                            "camera_id": data.get("camera_id", cid),
                            "timestamp": data.get("timestamp")
                            or _ts_from_filename(stem),
                            "counts": data.get("counts", {}),
                            "detections": data.get("detections", {}),
                            "model": data.get("model"),
                            "threshold": data.get("threshold"),
                            "image_url": (f"/api/image?camera={cid}"
                                          f"&event={stem}"),
                            "has_metadata": True,
                        }
                        entries.append(entry)
                        jpgs.discard(stem)
                    for stem in jpgs:  # .jpg without a sidecar (pre-v0.2.0)
                        entries.append({
                            "event_id": stem,
                            "camera_id": cid,
                            "timestamp": _ts_from_filename(stem),
                            "counts": {},
                            "detections": {},
                            "model": None,
                            "threshold": None,
                            "image_url": (f"/api/image?camera={cid}"
                                          f"&event={stem}"),
                            "has_metadata": False,
                        })
                entries.sort(key=lambda e: e["event_id"], reverse=True)
                if params.get("hide_empty", [None])[0] == "1":
                    # Hide events positively known to have no objects
                    # (all counts zero). Events with unknown counts
                    # (pre-v0.2.0, no sidecar) stay visible.
                    entries = [e for e in entries
                               if not (e["counts"]
                                       and all(v == 0
                                               for v in e["counts"].values()))]
                if class_filter:
                    entries = [e for e in entries
                               if e["counts"].get(class_filter, 0) > 0
                               or len(e["detections"].get(class_filter,
                                                          [])) > 0]
                if before:
                    entries = [e for e in entries if e["event_id"] < before]
                page = entries[:limit]
                has_more = len(entries) > limit
                self._send_json({
                    "events": page,
                    "has_more": has_more,
                    "next_before": page[-1]["event_id"] if has_more else None,
                })

            def _api_image(self, params):
                s = sensor_ref
                cam_id = params.get("camera", [None])[0]
                event_id = params.get("event", [None])[0]
                if not cam_id or not event_id or not _valid_event_id(event_id):
                    self._send_error_json(400, "bad camera or event_id")
                    return
                if not any(c["id"] == cam_id for c in s.cameras):
                    self._send_error_json(400, f"unknown camera {cam_id}")
                    return
                buf_root = os.path.join(
                    os.path.dirname(os.path.abspath(__file__)),
                    s.config["buffer"].get("dir", "buffer"))
                p = os.path.join(buf_root, cam_id, event_id + ".jpg")
                # Path must stay inside the buffer dir (no traversal).
                if os.path.commonpath(
                        [os.path.abspath(p), os.path.abspath(buf_root)]) \
                        != os.path.abspath(buf_root):
                    self._send_error_json(400, "bad path")
                    return
                try:
                    with open(p, "rb") as f:
                        data = f.read()
                except OSError:
                    self._send_error_json(404, "image not found")
                    return
                self._send_bytes(data, "image/jpeg")

            def _api_latest(self, params):
                cam = self._camera_or_400(params)
                if cam is False:
                    return
                if cam is None:
                    self._send_error_json(404, "no cameras configured")
                    return
                frame = cam.get("latest_frame")
                if frame is None:
                    self._send_error_json(404, "no frame captured yet")
                    return
                ok, buf = cv2.imencode(
                    ".jpg", frame,
                    [cv2.IMWRITE_JPEG_QUALITY, 85])
                if not ok:
                    self._send_error_json(500, "JPEG encode failed")
                    return
                counts = {cam["id_to_name"][cid]:
                          cam["last_counts"].get(cid, 0)
                          for cid in cam["watch_ids"]}
                self._send_json({
                    "camera_id": cam["id"],
                    "timestamp": cam.get("last_capture_at"),
                    "jpeg_base64": base64.b64encode(
                        buf.tobytes()).decode("ascii"),
                    "counts": counts,
                })

            def _api_stream(self):
                """SSE endpoint: push event/frame/config notifications.

                No Content-Length (HTTP/1.1 stream); a ': heartbeat'
                comment every 15 s keeps idle connections alive.
                """
                q = hub.subscribe()
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Cache-Control", "no-cache")
                    self.send_header("Connection", "keep-alive")
                    self.end_headers()
                    try:
                        self.wfile.write(b'data: {"type": "hello"}\n\n')
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        return
                    while True:
                        try:
                            msg = q.get(timeout=15)
                            data = ("data: " + json.dumps(msg) + "\n\n"
                                    ).encode("utf-8")
                        except queue.Empty:
                            data = b": heartbeat\n\n"
                        try:
                            self.wfile.write(data)
                            self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            break
                finally:
                    hub.unsubscribe(q)

            def _api_config_get(self, params):
                cam = self._camera_or_400(params)
                if cam is False:
                    return
                if cam is None:
                    self._send_error_json(404, "no cameras configured")
                    return
                self._send_json(sensor_ref.camera_config_payload(cam))

            def _api_config_post(self):
                body = self._read_json_body()
                if body is None or "camera_id" not in body:
                    self._send_error_json(400, "need JSON {camera_id, ...}")
                    return
                cam_id = body["camera_id"]
                cmd = {k: v for k, v in body.items() if k != "camera_id"}
                result, ok = sensor_ref.enqueue_web("config", cam_id, cmd)
                if not ok:
                    self._send_error_json(400, result.get("error", "failed"))
                    return
                self._send_json(result.get("camera", {}))

            def _api_capture_now(self):
                body = self._read_json_body()
                if body is None or "camera_id" not in body:
                    self._send_error_json(400, "need JSON {camera_id}")
                    return
                result, ok = sensor_ref.enqueue_web(
                    "capture_now", body["camera_id"], {})
                if not ok:
                    self._send_error_json(400, result.get("error", "failed"))
                    return
                self._send_json({"ok": True})

        self._handler = Handler
        self._httpd = _Server((host, port), Handler)
        self._thread = None

    def notify(self, payload):
        """Push a live-update message to SSE clients. Never raises."""
        try:
            self.hub.publish(payload)
        except Exception:
            pass

    def start(self):
        self._thread = threading.Thread(
            target=self._httpd.serve_forever, daemon=True,
            kwargs={"poll_interval": 0.2})
        self._thread.start()

    def stop(self):
        try:
            self._httpd.shutdown()
            self._httpd.server_close()
        except Exception:
            pass
