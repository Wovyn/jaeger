#!/usr/bin/env python3
"""Jaeger (muse-pi-yolo-mqtt) service v0.2.1.

Captures frames from configured cameras, runs YOLOv8 object detection, and
publishes per-class counts/details to MQTT only when the scene changes.

Topic tree: Wovyn/RaspberryPi/YOLOSensor/<cpu-serial>/camera{id}/...

Implementation: MuseCell-1. Spec: Scott.
"""

import base64
import datetime
import glob
import json
import os
import queue
import signal
import sys
import threading
import time

import cv2
import paho.mqtt.client as mqtt
from ultralytics import YOLO

try:
    from web_ui import JaegerWebServer
except ImportError:  # web UI optional; the sensor must keep running
    JaegerWebServer = None

VERSION = "0.2.1"
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(PROJECT_DIR, "config.json")
EVENT_REGISTRY_MAX = 200


# --------------------------------------------------------------------------
# Camera backends
# --------------------------------------------------------------------------

class Camera:
    """Abstract camera. capture() returns (bgr_numpy_array, epoch_seconds)."""

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


CAMERA_TYPES = {
    "picamera": PiCamera,
    # "rtsp": RTSPCamera,  # planned (backlog)
}


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def utcnow_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def read_cpu_serial():
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("Serial"):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return "unknown"


# --------------------------------------------------------------------------
# Service
# --------------------------------------------------------------------------

class YoloSensor:
    def __init__(self, config):
        self.config = config
        self.serial = read_cpu_serial()
        self.root = config["mqtt"]["topic_root"].rstrip("/")
        self.msg_queue = queue.Queue()
        self.stop_flag = False
        self.cameras = []
        self.event_registry = {}
        self.pending_capture = set()
        self.client = None
        self.version = VERSION
        self.started_at = utcnow_iso()
        self.started_monotonic = time.time()
        self.mqtt_connected = False
        self.last_cycle_seconds = None
        self.last_cycle_at = None
        self.web_server = None
        self.web_port = None

    # ---- topics ----
    def t_pi(self, *parts):
        return "/".join([self.root, self.serial] + list(parts))

    def t_cam(self, cam_id, *parts):
        return "/".join([self.root, self.serial, cam_id] + list(parts))

    def publish(self, topic, payload, retain=False):
        self.client.publish(topic, json.dumps(payload), qos=1, retain=retain)

    def publish_cam(self, cam, subtopic, payload, retain=False):
        self.publish(self.t_cam(cam["id"], subtopic), payload, retain=retain)

    # ---- MQTT ----
    def mqtt_connect(self):
        m = self.config["mqtt"]
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                                  client_id=f"muse-yolo-{self.serial}")
        self.client.on_connect = self.on_connect
        self.client.on_message = self.on_message
        self.client.on_disconnect = self.on_disconnect
        self.client.will_set(
            self.t_pi("status"),
            json.dumps({"status": "offline", "timestamp": utcnow_iso()}),
            qos=1, retain=True)
        if m.get("tls", True):
            self.client.tls_set()
        self.client.username_pw_set(m["username"], m["password"])
        self.client.reconnect_delay_set(min_delay=1, max_delay=60)
        while not self.stop_flag:
            try:
                self.client.connect(m["host"], m.get("port", 8883), keepalive=60)
                break
            except Exception as e:
                print(f"MQTT connect failed ({e}); retrying in 5s", flush=True)
                time.sleep(5)
        self.client.loop_start()

    def on_connect(self, client, userdata, flags, reason_code, properties):
        print(f"MQTT connected (rc={reason_code})", flush=True)
        self.mqtt_connected = True
        for cam in self.cameras:
            cid = cam["id"]
            client.subscribe(self.t_cam(cid, "config", "set"), qos=1)
            client.subscribe(self.t_cam(cid, "images", "request"), qos=1)
        # Pi-level state
        self.publish(self.t_pi("config"), {
            "service": "muse-pi-yolo-mqtt", "version": VERSION,
            "cpu_serial": self.serial, "start_time": utcnow_iso(),
            "cameras": [c["id"] for c in self.cameras],
            "timestamp": utcnow_iso()}, retain=True)
        self.publish(self.t_pi("status"),
                     {"status": "online", "timestamp": utcnow_iso()}, retain=True)
        # Per-camera state (republish current counts, not zeros, on reconnect)
        for cam in self.cameras:
            self.publish_camera_config(cam)
            self.publish_cam(cam, "status",
                             {"status": "online", "timestamp": utcnow_iso()},
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
        tmp = CONFIG_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self.config, f, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, CONFIG_PATH)

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

    def camera_config_payload(self, cam):
        """One camera-config dict shared by MQTT publish + web API."""
        cfg = cam["cfg"]
        files, bytes_ = self.buffer_stats(cam["id"])
        return {
            "service": "muse-pi-yolo-mqtt", "version": VERSION,
            "cpu_serial": self.serial,
            "camera_id": cam["id"], "name": cam["obj"].name,
            "type": cfg.get("type", "picamera"),
            "resolution": [cam["obj"].width, cam["obj"].height],
            "access_method": cam["obj"].access_method,
            "sample_interval": cfg.get("sample_interval", 5.0),
            "model": cfg.get("model", "yolov8n"),
            "imgsz": cfg.get("imgsz", 640),
            "confidence_threshold": cfg.get("confidence_threshold", 0.5),
            "watchlist": cfg.get("watchlist", []),
            "publish": cfg.get("publish", {}),
            "heartbeat_interval": cfg.get("heartbeat_interval", 600),
            "camera_controls": cfg.get("camera_controls", {}),
            "last_capture_at": cam.get("last_capture_at"),
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
        cam["last_counts"] = {cid: 0 for cid in new_ids}
        cam["pending_changes"] = {}
        cam["cfg"]["watchlist"] = valid
        if not initial:
            # initial baselines are published by on_connect (client may not
            # exist yet when the startup watchlist is set)
            for cid in new_ids:
                self.publish_baseline(cam, cid)

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
            if isinstance(item, tuple) and item and item[0] == "__web__":
                self.handle_web_item(item)
            else:
                topic, payload = item
                self.handle_message(topic, payload)

    def handle_web_item(self, item):
        """Config/capture requests from the web thread. Runs on the main
        loop, so the main loop stays the single config writer."""
        _, kind, cam_id, cmd, ack, result = item
        cam = next((c for c in self.cameras if c["id"] == cam_id), None)
        try:
            if cam is None:
                result["error"] = f"unknown camera {cam_id}"
            elif kind == "config":
                self.apply_config_command(cam, cmd)
                result["camera"] = self.camera_config_payload(cam)
            elif kind == "capture_now":
                self.pending_capture.add(cam_id)
                result["ok"] = True
            else:
                result["error"] = f"unknown web item {kind}"
        except Exception as e:
            result["error"] = str(e)
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

    def handle_message(self, topic, payload):
        parts = topic.split("/")
        # .../<serial>/<camera-id>/config/set  or  .../<camera-id>/images/request
        if len(parts) < 3:
            return
        cam_id = parts[-3] if parts[-2:] == ["config", "set"] else (
            parts[-3] if parts[-2:] == ["images", "request"] else None)
        cam = next((c for c in self.cameras if c["id"] == cam_id), None)
        if cam is None:
            return
        if parts[-2:] == ["config", "set"]:
            self.apply_config_command(cam, payload)
        elif parts[-2:] == ["images", "request"]:
            self.handle_image_request(cam, payload)

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
            want = {"n": "yolov8n", "s": "yolov8s"}.get(cmd["model"], cmd["model"])
            if want in ("yolov8n", "yolov8s") and want != cfg.get("model"):
                cam["pending_model"] = want; changed = True
        if "buffer_cap_mb" in cmd:
            self.config["buffer"]["cap_bytes"] = int(cmd["buffer_cap_mb"]) * 1024 * 1024
            changed = True
        if "heartbeat_interval" in cmd:
            cfg["heartbeat_interval"] = int(cmd["heartbeat_interval"]); changed = True
        if "publish" in cmd and isinstance(cmd["publish"], dict):
            cfg.setdefault("publish", {}).update(cmd["publish"]); changed = True
        if "camera_controls" in cmd and isinstance(cmd["camera_controls"], dict):
            merged = dict(cfg.get("camera_controls", {}))
            merged.update(cmd["camera_controls"])
            cfg["camera_controls"] = merged
            try:
                cam["obj"].apply_camera_controls(merged)
            except Exception as e:
                print(f"[{cam['id']}] camera controls failed: {e}", flush=True)
            changed = True
        if "imgsz" in cmd:
            cfg["imgsz"] = int(cmd["imgsz"]); changed = True
        if cmd.get("capture_now"):
            self.pending_capture.add(cam["id"])
            print(f"[{cam['id']}] capture_now triggered", flush=True)
        if changed:
            print(f"[{cam['id']}] config updated: {cmd}", flush=True)
            self.save_config()
            self.publish_camera_config(cam)
            self.notify_stream({"type": "config", "camera_id": cam["id"]})

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

    # ---- inference cycle ----
    def new_event_id(self):
        ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return f"{ts}_{os.urandom(2).hex()}"

    def process_camera(self, cam):
        cfg = cam["cfg"]
        if cam.get("pending_model"):
            want = cam.pop("pending_model")
            print(f"[{cam['id']}] loading model {want}", flush=True)
            cam["model_obj"] = YOLO(os.path.join(PROJECT_DIR, "models", f"{want}.pt"))
            cfg["model"] = want
            name_to_id = {v: k for k, v in cam["model_obj"].names.items()}
            cam["name_to_id"] = name_to_id
            cam["id_to_name"] = {k: v for v, k in name_to_id.items()}
            self.set_watchlist(cam, cfg.get("watchlist", []))
            self.save_config()
            self.publish_camera_config(cam)
        if not cam["watch_ids"]:
            print(f"[{cam['id']}] empty watchlist, skipping", flush=True)
            return
        frame, _ = cam["obj"].capture()
        cam["latest_frame"] = frame
        ts = utcnow_iso()
        cam["last_capture_at"] = ts
        self.notify_stream({"type": "frame", "camera_id": cam["id"],
                            "timestamp": ts})
        results = cam["model_obj"](frame, classes=cam["watch_ids"],
                                   conf=cfg.get("confidence_threshold", 0.5),
                                   imgsz=cfg.get("imgsz", 640),
                                   verbose=False)[0]
        h, w = frame.shape[:2]
        counts = {cid: 0 for cid in cam["watch_ids"]}
        dets = {cid: [] for cid in cam["watch_ids"]}
        if results.boxes is not None:
            for box in results.boxes:
                cid = int(box.cls[0])
                if cid not in counts:
                    continue
                c = float(box.conf[0])
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                counts[cid] += 1
                dets[cid].append({
                    "confidence": round(c, 3),
                    "bbox": [round(x1 / w, 4), round(y1 / h, 4),
                             round(x2 / w, 4), round(y2 / h, 4)]})
        # Confirm-2 debounce: a count change counts only after the same
        # value is observed in 2 consecutive inference cycles. A 1-cycle
        # flicker (e.g. a marginal detection blinking around the
        # threshold) is swallowed; a real change is delayed one cycle.
        pending = cam.setdefault("pending_changes", {})
        changed = []
        for cid in cam["watch_ids"]:
            if counts[cid] != cam["last_counts"][cid]:
                prev = pending.get(cid)
                if prev and prev.get("count") == counts[cid]:
                    prev["seen"] += 1
                else:
                    pending[cid] = {"count": counts[cid], "seen": 1}
                if pending[cid]["seen"] >= 2:
                    changed.append(cid)
            else:
                pending.pop(cid, None)
        if not changed:
            return
        # Act on confirmed changes only; drop their pending entries.
        for cid in changed:
            pending.pop(cid, None)
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
            "model": cfg.get("model", "yolov8n"),
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

    # ---- lifecycle ----
    def setup_cameras(self):
        for ccfg in self.config.get("cameras", []):
            cls = CAMERA_TYPES.get(ccfg.get("type", "picamera"))
            if cls is None:
                print(f"unknown camera type {ccfg.get('type')!r}; skipping",
                      flush=True)
                continue
            print(f"opening camera {ccfg['id']} ({ccfg.get('type')})", flush=True)
            obj = cls(ccfg)
            model_name = ccfg.get("model", "yolov8n")
            model = YOLO(os.path.join(PROJECT_DIR, "models", f"{model_name}.pt"))
            name_to_id = {v: k for k, v in model.names.items()}
            cam = {"id": ccfg["id"], "cfg": ccfg, "obj": obj,
                   "model_obj": model,
                   "name_to_id": name_to_id,
                   "id_to_name": {k: v for v, k in name_to_id.items()},
                   "watch_ids": [], "last_counts": {}, "last_cycle": 0,
                   "pending_changes": {}, "latest_frame": None,
                   "last_capture_at": None}
            self.set_watchlist(cam, ccfg.get("watchlist", []), initial=True)
            self.cameras.append(cam)
        if not self.cameras:
            print("no cameras configured; exiting", file=sys.stderr)
            sys.exit(1)

    def handle_signal(self, signum, frame):
        print(f"signal {signum}; stopping", flush=True)
        self.stop_flag = True

    def shutdown(self):
        print("shutting down", flush=True)
        if self.web_server is not None:
            try:
                self.web_server.stop()
            except Exception:
                pass
        for cam in self.cameras:
            try:
                self.publish_cam(cam, "status",
                                 {"status": "offline", "timestamp": utcnow_iso()},
                                 retain=True)
            except Exception:
                pass
            try:
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
        self.setup_cameras()
        self.start_web()
        self.mqtt_connect()
        signal.signal(signal.SIGTERM, self.handle_signal)
        signal.signal(signal.SIGINT, self.handle_signal)
        last_heartbeat = {cam["id"]: 0 for cam in self.cameras}
        print(f"yolo_sensor v{VERSION} running ({len(self.cameras)} camera(s))",
              flush=True)
        while not self.stop_flag:
            self.drain_messages()
            for cam in self.cameras:
                if self.stop_flag:
                    break
                cid = cam["id"]
                now = time.time()
                if now - last_heartbeat[cid] >= cam["cfg"].get("heartbeat_interval", 600):
                    self.publish_camera_config(cam)
                    last_heartbeat[cid] = now
                if cid in self.pending_capture:
                    self.pending_capture.discard(cid)
                    self.process_camera(cam)
                    cam["last_cycle"] = time.time()
                    continue
                if now - cam["last_cycle"] >= cam["cfg"].get("sample_interval", 5.0):
                    cam["last_cycle"] = now
                    t0 = time.time()
                    try:
                        self.process_camera(cam)
                    except Exception as e:
                        print(f"[{cid}] cycle error: {e}", flush=True)
                    print(f"[{cid}] cycle {time.time() - t0:.1f}s", flush=True)
                    self.last_cycle_seconds = round(time.time() - t0, 2)
                    self.last_cycle_at = utcnow_iso()
            time.sleep(0.2)
        self.shutdown()


def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)


def main():
    if not os.path.exists(CONFIG_PATH):
        print(f"missing {CONFIG_PATH}: copy config.json.example and run "
              f"setup_config.py", file=sys.stderr)
        sys.exit(1)
    YoloSensor(load_config()).run()


if __name__ == "__main__":
    main()
