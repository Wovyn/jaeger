# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
