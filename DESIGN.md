# muse-pi-yolo-mqtt — Plan & Design (v0.1)

Status: DRAFT for Scott's review (Oct 12, 2026; topic tree revised Oct 13;
multi-camera design Oct 13). Uncommitted.

## 1. Overview

Intelligent object recognition + notification on the Raspberry Pi (Muse-Pi-1).
Cameras capture frames at a low rate (start 0.2 FPS, max 1 FPS, configurable
over MQTT). YOLOv8 (n or s, configurable) detects objects. Results publish to
MQTT only when the detected scene changes. A bounded on-disk ring buffer keeps
event images retrievable on demand. Node-RED consumes MQTT for notifications
(Pushover first) and other actions.

The key consumer pattern (Scott, Oct 13): different software processes share
the camera + inference, each subscribing only to the object classes it cares
about — selective subscription via per-class topics, by id or by name.

Multi-camera (Scott, Oct 13): a single Pi may serve multiple cameras — the
local Pi Camera today, IP cameras via RTSP tomorrow. The topic tree,
configuration, and capture code are all built around a `cameras` list from
the start; v0.1 ships with one camera (the Pi Camera), multi-camera and RTSP
are planned follow-ons (see §12).

Non-goals for v0.1: real-time video analytics, identity tracking across
frames, cloud upload.

## 2. Platform

- Muse-Pi-1: Pi 4 8GB, Debian 13, Python 3.13.5, user musecell.
- Camera: ArduCam 8MP v2.3 (IMX219) via rpicam/Picamera2 stack.
  (Oct 12: needed `camera_auto_detect=0` + `dtoverlay=imx219`; capture verified.)
- picamera2 installed Oct 13 via `sudo apt install python3-picamera2`
  (pip install fails without sudo: python-prctl needs libcap dev headers).
- Disk: 28 GB SD, ~19 GB free. Ring buffer cap default 1 GB.

## 3. Components

- `yolo_sensor.py` — the service. Core loop iterates the configured
  `cameras` list; per camera:
  capture -> inference (ultralytics) -> per-class change detection ->
  MQTT publish (paho-mqtt, TLS to HiveMQ Cloud) -> ring-buffer store
  (only on change) -> sleep(camera's sample_interval) -> next camera.
- Capture abstraction (multi-camera ready):
  ```python
  class Camera:                     # abstract
      id, name, config
      def capture(self) -> Frame    # Frame = image array + timestamp
  class PiCamera(Camera):           # Picamera2 backend (v0.1)
  class RTSPCamera(Camera):         # planned: cv2.VideoCapture + reconnect
  ```
  v0.1: `cameras` holds one PiCamera; the loop is written against the list,
  so adding cameras later is config + backend, not a rewrite.
- `config.json` (mode 0600, gitignored) — broker, credentials, topic root,
  and the `cameras` list (per-camera: id, name, type, source, resolution,
  sample_interval, model, confidence_threshold, watchlist, buffer share,
  publish toggles). Remote changes via MQTT persist back to config.json.
- systemd unit `yolo-mqtt.service` — auto-start, restart on failure,
  runs as musecell (no sudo at runtime).
- Python venv at `~/projects/muse-pi-yolo-mqtt/venv`, created with
  `--system-site-packages` so it sees the apt-installed picamera2.
- `models/` — yolov8n.pt and yolov8s.pt (both installed, selectable).
- `buffer/<camera-id>/` — per-camera ring-buffer JPEGs (gitignored).

## 4. Install plan (also the README skeleton)

1. Verify camera: `rpicam-hello --list-cameras`; test still capture.
2. `sudo apt update && sudo apt install -y python3-picamera2`.
3. `python3 -m venv --system-site-packages ~/projects/muse-pi-yolo-mqtt/venv`
   then pip install (see README for the torch CPU-index details — IMPORTANT:
   default PyPI pulls the ~3 GB CUDA-bundled torch, useless on a Pi; install
   torch+torchvision from https://download.pytorch.org/whl/cpu FIRST, then
   ultralytics + paho-mqtt). Verified set Oct 12: torch 2.14.1+cpu,
   ultralytics 8.4.176, paho-mqtt 2.1.0.
4. Download yolov8n.pt + yolov8s.pt into models/.
5. Write config.json (0600). Populate MQTT creds from the existing
   on-Pi credential source with Scott's OK (never in git/logs).
6. Foreground test run, then install + enable systemd unit.

## 5. MQTT

- Broker: HiveMQ Cloud (same as other Wovyn sensors), TLS, same creds.
- All payloads JSON, timestamps ISO-8601 UTC, QoS 1.
- Naming (Oct 13): singular `classId` / `className`, per Scott.

Topic tree (multi-camera, Oct 13):

```
Wovyn/RaspberryPi/YOLOSensor/<cpu-serial>/
├── config                  (retained) service identity: sw version, serial,
│                           start time, camera list
├── status                  (retained, LWT) service online/offline
├── camera0/
│   ├── config              (retained) camera details + tunables: name, type
│   │                       (picamera|rtsp), resolution, access method, sample
│   │                       interval, model, confidence threshold, watchlist,
│   │                       buffer stats, heartbeat interval
│   ├── config/set          incoming commands for this camera
│   ├── status              (retained) camera online/degraded/offline
│   │                       (regular publish; MQTT LWT is per-connection, so it
│   │                       lives at the Pi level above)
│   ├── events              aggregate scene-change summary (kept per Scott)
│   ├── classId/
│   │   ├── 0               (retained) person:  {count, detections[], image_ref, ts}
│   │   ├── 1               (retained) bicycle: ...
│   │   └── …               one topic per watched COCO class id
│   ├── className/
│   │   ├── person          (retained) same payload as classId/0
│   │   └── …
│   └── images/
│       ├── request         {event_id} → ask for an image
│       └── response        {event_id, timestamp, jpeg_base64, detections}
├── camera1/
│   └── …                   (future: second camera, e.g. RTSP)
```

This Pi's serial: 10000000968c1b38. Node-RED subscribes with `+` wildcards,
e.g. `Wovyn/RaspberryPi/YOLOSensor/+/camera0/className/person`.

Per-class payload:

```json
{
  "timestamp": "2026-10-13T07:30:00Z",
  "count": 2,
  "detections": [
    {"confidence": 0.87, "bbox": [0.12, 0.34, 0.45, 0.78]}
  ],
  "image_ref": "20261013T073000Z_a1b2c3"
}
```

bbox is normalized 0–1 [x1, y1, x2, y2]. Only watchlist classes are
detected/published — ultralytics `classes=[...]` filters at inference time
(also faster). The watchlist is remotely configurable via config/set.

Publish rules:

- Per-class change detection, per camera: a class's topics (`classId/<id>`
  AND `className/<name>`) publish only when that class's count changes —
  including transitions to zero (`{count: 0, detections: []}`, which clears
  the retained state). A car arriving does not republish the person topic,
  so selective subscribers are never woken by irrelevant traffic.
- classId/* and className/* are retained: a new subscriber immediately sees
  the last-known state of every class.
- On service start, publish a retained `{count: 0}` baseline for every
  watchlist class of every camera.
- `events` (kept per Scott, Oct 13): on any class change, one aggregate
  `{timestamp, counts: {person: 1, car: 2}, image_ref}` per camera.
  Convenience channel for simple notifiers (Pushover) that don't want to
  maintain per-class state. NOT retained (it's an event stream, not state).
- v0.1 change semantic is count-only: a person walking across the frame at
  constant count does not republish. Presence-refresh (republish while a
  class remains present) is a future tunable.
- Future: `publish: {classId, className, events}` toggles per camera in
  config to disable each publishing group and save bandwidth, since
  classId/className duplicate the same payloads.

## 6. Change semantics

Per-class per camera, per §5. The ring buffer stores the frame whenever any
published class change occurs for that camera (no publish → no store).

## 7. Ring buffer

- `buffer/<camera-id>/<utc-timestamp>_<eventid>.jpg`, quality ~85.
- Admission: only frames tied to a published change (no empties).
- Eviction: byte cap shared across cameras (default 1 GB, MQTT-configurable
  to 2 GB max); delete oldest first regardless of camera; safety max file
  count (e.g. 5000).
- Capture resolution default 1280x720 (configurable per camera); YOLO resizes
  internally regardless.
- `image_ref` in MQTT payloads is the event id, retrievable via that
  camera's `images/request` → `images/response`.
- Future (not v0.1): offload to NAS/cloud.

## 8. Watchlist & model

- Default watchlist: person, car, truck, bus, dog, cat, bicycle,
  motorcycle (COCO names); confidence default 0.5. Both remotely
  configurable via config/set (per camera).
- Default model yolov8n; yolov8s selectable at runtime (per camera).
  MEASURED Oct 12 (cold run, imgsz 640, Pi 4 CPU): n ≈ 4.6 s, s ≈ 6.7 s
  per inference. With Picamera2 capture (~0.1 s, measured Oct 13) the 5 s
  interval is reachable for nano. Options if the interval gets tight:
  lower imgsz (416/320), lengthen the interval, or run s only at longer
  intervals. Revisit after warm timings.

## 9. Node-RED

- Selective consumers sharing the cameras + inference:
  - `Wovyn/RaspberryPi/YOLOSensor/+/camera0/className/person` → person/occupancy pipeline
  - `Wovyn/RaspberryPi/YOLOSensor/+/camera0/className/car` → vehicle pipeline
  - or by id: `.../camera0/classId/0`, `.../camera0/classId/2`
  - second camera: `.../camera1/className/person`
- Simple notifier: `Wovyn/RaspberryPi/YOLOSensor/+/camera0/events` → Pushover
  with the per-class counts from the summary (no per-class state needed).
- Image on demand: publish `{event_id}` to `.../camera0/images/request`,
  read the JPEG from `.../camera0/images/response`.
- Example flow documented in README (forthcoming, at implementation).

## 10. Security

- Credentials only in config.json (0600); never in git, logs, or chat.
  (Includes future RTSP URLs, which carry passwords.)
- Service runs as musecell, no sudo.

## 11. Versioning & docs

- Semver from v0.1.0. README (full install/config/ops guide for a human
  or another Muse agent), CHANGELOG.md, NOTICE (Apache 2.0 attributions).
- Authorship per convention: MuseCell-1 implementation, Scott specs.

## 12. Risks / open items / backlog

- torch CPU wheel — RESOLVED Oct 12. Camera hardware — RESOLVED Oct 12.
  Camera model — RESOLVED (ArduCam 8MP v2.3 = IMX219). picamera2 venv
  rewire — RESOLVED Oct 13 (118 ms capture at 1280x720).
- Inference headroom at 5 s interval — measured; see §8.
- BACKLOG (after v0.1 works): multi-camera on one Pi.
  - RTSP/IP camera sources: user-configurable additional cameras; capture
    by grabbing JPEGs/frames from RTSP streams (`RTSPCamera` backend via
    OpenCV VideoCapture with reconnect-on-failure).
  - Capture architecture for multi-camera: one lightweight capture thread
    per camera → per-camera latest-frame slot (capture is I/O-bound and
    fast); a single inference worker round-robins the cameras, always
    taking each camera's newest unprocessed frame (no unbounded queues —
    latest wins; no model thread-safety issues with one worker).
  - Performance (honest): inference throughput is the global bottleneck
    (~4.6 s nano @640px cold). N cameras → per-camera effective interval
    ≈ max(configured interval, N × inference_time). Two cameras ≈ 10 s
    effective each at 640px. Mitigations: lower imgsz, longer intervals,
    nano-only, or fewer cameras per Pi. RTSP H264 decode costs ~10–20% of
    one core at 720p (CPU decode).
  - Per-camera status already covers degraded/offline (RTSP disconnects).
- Awaiting Scott: design sign-off → implementation (service code, config,
  systemd unit, README completion).
- Pushover node setup in Node-RED (later step).
