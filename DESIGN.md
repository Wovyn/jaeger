# muse-pi-yolo-mqtt — Plan & Design (v0.1, v0.2.0, v0.3.0)

Status: v0.1.0 built and pushed Oct 14, 2026; v0.2.0 built and committed Oct 14, 2026, live testing in progress; v0.2.1 (UI fixes from testing feedback) built and committed Oct 16, 2026; v0.3.0 (RTSP + multi-camera) built and committed Oct 16, 2026, running live (topic tree: v0.3.0 Jaeger tree, Oct 16; multi-camera design Oct 13).

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

Topic tree (v0.3.0, hard cutover Oct 16, 2026; v0.1-v0.2.x used YOLOSensor/camera{id} directly under the serial, see 15.5):

```
Wovyn/RaspberryPi/Jaeger/<cpu-serial>/
├── config                  (retained) service identity: sw version, serial,
│                           start time, model (service-level), camera list
│                           (ids, names, types, statuses)
├── status                  (retained, LWT) service online/offline
└── cameras/
    └── <camera-id>/       (camera0, camera1, ...; stable IDs, never the name)
        ├── config          (retained) camera details + tunables: name, type
        │                   (picamera|rtsp), icon, resolution, access method,
        │                   sample interval, confidence threshold, watchlist,
        │                   buffer stats, heartbeat interval, paused
        ├── config/set      incoming commands for this camera
        ├── status          (retained) camera online/degraded/paused/offline
        │                   (regular publish; MQTT LWT is per-connection, so it
        │                   lives at the Pi level above)
        ├── events          aggregate scene-change summary (kept per Scott)
        ├── classId/
        │   ├── 0           (retained) person:  {count, detections[], image_ref, ts}
        │   ├── 1           (retained) bicycle: ...
        │   └── ...           one topic per watched COCO class id
        ├── className/
        │   ├── person      (retained) same payload as classId/0
        │   └── ...
        └── images/
            ├── request     {event_id} -> ask for an image
            └── response    {event_id, timestamp, jpeg_base64, detections}
```

This Pi's serial: 10000000968c1b38. Node-RED subscribes with `+` wildcards,
e.g. `Wovyn/RaspberryPi/Jaeger/+/cameras/camera0/className/person`.

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
  - `Wovyn/RaspberryPi/Jaeger/+/cameras/camera0/className/person` → person/occupancy pipeline
  - `Wovyn/RaspberryPi/Jaeger/+/cameras/camera0/className/car` → vehicle pipeline
  - or by id: `.../cameras/camera0/classId/0`, `.../cameras/camera0/classId/2`
  - second camera: `.../cameras/camera1/className/person`
- Simple notifier: `Wovyn/RaspberryPi/Jaeger/+/cameras/camera0/events` → Pushover
  with the per-class counts from the summary (no per-class state needed).
- Image on demand: publish `{event_id}` to `.../cameras/camera0/images/request`,
  read the JPEG from `.../cameras/camera0/images/response`.
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

## 15. v0.3.0 - RTSP + multi-camera support (DECIDED Oct 16, 2026; built and committed Oct 16, 2026, running live)

Scott answers to the 12 design questions (Oct 16, 2026): (1) MQTT migration: hard cutover to the Jaeger tree; nothing but testing uses the current tree. (2) Model: service-level for now, one shared model for all cameras. (3) Camera check interval is the same as per-camera sample_interval (inference cadence); no separate health-check cadence. (4) On delete: clear the retained MQTT topics, keep the buffered images. (5) Edit camera included in v0.3.0 (Scott had forgotten it). (6) Vendored Lucide-style SVG icons approved; exact set to be settled as work proceeds. (7) Snapshot URL field included. (8) Transport choice exposed. (9) Rescan for Pi camera included. (10) No hard camera limit; GUI shows stats instead. (11) Threads, not processes. (12) Agreed design recorded here before any build starts.

Additional Scott requirement (Oct 16, 2026): the cameras are NOT dedicated to Jaeger; other processes also check in on them. A persistent RTSP connection could block those other apps. So connection mode is a per-camera setting: persistent connection, or connect / grab / disconnect on each capture. The UI shows timing and other stats so the user can judge whether per-capture mode works for a given camera.

### 15.1 Architecture: threads + latest-frame slots

- Threads, not processes. Frames are about 2.6 MB numpy arrays at 1280x720; passing them between processes means pickling and copying every frame. Threads share the array. Capture is I/O-bound (network + OpenCV decode releases the GIL); the one CPU hog, inference, is owned by a single worker thread, so the GIL is not the bottleneck.
- Latest-frame slots, not a queue. A work queue of frames grows without bound whenever inference (the bottleneck) falls behind capture. Each camera gets one slot: newest frame + timestamp + sequence number, under a lock. The inference worker always takes the newest unprocessed frame. Nothing accumulates, nothing goes stale.
- Thread roles: main thread becomes supervisor (config, MQTT, shutdown, watchdog); one capture thread per camera; one inference worker thread owns the single shared YOLO instance. Web server and MQTT network loop keep their existing threads.
- Inference worker round-robins cameras: for each camera that is due (now - last_inference >= sample_interval), unpaused, and has a fresh frame, it runs the existing process_camera logic (confirm-2 debounce, events, sidecars, MQTT publishes). If behind, frames are superseded in their slots. Per-camera effective interval = max(sample_interval, N x inference_time). A slow camera cannot block a fast one.
- Watchdog: if a capture thread dies (exception) the supervisor restarts it. If no fresh frame arrives for about 3x sample_interval + 30 s, camera status goes degraded and the UI gets an SSE push.
- Zero cameras is a valid running state. setup_cameras must not exit when nothing configures. Service starts, status online, web UI shows a no-cameras empty state until the user adds RTSP cameras.
- capture_now: sets a flag; the capture thread grabs a fresh frame immediately and the inference worker prioritizes that camera next.

### 15.2 Capture backends + connection modes

- RTSPCamera backend via OpenCV VideoCapture (CAP_FFMPEG), RTSP over TCP by default, UDP selectable. Transport is a per-camera setting.
- Connection mode is a per-camera setting (Scott requirement, Oct 16, 2026):
  - persistent: hold one RTSP connection open, read continuously, keep the latest frame. Lowest per-frame overhead. Risk: holds one of the camera stream slots, which can block other apps that also use the camera.
  - per-capture: connect, grab one frame, disconnect, every sample_interval. Frees the camera between captures for other apps. Cost: every capture re-negotiates RTSP, waits for a keyframe (1-3 s), and software-decodes video; slower, more jitter, more CPU per frame. The UI shows grab timing so the user can judge whether per-capture mode works for a given camera.
- Snapshot URL path: if a per-camera HTTP snapshot URL is set, the capture thread polls it instead of holding an RTSP stream. Cheaper when the camera supports it; RTSP is the fallback when the snapshot fetch fails. Snapshot polling composes with per-capture mode naturally (each poll is independent) and with persistent mode as a periodic refresh.
- Reconnect: on disconnect, status goes degraded and the capture thread retries with backoff (2 s, 5 s, 10 s, 30 s cap). Reconnect logic lives in the capture thread, never in the inference path.
- Test connection must fully close its stream before the live capture thread opens one: sequential, never overlapping, because some cameras allow only 1-2 concurrent streams.
- Codec note: cameras defaulting to H.265 are expensive to software-decode on a Pi 4. Modal help text says to choose H.264 when the camera offers it. The test response reports actual codec + resolution so a misconfigured camera is visible.
- Frame timestamps use Pi arrival time; camera clocks are irrelevant.
- PiCamera backend: same slot pattern, capture_array at the camera interval. Camera controls unchanged (v0.2.0 behavior).

### 15.3 Camera lifecycle

- Camera IDs are auto-generated, never user-editable: camera0 for the Pi camera, then camera1, camera2, ... from a monotonic counter that never reuses IDs after a delete. Reuse would collide with retained MQTT topics and buffer directories.
- Names must be unique (enforced). Two cameras named Garage would confuse the UI and MQTT-adjacent tooling.
- Add flow: modal -> test -> confirm. POST /api/cameras/test opens the stream (or snapshot URL) with a hard timeout, grabs one frame, returns a downscaled thumbnail + actual resolution + codec. It persists nothing, never echoes or logs credentials, and never hangs the UI (timeout enforced server-side). On failure: plain-language error (connection refused, authentication failed, timed out waiting for a frame) and back to the modal with all fields preserved. On success: thumbnail shown, Add confirms -> POST /api/cameras persists to config.json, starts the capture thread, adds the Cameras panel row.
- Edit flow: same modal pre-filled. Name, icon, intervals, and connection fields are editable. Saving connection changes re-runs the test flow before persisting.
- Pause: per-camera flag; stops the capture thread AND disconnects the RTSP stream (frees the camera stream budget for other apps). Status becomes paused; counts freeze at last values. Resume reverses it.
- Delete: stops the thread, releases the backend, removes from config, persists. Retained MQTT topics for the camera are cleared (config, status, class topics) so subscribers never see a ghost camera. Buffered images are KEPT (evidence); no further writes go to that camera buffer dir.
- Pi camera: pause/resume allowed; delete forbidden when it was detected at start.
- Pi camera not detected at start: service runs with zero cameras. Rescan for Pi camera is a UI action + API endpoint (POST /api/cameras/rescan) that retries Picamera2 init at runtime without a service restart.

### 15.4 Add/Edit modal fields, grouped

Fields are grouped so the modal stays concise. Groups, in order:

- Identity: Name (unique, required); Icon (selection of vendored SVG icons; Pi camera gets its icon assigned automatically).
- Connection: Scheme (rtsp / rtsps); Host/IP (DNS name or IP); Port; Path; Stream (Mainstream / Substream); Transport (TCP default / UDP); Connection mode (Persistent / Per-capture, see 15.2); Connection timeout seconds (default 10).
- Access: Credentials On/Off (enables/disables Username + Password); Username; Password (never returned by any API, never logged); for rtsps only, Allow self-signed certificate checkbox.
- Capture: Sample interval seconds (per-camera inference cadence; the camera check interval); Snapshot URL (optional HTTP snapshot override, tried before RTSP when set); Rotate (0 / 90 / 180 / 270); Start paused checkbox.
- Buttons: Test connection (fetches a sample image, see 15.3); Add / Save; Cancel.
- Icon set: about 8 vendored Lucide-style SVG icons (ISC license, attribution in NOTICE): generic camera, door, garage, driveway, garden/yard, entrance, room, board/chip for the Pi camera. Exact set settled as work proceeds.

### 15.5 MQTT topic tree v0.3.0 (hard cutover)

- Hard cutover from YOLOSensor to Jaeger. Nothing but testing uses the current tree, so no dual-publish transition. Node-RED flows that reference the old tree need a one-time update; the CHANGELOG entry must say so plainly.
- New tree (all payloads JSON, timestamps ISO-8601 UTC, QoS 1):
  Wovyn/RaspberryPi/Jaeger/<cpu-serial>/
    config (retained) service identity: version, model, camera list (ids, names, types, statuses)
    status (retained, LWT) service online/offline
    cameras/
      <camera-id>/ (stable IDs camera0, camera1, ...; NEVER the user name)
        config (retained) camera details + tunables
        config/set incoming commands for this camera
        status (retained) camera online/degraded/paused/offline
        events aggregate scene-change summary
        classId/<id> (retained) per-class counts/detections
        className/<name> (retained) same payload, by name
        images/request -> images/response
- Camera names stay OUT of topic segments: names have spaces, slashes, unicode, and they change; a rename would orphan retained topics and break subscribers. Subscribers that need names read the retained Pi-level or per-camera config.
- Pi-level config already lived at the Pi level in v0.2.x; in v0.3.0 it also carries the camera list so a new subscriber learns the whole fleet from one retained message.
- On delete, retained topics for the camera are cleared (retained-clear publishes) per 15.3.
- Config migration: topic_root lives in config.json (mqtt.topic_root). On first v0.3.0 start, if topic_root ends in YOLOSensor, rewrite it to Jaeger, log the migration loudly, and note it in the CHANGELOG. Old camera0 picamera config keeps working; new fields get defaults.

### 15.6 Config schema changes

- Model moves from per-camera to service level: config.model (one shared model for all cameras). Per-camera model keys in old configs are ignored with a logged warning.
- Per-camera entries gain: icon (string key, default per type); paused (bool, default false); rtsp block: scheme, host, port, path, stream (main/sub), transport (tcp/udp), connection_mode (persistent/per-capture), timeout_s, snapshot_url (optional, empty = unused), tls_allow_self_signed (bool, rtsps only), username, password (0600 config.json, never logged, never returned by any API). RTSP URL is built server-side from parts, never stored as a full URL.
- Config gains next_camera_id (monotonic counter, never reused after delete).
- Rotation: rotate (0/90/180/270) per camera, applied in the capture thread before the slot write.

### 15.7 UI changes

- The [+] Add Camera button is enabled and opens the Add modal (15.4).
- Cameras panel rows show: icon, name, type, status dot (online/degraded/paused/offline), last image-grab time, and per-row pause/resume + edit + delete controls. Pi camera row has no delete control.
- Inference-falling-behind signal: each row shows its last inference time, and the header or Cameras panel shows a load indicator: saturation = sum over cameras of (measured inference_time / sample_interval). Above 1.0 the worker cannot keep up and the UI warns that inference is saturated (frames are superseded, per-camera effective intervals grow). No hard camera limit; the stats are the limit signal.
- Grab timing per camera is shown (last grab duration, and for per-capture mode the connect + keyframe + decode cost) so the user can judge whether per-capture mode works for that camera.
- No-cameras empty state: when zero cameras are configured, the Cameras panel says so and points at [+].
- Rescan for Pi camera action when no Pi camera is present.
- Settings modal: model becomes service-level (one dropdown, not per camera). Per-camera tunables (interval, threshold, watchlist, publish toggles, camera controls) stay per camera.
- New API endpoints: POST /api/cameras/test, POST /api/cameras (add), PATCH/POST /api/cameras/<id> (edit), POST /api/cameras/<id>/pause, POST /api/cameras/<id>/resume, DELETE /api/cameras/<id>, POST /api/cameras/rescan. Existing /api/config keeps working for per-camera tunables.

### 15.8 Cleanup items folded into v0.3.0

From the model-switch analysis (Oct 16, 2026) and this review, evaluated first, not yet implemented:

1. Explicit model unload: del the old model object + gc.collect() before loading the new one, so peak memory is one model, not two.
2. Clear debounce pending_changes on model switch.
3. SSE config push after a model swap completes, so the UI confirms the new model (fixes the v0.2.x behavior where Save-time retained config published the pre-swap model).
4. Single shared model instance owned by the inference worker (today each camera loads its own YOLO copy).
5. setup_cameras must not exit on zero cameras (see 15.1).
6. Log redaction: RTSP URLs with credentials must never appear in logs, errors, or API responses. Passwords are never returned by any API.
7. Save-time retained config publishing the pre-swap model is fixed by item 3.

### 15.9 Testing plan

- Isolated suite (fake camera backends, temp config/buffer, test port, no production broker): lifecycle (add/test/pause/resume/edit/delete), debounce + sidecars unchanged, paired eviction, retained-clear on delete, config migration (YOLOSensor -> Jaeger), zero-camera startup, rescan, per-capture vs persistent capture paths with a fake RTSP source.
- One live end-to-end test against a local RTSP stream generated by ffmpeg (test pattern) exercising reconnect + timeout paths for real. Unreachable host must fail fast, never hang.
- Production service untouched during the build (same rule as v0.2.0/v0.2.1). Restart + commit on Scott go-ahead.

### 15.10 Risks / open notes

- Credentials over the LAN: the web UI has no auth (known, LAN-only). Camera passwords will flow through that UI in plaintext HTTP. Same exposure class as everything else the UI does; the proxy + auth project covers it. Do not add cameras over a network you do not trust until the proxy lands.
- Concurrent-stream limits: some cameras allow only 1-2 streams. Persistent mode holds one; test-then-add is sequential (15.2); other apps sharing the camera are why per-capture mode exists.
- Old firmware: the cameras in question run 2022 firmware. Treat them as untrusted: isolated LAN segment, changed default credentials, no inbound exposure.
- ChatGPT RTSP conversation evaluated Oct 16, 2026 (share link): directionally sound (ffmpeg single-frame RTSP/TCP, HTTP snapshot idea, persistent connections beat per-shot) but not an implementation spec: no timeouts/retries/error handling, plaintext creds in URL, per-shot capture expensive on Pi 4, persistent-connection advice hand-wavy, ONVIF dangling, no Pi-specific guidance, no warning on 2022 firmware or guessed-endpoint probing risks. This design takes its best conclusions and implements them properly.

### 15.11 Build order (after design sign-off)

1. Core restructure: capture threads + latest-frame slots + inference worker + shared model + zero-camera startup + supervisor/watchdog.
2. RTSPCamera backend + snapshot-URL path + connection modes + reconnect/backoff.
3. Camera lifecycle APIs: test, add, edit, pause/resume, delete (+ retained-clear), rescan Pi camera.
4. UI: enabled [+], Add/Edit modal + test flow, icons, pause/edit/delete controls, load indicator, per-camera grab/inference stats, no-cameras empty state.
5. MQTT migration: Jaeger tree + cameras/ level + config migration on first start.
6. Cleanup items (15.8).
7. Tests (15.9).
8. Docs: README (RTSP setup, topic tree, multi-camera performance) + CHANGELOG v0.3.0 entry + this section marked built. Restart + commit on Scott go-ahead.

### 15.12 Build deviations (Oct 16, 2026)

- Icons: hand-written original SVGs, not vendored Lucide files (NOTICE states they are original works).
- Transport is strict, no TCP-to-UDP auto-fallback; the test error tells the user to switch the setting.
- Pi-camera pause keeps the Picamera2 object open (a close would force full re-init); RTSP pause disconnects the stream as specified.
- Per-camera model in MQTT config/set is ignored with a logged warning; model changes go through web Settings (service-level).
- Build notes that said Oct 17 used UTC dating; corrected to Oct 16 MDT at commit time.

### 15.13 Testing-feedback fixes, still in v0.3.0 (Oct 16, 2026)

Fixes from Scott live testing, folded into v0.3.0 (no version bump):

- Per-capture grab timing split: _open times the open,
  _read_with_keyframe_wait times the wait; _note_grab stores
  open_seconds + wait_seconds in last_grab_info, surfaced as
  last_grab_open_seconds / last_grab_wait_seconds in
  camera_config_payload (None when unknown, e.g. Pi camera or no
  grab yet) and shown in the Cameras panel as open + keyframe
  split. Snapshot path records open 0.0, wait = fetch time.
  Live evidence for the split: raising the Heber Driveway camera
  stream FPS 5 -> 10 dropped per-capture grab time from ~5.4 s
  to under 3 s; the camera I Frame Interval setting is 2,
  consistent with keyframe wait dominating the grab.
- FFmpeg open tuning: OPENCV_FFMPEG_CAPTURE_OPTIONS now also
  passes analyzeduration 500000 + probesize 500000 alongside
  rtsp_transport. Option pairs are pipe-separated
  (rtsp_transport;tcp|analyzeduration;500000|probesize;500000):
  a semicolon between pairs is WRONG -- FFmpeg then receives
  the whole tail as the first option value and the open fails
  (caught by the real-RTSP test before shipping). Timeout
  behavior, daemon-thread hard join timeout, and env-var
  save/restore unchanged.
- Events list flash: /api/events gains an `after` param (event_id;
  returns events strictly newer, newest-first; has_more=false,
  next_before=null; combines with existing filters). Client
  loadNewEvents() fetches after=newest-shown, dedupes by
  event_id, and prepends rows via a shared eventRow() builder
  (click resolves the modal index dynamically, so prepended rows
  never stale the indices of older rows). SSE `event` and
  modal-close stale refresh use loadNewEvents; full reload
  (loadEvents(true)) stays only for initial load, filter
  changes, SSE reconnect, manual refresh, and delete-camera
  refresh.
- Add/Edit camera modal redesigned to a two-column grouped layout
  (Identity row: Name + icon picker; Connection card left; Access +
  Capture cards right; footer with Test + tip left, Cancel + Save
  right; stacks below ~900 px). Live masked resolved-URL preview
  in the Connection card mirrors the server build_rtsp_url()
  ({stream} substitution, URL-encoding, userinfo rules) with the
  password always shown as literal bullets, never the real value.

- v0.3.0 follow-up (Oct 17): header staleness fix - loadStatus() now runs on SSE frame pushes, not just event/config/reconnect. Inference-load alert restyled as a centered bold white-on-red bar when saturated.

### 15.14 Modal redesign: tabbed camera modals + shared Detection tab + system-wide-only Service settings (v0.3.0 follow-up, Oct 17, 2026)

Motivation: the old Settings modal mixed system-wide items (model,
buffer cap) with per-camera items (interval, threshold, watchlist,
...), and the old Add/Edit modal was one long stack. The redesign
(Scott's designer mockups, four .dc.html artboards) gives every
camera-specific item a home in a camera modal and leaves Service
settings with only the two system-wide items.

One-scope-per-save rule: each Save writes exactly one scope.
- RTSP modal Save -> POST /api/cameras (add) or PATCH
  /api/cameras/<id> (edit): that camera's identity + connection +
  detection fields. Nothing service-level.
- Pi modal Save -> PATCH /api/cameras/<id>: that camera's identity +
  detection + camera_controls. Nothing service-level, no connection.
- Service settings Save -> POST /api/config with
  {camera_id: "service", model, buffer_cap_mb}: ONLY the two
  service-level fields. The "service" sentinel is the server's
  existing service-level path (apply_service_config honors only
  model + buffer_cap_mb); no per-camera id is sent.

Modals:
- #rtspCameraModal (tabs Connection | Detection), #piCameraModal
  (tabs Camera | Detection). Both 1000 px max-width, 90vh max-height,
  44 px tab bar. Add (+) opens the RTSP modal in add mode; per-row
  Edit opens the modal matching that camera's type. Pi modal is
  edit-only (the Pi camera is never added). ESC closes only the
  topmost modal (Service settings > camera modal > image modal).
- Shared Detection tab: ONE instance, built once by
  buildDetectionPanel() and MOVED (appendChild) into whichever camera
  modal is open -- one builder, one collectDetection, one
  validateDetection, no duplicate element IDs. Two-column: left
  Detection card (Sample every, Confidence slider + 2-decimal
  readout, Image size select, Heartbeat, hint) + Publish card (three
  toggles) + dashed note box naming the LIVE model from /api/status
  with a link that opens Service settings stacked above the camera
  modal (camera modal stays in the DOM, unsaved state intact);
  right Watchlist card (count, Clear, filter, Selected-only, grouped
  chips, internal scroll). Image size: 320/480/640/960/1280; a stored
  imgsz off that list is kept as an extra "(current)" option, never
  silently changed. Add defaults: sample 5, conf 0.5, imgsz 640,
  heartbeat 600, publish all on, watchlist = service
  DEFAULT_WATCHLIST. Edit fills the camera's stored values.
- Watchlist groups (designer's GROUPS list): People, Vehicles,
  Animals, Street, Carried, Sports, Electronics, Furniture,
  Appliances, Kitchen, Food, Household. Class names come from the
  LIVE /api/classes list, never hardcoded; any class not in the
  mapping lands in an "Other" group. Selected chip = filled primary
  blue with check. Per-group "n / total" counts.
- RTSP Connection tab = the old modal minus Sample every: Identity
  row (Name 280 px + icon radiogroup), Connection card (Scheme/Host/
  Port, Path + {stream} hint, Stream/Transport, Connection mode +
  Timeout + hint, masked resolved-URL preview), Access card
  (Requires-credentials checkbox in the header, Username/Password,
  hint, rtsps-only self-signed row), Capture card (Rotate + Start
  paused, Snapshot URL + hint). Footer: Test connection + H.264 tip
  + Cancel + Save. Test unchanged (POST /api/cameras/test).
- Pi Camera tab: Identity row (Name + icon), Sensor card (Detected
  status dot + sensor model, Camera port, Resolution) -- READ-ONLY
  detected info (see deviations), Capture card (Rotate + Start
  paused), White balance card (Auto (AWB) checkbox + hint), Exposure
  card (Auto/Manual segmented control + Preview frame + Refresh +
  Auto fields [AE exposure mode + EV slider -8..8 step 0.5 + readout]
  OR Manual fields [Shutter us + Analogue gain x]). Footer: Test
  capture + Cancel + Save. Preview loads /api/latest?camera=<id> on
  open; Refresh POSTs /api/capture_now and polls /api/latest ~10 s
  for a newer frame; Test capture adds a result line (resolution +
  grab seconds). Preview timeout reports the camera may be paused.
- Service settings modal: 600x460, "Applies to all cameras" badge,
  ONLY Detection model (yolov8n / yolov8s) + Image history limit
  (MB) with a live In-use bar (label "<used MB> / <cap MB>", width =
  used/cap) fed by the existing /api/status buffer.bytes + cap_bytes;
  the bar/label update as the limit input changes. Hamburger menu
  Settings opens it with no camera required.
- Error dots: Save validates ALL fields client-side (name/host
  required; sample >= 0.5; conf 0-1; imgsz positive; heartbeat >=
  30; timeout 1-120; port 1-65535; snapshot URL http(s); Manual
  shutter 1-10,000,000 us, gain 1.0-16.0). On failure a small red
  dot appears on every tab containing an invalid field, the error
  text shows, and the first error tab opens. Server-side errors map
  the same way (detection keywords -> Detection tab, everything else
  -> first tab). Dots clear as errors are fixed (revalidated on
  input/change, never newly shown outside Save).
- Behaviors preserved: blank password keeps stored (never prefilled/
  echoed); credentials toggle disables user/pass; rtsps shows the
  self-signed row; resolved-URL preview masks the password; Pi camera
  cannot be deleted; after save, cameras/counts/status refresh.

Server changes (minimal, all in the modal scope):
- apply_config_command camera_controls merge: explicit null values
  DELETE the key (Auto mode sends exposure_time/analogue_gain as
  null). The old plain merge retained manual values forever, so
  "return to Auto" never actually cleared them and reopening the
  modal showed stale Manual values. With null-clearing, Auto truly
  returns the camera to auto (AeEnable=true; stale ExposureTime/
  Gain ignored by libcamera once cleared) and Manual reopens showing
  Manual with its stored values. Mode detection on open: Manual iff
  stored camera_controls contains exposure_time or analogue_gain.
- edit_camera: Pi cameras are now editable via _edit_picamera
  (identity + detection + camera_controls through
  apply_config_command; start_paused maps to paused). RTSP edit
  applies the Detection-tab fields too.
- add_camera: applies the Detection-tab fields from the Add body
  through apply_config_command after the runtime cam is built.
- camera_config_payload gains sensor_model (best-effort from
  Picamera2 camera_properties Model, fallback "Unknown"; None for
  RTSP) and camera_port ("CSI 0" -- Picamera2() with no args opens
  camera_num 0 by construction; None for RTSP).
- /api/classes falls back to the service-level model names when no
  cameras exist, so the Add flow can build the watchlist on a fresh
  setup (previously 404 "no cameras configured").

Deliberate deviations from the mockups (already decided; do not
"fix" back):
1. Scheme rtsp/rtsps ONLY. The mockup adds "http" -- the service has
   no HTTP-stream backend (HTTP is covered by Snapshot URL).
2. Model yolov8n / yolov8s ONLY. The mockup adds yolov8m -- that
   model file is not installed and would run far too slowly on a
   Pi 4.
3. AE exposure mode Default / Short / Normal / Long (the
   server-supported libcamera set). The mockup drops Normal and adds
   "Custom", which is not a libcamera AeExposureMode.
4. Pi Sensor card (port / resolution): DISPLAY-ONLY detected info.
   Editable port/resolution switching is a new backend feature
   (camera re-init with a new sensor config), out of scope.
5. Fonts: the app's existing system font stack, no Google Fonts
   dependency.
6. EV slider step 0.5 per design: a stored EV off-step is snapped
   to the nearest 0.5 step for display.
### 15.15 Asymmetric debounce + weak (sub-threshold) detections (v0.3.0 follow-up, Oct 18, 2026)
Rationale: camera2 "Paducah - Garage" showed threshold-boundary flapping:
   a parked car produced perfectly alternating car=1/car=0 events with an
   identical bbox (~[0.594, 0.082, 0.665, 0.130]) and confidences 0.50-0.58
   vs the 0.5 threshold. Confirm-2 alone cannot suppress oscillation whose
   period is tens of seconds to minutes; the decided event semantics
   (one notification on arrival, one when gone) need a longer disappearance
   confirmation.
1. Asymmetric debounce (per camera, per class):
   - A transition TO zero (last confirmed count > 0, this cycle 0)
     requires `disappear_confirm_cycles` consecutive zero cycles before
     the {count: 0} is published, the event stored, and the image
     buffered. All other changes (0->k, k->j) keep confirm-2.
   - While a disappearance is pending, `last_counts` keeps the old value,
     so the counts panel, /api/counts and MQTT keep showing
     the last CONFIRMED count; nothing is stored or published.
   - `disappear_confirm_cycles`: per-camera key, default 4, integer,
     valid 2..20. Out-of-range/non-integer input falls back to 4 with a
     logged warning (config migration, MQTT config/set apply path, and
   - On (re)connect, baselines publish from `last_counts`, so a pending
     (unconfirmed) disappearance can never leak into baselines.
   - UI: one number field in the shared Detection tab ("Confirm absent
     (cycles)", hint "Consecutive empty cycles before a disappearance is
     published - default 4"), client-validated int 2..20 with the
     existing error-dot mechanism; round-trips RTSP add/edit + Pi edit.
2. Weak detections under Latest Frame (DISPLAY_FLOOR = 0.25):
   - Inference runs at conf=min(threshold, DISPLAY_FLOOR); each cycle
     watched-class boxes split into confirmed (confidence >= threshold)
     and weak (0.25 <= confidence < threshold). Counts, events, MQTT,
     buffer storage and debounce use CONFIRMED only.
   - Per-camera `latest_dets`/`latest_weak` refresh every capture cycle,
     even when nothing is confirmed; never stored or published.
   - GET /api/latest_meta?camera=<id> returns {camera_id, timestamp,
     threshold, display_floor, detections: {class: [{confidence, bbox}]},
     weak_detections: [{class, confidence, bbox}]}; 404 for unknown
     camera, same as /api/latest.
   - Latest Frame panel: below the image, a compact text list
     ("car 0.83"); weak entries muted via .dim with a "(weak)" marker;
     "No object detections" when empty. No bbox overlay (explicit choice). Refreshes on every SSE frame push via loadLatest,
     follows the selected camera.
