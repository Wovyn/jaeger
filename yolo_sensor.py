#!/usr/bin/env python3
"""Jaeger service v0.4.0.

Captures frames from configured cameras, runs YOLOv8 object detection, and
publishes per-class counts/details to MQTT only when the scene changes.

Topic tree: Wovyn/RaspberryPi/Jaeger/<cpu-serial>/cameras/<camera-id>/...

Architecture (DESIGN.md §15.1): one capture thread per camera writes the
newest frame into a per-camera latest-frame slot (newest wins, nothing
accumulates); ONE inference worker thread owns the single shared YOLO
instance and round-robins cameras; the main thread supervises (config,
MQTT, shutdown, watchdog).

Implementation: MuseCell-1. Spec: Scott.
"""

import base64
import datetime
import gc
import glob
import json
import os
import queue
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

import cv2
import paho.mqtt.client as mqtt
from ultralytics import YOLO

try:
    from web_ui import JaegerWebServer
except ImportError:  # web UI optional; the sensor must keep running
    JaegerWebServer = None

VERSION = "0.4.0"
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(PROJECT_DIR, "config.json")
EVENT_REGISTRY_MAX = 200
RECONNECT_BACKOFFS = (2, 5, 10, 30)  # seconds; last value repeats (cap)
DEFAULT_WATCHLIST = ["person", "car", "truck", "bus",
                     "dog", "cat", "bicycle", "motorcycle"]
ICON_KEYS = ("camera", "door", "garage", "driveway",
             "garden", "entrance", "room", "board")
MODELS = ("yolov8n", "yolov8s")
# Asymmetric debounce: an appearance or any other count change publishes
# after 2 consecutive inference cycles; a disappearance (count -> 0) needs
# disappear_confirm_cycles consecutive empty cycles (per camera,
# default 4, valid range 2..20).
DISAPPEAR_CONFIRM_DEFAULT = 4
DISAPPEAR_CONFIRM_MIN = 2
DISAPPEAR_CONFIRM_MAX = 20
# DISPLAY_FLOOR: inference runs at conf=min(threshold, DISPLAY_FLOOR) so
# sub-threshold ("weak") detections reach the code; counts, events, MQTT
# publishing and debounce still use the configured threshold. Weak boxes
# are a Latest Frame diagnostic only: never stored, never published.
DISPLAY_FLOOR = 0.25

# v0.4.0 MQTT helpers and default config (inserted after DISPLAY_FLOOR).
DEFAULT_TOPIC_ROOT = 'Wovyn/RaspberryPi/Jaeger'


def default_mqtt_block():
    return {'enabled': False, 'host': '', 'port': 8883, 'tls': True,
            'topic_root': DEFAULT_TOPIC_ROOT, 'username': '', 'password': ''}


def default_config():
    return {'buffer': {'cap_bytes': 1073741824, 'dir': 'buffer',
                       'jpeg_quality': 85, 'max_files': 5000},
            'cameras': [], 'model': 'yolov8n',
            'mqtt': default_mqtt_block(), 'next_camera_id': 0,
            'web': {'enabled': True, 'host': '0.0.0.0', 'port': 8082}}


def mqtt_is_configured(config):
    m = config.get('mqtt') if isinstance(config, dict) else None
    if not isinstance(m, dict):
        return False
    if 'enabled' not in m:
        return bool(str(m.get('host') or '').strip())
    return bool(m.get('enabled')) and bool(str(m.get('host') or '').strip())


def mqtt_settings_payload(config):
    m = config.get('mqtt') if isinstance(config, dict) else None
    if not isinstance(m, dict):
        m = {}
    return {'enabled': mqtt_is_configured(config),
            'host': str(m.get('host') or ''),
            'port': m.get('port', 8883),
            'tls': bool(m.get('tls', True)),
            'topic_root': str(m.get('topic_root') or DEFAULT_TOPIC_ROOT),
            'username': str(m.get('username') or ''),
            'has_password': bool(m.get('password'))}


def normalize_mqtt_block(block, stored=None):
    if not isinstance(block, dict):
        raise ValueError('mqtt settings must be a JSON object')
    stored = stored if isinstance(stored, dict) else {}
    enabled = bool(block.get('enabled', stored.get('enabled', False)))
    host = str(block.get('host', stored.get('host', '')) or '').strip()
    tls = bool(block.get('tls', stored.get('tls', True)))
    raw_port = block.get('port', stored.get('port', None))
    if raw_port in ('', None):
        port = 8883 if tls else 1883
    else:
        try:
            port = int(raw_port)
        except (TypeError, ValueError):
            raise ValueError('mqtt port must be an integer')
        if not 1 <= port <= 65535:
            raise ValueError('mqtt port must be 1-65535')
    topic_root = str(block.get('topic_root', stored.get('topic_root', '')) or '').strip()
    if not topic_root:
        topic_root = DEFAULT_TOPIC_ROOT
    username = str(block.get('username', stored.get('username', '')) or '')
    pw = block.get('password', None)
    if pw is None or pw == '':
        password = str(stored.get('password') or '')
    else:
        password = str(pw)
    if enabled and not host:
        raise ValueError('mqtt host is required when MQTT is enabled')
    return {'enabled': enabled, 'host': host, 'port': port, 'tls': tls,
            'topic_root': topic_root, 'username': username,
            'password': password}


def test_mqtt_connection(fields, stored=None, timeout=10.0):
    # Temporary client only: never touches the live client, never saves.
    # Error messages are generic on purpose: they never echo host,
    # port, username or any credential.
    m = normalize_mqtt_block(fields, stored=stored)
    if not m['host']:
        raise ValueError('mqtt host is required')
    done = threading.Event()
    holder = {}
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                         client_id='jaeger-mqtt-test')
    def _on_connect(c, u, f, rc, props):
        try:
            holder['rc'] = int(getattr(rc, 'value', rc))
        except Exception:
            holder['rc'] = -1
        done.set()
    client.on_connect = _on_connect
    try:
        if m['tls']:
            client.tls_set()
        if m['username'] or m['password']:
            client.username_pw_set(m['username'], m['password'])
        client.connect(m['host'], m['port'], keepalive=60)
    except Exception as e:
        try:
            client.loop_stop()
        except Exception:
            pass
        if isinstance(e, ConnectionRefusedError):
            raise ValueError('mqtt connection refused by broker')
        if isinstance(e, (socket.timeout, TimeoutError)):
            raise ValueError('mqtt connection timed out')
        if isinstance(e, socket.gaierror):
            raise ValueError('mqtt could not resolve broker host')
        raise ValueError('mqtt connection failed')
    client.loop_start()
    try:
        if not done.wait(timeout=timeout):
            raise ValueError('mqtt connection timed out')
        rc = holder.get('rc', -1)
        if rc == 0:
            return {'ok': True}
        if rc == 5:
            raise ValueError('mqtt broker rejected credentials')
        raise ValueError('mqtt broker refused connection')
    finally:
        try:
            client.disconnect()
        except Exception:
            pass
        try:
            client.loop_stop()
        except Exception:
            pass


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

# ---- portal (web UI) port helpers (v0.4.0 General panel) ----
WEB_PORT_MIN = 1024
WEB_PORT_MAX = 65535
DEFAULT_WEB_HOST = "0.0.0.0"
DEFAULT_WEB_PORT = 8082


def validate_web_port(value):
    """Portal port: integer 1024-65535. musecell cannot bind <1024."""
    if isinstance(value, bool):
        raise ValueError("portal port must be an integer 1024-65535")
    if isinstance(value, float) and not value.is_integer():
        raise ValueError("portal port must be an integer 1024-65535")
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise ValueError("portal port must be an integer 1024-65535")
    if not WEB_PORT_MIN <= port <= WEB_PORT_MAX:
        raise ValueError("portal port must be 1024-65535")
    return port


def web_port_available(host, port):
    """Authoritative bind test on the configured host: bind, close at
    once. True when nothing is listening there right now."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    # Mirror the real server (allow_reuse_address): a port in TIME_WAIT
    # after a just-closed listener must NOT read as "in use" (moving
    # straight back to the previous port failed on this, Oct 26),
    # while an actively listening socket still blocks the bind.
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        sock.close()


def utcnow_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def epoch_to_iso(epoch):
    return datetime.datetime.fromtimestamp(
        epoch, datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def read_cpu_serial():
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("Serial"):
                    return line.split(": ", 1)[1].strip()
    except OSError:
        pass
    return "unknown"


_CRED_IN_URL = re.compile(r"(://[^:/@]+:)[^@]*(@)")


def redact_url(url):
    """Replace the password in a URL with ***. Never log a full RTSP URL."""
    if not isinstance(url, str):
        return "<not-a-url>"
    return _CRED_IN_URL.sub(r"\1***\2", url)


def redact_value(value):
    """Deep-copy a config-ish value, stripping every 'password' key."""
    if isinstance(value, dict):
        return {k: ("***" if k == "password" else redact_value(v))
                for k, v in value.items()}
    if isinstance(value, list):
        return [redact_value(v) for v in value]
    return value


def apply_rotation(frame, rotate):
    """Rotate a BGR frame by 0/90/180/270 degrees clockwise."""
    if rotate == 90:
        return cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
    if rotate == 180:
        return cv2.rotate(frame, cv2.ROTATE_180)
    if rotate == 270:
        return cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return frame


def fourcc_to_str(code):
    """Decode an OpenCV FOURCC int to a 4-char codec tag, or ''."""
    try:
        chars = bytes([(int(code) >> (8 * i)) & 0xFF for i in range(4)])
        return chars.decode("ascii", errors="ignore").strip("\x00 ").strip()
    except Exception:
        return ""


def sleep_interruptible(seconds, stop_events=()):
    """Sleep, waking early if any event in stop_events is set."""
    deadline = time.time() + max(0.0, seconds)
    while time.time() < deadline:
        if any(e.is_set() for e in stop_events):
            return
        time.sleep(min(0.2, deadline - time.time()))


def build_rtsp_url(rtsp):
    """Build an RTSP(S) URL from config parts. NEVER log the result: it
    may carry credentials. The URL is never stored; it is built fresh at
    each connect from the parts in config.json (0600)."""
    scheme = rtsp.get("scheme", "rtsp")
    host = rtsp.get("host", "")
    port = int(rtsp.get("port", 554))
    path = rtsp.get("path", "/") or "/"
    stream = rtsp.get("stream", "main")
    if "{stream}" in path:
        path = path.replace("{stream}", stream)
    if not path.startswith("/"):
        path = "/" + path
    user = rtsp.get("username", "")
    password = rtsp.get("password", "")
    auth = ""
    if user:
        auth = urllib.parse.quote(user, safe="") + ":"
        auth += urllib.parse.quote(password, safe="") + "@"
    return f"{scheme}://{auth}{host}:{port}{path}"


def default_rtsp_block():
    return {"scheme": "rtsp", "host": "", "port": 554, "path": "/",
            "stream": "main", "transport": "tcp",
            "connection_mode": "persistent", "timeout_s": 10,
            "snapshot_url": "", "tls_allow_self_signed": False,
            "username": "", "password": ""}


def default_camera_cfg(cam_id, cam_type, name):
    cfg = {"id": cam_id, "name": name, "type": cam_type,
           "icon": "board" if cam_type == "picamera" else "camera",
           "paused": False, "rotate": 0,
           "resolution": [1280, 720], "sample_interval": 5.0,
           "imgsz": 640, "confidence_threshold": 0.5,
           "disappear_confirm_cycles": DISAPPEAR_CONFIRM_DEFAULT,
           "watchlist": list(DEFAULT_WATCHLIST),
           "publish": {"classId": True, "className": True, "events": True},
           "heartbeat_interval": 600, "camera_controls": {}}
    if cam_type == "rtsp":
        cfg["rtsp"] = default_rtsp_block()
    if cam_type == 'usb':
        cfg['usb'] = default_usb_block()
        cfg['usb_controls'] = default_usb_controls()
    return cfg


def normalize_camera_form(body):
    """Normalize an Add/Edit camera form (web UI) into
    (top-level fields, rtsp block). Raises ValueError on bad input.
    Password: '' on edit means 'keep the existing password' (handled by
    the caller, which knows the stored value); on add '' means none."""
    if not isinstance(body, dict):
        raise ValueError("camera form must be a JSON object")
    name = str(body.get("name", "")).strip()
    if not name:
        raise ValueError("name is required")
    icon = str(body.get("icon", "camera"))
    if icon not in ICON_KEYS:
        icon = "camera"
    try:
        sample_interval = float(body.get("sample_interval", 5.0))
    except (TypeError, ValueError):
        raise ValueError("sample_interval must be a number")
    if sample_interval < 0.5:
        raise ValueError("sample_interval must be >= 0.5s")
    try:
        rotate = int(body.get("rotate", 0))
    except (TypeError, ValueError):
        raise ValueError("rotate must be 0/90/180/270")
    if rotate not in (0, 90, 180, 270):
        raise ValueError("rotate must be 0/90/180/270")
    rtsp = default_rtsp_block()
    src = body.get("rtsp") if isinstance(body.get("rtsp"), dict) else body
    rtsp["scheme"] = str(src.get("scheme", "rtsp"))
    if rtsp["scheme"] not in ("rtsp", "rtsps"):
        raise ValueError("scheme must be rtsp or rtsps")
    rtsp["host"] = str(src.get("host", "")).strip()
    if not rtsp["host"]:
        raise ValueError("host/IP is required")
    try:
        rtsp["port"] = int(src.get("port", 554))
    except (TypeError, ValueError):
        raise ValueError("port must be an integer")
    if not 1 <= rtsp["port"] <= 65535:
        raise ValueError("port must be 1-65535")
    rtsp["path"] = str(src.get("path", "/") or "/")
    rtsp["stream"] = str(src.get("stream", "main"))
    if rtsp["stream"] not in ("main", "sub"):
        raise ValueError("stream must be main or sub")
    rtsp["transport"] = str(src.get("transport", "tcp"))
    if rtsp["transport"] not in ("tcp", "udp"):
        raise ValueError("transport must be tcp or udp")
    rtsp["connection_mode"] = str(src.get("connection_mode", "persistent"))
    if rtsp["connection_mode"] not in ("persistent", "per-capture"):
        raise ValueError("connection_mode must be persistent or per-capture")
    try:
        rtsp["timeout_s"] = int(src.get("timeout_s", 10))
    except (TypeError, ValueError):
        raise ValueError("timeout_s must be an integer")
    if not 1 <= rtsp["timeout_s"] <= 120:
        raise ValueError("timeout_s must be 1-120")
    rtsp["snapshot_url"] = str(src.get("snapshot_url", "") or "")
    rtsp["tls_allow_self_signed"] = bool(
        src.get("tls_allow_self_signed", False))
    creds_on = body.get("credentials_on", body.get("credentialsOn"))
    if creds_on is None:
        creds_on = bool(src.get("username") or src.get("password"))
    if creds_on:
        rtsp["username"] = str(src.get("username", ""))
        rtsp["password"] = str(src.get("password", ""))
    else:
        rtsp["username"] = ""
        rtsp["password"] = ""
    fields = {"name": name, "icon": icon,
              "sample_interval": sample_interval, "rotate": rotate,
              "credentials_on": bool(creds_on),
              "password_given": bool(src.get("password")),
              "paused": bool(body.get("start_paused", body.get("paused", False)))}
    return fields, rtsp


class RTSPTestError(Exception):
    """Plain-language connection-test failure. Never carries a URL."""


# --------------------------------------------------------------------------
# Camera backends
# --------------------------------------------------------------------------

class Camera:
    """Abstract camera. capture() returns (bgr_numpy_array, epoch_seconds)
    or None on a (backend-handled) failure."""

    def __init__(self, cfg):
        self.id = cfg["id"]
        self.name = cfg.get("name", self.id)
        self.cfg = cfg
        self.last_metadata = {}
        w, h = cfg.get("resolution", [1280, 720])
        self.width, self.height = int(w), int(h)

    def capture(self):
        raise NotImplementedError

    def close(self):
        pass

    def apply_camera_controls(self, controls):
        """Apply camera controls. Base: no-op; backends override."""
        return {}

    @property
    def access_method(self):
        return "unknown"


class PiCamera(Camera):
    """Raspberry Pi camera via Picamera2. Persistent camera object."""

    def __init__(self, cfg):
        super().__init__(cfg)
        from picamera2 import Picamera2
        self._picam2 = Picamera2()
        still_cfg = self._picam2.create_still_configuration(
            main={"size": (self.width, self.height), "format": "BGR888"})
        self._picam2.configure(still_cfg)
        self._picam2.start()
        time.sleep(2)  # let AEC/AGC settle
        self.apply_camera_controls(cfg.get("camera_controls", {}))

    @property
    def sensor_model(self):
        """Best-effort sensor model from Picamera2 camera_properties."""
        try:
            return str(self._picam2.camera_properties.get("Model", "Unknown"))
        except Exception:
            return "Unknown"

    def capture(self):
        arr = self._picam2.capture_array()  # BGR888 -> BGR numpy array
        try:
            self.last_metadata = self._picam2.capture_metadata()
        except Exception:
            pass
        return arr, time.time()

    def apply_camera_controls(self, controls):
        """Apply validated Picamera2 controls. Never raises: bad values
        are logged and ignored, previous settings kept. Returns the
        input controls dict on success, {} if nothing was applied."""
        if not isinstance(controls, dict) or not controls:
            return {}
        raw = {}
        try:
            if "exposure_value" in controls:
                ev = float(controls["exposure_value"])
                raw["ExposureValue"] = max(-8.0, min(8.0, ev))
            if "ae_exposure_mode" in controls:
                mode = str(controls["ae_exposure_mode"])
                if mode in ("Short", "Normal", "Long"):
                    try:
                        from libcamera import controls as lc_controls
                        raw["AeExposureMode"] = getattr(
                            lc_controls.AeExposureModeEnum, mode)
                    except Exception as e:
                        print(f"camera controls: AeExposureMode {mode} "
                              f"unavailable ({e}); skipping", flush=True)
                else:
                    print(f"camera controls: bad AeExposureMode {mode!r}; "
                          "want Short/Normal/Long", flush=True)
            manual = False
            if "exposure_time" in controls:
                et = int(controls["exposure_time"])
                raw["ExposureTime"] = max(1, min(10000000, et))
                manual = True
            if "analogue_gain" in controls:
                ag = float(controls["analogue_gain"])
                raw["AnalogueGain"] = max(1.0, min(16.0, ag))
                manual = True
            if manual:
                # Manual exposure/gain only take effect with AEC off.
                raw["AeEnable"] = False
            if "ae_enable" in controls:
                raw["AeEnable"] = bool(controls["ae_enable"])
            if "awb_enable" in controls:
                raw["AwbEnable"] = bool(controls["awb_enable"])
            unknown = sorted(set(controls) - {
                "exposure_value", "ae_exposure_mode", "exposure_time",
                "analogue_gain", "ae_enable", "awb_enable"})
            for key in unknown:
                print(f"camera controls: unknown key {key!r} ignored",
                      flush=True)
        except (TypeError, ValueError) as e:
            print(f"camera controls: bad value ({e}); ignoring",
                  flush=True)
            return {}
        if not raw:
            return {}
        try:
            self._picam2.set_controls(raw)
        except Exception as e:
            print(f"camera controls: set_controls failed ({e}); "
                  "previous settings kept", flush=True)
            return {}
        return dict(controls)

    def close(self):
        try:
            self._picam2.stop()
        except Exception:
            pass

    @property
    def access_method(self):
        return "picamera2"


_FFMPEG_OPTS_LOCK = threading.Lock()


def _ffmpeg_capture_options(transport):
    # Build the OPENCV_FFMPEG_CAPTURE_OPTIONS string. OpenCV
    # separates option pairs with a pipe character: each pair
    # is key;value and pairs are joined by |. A semicolon
    # between pairs is WRONG: FFmpeg then receives the whole
    # tail as the first option value (observed: rtsp_transport
    # got udp;analyzeduration;500000;probesize;500000 and the
    # open failed).
    return (f"rtsp_transport;{transport}|analyzeduration;500000"
            f"|probesize;500000")


def _open_capture(url, transport, timeout_s):
    """Open a cv2.VideoCapture for an RTSP URL.

    Transport is passed to FFmpeg via OPENCV_FFMPEG_CAPTURE_OPTIONS
    (read by the OpenCV FFmpeg backend at open time). analyzeduration
    and probesize are capped (0.5 s / 500 KB) so FFmpeg stream
    probing cannot stall the open on slow cameras. Option pairs
    are pipe-separated (see _ffmpeg_capture_options).
    (read by OpenCV's FFmpeg backend at open time); the env var is set
    under a lock and restored, so per-camera transports stay correct
    with concurrent capture threads. CAP_PROP_OPEN/READ_TIMEOUT_MSEC
    are set as hints. The open itself runs in a daemon thread with a
    hard join timeout, so a hung connect can never stall a capture
    thread: on timeout the orphaned open releases its capture if it
    ever completes (cancelled flag). Returns (cap, opened_bool).
    """
    holder = {}

    def _do_open():
        with _FFMPEG_OPTS_LOCK:
            prev = os.environ.get("OPENCV_FFMPEG_CAPTURE_OPTIONS")
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
                _ffmpeg_capture_options(transport))
            try:
                cap = cv2.VideoCapture()
                cap.set(cv2.CAP_PROP_OPEN_TIMEOUT_MSEC,
                        int(timeout_s * 1000))
                cap.set(cv2.CAP_PROP_READ_TIMEOUT_MSEC,
                        int(timeout_s * 1000))
                holder["opened"] = bool(cap.open(url, cv2.CAP_FFMPEG))
                holder["cap"] = cap
            finally:
                if prev is None:
                    os.environ.pop("OPENCV_FFMPEG_CAPTURE_OPTIONS", None)
                else:
                    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = prev
        if holder.get("cancelled"):
            try:
                holder["cap"].release()
            except Exception:
                pass

    t = threading.Thread(target=_do_open, daemon=True)
    t.start()
    t.join(timeout=timeout_s + 5)
    if t.is_alive():
        holder["cancelled"] = True
        return holder.get("cap"), False
    return holder.get("cap"), bool(holder.get("opened"))


def _snapshot_fetch(snapshot_url, timeout_s):
    """Fetch one JPEG from an HTTP snapshot URL. Returns a BGR frame.
    Raises RTSPTestError with a plain message (never the URL)."""
    try:
        parts = urllib.parse.urlsplit(snapshot_url)
    except ValueError as e:
        raise RTSPTestError(f"bad snapshot URL ({e})")
    if parts.scheme not in ("http", "https"):
        raise RTSPTestError("snapshot URL must start with http:// or https://")
    req = urllib.request.Request(snapshot_url)
    if parts.username:
        creds = urllib.parse.unquote(parts.username) + ":"
        creds += urllib.parse.unquote(parts.password or "")
        req.add_header("Authorization",
                       "Basic " + base64.b64encode(
                           creds.encode("utf-8")).decode("ascii"))
    try:
        import numpy as np
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = resp.read(8 * 1024 * 1024)
    except Exception as e:
        raise RTSPTestError(f"snapshot fetch failed ({e})")
    try:
        import numpy as np
        arr = cv2.imdecode(np.frombuffer(data, dtype=np.uint8),
                           cv2.IMREAD_COLOR)
    except Exception:
        raise RTSPTestError("snapshot fetch returned data that is not a JPEG")
    if arr is None or arr.size == 0:
        raise RTSPTestError("snapshot fetch returned data that is not a JPEG")
    return arr


class RTSPCamera(Camera):
    """IP camera via OpenCV VideoCapture (CAP_FFMPEG).

    Connection modes (per camera, DESIGN.md §15.2):
    - persistent: hold one RTSP connection open, read continuously.
    - per-capture: connect, grab one frame, disconnect, every
      sample_interval. Frees the camera between captures for other apps.
    Snapshot URL (if set) is polled instead of RTSP; RTSP is the
    fallback when the snapshot fetch fails.
    """

    def __init__(self, cfg):
        super().__init__(cfg)
        rtsp = dict(default_rtsp_block())
        rtsp.update(cfg.get("rtsp", {}) or {})
        self.rtsp = rtsp
        self._cap = None
        self._lock = threading.Lock()
        self.last_grab_info = {}
        self.fail_streak = 0

    @property
    def access_method(self):
        return "rtsp"

    def _open(self):
        # Open the RTSP stream. Returns (cap, open_seconds)
        # or (None, open_seconds) on failure.
        url = build_rtsp_url(self.rtsp)  # never logged
        t0 = time.time()
        cap, opened = _open_capture(
            url, self.rtsp.get("transport", "tcp"),
            int(self.rtsp.get("timeout_s", 10)))
        open_s = round(time.time() - t0, 2)
        if not opened or cap is None:
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass
            return None, open_s
        return cap, open_s

    def _read_with_keyframe_wait(self, cap, timeout_s):
        """Read until a decodable frame arrives (first frames after a
        connect wait for a keyframe, typically 1-3 s). Returns
        (frame_or_None, wait_seconds)."""
        t0 = time.time()
        deadline = time.time() + max(1.0, timeout_s)
        while time.time() < deadline:
            try:
                ok, frame = cap.read()
            except Exception:
                return None, round(time.time() - t0, 2)
            if ok and frame is not None and frame.size:
                return frame, round(time.time() - t0, 2)
            time.sleep(0.05)
        return None, round(time.time() - t0, 2)

    def capture(self):
        """One grab. Returns (frame, epoch) or None on failure.
        Serialized per camera via the stream lock, so a connection test
        never overlaps the live capture (some cameras allow only 1-2
        concurrent streams)."""
        with self._lock:
            return self._capture_locked()

    def _capture_locked(self):
        t0 = time.time()
        timeout_s = int(self.rtsp.get("timeout_s", 10))
        snapshot_url = self.rtsp.get("snapshot_url", "")
        if snapshot_url:
            try:
                frame = _snapshot_fetch(snapshot_url, timeout_s)
                self._note_grab("snapshot", time.time() - t0, frame,
                                0.0, time.time() - t0)
                return frame, time.time()
            except RTSPTestError as e:
                # Snapshot failed; RTSP is the fallback (DESIGN.md §15.2).
                print(f"[{self.id}] snapshot failed ({e}); "
                      "falling back to RTSP", flush=True)
        mode = self.rtsp.get("connection_mode", "persistent")
        if mode == "per-capture":
            cap, open_s = self._open()
            if cap is None:
                return None
            try:
                frame, wait_s = self._read_with_keyframe_wait(cap, timeout_s)
            finally:
                try:
                    cap.release()
                except Exception:
                    pass
            if frame is None:
                return None
            self._note_grab("per-capture", time.time() - t0, frame,
                            open_s, wait_s)
            return frame, time.time()
        # persistent
        open_s = 0.0
        if self._cap is None:
            self._cap, open_s = self._open()
            if self._cap is None:
                return None
        frame, wait_s = self._read_with_keyframe_wait(self._cap, timeout_s)
        if frame is None:
            try:
                self._cap.release()
            except Exception:
                pass
            self._cap = None
            return None
        self._note_grab("persistent", time.time() - t0, frame,
                        open_s, wait_s)
        return frame, time.time()

    def _note_grab(self, source, seconds, frame,
                   open_seconds=None, wait_seconds=None):
        try:
            h, w = frame.shape[:2]
            self.width, self.height = int(w), int(h)
        except Exception:
            pass
        self.last_grab_info = {"source": source,
                               "seconds": round(seconds, 2),
                               "open_seconds": (round(open_seconds, 2)
                                                if open_seconds is not None
                                                else None),
                               "wait_seconds": (round(wait_seconds, 2)
                                                if wait_seconds is not None
                                                else None)}
        self.fail_streak = 0

    def close(self):
        """Disconnect the RTSP stream (frees the camera for other apps)."""
        with self._lock:
            if self._cap is not None:
                try:
                    self._cap.release()
                except Exception:
                    pass
                self._cap = None

    @staticmethod
    def test_connection(rtsp, timeout_s=None, stream_lock=None):
        """Grab one frame from an RTSP/snapshot config. Returns
        (frame, width, height, codec, seconds, source). Raises
        RTSPTestError with a plain-language message. Persists nothing,
        never echoes or logs credentials, never hangs: every wait is
        bounded by timeout_s. If stream_lock is given (the live
        backend's lock for an existing camera), the test serializes
        against the live capture thread."""
        merged = dict(default_rtsp_block())
        merged.update(rtsp or {})
        rtsp = merged
        timeout_s = int(timeout_s or rtsp.get("timeout_s", 10))
        timeout_s = max(1, min(120, timeout_s))
        lock = stream_lock or threading.Lock()
        with lock:
            return RTSPCamera._test_locked(rtsp, timeout_s)

    @staticmethod
    def _test_locked(rtsp, timeout_s):
        t0 = time.time()
        snapshot_url = rtsp.get("snapshot_url", "")
        if snapshot_url:
            try:
                frame = _snapshot_fetch(snapshot_url, timeout_s)
                h, w = frame.shape[:2]
                return (frame, int(w), int(h), "snapshot-jpeg",
                        round(time.time() - t0, 2), "snapshot")
            except RTSPTestError as e:
                print(f"camera test: snapshot failed ({e}); "
                      "falling back to RTSP", flush=True)
        host = rtsp.get("host", "")
        port = int(rtsp.get("port", 554))
        # TCP pre-check: turns a refused/timeout connect into a
        # plain-language error instead of a generic open failure.
        try:
            sock = socket.create_connection(
                (host, port), timeout=min(timeout_s, 5))
            sock.close()
        except ConnectionRefusedError:
            raise RTSPTestError(
                f"connection refused by {host}:{port} "
                "(camera not listening on that port)")
        except socket.timeout:
            raise RTSPTestError(
                f"timed out connecting to {host}:{port} "
                "(host unreachable or port filtered)")
        except OSError as e:
            raise RTSPTestError(
                f"cannot reach {host}:{port} ({e.strerror or e})")
        url = build_rtsp_url(rtsp)  # never logged
        cap, opened = _open_capture(
            url, rtsp.get("transport", "tcp"), timeout_s)
        if not opened or cap is None:
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass
            raise RTSPTestError(
                "could not open the stream (check credentials, path, "
                "and stream selection)")
        try:
            codec = ""
            try:
                codec = fourcc_to_str(
                    cap.get(cv2.CAP_PROP_FOURCC)) or "unknown"
            except Exception:
                codec = "unknown"
            deadline = time.time() + timeout_s
            frame = None
            while time.time() < deadline:
                try:
                    ok, frame = cap.read()
                except Exception:
                    frame = None
                    break
                if ok and frame is not None and frame.size:
                    break
                frame = None
                time.sleep(0.05)
            if frame is None:
                raise RTSPTestError(
                    "timed out waiting for a frame (stream opened but "
                    "no keyframe arrived; try another stream/path)")
            h, w = frame.shape[:2]
            return (frame, int(w), int(h), codec,
                    round(time.time() - t0, 2), "rtsp")
        finally:
            try:
                cap.release()
            except Exception:
                pass


# v0.4.0 USB device helpers (inserted before CAMERA_TYPES).
import glob as _glob
import re as _re


def _usb_id_maps():
    by_id = {}
    by_path = {}
    for d, out in (('/dev/v4l/by-id', by_id), ('/dev/v4l/by-path', by_path)):
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for name in names:
            p = os.path.join(d, name)
            try:
                out[name] = os.path.realpath(p)
            except OSError:
                pass
    return by_id, by_path


def resolve_usb_node(device_id):
    if not device_id:
        return None
    device_id = str(device_id)
    if '/' in device_id:
        return device_id if os.path.exists(device_id) else None
    by_id, by_path = _usb_id_maps()
    if device_id in by_id:
        return by_id[device_id]
    if device_id in by_path:
        return by_path[device_id]
    return None


def usb_device_formats(node):
    try:
        proc = subprocess.run(['v4l2-ctl', '-d', node, '--list-formats-ext'],
                              timeout=10, capture_output=True, text=True)
        out = proc.stdout or ''
    except Exception:
        return []
    formats = []
    cur = None
    for line in out.splitlines():
        m = _re.search(r"\[\d+\]: '([A-Za-z0-9]+)'", line)
        if m:
            cur = {'pixel_format': m.group(1), 'sizes': [], 'fps': []}
            formats.append(cur)
            continue
        m = _re.search(r'Size: Discrete (\d+)x(\d+)', line)
        if m and cur is not None:
            size = [int(m.group(1)), int(m.group(2))]
            if size not in cur['sizes']:
                cur['sizes'].append(size)
            continue
        m = _re.search(r'\(([0-9.]+) fps\)', line)
        if m and cur is not None:
            fps = int(round(float(m.group(1))))
            if fps > 0 and fps not in cur['fps']:
                cur['fps'].append(fps)
    for f in formats:
        f['sizes'] = sorted(f['sizes'], key=lambda s: s[0] * s[1], reverse=True)
        f['fps'] = sorted(f['fps'], reverse=True)
    return formats


def default_usb_block():
    return {'device_id': '', 'model': '', 'pixel_format': 'MJPG', 'fps': 15}


def default_usb_controls():
    return {'auto_exposure': True, 'exposure_time_absolute': None,
            'white_balance_automatic': True,
            'white_balance_temperature': None}


def apply_usb_controls(node, controls):
    if not isinstance(controls, dict) or not node:
        return
    def _set(ctrl, value):
        try:
            subprocess.run(['v4l2-ctl', '-d', node, '--set-ctrl',
                            ctrl + '=' + str(value)],
                           timeout=5, capture_output=True)
        except Exception as e:
            print('usb controls failed for device (' + str(e) + ')', flush=True)
    if controls.get('auto_exposure', True):
        _set('auto_exposure', 3)
    else:
        _set('auto_exposure', 1)
        if controls.get('exposure_time_absolute') is not None:
            _set('exposure_time_absolute', controls['exposure_time_absolute'])
    if controls.get('white_balance_automatic', True):
        _set('white_balance_automatic', 1)
    else:
        _set('white_balance_automatic', 0)
        if controls.get('white_balance_temperature') is not None:
            _set('white_balance_temperature',
                 controls['white_balance_temperature'])


def normalize_usb_form(body):
    if not isinstance(body, dict):
        raise ValueError('usb camera form must be a JSON object')
    name = str(body.get('name', '')).strip()
    if not name:
        raise ValueError('name is required')
    icon = str(body.get('icon', 'camera'))
    if icon not in ICON_KEYS:
        icon = 'camera'
    try:
        sample_interval = float(body.get('sample_interval', 5.0))
    except (TypeError, ValueError):
        raise ValueError('sample_interval must be a number')
    if sample_interval < 0.5:
        raise ValueError('sample_interval must be >= 0.5s')
    try:
        rotate = int(body.get('rotate', 0))
    except (TypeError, ValueError):
        raise ValueError('rotate must be 0/90/180/270')
    if rotate not in (0, 90, 180, 270):
        raise ValueError('rotate must be 0/90/180/270')
    src = body.get('usb') if isinstance(body.get('usb'), dict) else body
    device_id = str(src.get('device_id', '') or '').strip()
    if not device_id:
        raise ValueError('usb device is required')
    pixel_format = str(src.get('pixel_format', 'MJPG') or 'MJPG')
    if len(pixel_format) != 4:
        raise ValueError('usb format is invalid')
    res = src.get('resolution', [1280, 720])
    try:
        resolution = [int(res[0]), int(res[1])]
    except Exception:
        raise ValueError('usb resolution is invalid')
    if resolution[0] <= 0 or resolution[1] <= 0:
        raise ValueError('usb resolution is invalid')
    try:
        fps = int(src.get('fps', 15))
    except (TypeError, ValueError):
        raise ValueError('usb fps must be an integer')
    if fps <= 0:
        raise ValueError('usb fps is invalid')
    usb = {'device_id': device_id,
           'model': str(src.get('model', '') or ''),
           'pixel_format': pixel_format, 'fps': fps}
    ctrls_src = body.get('usb_controls') if isinstance(body.get('usb_controls'), dict) else {}
    auto_exp = bool(ctrls_src.get('auto_exposure', True))
    exp_val = None
    if not auto_exp:
        try:
            exp_val = int(ctrls_src.get('exposure_time_absolute'))
        except (TypeError, ValueError):
            raise ValueError('usb exposure must be 1-10000')
        if not 1 <= exp_val <= 10000:
            raise ValueError('usb exposure must be 1-10000')
    auto_wb = bool(ctrls_src.get('white_balance_automatic', True))
    wb_val = None
    if not auto_wb:
        try:
            wb_val = int(ctrls_src.get('white_balance_temperature'))
        except (TypeError, ValueError):
            raise ValueError('usb white balance temperature must be 0-10000')
        if not 0 <= wb_val <= 10000:
            raise ValueError('usb white balance temperature must be 0-10000')
    controls = {'auto_exposure': auto_exp,
                'exposure_time_absolute': exp_val,
                'white_balance_automatic': auto_wb,
                'white_balance_temperature': wb_val}
    node = resolve_usb_node(device_id)
    if node is not None:
        formats = usb_device_formats(node)
        match = None
        for f in formats:
            if f['pixel_format'] == pixel_format:
                match = f
                break
        if formats and match is None:
            raise ValueError('usb format is not supported by this device')
        if match is not None and resolution not in match['sizes']:
            raise ValueError('usb resolution is not supported by this device')
        if match is not None and match['fps'] and fps not in match['fps']:
            raise ValueError('usb fps is not supported by this device')
    fields = {'name': name, 'icon': icon,
              'sample_interval': sample_interval, 'rotate': rotate,
              'paused': bool(body.get('start_paused', body.get('paused', False)))}
    return fields, usb, controls, resolution

# v0.4.0 USB camera backend: persistent V4L2 capture, lazy open.
class USBCamera(Camera):
    def __init__(self, cfg):
        super().__init__(cfg)
        usb = dict(default_usb_block())
        usb.update(cfg.get('usb', {}) or {})
        self.usb = usb
        controls = dict(default_usb_controls())
        controls.update(cfg.get('usb_controls', {}) or {})
        self.usb_controls = controls
        self._cap = None
        self._lock = threading.Lock()
        self.last_grab_info = {}
        self.fail_streak = 0

    @property
    def access_method(self):
        return 'usb'

    def _open(self):
        node = resolve_usb_node(self.usb.get('device_id', ''))
        if node is None:
            return None, 0.0
        t0 = time.time()
        apply_usb_controls(node, self.usb_controls)
        cap = cv2.VideoCapture(node, cv2.CAP_V4L2)
        try:
            pf = self.usb.get('pixel_format', 'MJPG')
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*pf))
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, int(self.width))
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, int(self.height))
            cap.set(cv2.CAP_PROP_FPS, int(self.usb.get('fps', 15)))
        except Exception:
            pass
        if not cap.isOpened():
            try:
                cap.release()
            except Exception:
                pass
            return None, round(time.time() - t0, 2)
        return cap, round(time.time() - t0, 2)

    def capture(self):
        with self._lock:
            open_s = 0.0
            if self._cap is None:
                self._cap, open_s = self._open()
                if self._cap is None:
                    return None
            try:
                ok, frame = self._cap.read()
            except Exception:
                ok, frame = False, None
            if not ok or frame is None or not frame.size:
                try:
                    self._cap.release()
                except Exception:
                    pass
                self._cap = None
                return None
            try:
                h, w = frame.shape[:2]
                self.width, self.height = int(w), int(h)
            except Exception:
                pass
            self.last_grab_info = {'source': 'usb', 'seconds': 0.0,
                                   'open_seconds': open_s,
                                   'wait_seconds': None}
            self.fail_streak = 0
            return frame, time.time()

    def close(self):
        with self._lock:
            if self._cap is not None:
                try:
                    self._cap.release()
                except Exception:
                    pass
                self._cap = None

    @staticmethod
    def test_usb(usb, timeout_s=10):
        node = resolve_usb_node(usb.get('device_id', ''))
        if node is None:
            raise RTSPTestError('usb device not found')
        t0 = time.time()
        cap = cv2.VideoCapture(node, cv2.CAP_V4L2)
        try:
            pf = usb.get('pixel_format', 'MJPG')
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*pf))
            res = usb.get('resolution', [1280, 720])
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, int(res[0]))
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, int(res[1]))
            cap.set(cv2.CAP_PROP_FPS, int(usb.get('fps', 15)))
            if not cap.isOpened():
                raise RTSPTestError('usb device is busy or could not be opened')
            deadline = time.time() + max(1, timeout_s)
            frame = None
            while time.time() < deadline:
                ok, frame = cap.read()
                if ok and frame is not None and frame.size:
                    break
                frame = None
                time.sleep(0.05)
            if frame is None:
                raise RTSPTestError('usb test timed out waiting for a frame')
            h, w = frame.shape[:2]
            return (frame, int(w), int(h), pf,
                    round(time.time() - t0, 2), usb.get('device_id', ''))
        finally:
            try:
                cap.release()
            except Exception:
                pass


def scan_usb_present():
    by_id, by_path = _usb_id_maps()
    node_to_id = {}
    for name, node in by_id.items():
        if name.endswith('-video-index0'):
            node_to_id[node] = name
    for name, node in by_path.items():
        if name.endswith('-video-index0') and node not in node_to_id:
            node_to_id[node] = name
    devices = []
    for node in sorted(_glob.glob('/sys/class/video4linux/video*')):
        base = os.path.basename(node)
        if not base.startswith('video') or not base[5:].isdigit():
            continue
        try:
            driver = os.path.basename(os.readlink(os.path.join(node, 'device', 'driver')))
        except OSError:
            continue
        if driver != 'uvcvideo':
            continue
        dev_node = '/dev/' + base
        if dev_node not in node_to_id:
            continue
        try:
            with open(os.path.join(node, 'name')) as f:
                model = f.read().strip()
        except OSError:
            model = 'USB camera'
        devices.append({'device_id': node_to_id[dev_node],
                        'model': model, 'present': True,
                        'node': dev_node,
                        'formats': usb_device_formats(dev_node)})
    return devices


CAMERA_TYPES = {
    "picamera": PiCamera,
    "rtsp": RTSPCamera,
    "usb": USBCamera,
}

# --------------------------------------------------------------------------
# Config migration (v0.2.x -> v0.3.0)
# --------------------------------------------------------------------------

def migrate_config(config):
    """Rewrite a v0.2.x config dict in place to the v0.3.0 schema.

    Returns a list of human-readable change descriptions (empty when the
    config was already v0.3.0). The caller decides when to persist.
    - mqtt.topic_root ending in YOLOSensor -> Jaeger (hard cutover).
    - model moves from per-camera to service level (config.model).
    - per-camera model keys are dropped (ignored with a logged warning).
    - next_camera_id is derived from existing camera ids.
    - per-camera defaults: icon, paused, rotate, rtsp block, publish.
    Never touches credentials; never logs them.
    """
    changes = []
    if not isinstance(config.get('mqtt'), dict):
        config['mqtt'] = default_mqtt_block()
        changes.append('mqtt block added (disabled)')
    mqtt_cfg = config.setdefault('mqtt', {})
    if not str(mqtt_cfg.get('topic_root') or '').strip():
        mqtt_cfg['topic_root'] = DEFAULT_TOPIC_ROOT
        changes.append('mqtt topic_root defaulted')
    root = mqtt_cfg.get("topic_root", "")
    if root.endswith("YOLOSensor"):
        mqtt_cfg["topic_root"] = root[:-len("YOLOSensor")] + "Jaeger"
        changes.append(f"topic_root {root} -> {mqtt_cfg['topic_root']} "
                       "(hard cutover to the Jaeger tree)")
        print("CONFIG MIGRATION: topic_root rewritten to the Jaeger tree "
              f"(was {root}). Node-RED flows referencing the old tree "
              "need a one-time update.", flush=True)
    cameras = config.get("cameras", [])
    if "model" not in config:
        model = "yolov8n"
        for ccfg in cameras:
            if ccfg.get("model") in MODELS:
                model = ccfg["model"]
                break
        config["model"] = model
        changes.append(f"model moved to service level ({model})")
    for ccfg in cameras:
        if "model" in ccfg:
            print(f"CONFIG MIGRATION: ignoring per-camera model key "
                  f"on {ccfg.get('id')} (model is now service-level)",
                  flush=True)
            del ccfg["model"]
            changes.append(f"dropped per-camera model key on {ccfg.get('id')}")
        ccfg.setdefault("icon",
                        "board" if ccfg.get("type") == "picamera" else "camera")
        if ccfg.get("icon") not in ICON_KEYS:
            ccfg["icon"] = "camera"
        ccfg.setdefault("paused", False)
        ccfg.setdefault("rotate", 0)
        dcc = ccfg.get("disappear_confirm_cycles",
                       DISAPPEAR_CONFIRM_DEFAULT)
        try:
            dcc = int(dcc)
        except (TypeError, ValueError):
            dcc = DISAPPEAR_CONFIRM_DEFAULT
        if not DISAPPEAR_CONFIRM_MIN <= dcc <= DISAPPEAR_CONFIRM_MAX:
            dcc = DISAPPEAR_CONFIRM_DEFAULT
        ccfg["disappear_confirm_cycles"] = dcc
        ccfg.setdefault("camera_controls", {})
        ccfg.setdefault("publish", {"classId": True, "className": True,
                                    "events": True})
        if ccfg.get("type") == "rtsp":
            merged = default_rtsp_block()
            merged.update(ccfg.get("rtsp", {}) or {})
            ccfg["rtsp"] = merged
    if "next_camera_id" not in config:
        taken = []
        for ccfg in cameras:
            cid = str(ccfg.get("id", ""))
            if cid.startswith("camera") and cid[6:].isdigit():
                taken.append(int(cid[6:]))
        config["next_camera_id"] = (max(taken) + 1) if taken else 0
        changes.append(
            f"next_camera_id set to {config['next_camera_id']}")
    return changes


# --------------------------------------------------------------------------
# Service
# --------------------------------------------------------------------------

class YoloSensor:
    def __init__(self, config):
        self.config = config
        if 'buffer' not in self.config or not isinstance(self.config['buffer'], dict):
            self.config['buffer'] = {'cap_bytes': 1073741824, 'dir': 'buffer', 'jpeg_quality': 85, 'max_files': 5000}
        self.serial = read_cpu_serial()
        self.mqtt_configured = mqtt_is_configured(self.config)
        _m = self.config.get('mqtt') if isinstance(self.config.get('mqtt'), dict) else {}
        self.root = str(_m.get('topic_root') or DEFAULT_TOPIC_ROOT).rstrip('/')
        self.mqtt_configured = mqtt_is_configured(self.config)
        self.mqtt_thread = None
        self.msg_queue = queue.Queue()
        self.stop_flag = False
        self.cameras = []
        self.event_registry = {}
        self.client = None
        self.version = VERSION
        self.started_at = utcnow_iso()
        self.started_monotonic = time.time()
        self.mqtt_connected = False
        self.last_cycle_seconds = None
        self.last_cycle_at = None
        self.web_server = None
        self.web_port = None
        self.restart_requested = None
        self.restart_exec = False
        self.config_path = CONFIG_PATH
        # Shared model (service-level, owned by the inference worker).
        self.model_name = config.get("model", "yolov8n")
        # DISPLAY_FLOOR mirror for the web UI (avoids a circular import:
        # yolo_sensor imports web_ui, so web_ui cannot import yolo_sensor).
        self.display_floor = DISPLAY_FLOOR
        self.model_obj = None
        self.pending_model = None
        self.name_to_id = {}
        self.id_to_name = {}
        self.model_factory = lambda name: YOLO(
            os.path.join(PROJECT_DIR, "models", f"{name}.pt"))
        self.inference_thread = None
        self.last_pi_heartbeat = 0.0
        self._stop_evt = threading.Event()

    # ---- topics ----
    def t_pi(self, *parts):
        return "/".join([self.root, self.serial] + list(parts))

    def t_cam(self, cam_id, *parts):
        return "/".join([self.root, self.serial, "cameras", cam_id]
                        + list(parts))

    def publish(self, topic, payload, retain=False, raw=False):
        if not getattr(self, 'mqtt_configured', False):
            return
        if self.client is None:
            return
        body = payload if raw else json.dumps(payload)
        self.client.publish(topic, body, qos=1, retain=retain)

    def publish_cam(self, cam, subtopic, payload, retain=False):
        self.publish(self.t_cam(cam["id"], subtopic), payload, retain=retain)

    # ---- MQTT ----
    def mqtt_connect(self):
        # Background worker: retries forever until stopped, so a down
        # broker never blocks cameras, inference or the web UI.
        if not self.mqtt_configured:
            return
        m = self.config['mqtt']
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                             client_id='muse-yolo-' + self.serial)
        client.on_connect = self.on_connect
        client.on_message = self.on_message
        client.on_disconnect = self.on_disconnect
        client.will_set(self.t_pi('status'),
                        json.dumps({'status': 'offline',
                                    'timestamp': utcnow_iso()}),
                        qos=1, retain=True)
        if m.get('tls', True):
            client.tls_set()
        if m.get('username') or m.get('password'):
            client.username_pw_set(m.get('username', ''), m.get('password', ''))
        client.reconnect_delay_set(min_delay=1, max_delay=60)
        self.client = client
        while not self.stop_flag:
            try:
                client.connect(m['host'], m.get('port', 8883), keepalive=60)
                break
            except Exception:
                print('MQTT connect failed; retrying in 5s', flush=True)
                time.sleep(5)
        if self.stop_flag:
            return
        client.loop_start()

    def start_mqtt_background(self):
        if not self.mqtt_configured:
            print('MQTT not configured; running without MQTT reporting',
                  flush=True)
            return
        t = getattr(self, 'mqtt_thread', None)
        if t is not None and t.is_alive():
            return
        t = threading.Thread(target=self.mqtt_connect, daemon=True,
                             name='mqtt-connect')
        self.mqtt_thread = t
        t.start()

    def mqtt_disconnect(self):
        client = self.client
        self.client = None
        self.mqtt_connected = False
        if client is not None:
            try:
                client.loop_stop()
            except Exception:
                pass
            try:
                client.disconnect()
            except Exception:
                pass

    def mqtt_test(self, fields):
        if isinstance(fields, dict) and fields.get('enabled') is False:
            raise ValueError('mqtt is disabled')
        stored = self.config.get('mqtt') if isinstance(self.config, dict) else {}
        return test_mqtt_connection(fields, stored=stored)

    def mqtt_settings(self):
        return mqtt_settings_payload(self.config)

    def apply_mqtt_config(self, cmd):
        self.apply_service_config({'mqtt': cmd})

    def on_connect(self, client, userdata, flags, reason_code, properties):
        print(f"MQTT connected (rc={reason_code})", flush=True)
        self.mqtt_connected = True
        for cam in self.cameras:
            cid = cam["id"]
            client.subscribe(self.t_cam(cid, "config", "set"), qos=1)
            client.subscribe(self.t_cam(cid, "images", "request"), qos=1)
        # Pi-level state
        self.publish(self.t_pi("config"), self.service_config_payload(),
                     retain=True)
        self.publish(self.t_pi("status"),
                     {"status": "online", "timestamp": utcnow_iso()}, retain=True)
        # Per-camera state (republish current counts, not zeros, on reconnect)
        for cam in self.cameras:
            self.publish_camera_config(cam)
            self.publish_cam(cam, "status",
                             {"status": cam["status"],
                              "timestamp": utcnow_iso()},
                             retain=True)
            for cid in cam["watch_ids"]:
                self.publish_baseline(cam, cid)

    def on_disconnect(self, client, userdata, flags, reason_code, properties):
        print(f"MQTT disconnected (rc={reason_code})", flush=True)
        self.mqtt_connected = False

    def on_message(self, client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode("utf-8"))
        except Exception:
            print(f"ignoring non-JSON message on {msg.topic}", flush=True)
            return
        self.msg_queue.put((msg.topic, payload))

    # ---- config ----
    def save_config(self):
        tmp = self.config_path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.config, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.config_path)

    def buffer_dir(self, cam_id):
        return os.path.join(PROJECT_DIR,
                             self.config["buffer"].get("dir", "buffer"),
                             cam_id)

    def buffer_stats(self, cam_id):
        files = bytes_ = 0
        d = self.buffer_dir(cam_id)
        if os.path.isdir(d):
            for fn in os.listdir(d):
                p = os.path.join(d, fn)
                if os.path.isfile(p):
                    bytes_ += os.path.getsize(p)
                    if fn.lower().endswith(".jpg"):
                        files += 1
        return files, bytes_

    def service_config_payload(self):
        """Pi-level retained config: service identity + camera list."""
        return {
            "service": "jaeger", "version": VERSION,
            "cpu_serial": self.serial, "start_time": self.started_at,
            "model": self.model_name,
            "cameras": [{"id": c["id"], "name": c["cfg"].get("name", c["id"]),
                         "type": c["cfg"].get("type", "picamera"),
                         "icon": c["cfg"].get("icon", "camera"),
                         "status": c["status"],
                         "paused": bool(c["cfg"].get("paused", False))}
                        for c in self.cameras],
            "timestamp": utcnow_iso()}

    def publish_service_config(self):
        self.publish(self.t_pi("config"), self.service_config_payload(),
                     retain=True)

    def camera_config_payload(self, cam):
        """One camera-config dict shared by MQTT publish + web API.
        NEVER includes the RTSP password (only a has_password flag)."""
        cfg = cam["cfg"]
        files, bytes_ = self.buffer_stats(cam["id"])
        rtsp_out = None
        usb_out = None
        usb_controls_out = None
        if cfg.get("type") == "usb":
            usb_out = dict(cfg.get("usb", {}) or {})
            usb_controls_out = dict(cfg.get("usb_controls", {}) or {})
        if cfg.get("type") == "rtsp":
            rtsp = dict(cfg.get("rtsp", {}) or {})
            rtsp_out = {k: v for k, v in rtsp.items() if k != "password"}
            rtsp_out["has_password"] = bool(rtsp.get("password"))
        return {
            "service": "jaeger", "version": VERSION,
            "cpu_serial": self.serial,
            "camera_id": cam["id"], "name": cam["cfg"].get("name", cam["id"]),
            "type": cfg.get("type", "picamera"),
            "icon": cfg.get("icon", "camera"),
            "status": cam["status"],
            "paused": bool(cfg.get("paused", False)),
            "rotate": cfg.get("rotate", 0),
            "resolution": [cam["obj"].width, cam["obj"].height]
            if cam.get("obj") is not None else list(
                cfg.get("resolution", [1280, 720])),
            "access_method": cam["obj"].access_method
            if cam.get("obj") is not None else "unavailable",
            "sample_interval": cfg.get("sample_interval", 5.0),
            "imgsz": cfg.get("imgsz", 640),
            "confidence_threshold": cfg.get("confidence_threshold", 0.5),
            "disappear_confirm_cycles": cfg.get("disappear_confirm_cycles",
                                                DISAPPEAR_CONFIRM_DEFAULT),
            "watchlist": cfg.get("watchlist", []),
            "publish": cfg.get("publish", {}),
            "heartbeat_interval": cfg.get("heartbeat_interval", 600),
            "camera_controls": cfg.get("camera_controls", {}),
            "rtsp": rtsp_out,
            "usb": usb_out,
            "usb_controls": usb_controls_out,
            # Pi Sensor card: display-only detected info (None for RTSP).
            "sensor_model": cam.get("sensor_model"),
            "camera_port": cam.get("camera_port"),
            "last_capture_at": cam.get("last_capture_at"),
            "last_grab_at": cam.get("last_grab_at"),
            "last_grab_seconds": cam.get("last_grab_seconds"),
            "last_grab_open_seconds": (
                getattr(cam.get("obj"), "last_grab_info", None) or {}
            ).get("open_seconds"),
            "last_grab_wait_seconds": (
                getattr(cam.get("obj"), "last_grab_info", None) or {}
            ).get("wait_seconds"),
            "last_inference_at": cam.get("last_inference_at"),
            "last_inference_seconds": cam.get("last_inference_seconds"),
            "frame_seq": cam.get("slot_seq", 0),
            "grab_error": cam.get("grab_error"),
            "buffer": {"files": files, "bytes": bytes_,
                       "cap_bytes": self.config["buffer"].get("cap_bytes", 2**30)},
            "timestamp": utcnow_iso()}

    def publish_camera_config(self, cam):
        self.publish_cam(cam, "config",
                         self.camera_config_payload(cam), retain=True)

    def publish_baseline(self, cam, cid):
        name = cam["id_to_name"][cid]
        payload = {"timestamp": utcnow_iso(),
                   "count": cam["last_counts"].get(cid, 0),
                   "detections": [], "image_ref": None}
        if cam["cfg"].get("publish", {}).get("classId", True):
            self.publish_cam(cam, f"classId/{cid}", payload, retain=True)
        if cam["cfg"].get("publish", {}).get("className", True):
            self.publish_cam(cam, f"className/{name}", payload, retain=True)

    def set_watchlist(self, cam, names, initial=False):
        valid = [n for n in names if n in cam["name_to_id"]]
        new_ids = [cam["name_to_id"][n] for n in valid]
        if not initial:
            for cid in cam["watch_ids"]:
                if cid not in new_ids:
                    name = cam["id_to_name"][cid]
                    zero = {"timestamp": utcnow_iso(), "count": 0,
                            "detections": [], "image_ref": None}
                    if cam["cfg"].get("publish", {}).get("classId", True):
                        self.publish_cam(cam, f"classId/{cid}", zero, retain=True)
                    if cam["cfg"].get("publish", {}).get("className", True):
                        self.publish_cam(cam, f"className/{name}", zero, retain=True)
        cam["watch_ids"] = new_ids
        cam["last_counts"] = {cid: cam["last_counts"].get(cid, 0)
                              for cid in new_ids}
        cam["pending_changes"] = {}
        cam["cfg"]["watchlist"] = valid
        if not initial:
            # initial baselines are published by on_connect (client may not
            # exist yet when the startup watchlist is set)
            for cid in new_ids:
                self.publish_baseline(cam, cid)

    def set_cam_status(self, cam, status, reason=None):
        """Status transition helper: publishes retained status + SSE
        push only when the status actually changes."""
        if cam["status"] == status:
            return
        cam["status"] = status
        if reason:
            cam["status_reason"] = reason
        self.publish_cam(cam, "status",
                         {"status": status, "timestamp": utcnow_iso()},
                         retain=True)
        self.notify_stream({"type": "config", "camera_id": cam["id"]})

    def saturation(self):
        """Inference load: sum over cameras of
        (measured inference_time / sample_interval). Above 1.0 the
        worker cannot keep up; frames are superseded and per-camera
        effective intervals grow. Paused cameras and cameras with no live backend are excluded. No hard camera limit; this is the
        limit signal (DESIGN.md §15.7)."""
        total = 0.0
        for cam in self.cameras:
            if cam.get("paused") or cam.get("obj") is None:
                continue
            secs = cam.get("last_inference_seconds")
            interval = cam["cfg"].get("sample_interval", 5.0) or 5.0
            if secs:
                total += secs / interval
        return round(total, 3)

    # ---- model (service-level, shared) ----
    def perform_model_swap(self, want):
        """Load a new shared model, explicitly unloading the old one
        first (del + gc.collect() BEFORE loading, so peak memory is one
        model, not two). Clears debounce pending_changes on every
        camera (DESIGN.md §15.8.2) and pushes an SSE config update
        AFTER the swap completes, so the UI confirms the new model."""
        print(f"loading model {want}", flush=True)
        old = self.model_obj
        self.model_obj = None
        if old is not None:
            del old
        gc.collect()
        self.model_obj = self.model_factory(want)
        self.model_name = want
        self.config["model"] = want
        # In-place update: per-camera dicts share these objects.
        self.name_to_id.clear()
        self.name_to_id.update(
            {v: k for k, v in self.model_obj.names.items()})
        self.id_to_name.clear()
        self.id_to_name.update(
            {k: v for v, k in self.name_to_id.items()})
        for cam in self.cameras:
            cam["pending_changes"] = {}
            cam["watch_ids"] = [self.name_to_id[n]
                                for n in cam["cfg"].get("watchlist", [])
                                if n in self.name_to_id]
            cam["last_counts"] = {cid: cam["last_counts"].get(cid, 0)
                                  for cid in cam["watch_ids"]}
        self.save_config()
        self.publish_service_config()
        self.notify_stream({"type": "config"})
        print(f"model swap complete: {want}", flush=True)

    def current_web_host(self):
        web_cfg = self.config.get("web") \
            if isinstance(self.config.get("web"), dict) else {}
        return str(web_cfg.get("host") or DEFAULT_WEB_HOST)

    def current_web_port(self):
        if self.web_port:
            try:
                return int(self.web_port)
            except (TypeError, ValueError):
                pass
        web_cfg = self.config.get("web") \
            if isinstance(self.config.get("web"), dict) else {}
        try:
            return int(web_cfg.get("port", DEFAULT_WEB_PORT))
        except (TypeError, ValueError):
            return DEFAULT_WEB_PORT

    def test_web_port(self, port):
        """POST /api/web/test-port logic. The port this process is
        already serving on always tests available: it is freed when
        the service restarts onto it."""
        port = validate_web_port(port)
        if port == self.current_web_port():
            return {"ok": True, "port": port, "available": True,
                    "current": True}
        host = self.current_web_host()
        if web_port_available(host, port):
            return {"ok": True, "port": port, "available": True,
                    "current": False}
        return {"ok": False, "port": port, "available": False,
                "current": False,
                "error": f"port {port} is not available on {host}"}

    def apply_service_config(self, cmd):
        # Service-level config: model, buffer cap, mqtt block, and/or
        # portal port. One save for a combined call; MQTT switching
        # happens after the save. Retained topics under an old
        # topic_root are NOT cleared automatically (documented in
        # README/DESIGN).
        # Returns a dict: empty normally, or restarting/new_port/
        # old_port when a port change schedules a service restart.
        # A bad port raises ValueError BEFORE any mutation, so a
        # failed port save persists nothing.
        if not isinstance(cmd, dict):
            return {}
        restart_info = None
        if 'web_port' in cmd:
            new_port = validate_web_port(cmd['web_port'])
            old_port = self.current_web_port()
            if new_port != old_port:
                host = self.current_web_host()
                if not web_port_available(host, new_port):
                    raise ValueError(
                        f"portal port {new_port} is not available "
                        f"on {host}")
                restart_info = {'old_port': old_port,
                                'new_port': new_port}
        changed = False
        mqtt_switch = None
        if 'model' in cmd:
            want = {'n': 'yolov8n', 's': 'yolov8s'}.get(cmd['model'], cmd['model'])
            if want in MODELS and want != self.model_name:
                self.pending_model = want
                changed = True
            elif want not in MODELS:
                print('service config: unknown model ' + repr(cmd['model']) + '; want yolov8n/yolov8s', flush=True)
        if 'buffer_cap_mb' in cmd:
            self.config['buffer']['cap_bytes'] = int(cmd['buffer_cap_mb']) * 1024 * 1024
            changed = True
        if 'mqtt' in cmd and isinstance(cmd['mqtt'], dict):
            stored = self.config.get('mqtt') if isinstance(self.config.get('mqtt'), dict) else {}
            new_mqtt = normalize_mqtt_block(cmd['mqtt'], stored=stored)
            if new_mqtt != stored:
                self.config['mqtt'] = new_mqtt
                self.mqtt_configured = mqtt_is_configured(self.config)
                self.root = str(new_mqtt.get('topic_root') or DEFAULT_TOPIC_ROOT).rstrip('/')
                mqtt_switch = new_mqtt
                changed = True
        if 'web_port' in cmd:
            # Legacy configs may have no web block: create it with
            # defaults (host 0.0.0.0, current port) rather than crash.
            web_cfg = self.config.setdefault('web', {})
            if not isinstance(web_cfg, dict):
                web_cfg = self.config['web'] = {}
            before = dict(web_cfg)
            web_cfg.setdefault('host', DEFAULT_WEB_HOST)
            if restart_info is not None:
                web_cfg['port'] = restart_info['new_port']
                changed = True
            else:
                web_cfg.setdefault('port', old_port)
            if web_cfg != before:
                changed = True
        if changed:
            self.save_config()
            if restart_info is not None:
                # Restart AFTER the save response reaches the browser:
                # the main loop honours this once the delay elapses.
                self.restart_requested = {
                    'old_port': restart_info['old_port'],
                    'new_port': restart_info['new_port'],
                    'at': time.monotonic() + 0.75}
            if mqtt_switch is not None:
                if self.mqtt_configured:
                    self.mqtt_disconnect()
                    self.start_mqtt_background()
                else:
                    self.mqtt_disconnect()
                self.notify_stream({'type': 'config'})
            else:
                self.publish_service_config()
                self.notify_stream({'type': 'config'})
        if restart_info is not None:
            return {'restarting': True,
                    'old_port': restart_info['old_port'],
                    'new_port': restart_info['new_port']}
        return {}


    # ---- incoming commands ----
    def notify_stream(self, payload):
        """Push a live-update notification to web UI SSE clients.

        Never raises and never blocks inference: a web failure must
        not take down the sensor.
        """
        try:
            ws = self.web_server
            if ws is not None:
                ws.notify(payload)
        except Exception:
            pass

    def drain_messages(self):
        while True:
            try:
                item = self.msg_queue.get_nowait()
            except queue.Empty:
                break
            try:
                if isinstance(item, tuple) and item and item[0] == "__web__":
                    self.handle_web_item(item)
                else:
                    topic, payload = item
                    self.handle_message(topic, payload)
            except Exception as e:
                # One bad message must never kill the supervisor loop.
                print(f"message handling error: {e}", flush=True)

    def handle_web_item(self, item):
        """Requests from the web thread. Runs on the main loop, so the
        main loop stays the single config writer."""
        _, kind, cam_id, cmd, ack, result = item
        try:
            if kind == "config":
                cam = self._find_cam(cam_id)
                if cam is None:
                    result["error"] = f"unknown camera {cam_id}"
                else:
                    self.apply_config_command(cam, cmd)
                    result["camera"] = self.camera_config_payload(cam)
            elif kind == "capture_now":
                cam = self._find_cam(cam_id)
                if cam is None:
                    result["error"] = f"unknown camera {cam_id}"
                else:
                    cam["capture_now"].set()
                    cam["priority_next"] = True
                    result["ok"] = True
            elif kind == "service_config":
                info = self.apply_service_config(cmd) or {}
                result.update(info)
                result["ok"] = True
            elif kind == "camera_add":
                result["camera"] = self.add_camera(cmd)
            elif kind == "camera_edit":
                result["camera"] = self.edit_camera(cam_id, cmd)
            elif kind == "camera_pause":
                result["camera"] = self.pause_camera(cam_id)
            elif kind == "camera_resume":
                result["camera"] = self.resume_camera(cam_id)
            elif kind == "camera_delete":
                self.delete_camera(cam_id)
                result["ok"] = True
            elif kind == "rescan":
                result["camera"] = self.rescan_picamera()
            else:
                result["error"] = f"unknown web item {kind}"
        except ValueError as e:
            result["error"] = str(e)
        except Exception as e:
            result["error"] = f"{type(e).__name__}: {e}"
        finally:
            ack.set()

    def enqueue_web(self, kind, cam_id, cmd=None, timeout=10.0):
        """Called from the web thread: route a request through the main
        loop and wait for the result. Returns (result_dict, ok)."""
        ack = threading.Event()
        result = {}
        self.msg_queue.put(("__web__", kind, cam_id, cmd or {}, ack, result))
        if not ack.wait(timeout=timeout):
            return {"error": "timed out waiting for main loop"}, False
        if "error" in result:
            return result, False
        return result, True

    def _find_cam(self, cam_id):
        return next((c for c in self.cameras if c["id"] == cam_id), None)

    def _find_ccfg(self, cam_id):
        return next((c for c in self.config.get("cameras", [])
                     if c.get("id") == cam_id), None)

    def handle_message(self, topic, payload):
        parts = topic.split("/")
        # .../cameras/<camera-id>/config/set
        # .../cameras/<camera-id>/images/request
        try:
            ci = parts.index("cameras")
        except ValueError:
            return
        if len(parts) < ci + 4:
            return
        cam_id = parts[ci + 1]
        tail = parts[ci + 2:]
        cam = self._find_cam(cam_id)
        if cam is None:
            return
        try:
            if tail == ["config", "set"]:
                self.apply_config_command(cam, payload)
            elif tail == ["images", "request"]:
                self.handle_image_request(cam, payload)
        except Exception as e:
            print(f"[{cam_id}] MQTT command failed: {e}", flush=True)

    def apply_config_command(self, cam, cmd):
        if not isinstance(cmd, dict):
            return
        cfg = cam["cfg"]
        changed = False
        if "sample_interval" in cmd:
            cfg["sample_interval"] = float(cmd["sample_interval"]); changed = True
        if "confidence_threshold" in cmd:
            cfg["confidence_threshold"] = float(cmd["confidence_threshold"]); changed = True
        if "watchlist" in cmd and isinstance(cmd["watchlist"], list):
            self.set_watchlist(cam, cmd["watchlist"]); changed = True
        if "model" in cmd:
            # Model is service-level in v0.3.0 (DESIGN.md §15.6). A
            # per-camera model key is ignored with a logged warning;
            # use the Settings modal (service-level model) to swap.
            print(f"[{cam['id']}] ignoring per-camera model key "
                  f"({cmd['model']!r}); model is service-level", flush=True)
        if "buffer_cap_mb" in cmd:
            self.config["buffer"]["cap_bytes"] = int(cmd["buffer_cap_mb"]) * 1024 * 1024
            changed = True
        if "heartbeat_interval" in cmd:
            cfg["heartbeat_interval"] = int(cmd["heartbeat_interval"]); changed = True
        if "disappear_confirm_cycles" in cmd:
            try:
                dcc = int(cmd["disappear_confirm_cycles"])
            except (TypeError, ValueError):
                dcc = None
            if dcc is None or not (DISAPPEAR_CONFIRM_MIN <= dcc
                                   <= DISAPPEAR_CONFIRM_MAX):
                print("[" + str(cam["id"]) + "] disappear_confirm_cycles invalid ("
                      + repr(cmd["disappear_confirm_cycles"]) + "); using default "
                      + str(DISAPPEAR_CONFIRM_DEFAULT), flush=True)
                dcc = DISAPPEAR_CONFIRM_DEFAULT
            cfg["disappear_confirm_cycles"] = dcc; changed = True
        if "publish" in cmd and isinstance(cmd["publish"], dict):
            cfg.setdefault("publish", {}).update(cmd["publish"]); changed = True
        if "camera_controls" in cmd and isinstance(cmd["camera_controls"], dict):
            # Explicit nulls CLEAR a stored key (the Pi modal's Auto
            # mode sends exposure_time/analogue_gain as null to return
            # the camera to auto); a plain merge would retain them.
            merged = dict(cfg.get("camera_controls", {}))
            for k, v in cmd["camera_controls"].items():
                if v is None:
                    merged.pop(k, None)
                else:
                    merged[k] = v
            cfg["camera_controls"] = merged
            try:
                if cam.get("obj") is not None:
                    cam["obj"].apply_camera_controls(merged)
            except Exception as e:
                print(f"[{cam['id']}] camera controls failed: {e}", flush=True)
            changed = True
        if "imgsz" in cmd:
            cfg["imgsz"] = int(cmd["imgsz"]); changed = True
        if "icon" in cmd:
            if cmd["icon"] in ICON_KEYS:
                cfg["icon"] = cmd["icon"]; changed = True
        if "rotate" in cmd:
            if int(cmd["rotate"]) in (0, 90, 180, 270):
                cfg["rotate"] = int(cmd["rotate"]); changed = True
        if "name" in cmd:
            new_name = str(cmd["name"]).strip()
            if new_name:
                self._check_name_unique(new_name, exclude_id=cam["id"])
                cfg["name"] = new_name; changed = True
        if "paused" in cmd:
            if bool(cmd["paused"]):
                self.pause_camera(cam["id"])
            else:
                self.resume_camera(cam["id"])
            changed = True  # pause/resume already saved + published
        if "rtsp" in cmd and isinstance(cmd["rtsp"], dict) \
                and cfg.get("type") == "rtsp":
            self._apply_rtsp_update(cam, cmd["rtsp"])
            changed = True  # _apply_rtsp_update saved + published
        if cmd.get("capture_now"):
            cam["capture_now"].set()
            cam["priority_next"] = True
            print(f"[{cam['id']}] capture_now triggered", flush=True)
        if changed:
            print(f"[{cam['id']}] config updated: "
                  f"{redact_value(cmd)}", flush=True)
            self.save_config()
            self.publish_camera_config(cam)
            self.notify_stream({"type": "config", "camera_id": cam["id"]})

    def _apply_rtsp_update(self, cam, rtsp_update):
        """Merge an rtsp-block update; restart the capture thread when
        any connection field changed. Caller: apply_config_command."""
        cfg = cam["cfg"]
        old = dict(cfg.get("rtsp", {}) or {})
        new = dict(old)
        for key in default_rtsp_block():
            if key in rtsp_update:
                new[key] = rtsp_update[key]
        cfg["rtsp"] = new
        if new == old:
            return
        print(f"[{cam['id']}] RTSP connection changed; "
              "restarting capture thread", flush=True)
        self._restart_capture_thread(cam)

    def _check_name_unique(self, name, exclude_id=None):
        for ccfg in self.config.get("cameras", []):
            if ccfg.get("id") == exclude_id:
                continue
            if str(ccfg.get("name", "")).strip().lower() == name.lower():
                raise ValueError(
                    f"a camera named {ccfg.get('name')!r} already exists; "
                    "camera names must be unique")

    def handle_image_request(self, cam, payload):
        event_id = payload.get("event_id", "") if isinstance(payload, dict) else ""
        if not event_id or not all(c.isalnum() or c in "-_TZ" for c in event_id):
            return
        matches = glob.glob(os.path.join(
            PROJECT_DIR, self.config["buffer"].get("dir", "buffer"),
            cam["id"], event_id + ".jpg"))
        if not matches:
            print(f"[{cam['id']}] image {event_id} not found", flush=True)
            return
        with open(matches[0], "rb") as f:
            jpeg_b64 = base64.b64encode(f.read()).decode("ascii")
        reg = self.event_registry.get(event_id, {})
        sidecar = self.load_event_sidecar(cam, event_id)
        timestamp = reg.get("timestamp") or (sidecar or {}).get("timestamp")
        detections = reg.get("detections") or (sidecar or {}).get(
            "detections", {})
        self.publish_cam(cam, "images/response", {
            "event_id": event_id,
            "timestamp": timestamp,
            "jpeg_base64": jpeg_b64,
            "detections": detections})
        print(f"[{cam['id']}] served image {event_id}", flush=True)

    def load_event_sidecar(self, cam, event_id):
        """Read <event_id>.json if present; None if missing/unreadable."""
        p = os.path.join(self.buffer_dir(cam["id"]), event_id + ".json")
        try:
            with open(p) as f:
                data = json.load(f)
            return data if isinstance(data, dict) else None
        except (OSError, ValueError):
            return None

    # ---- camera lifecycle (DESIGN.md §15.3) ----
    def test_camera(self, body, camera_id=None):
        # Connection test: grabs one frame, returns thumbnail +
        # resolution + codec. Persists NOTHING, never echoes/logs
        # credentials, never hangs (bounded by timeout_s). USB tests
        # return the same shape as RTSP tests.
        cam = self._find_cam(camera_id) if camera_id else None
        if camera_id and cam is None:
            raise ValueError('unknown camera ' + str(camera_id))
        is_usb = False
        if cam is not None:
            is_usb = cam['cfg'].get('type') == 'usb'
        elif isinstance(body, dict) and (body.get('type') == 'usb' or isinstance(body.get('usb'), dict)):
            is_usb = True
        if is_usb:
            if cam is not None and isinstance(body, dict) and not isinstance(body.get('usb'), dict):
                body = dict(body)
                body['usb'] = dict(cam['cfg'].get('usb', {}) or {})
                body['usb_controls'] = dict(cam['cfg'].get('usb_controls', {}) or {})
                if 'name' not in body:
                    body['name'] = cam['cfg'].get('name', cam['id'])
            fields, usb, controls, resolution = normalize_usb_form(body)
            if cam is not None:
                stored_usb = dict(cam['cfg'].get('usb', {}) or {})
                if usb == stored_usb and cam.get('slot') is not None:
                    frame = cam['slot']
                    h, w = frame.shape[:2]
                    ok, buf = cv2.imencode('.jpg', self._downscale(frame, 320), [cv2.IMWRITE_JPEG_QUALITY, 70])
                    if not ok:
                        raise ValueError('usb connection test failed: thumbnail encode failed')
                    return {'thumbnail_base64': base64.b64encode(buf.tobytes()).decode('ascii'), 'width': int(w), 'height': int(h), 'codec': stored_usb.get('pixel_format', 'MJPG'), 'grab_seconds': cam.get('last_grab_seconds') or 0, 'source': stored_usb.get('device_id', '')}
                if isinstance(cam.get('obj'), USBCamera) and not cam.get('paused') and cam['obj']._cap is not None:
                    try:
                        frame, w, h, codec, secs, source = USBCamera.test_usb(usb)
                    except RTSPTestError:
                        raise ValueError('usb device is busy; pause the camera and test again')
                else:
                    try:
                        frame, w, h, codec, secs, source = USBCamera.test_usb(usb)
                    except RTSPTestError as e:
                        raise ValueError('usb connection test failed: ' + str(e))
            else:
                try:
                    frame, w, h, codec, secs, source = USBCamera.test_usb(usb)
                except RTSPTestError as e:
                    raise ValueError('usb connection test failed: ' + str(e))
            ok, buf = cv2.imencode('.jpg', self._downscale(frame, 320), [cv2.IMWRITE_JPEG_QUALITY, 70])
            if not ok:
                raise ValueError('usb connection test failed: thumbnail encode failed')
            return {'thumbnail_base64': base64.b64encode(buf.tobytes()).decode('ascii'), 'width': int(w), 'height': int(h), 'codec': codec, 'grab_seconds': secs, 'source': source}
        fields, rtsp = normalize_camera_form(body)
        if cam is not None and cam['cfg'].get('type') != 'rtsp':
            raise ValueError('connection test only applies to RTSP cameras')
        lock = None
        if cam is not None and isinstance(cam.get('obj'), RTSPCamera):
            lock = cam['obj']._lock
        if cam is not None:
            stored = cam['cfg'].get('rtsp', {}) or {}
            if fields['credentials_on'] and not fields['password_given'] and stored.get('password'):
                rtsp['password'] = stored['password']
                if not rtsp.get('username'):
                    rtsp['username'] = stored.get('username', '')
        try:
            frame, w, h, codec, secs, source = RTSPCamera.test_connection(rtsp, stream_lock=lock)
        except RTSPTestError as e:
            raise ValueError('connection test failed: ' + str(e))
        ok, buf = cv2.imencode('.jpg', self._downscale(frame, 320), [cv2.IMWRITE_JPEG_QUALITY, 70])
        if not ok:
            raise ValueError('connection test failed: thumbnail encode failed')
        return {'thumbnail_base64': base64.b64encode(buf.tobytes()).decode('ascii'), 'width': w, 'height': h, 'codec': codec, 'grab_seconds': secs, 'source': source}

    @staticmethod
    def _downscale(frame, max_width):
        h, w = frame.shape[:2]
        if w <= max_width:
            return frame
        scale = max_width / w
        return cv2.resize(frame, (max_width, max(1, int(h * scale))))

    def usb_scan(self):
        present = scan_usb_present()
        by_device = {}
        for c in self.config.get('cameras', []):
            if c.get('type') == 'usb':
                usb = c.get('usb', {}) or {}
                by_device[usb.get('device_id', '')] = c
        out = []
        seen = set()
        for d in present:
            entry = {'device_id': d['device_id'], 'model': d['model'],
                     'present': True, 'formats': d['formats']}
            c = by_device.get(d['device_id'])
            if c is not None:
                entry['camera_id'] = c['id']
                entry['camera_name'] = c.get('name', '')
            else:
                entry['camera_id'] = None
                entry['camera_name'] = None
            seen.add(d['device_id'])
            out.append(entry)
        for device_id, c in by_device.items():
            if device_id in seen:
                continue
            usb = c.get('usb', {}) or {}
            out.append({'device_id': device_id,
                        'model': usb.get('model') or c.get('name', ''),
                        'present': False, 'camera_id': c['id'],
                        'camera_name': c.get('name', ''), 'formats': []})
        return {'devices': out}

    def _add_usb_camera(self, body):
        fields, usb, controls, resolution = normalize_usb_form(body)
        self._check_name_unique(fields['name'])
        try:
            frame, w, h, codec, secs, source = USBCamera.test_usb(usb)
        except RTSPTestError as e:
            raise ValueError('usb connection test failed: ' + str(e))
        cam_id = 'camera' + str(self.config.get('next_camera_id', 0))
        self.config['next_camera_id'] = self.config.get('next_camera_id', 0) + 1
        ccfg = default_camera_cfg(cam_id, 'usb', fields['name'])
        ccfg['icon'] = fields['icon']
        ccfg['paused'] = fields['paused']
        ccfg['rotate'] = fields['rotate']
        ccfg['sample_interval'] = fields['sample_interval']
        ccfg['resolution'] = [w, h]
        present = {d['device_id']: d for d in scan_usb_present()}
        if usb['device_id'] in present:
            usb['model'] = present[usb['device_id']]['model']
        ccfg['usb'] = usb
        ccfg['usb_controls'] = controls
        self.config.setdefault('cameras', []).append(ccfg)
        self.save_config()
        cam = self._make_runtime_cam(ccfg, USBCamera(ccfg))
        self.cameras.append(cam)
        det = {k: body[k] for k in ('confidence_threshold', 'imgsz',
                                    'heartbeat_interval', 'publish',
                                    'watchlist', 'disappear_confirm_cycles') if k in body}
        if det:
            self.apply_config_command(cam, det)
        self.start_capture_thread(cam)
        self.publish_service_config()
        self.publish_camera_config(cam)
        self.publish_cam(cam, 'status', {'status': cam['status'], 'timestamp': utcnow_iso()}, retain=True)
        self.notify_stream({'type': 'config', 'camera_id': cam_id})
        print('[' + cam_id + '] usb camera added (' + fields['name'] + ', ' + str(w) + 'x' + str(h) + ' ' + codec + ')', flush=True)
        return self.camera_config_payload(cam)

    def _edit_usb_camera(self, cam, body):
        cam_id = cam['id']
        fields, usb, controls, resolution = normalize_usb_form(body)
        self._check_name_unique(fields['name'], exclude_id=cam_id)
        ccfg = cam['cfg']
        stored_usb = dict(ccfg.get('usb', {}) or {})
        stored_controls = dict(ccfg.get('usb_controls', {}) or {})
        stored_res = list(ccfg.get('resolution', [1280, 720]))
        connection_changed = (usb != stored_usb or controls != stored_controls or resolution != stored_res)
        if connection_changed:
            live = isinstance(cam.get('obj'), USBCamera) and not cam.get('paused') and cam['obj']._cap is not None
            if live:
                self.stop_capture_thread(cam)
                try:
                    cam['obj'].close()
                except Exception:
                    pass
                try:
                    USBCamera.test_usb(usb)
                except RTSPTestError as e:
                    self._restart_capture_thread(cam)
                    raise ValueError('usb connection test failed: ' + str(e))
            else:
                try:
                    USBCamera.test_usb(usb)
                except RTSPTestError as e:
                    raise ValueError('usb connection test failed: ' + str(e))
        paused_changed = (fields['paused'] != bool(ccfg.get('paused', False)))
        ccfg['name'] = fields['name']
        ccfg['icon'] = fields['icon']
        ccfg['rotate'] = fields['rotate']
        ccfg['sample_interval'] = fields['sample_interval']
        ccfg['usb'] = usb
        ccfg['usb_controls'] = controls
        ccfg['resolution'] = resolution
        det = {k: body[k] for k in ('confidence_threshold', 'imgsz',
                                    'heartbeat_interval', 'publish',
                                    'watchlist', 'disappear_confirm_cycles') if k in body}
        if det:
            self.apply_config_command(cam, det)
        if connection_changed:
            print('[' + cam_id + '] usb connection changed; restarting capture thread', flush=True)
            self._restart_capture_thread(cam)
        if paused_changed:
            if fields['paused']:
                self._apply_pause(cam)
            else:
                self._apply_resume(cam)
        self.save_config()
        self.publish_camera_config(cam)
        self.notify_stream({'type': 'config', 'camera_id': cam_id})
        print('[' + cam_id + '] usb camera edited', flush=True)
        return self.camera_config_payload(cam)

    def add_camera(self, body):
        if isinstance(body, dict) and body.get('type') == 'usb':
            return self._add_usb_camera(body)
        """Add an RTSP camera. Runs the connection test BEFORE
        persisting; a failed test adds nothing. IDs come from the
        monotonic next_camera_id counter and are never reused."""
        fields, rtsp = normalize_camera_form(body)
        self._check_name_unique(fields["name"])
        try:
            frame, w, h, codec, secs, source = RTSPCamera.test_connection(rtsp)
        except RTSPTestError as e:
            raise ValueError(f"connection test failed: {e}")
        cam_id = f"camera{self.config.get('next_camera_id', 0)}"
        self.config["next_camera_id"] = (
            self.config.get("next_camera_id", 0) + 1)
        ccfg = default_camera_cfg(cam_id, "rtsp", fields["name"])
        ccfg["icon"] = fields["icon"]
        ccfg["paused"] = fields["paused"]
        ccfg["rotate"] = fields["rotate"]
        ccfg["sample_interval"] = fields["sample_interval"]
        ccfg["resolution"] = [w, h]  # measured by the test
        ccfg["rtsp"] = rtsp
        self.config.setdefault("cameras", []).append(ccfg)
        self.save_config()
        cam = self._make_runtime_cam(ccfg, RTSPCamera(ccfg))
        self.cameras.append(cam)
        # Detection fields ride along with the Add body (the shared
        # Detection tab); apply them through the same path as edits.
        det = {k: body[k] for k in ("confidence_threshold", "imgsz",
                                    "heartbeat_interval", "publish",
                                    "watchlist", "disappear_confirm_cycles") if k in body}
        if det:
            self.apply_config_command(cam, det)
        self.start_capture_thread(cam)
        self.publish_service_config()
        self.publish_camera_config(cam)
        self.publish_cam(cam, "status",
                         {"status": cam["status"],
                          "timestamp": utcnow_iso()}, retain=True)
        self.notify_stream({"type": "config", "camera_id": cam_id})
        print(f"[{cam_id}] camera added ({fields['name']}, "
              f"{w}x{h} {codec})", flush=True)
        return self.camera_config_payload(cam)

    def edit_camera(self, cam_id, body):
        """Edit a camera (same modal as add). Connection changes re-run
        the test before persisting; a failed test persists nothing.
        An empty password keeps the stored password."""
        cam = self._find_cam(cam_id)
        if cam is None:
            raise ValueError(f"unknown camera {cam_id}")
        if cam["cfg"].get("type") == "picamera":
            return self._edit_picamera(cam, body)
        if cam['cfg'].get('type') == 'usb':
            return self._edit_usb_camera(cam, body)
        fields, rtsp = normalize_camera_form(body)
        self._check_name_unique(fields["name"], exclude_id=cam_id)
        ccfg = cam["cfg"]
        stored = dict(ccfg.get("rtsp", {}) or {})
        if fields["credentials_on"] and not fields["password_given"] \
                and stored.get("password"):
            rtsp["password"] = stored["password"]
            if not rtsp.get("username"):
                rtsp["username"] = stored.get("username", "")
        connection_changed = (rtsp != stored)
        if connection_changed:
            try:
                RTSPCamera.test_connection(rtsp)
            except RTSPTestError as e:
                raise ValueError(f"connection test failed: {e}")
        paused_changed = (fields["paused"] != bool(ccfg.get("paused", False)))
        ccfg["name"] = fields["name"]
        ccfg["icon"] = fields["icon"]
        ccfg["rotate"] = fields["rotate"]
        ccfg["sample_interval"] = fields["sample_interval"]
        ccfg["rtsp"] = rtsp
        # Detection fields ride along with the Edit body (the shared
        # Detection tab); apply them through the same path as config.
        det = {k: body[k] for k in ("confidence_threshold", "imgsz",
                                    "heartbeat_interval", "publish",
                                    "watchlist", "disappear_confirm_cycles") if k in body}
        if det:
            self.apply_config_command(cam, det)
        if connection_changed:
            print(f"[{cam_id}] connection changed; "
                  "restarting capture thread", flush=True)
            self._restart_capture_thread(cam)
        if paused_changed:
            if fields["paused"]:
                self._apply_pause(cam)
            else:
                self._apply_resume(cam)
        self.save_config()
        self.publish_camera_config(cam)
        self.notify_stream({"type": "config", "camera_id": cam_id})
        print(f"[{cam_id}] camera edited", flush=True)
        return self.camera_config_payload(cam)

    def _edit_picamera(self, cam, body):
        """Edit the Pi camera: identity + detection + camera controls.
        No connection test (local camera); no delete (enforced by the
        web layer)."""
        cam_id = cam["id"]
        ccfg = cam["cfg"]
        name = body.get("name", "")
        if not isinstance(name, str) or not name.strip():
            raise ValueError("camera name is required")
        self._check_name_unique(name.strip(), exclude_id=cam_id)
        ccfg["name"] = name.strip()
        icon = body.get("icon")
        if icon in ICON_KEYS:
            ccfg["icon"] = icon
        rotate = body.get("rotate")
        if rotate is not None and int(rotate) in (0, 90, 180, 270):
            ccfg["rotate"] = int(rotate)
        # start_paused from the modal maps to the paused flag.
        paused = body.get("start_paused", body.get("paused"))
        if paused is not None:
            if bool(paused) and not ccfg.get("paused", False):
                self._apply_pause(cam)
            elif not bool(paused) and ccfg.get("paused", False):
                self._apply_resume(cam)
        det = {k: body[k] for k in ("confidence_threshold", "imgsz",
                                    "heartbeat_interval", "publish",
                                    "watchlist", "disappear_confirm_cycles", "sample_interval",
                                    "camera_controls") if k in body}
        if det:
            self.apply_config_command(cam, det)
        self.save_config()
        self.publish_camera_config(cam)
        self.notify_stream({"type": "config", "camera_id": cam_id})
        print(f"[{cam_id}] Pi camera edited", flush=True)
        return self.camera_config_payload(cam)

    def _apply_pause(self, cam):
        """Pause: stop capture AND disconnect the RTSP stream (frees
        the camera for other apps). Status paused; counts freeze."""
        cam["cfg"]["paused"] = True
        cam["paused"] = True
        if isinstance(cam.get("obj"), (RTSPCamera, USBCamera)):
            cam["obj"].close()
        self.set_cam_status(cam, "paused")
        self.save_config()
        self.publish_camera_config(cam)

    def _apply_resume(self, cam):
        cam["cfg"]["paused"] = False
        cam["paused"] = False
        # Optimistic online; the capture thread promotes from degraded
        # if grabs fail, and the watchdog degrades on stale frames.
        self.set_cam_status(cam, "online")
        self.save_config()
        self.publish_camera_config(cam)

    def pause_camera(self, cam_id):
        cam = self._find_cam(cam_id)
        if cam is None:
            raise ValueError(f"unknown camera {cam_id}")
        self._apply_pause(cam)
        print(f"[{cam_id}] paused", flush=True)
        return self.camera_config_payload(cam)

    def resume_camera(self, cam_id):
        cam = self._find_cam(cam_id)
        if cam is None:
            raise ValueError(f"unknown camera {cam_id}")
        self._apply_resume(cam)
        print(f"[{cam_id}] resumed", flush=True)
        return self.camera_config_payload(cam)

    def delete_camera(self, cam_id):
        """Delete a camera: stop the thread, release the backend,
        remove from config, persist. Retained MQTT topics for the
        camera are cleared so subscribers never see a ghost camera.
        Buffered images are KEPT (evidence)."""
        cam = self._find_cam(cam_id)
        if cam is None:
            raise ValueError(f"unknown camera {cam_id}")
        if cam["cfg"].get("type") == "picamera":
            raise ValueError("the Pi camera cannot be deleted "
                             "(pause it instead)")
        self.stop_capture_thread(cam)
        try:
            if cam.get("obj") is not None:
                cam["obj"].close()
        except Exception:
            pass
        self._clear_camera_topics(cam)
        self.cameras = [c for c in self.cameras if c["id"] != cam_id]
        self.config["cameras"] = [c for c in self.config.get("cameras", [])
                                  if c.get("id") != cam_id]
        self.save_config()
        self.publish_service_config()
        self.notify_stream({"type": "config", "camera_id": cam_id})
        print(f"[{cam_id}] camera deleted (buffered images kept)",
              flush=True)

    def _clear_camera_topics(self, cam):
        """Retained-clear publishes for one camera's topics: empty
        retained payloads so subscribers drop the ghost camera."""
        topics = ["config", "status"]
        for cid in cam["watch_ids"]:
            topics.append(f"classId/{cid}")
            topics.append(f"className/{cam['id_to_name'][cid]}")
        for sub in topics:
            self.publish(self.t_cam(cam["id"], sub), b"", retain=True,
                         raw=True)

    def rescan_picamera(self):
        """Retry Picamera2 init at runtime (no service restart).
        Retries a failed picamera config entry first (same id); else
        creates a new Pi-camera entry from next_camera_id."""
        for cam in self.cameras:
            if cam["cfg"].get("type") == "picamera":
                return self.camera_config_payload(cam)
        ccfg = self._find_ccfg_for_picamera_retry()
        if ccfg is None:
            cam_id = f"camera{self.config.get('next_camera_id', 0)}"
            self.config["next_camera_id"] = (
                self.config.get("next_camera_id", 0) + 1)
            ccfg = default_camera_cfg(cam_id, "picamera", "Pi Camera")
            self.config.setdefault("cameras", []).append(ccfg)
        try:
            obj = PiCamera(ccfg)
        except Exception as e:
            raise ValueError(f"Pi camera not detected ({e})")
        cam = self._make_runtime_cam(ccfg, obj)
        self.cameras.append(cam)
        self.start_capture_thread(cam)
        self.save_config()
        self.publish_service_config()
        self.publish_camera_config(cam)
        self.publish_cam(cam, "status",
                         {"status": cam["status"],
                          "timestamp": utcnow_iso()}, retain=True)
        self.notify_stream({"type": "config", "camera_id": cam["id"]})
        print(f"[{cam['id']}] Pi camera found by rescan", flush=True)
        return self.camera_config_payload(cam)

    def _find_ccfg_for_picamera_retry(self):
        """A picamera config entry with no live runtime camera (its
        open failed at startup) is retried under its original id."""
        live = {c["id"] for c in self.cameras}
        for ccfg in self.config.get("cameras", []):
            if ccfg.get("type") == "picamera" and ccfg.get("id") not in live:
                return ccfg
        return None


    # ---- inference ----
    def new_event_id(self):
        ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return f"{ts}_{os.urandom(2).hex()}"

    def process_frame(self, cam, frame, ts_epoch):
        """Run one inference on a frame already pulled from the
        camera's slot. Owned by the inference worker thread (the only
        thread that touches the shared model)."""
        cfg = cam["cfg"]
        if not cam["watch_ids"]:
            print(f"[{cam['id']}] empty watchlist, skipping", flush=True)
            return
        t0 = time.time()
        threshold = cfg.get("confidence_threshold", 0.5)
        # Run the model at the display floor so sub-threshold ("weak")
        # detections reach the code; confirmed counts/events/MQTT still
        # use the configured threshold.
        infer_conf = threshold if threshold < DISPLAY_FLOOR else DISPLAY_FLOOR
        results = self.model_obj(frame, classes=cam["watch_ids"],
                                 conf=infer_conf,
                                 imgsz=cfg.get("imgsz", 640),
                                 verbose=False)[0]
        h, w = frame.shape[:2]
        counts = {cid: 0 for cid in cam["watch_ids"]}
        dets = {cid: [] for cid in cam["watch_ids"]}
        weak = []
        if results.boxes is not None:
            for box in results.boxes:
                cid = int(box.cls[0])
                if cid not in counts:
                    continue
                c = float(box.conf[0])
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                entry = {
                    "confidence": round(c, 3),
                    "bbox": [round(x1 / w, 4), round(y1 / h, 4),
                             round(x2 / w, 4), round(y2 / h, 4)]}
                if c >= threshold:
                    counts[cid] += 1
                    dets[cid].append(entry)
                elif c >= DISPLAY_FLOOR:
                    weak.append({"class": cam["id_to_name"][cid],
                                 "confidence": entry["confidence"],
                                 "bbox": entry["bbox"]})
        cam["last_inference_seconds"] = round(time.time() - t0, 2)
        # Latest-frame diagnostic state, refreshed every cycle even when
        # nothing is confirmed. Weak boxes are never stored or published.
        cam["latest_dets"] = {cam["id_to_name"][cid]: dets[cid]
                              for cid in cam["watch_ids"]}
        cam["latest_weak"] = weak
        cam["last_inference_at"] = utcnow_iso()
        self.last_cycle_seconds = cam["last_inference_seconds"]
        self.last_cycle_at = cam["last_inference_at"]
        # Asymmetric debounce: an appearance or any other count change
        # publishes after the same value is seen in 2 consecutive
        # inference cycles; a disappearance (count -> 0) needs
        # disappear_confirm_cycles consecutive empty cycles. While a
        # disappearance is pending, last_counts keeps the old value, so
        # the counts panel, /api/counts and MQTT keep showing it.
        pending = cam.setdefault("pending_changes", {})
        disappear_n = cfg.get("disappear_confirm_cycles",
                              DISAPPEAR_CONFIRM_DEFAULT)
        try:
            disappear_n = int(disappear_n)
        except (TypeError, ValueError):
            disappear_n = DISAPPEAR_CONFIRM_DEFAULT
        if not DISAPPEAR_CONFIRM_MIN <= disappear_n <= DISAPPEAR_CONFIRM_MAX:
            disappear_n = DISAPPEAR_CONFIRM_DEFAULT
        changed = []
        for cid in cam["watch_ids"]:
            if counts[cid] != cam["last_counts"][cid]:
                prev = pending.get(cid)
                if prev and prev.get("count") == counts[cid]:
                    prev["seen"] += 1
                else:
                    pending[cid] = {"count": counts[cid], "seen": 1}
                need = disappear_n if counts[cid] == 0 else 2
                if pending[cid]["seen"] >= need:
                    changed.append(cid)
            else:
                pending.pop(cid, None)
        if not changed:
            return
        # Act on confirmed changes only; drop their pending entries.
        for cid in changed:
            pending.pop(cid, None)
        ts = epoch_to_iso(ts_epoch)
        event_id = self.new_event_id()
        self.event_registry[event_id] = {
            "timestamp": ts,
            "detections": {cam["id_to_name"][c]: dets[c] for c in changed}}
        while len(self.event_registry) > EVENT_REGISTRY_MAX:
            self.event_registry.pop(next(iter(self.event_registry)))
        event_data = {
            "event_id": event_id,
            "camera_id": cam["id"],
            "timestamp": ts,
            "counts": {cam["id_to_name"][c]: counts[c]
                       for c in cam["watch_ids"]},
            "detections": {cam["id_to_name"][c]: dets[c]
                           for c in cam["watch_ids"]},
            "model": self.model_name,
            "threshold": cfg.get("confidence_threshold", 0.5),
        }
        self.store_frame(cam, event_id, frame, event_data)
        self.notify_stream({"type": "event", "event_id": event_id,
                            "camera_id": cam["id"], "timestamp": ts})
        for cid in changed:
            cam["last_counts"][cid] = counts[cid]
            name = cam["id_to_name"][cid]
            payload = {"timestamp": ts, "count": counts[cid],
                       "detections": dets[cid], "image_ref": event_id}
            if cfg.get("publish", {}).get("classId", True):
                self.publish_cam(cam, f"classId/{cid}", payload, retain=True)
            if cfg.get("publish", {}).get("className", True):
                self.publish_cam(cam, f"className/{name}", payload, retain=True)
        if cfg.get("publish", {}).get("events", True):
            self.publish_cam(cam, "events", {
                "timestamp": ts,
                "counts": {cam["id_to_name"][c]: counts[c]
                           for c in cam["watch_ids"]},
                "image_ref": event_id})
        print(f"[{cam['id']}] change: "
              + ", ".join(f"{cam['id_to_name'][c]}={counts[c]}" for c in changed),
              flush=True)

    # ---- ring buffer ----
    def store_frame(self, cam, event_id, frame, event_data=None):
        buf_dir = self.buffer_dir(cam["id"])
        os.makedirs(buf_dir, exist_ok=True)
        quality = self.config["buffer"].get("jpeg_quality", 85)
        cv2.imwrite(os.path.join(buf_dir, f"{event_id}.jpg"), frame,
                    [cv2.IMWRITE_JPEG_QUALITY, quality])
        if event_data is not None:
            sidecar = dict(event_data)
            sidecar["image"] = f"{event_id}.jpg"
            tmp = os.path.join(buf_dir, f".{event_id}.json.tmp")
            try:
                with open(tmp, "w") as f:
                    json.dump(sidecar, f, indent=2)
                os.replace(tmp, os.path.join(buf_dir, f"{event_id}.json"))
            except OSError as e:
                print(f"[{cam['id']}] sidecar write failed: {e}", flush=True)
                try:
                    os.remove(tmp)
                except OSError:
                    pass
        self.enforce_buffer_cap()

    def enforce_buffer_cap(self):
        buf_root = os.path.join(PROJECT_DIR,
                                self.config["buffer"].get("dir", "buffer"))
        cap = self.config["buffer"].get("cap_bytes", 2**30)
        max_files = self.config["buffer"].get("max_files", 5000)
        jpgs = []  # (mtime, size, path) for .jpg files only
        total = 0
        orphans = []  # sidecars/tmp files with no matching .jpg
        for dirpath, _, fns in os.walk(buf_root):
            for fn in fns:
                p = os.path.join(dirpath, fn)
                try:
                    sz = os.path.getsize(p)
                except OSError:
                    continue
                total += sz
                low = fn.lower()
                if low.endswith(".jpg"):
                    try:
                        jpgs.append((os.path.getmtime(p), sz, p))
                    except OSError:
                        pass
                elif low.endswith(".json"):
                    base = fn[:-5]
                    if not os.path.exists(
                            os.path.join(dirpath, base + ".jpg")):
                        orphans.append(p)
                elif low.endswith(".tmp"):
                    orphans.append(p)
        jpgs.sort()
        while (total > cap or len(jpgs) > max_files) and jpgs:
            _, s, p = jpgs.pop(0)
            # Evict the .jpg AND its .json sidecar as one pair.
            for q in (p, os.path.splitext(p)[0] + ".json"):
                try:
                    if os.path.exists(q):
                        total -= os.path.getsize(q)
                        os.remove(q)
                except OSError:
                    pass
        # A .json whose .jpg is gone (manual delete, crash) is dead weight.
        for p in orphans:
            try:
                os.remove(p)
            except OSError:
                pass

    # ---- threads ----
    def _make_runtime_cam(self, ccfg, obj):
        """Runtime dict for one camera. The frame slot holds exactly
        one frame (newest wins); the worker tracks the last processed
        sequence number."""
        status = "paused" if ccfg.get("paused") else "online"
        if obj is None:
            status = "offline"
        if ccfg.get('type') == 'usb' and resolve_usb_node((ccfg.get('usb', {}) or {}).get('device_id', '')) is None:
            status = 'offline'
        # Pi Sensor card: display-only detected info. Picamera2() with
        # no args opens camera_num 0 by construction, i.e. CSI 0.
        if ccfg.get("type") == "picamera" and obj is not None:
            sensor_model = getattr(obj, "sensor_model", "Unknown")
            camera_port = "CSI 0"
        else:
            sensor_model = None
            camera_port = None
        cam = {"id": ccfg["id"], "cfg": ccfg, "obj": obj,
               "sensor_model": sensor_model, "camera_port": camera_port,
               "name_to_id": self.name_to_id,
               "id_to_name": self.id_to_name,
               "watch_ids": [], "last_counts": {},
               "pending_changes": {},
               "latest_dets": {}, "latest_weak": [],
               "status": status, "status_reason": None,
               "paused": bool(ccfg.get("paused", False)),
               "slot": None, "slot_ts": None, "slot_seq": 0,
               "slot_lock": threading.Lock(),
               "last_processed_seq": -1,
               "last_capture_at": None, "last_grab_at": None,
               "last_grab_seconds": None, "last_grab_mono": 0.0,
               "last_slot_mono": 0.0, "last_inference_at": None,
               "last_inference_seconds": None, "last_inference_mono": 0.0,
               "grab_error": None, "fail_streak": 0,
               "capture_thread": None,
               "capture_stop": threading.Event(),
               "capture_now": threading.Event(),
               "priority_next": False,
               "backend_failed": obj is None}
        self.set_watchlist(cam, ccfg.get("watchlist", []), initial=True)
        return cam

    def start_capture_thread(self, cam):
        if cam.get("obj") is None:
            return
        cam["capture_stop"] = threading.Event()
        t = threading.Thread(target=self.capture_loop, args=(cam,),
                             daemon=True, name=f"capture-{cam['id']}")
        cam["capture_thread"] = t
        t.start()

    def stop_capture_thread(self, cam, timeout=5.0):
        cam["capture_stop"].set()
        t = cam.get("capture_thread")
        if t is not None and t.is_alive():
            t.join(timeout=timeout)
            if t.is_alive():
                print(f"[{cam['id']}] capture thread did not stop; "
                      "leaving it (daemon)", flush=True)
        cam["capture_thread"] = None

    def _restart_capture_thread(self, cam):
        """Recreate the backend object and restart the capture thread
        (used when a camera's connection settings change)."""
        self.stop_capture_thread(cam)
        try:
            if cam.get("obj") is not None:
                cam["obj"].close()
        except Exception:
            pass
        cls = CAMERA_TYPES.get(cam["cfg"].get("type", "picamera"))
        try:
            cam["obj"] = cls(cam["cfg"]) if cls else None
        except Exception as e:
            print(f"[{cam['id']}] backend reopen failed ({e}); "
                  "camera offline", flush=True)
            cam["obj"] = None
            cam["backend_failed"] = True
            self.set_cam_status(cam, "offline")
            return
        cam["backend_failed"] = False
        self.start_capture_thread(cam)

    def capture_loop(self, cam):
        """One capture thread per camera: grab at the camera's
        sample_interval (or immediately on capture_now) and write the
        newest frame into the slot. Never blocks inference."""
        while not self.stop_flag and not cam["capture_stop"].is_set():
            if cam.get("paused"):
                sleep_interruptible(0.2, (self._stop_evt,))
                continue
            now = time.time()
            due = (cam["capture_now"].is_set()
                   or now - cam["last_grab_mono"] >=
                   cam["cfg"].get("sample_interval", 5.0))
            if not due:
                sleep_interruptible(0.05, (self._stop_evt,))
                continue
            cam["capture_now"].clear()
            t0 = time.time()
            try:
                result = cam["obj"].capture()
            except Exception as e:
                result = None
                cam["grab_error"] = str(e)
            if result is None or result[0] is None:
                cam["fail_streak"] += 1
                if not cam.get("grab_error"):
                    cam["grab_error"] = "capture failed"
                self.set_cam_status(cam, "degraded", "capture failed")
                backoff = RECONNECT_BACKOFFS[min(
                    cam["fail_streak"] - 1, len(RECONNECT_BACKOFFS) - 1)]
                sleep_interruptible(backoff, (self._stop_evt,
                                              cam["capture_stop"]))
                continue
            frame, ts_epoch = result
            frame = apply_rotation(frame, cam["cfg"].get("rotate", 0))
            with cam["slot_lock"]:
                cam["slot"] = frame
                cam["slot_ts"] = ts_epoch
                cam["slot_seq"] += 1
            cam["last_grab_mono"] = time.time()
            cam["last_grab_seconds"] = round(time.time() - t0, 2)
            cam["last_grab_at"] = epoch_to_iso(ts_epoch)
            cam["last_capture_at"] = cam["last_grab_at"]
            cam["last_slot_mono"] = time.time()
            cam["grab_error"] = None
            cam["fail_streak"] = 0
            self.set_cam_status(cam, "online")
            self.notify_stream({"type": "frame", "camera_id": cam["id"],
                                "timestamp": cam["last_grab_at"]})

    def inference_step(self):
        """One worker pass: model swap (if requested), then one
        round-robin pass over due cameras with fresh frames.
        capture_now cameras go first."""
        if self.pending_model:
            want = self.pending_model
            self.pending_model = None
            self.perform_model_swap(want)
        now = time.time()
        ordered = sorted(self.cameras,
                         key=lambda c: 0 if c.get("priority_next") else 1)
        for cam in ordered:
            if self.stop_flag:
                return
            if cam.get("paused") or cam.get("obj") is None:
                continue
            if now - cam["last_inference_mono"] < \
                    cam["cfg"].get("sample_interval", 5.0):
                continue
            with cam["slot_lock"]:
                if cam["slot_seq"] <= cam["last_processed_seq"]:
                    continue
                frame = cam["slot"]
                ts_epoch = cam["slot_ts"]
                cam["last_processed_seq"] = cam["slot_seq"]
            cam["priority_next"] = False
            cam["last_inference_mono"] = now
            try:
                self.process_frame(cam, frame, ts_epoch)
            except Exception as e:
                print(f"[{cam['id']}] inference error: {e}", flush=True)

    def inference_loop(self):
        while not self.stop_flag:
            try:
                self.inference_step()
            except Exception as e:
                print(f"inference worker error: {e}", flush=True)
            sleep_interruptible(0.2, (self._stop_evt,))

    def watchdog_step(self):
        """Supervisor checks: restart dead capture threads; degrade
        cameras with no fresh frame for ~3x sample_interval + 30 s."""
        now = time.time()
        for cam in list(self.cameras):
            if cam.get("paused") or cam.get("backend_failed"):
                continue
            t = cam.get("capture_thread")
            if cam.get("obj") is not None and (t is None or not t.is_alive()):
                print(f"[{cam['id']}] capture thread died; restarting",
                      flush=True)
                self.start_capture_thread(cam)
            stale_after = 3 * cam["cfg"].get("sample_interval", 5.0) + 30
            last_slot = cam["last_slot_mono"] or self.started_monotonic
            if cam["status"] == "online" and now - last_slot > stale_after:
                self.set_cam_status(cam, "degraded",
                                    "no fresh frame from capture thread")

    # ---- lifecycle ----
    def setup_cameras(self):
        """Open configured cameras. A camera that fails to open is
        kept as offline (rescan can retry it); zero cameras is a valid
        running state -- this must NOT exit."""
        if self.model_obj is None:
            self.model_obj = self.model_factory(self.model_name)
            self.name_to_id.clear()
            self.name_to_id.update(
                {v: k for k, v in self.model_obj.names.items()})
            self.id_to_name.clear()
            self.id_to_name.update(
                {k: v for v, k in self.name_to_id.items()})
        for ccfg in self.config.get("cameras", []):
            cls = CAMERA_TYPES.get(ccfg.get("type", "picamera"))
            if cls is None:
                print(f"unknown camera type {ccfg.get('type')!r}; skipping",
                      flush=True)
                continue
            print(f"opening camera {ccfg['id']} ({ccfg.get('type')})",
                  flush=True)
            try:
                obj = cls(ccfg)
            except Exception as e:
                print(f"camera {ccfg['id']} failed to open ({e}); "
                      "status offline (rescan can retry)", flush=True)
                cam = self._make_runtime_cam(ccfg, None)
                self.cameras.append(cam)
                continue
            cam = self._make_runtime_cam(ccfg, obj)
            self.cameras.append(cam)
            self.start_capture_thread(cam)
        if not self.cameras:
            print("no cameras configured; service running (add cameras "
                  "via the web UI)", flush=True)

    def handle_signal(self, signum, frame):
        print(f"signal {signum}; stopping", flush=True)
        self.stop_flag = True
        self._stop_evt.set()

    def shutdown(self):
        print("shutting down", flush=True)
        self._stop_evt.set()
        for cam in self.cameras:
            self.stop_capture_thread(cam, timeout=2.0)
        if self.web_server is not None:
            try:
                self.web_server.stop()
            except Exception:
                pass
        for cam in self.cameras:
            try:
                self.publish_cam(cam, "status",
                                 {"status": "offline",
                                  "timestamp": utcnow_iso()},
                                 retain=True)
            except Exception:
                pass
            try:
                if cam.get("obj") is not None:
                    cam["obj"].close()
            except Exception:
                pass
        try:
            self.publish(self.t_pi("status"),
                         {"status": "offline", "timestamp": utcnow_iso()},
                         retain=True)
        except Exception:
            pass
        try:
            if self.client is not None:
                self.client.loop_stop()
                self.client.disconnect()
        except Exception:
            pass

    def start_web(self):
        """Start the Jaeger web UI. A failure here must never take down
        the sensor: log and continue without the UI."""
        if JaegerWebServer is None:
            print("web UI unavailable (web_ui import failed)", flush=True)
            return
        web_cfg = self.config.get("web", {})
        if not web_cfg.get("enabled", True):
            return
        host = web_cfg.get("host", "0.0.0.0")
        port = int(web_cfg.get("port", 8082))
        try:
            self.web_server = JaegerWebServer(self, host, port)
            self.web_server.start()
            self.web_port = port
            print(f"web UI listening on {host}:{port}", flush=True)
        except Exception as e:
            print(f"web UI failed to start ({e}); continuing without it",
                  flush=True)
            self.web_server = None

    def run(self):
        changes = migrate_config(self.config)
        if changes:
            self.save_config()
        self.mqtt_configured = mqtt_is_configured(self.config)
        _m = self.config.get('mqtt') if isinstance(self.config.get('mqtt'), dict) else {}
        self.root = str(_m.get('topic_root') or DEFAULT_TOPIC_ROOT).rstrip('/')
        self.setup_cameras()
        self.start_web()
        self.start_mqtt_background()
        signal.signal(signal.SIGTERM, self.handle_signal)
        signal.signal(signal.SIGINT, self.handle_signal)
        self.inference_thread = threading.Thread(
            target=self.inference_loop, daemon=True, name="inference")
        self.inference_thread.start()
        last_heartbeat = {cam["id"]: 0.0 for cam in self.cameras}
        print(f"yolo_sensor v{VERSION} running ({len(self.cameras)} camera(s))",
              flush=True)
        while not self.stop_flag:
            self.drain_messages()
            if self.restart_requested is not None and \
                    time.monotonic() >= self.restart_requested["at"]:
                req = self.restart_requested
                self.restart_requested = None
                host = self.current_web_host()
                if not web_port_available(host, req["new_port"]):
                    # Port grabbed since the save: abort, revert the
                    # saved port, stay on the old port. Clients poll
                    # the new port, then fall back to the old one.
                    web_cfg = self.config.setdefault("web", {})
                    if not isinstance(web_cfg, dict):
                        web_cfg = self.config["web"] = {}
                    web_cfg["port"] = req["old_port"]
                    self.save_config()
                    print(f"portal-port restart aborted: port "
                          f"{req['new_port']} became unavailable; "
                          f"kept port {req['old_port']}", flush=True)
                    self.notify_stream({"type": "restart_aborted",
                                        "old_port": req["old_port"],
                                        "new_port": req["new_port"]})
                else:
                    # Every open tab moves: broadcast first, give SSE
                    # a beat to flush, then exit the loop so
                    # shutdown() runs before the exec in main().
                    self.notify_stream({"type": "restart",
                                        "new_port": req["new_port"]})
                    time.sleep(0.5)
                    self.restart_exec = True
                    self.stop_flag = True
                    self._stop_evt.set()
                    break
            self.watchdog_step()
            now = time.time()
            for cam in list(self.cameras):
                if cam["id"] not in last_heartbeat:
                    last_heartbeat[cam["id"]] = 0.0
                if now - last_heartbeat[cam["id"]] >= \
                        cam["cfg"].get("heartbeat_interval", 600):
                    self.publish_camera_config(cam)
                    last_heartbeat[cam["id"]] = now
            if now - self.last_pi_heartbeat >= 600:
                self.publish_service_config()
                self.last_pi_heartbeat = now
            time.sleep(0.2)
        self.shutdown()


def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)


def load_or_create_config():
    if os.path.exists(CONFIG_PATH):
        return load_config()
    cfg = default_config()
    tmp = CONFIG_PATH + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(cfg, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CONFIG_PATH)
    print('created default config at ' + CONFIG_PATH + ' (MQTT disabled; add cameras via the web UI)', flush=True)
    return cfg


def main():
    sensor = YoloSensor(load_or_create_config())
    sensor.run()
    if getattr(sensor, "restart_exec", False):
        # Full-service restart on the new portal port: exec a fresh
        # process so the whole saved config is re-read (detection and
        # MQTT behaviour on restart are identical to a manual one:
        # MQTT offline then online, cameras reopened). Never restart
        # only the web thread as a shortcut.
        print("restarting on the new portal port (full service "
              "restart; config re-read)", flush=True)
        try:
            os.execv(sys.executable,
                     [sys.executable, os.path.abspath(__file__)])
        except Exception as e:
            print(f"portal-port restart exec failed ({e}); service "
                  f"stopped - restart manually from "
                  f"~/projects/jaeger with: "
                  f"venv/bin/python -u yolo_sensor.py", flush=True)
            sys.exit(1)


if __name__ == "__main__":
    main()
