# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
