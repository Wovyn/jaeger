# muse-pi-yolo-mqtt — Plan & Design (v0.1, v0.2.0)

Status: v0.1.0 built and pushed Oct 14, 2026; v0.2.0 built and committed Oct 14, 2026, live testing in progress; v0.2.1 (UI fixes from testing feedback) built and committed Oct 16, 2026 (topic tree revised Oct 13; multi-camera design Oct 13).

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
- Example flow documented in README §7 (Node-RED).

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

## 13. v0.2.0 - Jaeger web UI (DECIDED Oct 14, 2026; built Oct 14, 2026, committed Oct 14, 2026; live testing in progress)

- Project evolves to Jaeger (play on Frigate, a smaller version). Header shows Jaeger + version from one code constant. Repo/folder keep muse-pi-yolo-mqtt for now.
- Web UI on port 8082. Embedded ThreadingHTTPServer thread in yolo_sensor.py (stdlib only, static HTML/JS/CSS). One config writer shared with the MQTT config/set path.
- Layout: header (Jaeger + version, hamburger menu right). Left 50 percent: cameras list (selected camera) + counts panel for the selected camera. Right 50 percent: events list.
- Cameras panel: name, type, resolution, status dot, last capture time. Greyed [+] add-camera placeholder, disabled, tooltip RTSP coming soon.
- Counts panel: rows of name, count, counts aligned via CSS grid, toggle hides zero counts. Clicking a row filters events to that class. Counts follow the selected camera.
- Events list: newest first, last 25 initial, infinite scroll for older. Each row: camera, local date/time (UTC on mouseover), objects + counts, thumbnail. Click opens full-size modal. Bbox overlay toggle default on (client-side SVG from sidecar bbox data). Esc closes modal, arrows step events.
- Latest frame strip: most recent capture shown even with no detections.
- Event filter by camera. Header status dot: MQTT connection + uptime + last inference duration.
- No auth in v0.2.0 (LAN-only). Revisit as the project grows.
- Settings (via hamburger menu): all tunables - sample interval, confidence threshold, watchlist (COCO 80 checkboxes), model, buffer cap, heartbeat, publish toggles, camera controls. Buffer cap editable in Settings; current buffer usage shown in menu.
- Thumbnails: browser-scaled full JPEGs (no server thumbnail pipeline in v0.2.0).
- Time display: browser local time; UTC on mouseover.
- Sidecars: <event_id>.json next to each <event_id>.jpg. Fields: camera id, timestamp, full counts for watched classes, detections (class, confidence, bbox normalized 0-1), model, threshold. Eviction deletes jpg+json pair. Images/response reads detections from sidecar (survives restart). No backfill for pre-v0.2.0 JPGs.
- Debounce: a change counts only after 2 consecutive inference cycles (confirm-2). Test data will tell if more is needed.
- Camera controls (Muse experiments; Google AI Mode conversation Oct 14): Picamera2 AEC/AGC on by default. Expose ExposureValue (EV compensation), AeExposureMode (Short/Normal/Long), manual ExposureTime + AnalogueGain, and AeEnable/AwbEnable lock. Test AeExposureMode Long for dark-room noise/flap reduction. Brightness/Contrast/Saturation/Sharpness/AeMeteringMode/NoiseReductionMode/HDR were NOT in that conversation as Picamera2 controls; do not assume they exist.
- Build order: sidecars + paired eviction; debounce; web thread + API; static UI; camera controls; docs. Commit as v0.2.0 on Scott go-ahead.
- Oct 14 housekeeping: test buffer JPGs dropped (1953 files, 395 MB, all flap test data). v0.1.0 pushed by Scott Oct 14 (b237fce on origin/main, in sync).

## 14. v0.2.1 - UI fixes (Scott testing feedback, Oct 15, 2026; committed Oct 16, 2026)

All items from Scott's Oct 15 testing pass over v0.2.0. No behavior
change to MQTT, inference, or the ring buffer except where noted.

- Counts panel: "Show zero counts" defaults to UNCHECKED. When no rows
  render (all counts zero, or no counts), the panel shows a centered
  one-line "No objects detected" message instead of an empty list.
- Class filter bug (events list not filtered): root cause was
  server-side in `/api/events`. The filter matched an event if the
  class key merely existed in the sidecar `detections` dict — and
  sidecars list every watchlist class, even with empty lists. Fixed:
  an event matches a class filter only with a positive count for that
  class or a non-empty object-detection list for it. Camera + class +
  no-object-detections filters combine in one events fetch.
- "Filter no object detections" checkbox (default CHECKED) hides
  events whose counts are all zero (`hide_empty=1` on `/api/events`).
  Events with unknown counts (pre-v0.2.0 JPGs, no sidecar) stay
  visible: the filter hides only events positively known to be empty.
- Terminology rule: user-visible text says "object detections", never
  bare "detections". API JSON keys (`detections`) and code identifiers
  are unchanged.
- Modal bounding boxes: root cause was the overlay code multiplying
  normalized 0-1 bboxes by image pixels while the SVG viewBox is
  `0 0 1 1`, pushing every box off-canvas. The SVG CSS was already
  written for 0-1 coordinates (font-size/stroke in viewBox units);
  the JS now uses the normalized coordinates as-is, with
  viewBox-fraction text offsets.
- Modal close X: root cause was stacking — the button (earlier
  sibling, z-index auto) painted under `.modal-img-wrap` (later
  positioned sibling). Fixed with z-index + an opaque dark circular
  background on the image-modal close button so it sits above the
  picture and is clickable. Settings/About close buttons get the
  z-index too.
- Live updates via server-sent events (replaces timer polling):
  `GET /api/stream` (`text/event-stream`, `: heartbeat` comments
  every 15 s). `StreamHub` fan-out in web_ui.py: each SSE client gets
  its own bounded queue (32); a slow client drops messages and
  resyncs on reconnect instead of blocking the sensor. Push points
  in yolo_sensor.py via `notify_stream()` (never raises, never
  blocks inference): `{"type": "frame"}` after every capture,
  `{"type": "event"}` after an event is stored, `{"type": "config"}`
  after a config change is applied. Client (`EventSource`):
  on open -> full resync; `event` -> refresh events list + counts +
  status; `frame` -> refresh Latest Frame + cameras (keeps the
  per-camera last-capture time fresh); `config` -> refresh cameras +
  counts + status. A list refresh is deferred while the image modal
  is open (flagged stale, applied on close) so the list is not yanked
  out from under an inspected image.
- Latest Frame definition (documented): the most recent capture
  regardless of object detections, refreshed on every capture push.
  (The sensor already updated `latest_frame` on every capture in
  v0.2.0; only the client refresh was timer-based.)
- Uptime format rule: years (365 days) / days / hours / minutes /
  seconds, zero-valued units omitted, seconds always shown
  (`0s` if all zero). Examples: `45s`, `14m 23s`,
  `1y 67d 3h 52m 45s`. Mouseover (`title`) shows the service start
  time. The displayed uptime ticks locally every second from the
  fetched `started_at` — the server is not re-polled for it.
- About popup: square sizing (`width: min(90vw, 480px)`,
  `aspect-ratio: 1 / 1`, scroll on overflow) via its own
  `.about-box` class. The image modal keeps fitting its image.
- Logo/favicon: `static/logo.png` (1600x1600 PNG, white jaeger
  seabird silhouette on deep navy, matching the header) is served
  via the static allowlist and wired in as the header logo
  (~32 px), the About popup logo, and the favicon.
