# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-16

### Added
- RTSP camera support (`RTSPCamera` backend via OpenCV `VideoCapture` /
  `CAP_FFMPEG`): scheme (rtsp/rtsps), host, port, path, stream
  (mainstream/substream), transport (TCP default / UDP), connection
  timeout. The test response reports actual resolution + codec, and the
  modal help text says to choose H.264 when the camera offers it (H.265
  is expensive to software-decode on a Pi 4).
- Per-camera connection mode (Scott requirement): `persistent` (hold one
  RTSP connection open, lowest overhead) or `per-capture` (connect / grab
  / disconnect every sample_interval, freeing the camera between captures
  for other apps). The UI shows per-camera grab timing so the user can
  judge whether per-capture mode works for a given camera.
- HTTP snapshot-URL path: when a per-camera snapshot URL is set, the
  capture thread polls it instead of holding an RTSP stream; RTSP is the
  fallback when the snapshot fetch fails.
- Reconnect with backoff (2 s, 5 s, 10 s, 30 s cap) in the capture
  thread, never in the inference path.
- Camera lifecycle APIs: `POST /api/cameras/test` (hard timeout,
  downscaled thumbnail + resolution + codec; persists nothing, never
  echoes/logs credentials, never hangs), `POST /api/cameras` (add),
  `PATCH`/`POST /api/cameras/<id>` (edit; connection changes re-run the
  test before persisting), `POST /api/cameras/<id>/pause` + `/resume`
  (pause disconnects the RTSP stream; status paused; counts freeze),
  `DELETE /api/cameras/<id>` (clears retained MQTT topics, keeps buffered
  images), `POST /api/cameras/rescan` (retry Picamera2 init at runtime).
- Web UI: enabled [+] Add Camera button; Add/Edit modal with grouped
  fields (Identity: name, icon; Connection: scheme/host/port/path/stream/
  transport/connection mode/timeout; Access: credentials on/off,
  username/password, rtsps-only allow-self-signed; Capture: sample
  interval, snapshot URL, rotate, start-paused) plus Test / Add-Save /
  Cancel. About 8 original hand-written SVG icons (generic camera, door,
  garage, driveway, garden/yard, entrance, room, board/chip for the Pi
  camera). Cameras panel rows show icon, name, type, status dot
  (online/degraded/paused/offline), last image-grab time, last inference
  time, grab timing, and per-row pause/resume + edit + delete (no delete
  control for the Pi camera). Load indicator: saturation = sum over
  cameras of (measured inference_time / sample_interval); warns above
  1.0. No-cameras empty state. Rescan action.
- Camera IDs are auto-generated from a monotonic `next_camera_id` counter
  (`camera0`, `camera1`, ...) and NEVER reused after a delete. Camera
  names must be unique (enforced, clear error on duplicate).
- Multi-camera architecture: one capture thread per camera + per-camera
  latest-frame slots (one frame each, newest wins, no unbounded queue) +
  ONE inference worker thread owning the single shared YOLO instance +
  main thread as supervisor (config/MQTT/shutdown/watchdog). Zero cameras
  is a valid running state; the service no longer exits when nothing is
  configured. Watchdog restarts dead capture threads; no fresh frame for
  ~3x sample_interval + 30 s degrades the camera status with an SSE push.
  `capture_now` prioritizes a camera.

### Changed
- **MQTT topic tree: HARD CUTOVER from `Wovyn/RaspberryPi/YOLOSensor/` to
  `Wovyn/RaspberryPi/Jaeger/`, with a `cameras/<camera-id>/` level**
  (`Wovyn/RaspberryPi/Jaeger/<serial>/cameras/camera0/...`). No
  dual-publish. Node-RED flows referencing the old tree need a one-time
  update. On first v0.3.0 start, a `topic_root` ending in `YOLOSensor` is
  rewritten to `Jaeger` and the migration is logged loudly.
- **Model is now service-level** (`config.model`, one shared model for all
  cameras; Settings shows one model dropdown, not one per camera).
  Per-camera model keys in old configs are ignored with a logged warning.
- Per-camera config gains `icon`, `paused`, `rotate`, and an `rtsp` block
  (scheme/host/port/path/stream/transport/connection_mode/timeout_s/
  snapshot_url/tls_allow_self_signed/username/password). The RTSP URL is
  built server-side from parts and never stored as a full URL.
- Settings modal: model is service-level (one dropdown). Per-camera
  tunables (interval, threshold, watchlist, publish toggles, camera
  controls) stay per camera.
- `/api/status` now also reports the service-level `model` and inference
  `saturation`. `/api/latest` reads the frame from the camera's slot.
- Per-camera config payloads no longer carry `model` (service-level now)
  and never carry the RTSP password (only a `has_password` flag).

### Fixed
- Model swap: the old model object is explicitly unloaded (`del` +
  `gc.collect()`) BEFORE the new one loads, so peak memory is one model,
  not two.
- Debounce `pending_changes` are cleared on model switch.
- SSE config push happens AFTER a model swap completes, so the UI
  confirms the new model (fixes the v0.2.x behavior where Save-time
  retained config published the pre-swap model).
- RTSP URLs / credentials never appear in logs, errors, or API
  responses. Passwords are never returned by any API.

### Security
- Camera passwords live only in `config.json` (0600), are never returned
  by any API, never logged, and never stored as part of a full URL. The
  web UI still has no auth (LAN-only, known); camera passwords flow
  through it in plaintext HTTP, the same exposure class as everything
  else the UI does — the proxy + auth project covers it. Do not add
  cameras over a network you do not trust until the proxy lands.

## [0.2.1] - 2026-10-16

### Fixed
- Counts panel: "Show zero counts" now defaults to unchecked; when no
  objects are detected the panel shows a centered one-line message,
  "No objects detected", instead of an empty list.
- Counts-panel class filter now actually filters the events list.
  Root cause (server): the filter matched an event if the class key
  merely existed in the sidecar `detections` dict — and sidecars list
  every watchlist class, even empty ones. It now requires a positive
  count or a non-empty object-detection list for that class.
- New "Filter no object detections" checkbox (default checked) hides
  events whose counts are all zero. Events with unknown counts
  (pre-v0.2.0, no sidecar) stay visible.
- User-visible text now says "object detections" everywhere instead
  of bare "detections" (API JSON keys and code identifiers unchanged).
- Modal bounding boxes now render. Root cause: the overlay code
  multiplied normalized 0-1 bboxes by image pixels while the SVG
  viewBox is `0 0 1 1`, pushing every box off-canvas. Coordinates are
  now used as-is, with viewBox-fraction text offsets.
- Modal close X now sits above the image (z-index + opaque
  background) and is clickable.
- Events list now updates on push via server-sent events
  (`GET /api/stream`) instead of 5 s timer polling: a new event
  refreshes the list and counts; a config change refreshes cameras,
  counts, and status. (A refresh is deferred while the image modal
  is open, then applied on close.)
- Latest Frame now refreshes on a per-capture SSE push instead of
  the timer. Latest Frame is the most recent capture regardless of
  object detections.
- Header uptime is now human-readable ("1y 67d 3h 52m 45s": years of
  365 days / days / hours / minutes / seconds, zero-valued units
  omitted, seconds always shown) with the service start time on
  mouseover. The displayed uptime ticks locally every second; the
  server is not re-polled for it.
- About popup is now square (`min(90vw, 480px)`, aspect-ratio 1/1)
  without changing the image modal.

### Added
- Jaeger logo (white jaeger seabird silhouette on deep navy) in the
  header and the About popup, plus a favicon (`static/logo.png`).

## [0.2.0] - 2026-10-14

### Added
- Web UI on port 8082 (`web_ui.py` + `static/`, stdlib only, no auth —
  LAN-only by decision): header with Jaeger + version, MQTT status dot,
  and hamburger menu (Settings, About, buffer usage); left column with
  cameras list (click to select) + counts panel for the selected camera
  (aligned `name: count` rows, show-zero toggle, click a row to filter
  events) + latest-frame strip; right column with the events list (last
  25, infinite scroll, camera/class filters, thumbnails, full-size modal
  with client-side SVG bounding-box overlay, Esc/arrows).
- JSON API (`/api/status`, `/api/cameras`, `/api/counts`, `/api/classes`,
  `/api/events`, `/api/image`, `/api/latest`, `/api/config`,
  `/api/capture_now`). UI config writes go through the same apply +
  persist path as MQTT `config/set` (main loop stays the single writer).
- Per-image JSON sidecars: `<event_id>.json` next to each `<event_id>.jpg`
  (camera, timestamp, full counts, detections incl. bboxes, model,
  threshold). Eviction deletes `.jpg` + `.json` as a pair; orphan
  sidecars are cleaned up; `images/response` reads detections from the
  sidecar, so they survive a restart.
- Confirm-2 debounce: a count change publishes/stores only after the same
  value is observed in 2 consecutive inference cycles (kills 1-cycle
  flicker around the threshold).
- Picamera2 camera controls (per camera, via config / MQTT `config/set` /
  Settings): `exposure_value`, `ae_exposure_mode` (Short/Normal/Long),
  manual `exposure_time` + `analogue_gain` (imply AEC off), `ae_enable`,
  `awb_enable`. Values validated/clamped; bad values logged, never fatal.
- `camera_config_payload()` — one camera-config dict shared by MQTT
  publish and the web API; payload now also carries `camera_controls`
  and `last_capture_at`.

## [0.1.0] - 2026-10-13

### Added
- Initial test implementation of the intelligent object-recognition + notification
  service for the Raspberry Pi (Muse-Pi-1).
- `yolo_sensor.py`: Picamera2 capture (persistent camera object, 118 ms/frame),
  YOLOv8n/YOLOv8s inference via ultralytics (model selectable at runtime),
  per-class change detection, MQTT publishing to HiveMQ Cloud over TLS.
- Per-class MQTT topics by id and by name
  (`.../<cpu-serial>/camera0/classId/<id>`, `.../className/<name>`), retained,
  with `{count: 0}` baselines on startup and zero-transitions clearing state.
- Aggregate `events` topic for simple notifiers; Pi-level `config`/`status`
  (LWT); per-camera `config` (camera details + tunables), `config/set`
  (sample_interval, confidence_threshold, watchlist, model, buffer_cap_mb,
  heartbeat_interval, publish toggles, capture_now), `status`,
  `images/request`/`images/response`.
- Ring buffer (`buffer/<camera-id>/`): stores frames only on published change,
  shared byte cap (default 1 GB, configurable to 2 GB), oldest-first eviction.
- `setup_config.py`: generates `config.json` (0600) from `~/Documents/HiveMQ.txt`
  without exposing secrets; remote config changes persist back.
- `yolo-mqtt.service`: systemd unit (runs as musecell, restart on failure).
- Multi-camera-ready design: `cameras` list, `Camera`/`PiCamera` abstraction,
  `.../<cpu-serial>/camera{id}/` topic level (RTSP/IP cameras on the backlog).
- Docs: README (hardware setup, environment, models, verification, config,
  MQTT reference, Node-RED), DESIGN.md, NOTICE, Apache 2.0 LICENSE.

### Verified
- Camera: ArduCam 8MP v2.3 (IMX219) via `dtoverlay=imx219` (Oct 12).
- Environment: torch 2.14.1+cpu, ultralytics 8.4.176, paho-mqtt 2.1.0 (Oct 12);
  picamera2 via apt + venv `--system-site-packages` (Oct 13).
- Cold inference yolov8n ≈ 4.6 s, yolov8s ≈ 6.7 s (imgsz 640, Pi 4 CPU);
  warmed-up steady-state ≈ 1.0 s.
- End-to-end against the live broker: connect, retained tree, baselines,
  change→publish→buffer→events, config/set round-trip, image request/response,
  graceful shutdown (offline statuses).
