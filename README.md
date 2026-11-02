# Jaeger

![Jaeger logo](static/logo.png)

Jaeger is an intelligent object-recognition and notification service for the
Raspberry Pi. Cameras capture frames at a low rate, YOLOv8 detects objects,
results publish to MQTT only when the scene changes, and a bounded ring buffer
keeps the event images retrievable on demand. It is a much smaller, Pi-focused
take on the Frigate idea: not real-time video analysis, but scene-change
watching — a person arrives, a car leaves, a dog appears — reported as it
happens. Node-RED (or any MQTT consumer) can turn the events into
notifications, e.g. via Pushover, or other actions.

A Wovyn R&D project. Apache 2.0.

Current release: **v0.4.0** — see [CHANGELOG.md](CHANGELOG.md).

## Features

- **Three camera types, mixed freely:** Pi CSI cameras (via Picamera2),
  RTSP/IP cameras (via OpenCV/FFmpeg), and USB cameras (V4L2). Cameras are
  added, edited, paused, and deleted from the web UI, with a
  test-before-save flow — a failed connection test persists nothing.
- **YOLOv8 detection:** one shared model for all cameras (`yolov8n` nano or
  `yolov8s` small, selectable in Settings), COCO-class watchlist per camera
  (default: person, car, truck, bus, dog, cat, bicycle, motorcycle).
- **Change-only publishing:** per-class counts publish only when they change.
  A confirm-2 debounce swallows one-cycle flicker, and disappearances need a
  configurable number of consecutive empty cycles
  (`disappear_confirm_cycles`, default 4) before a count of 0 is published.
- **Weak detections in the UI only:** detections below the camera threshold
  but at or above 0.25 confidence are shown muted in the web UI; they are
  never published or stored.
- **Event image ring buffer:** every published change stores the frame as a
  JPEG (quality 85) with a JSON metadata sidecar (full counts, detections
  with bounding boxes, model, threshold). Size-capped (default 1 GB,
  adjustable in Settings); oldest images are evicted first. Images are
  retrievable via MQTT request/response or downloadable from the web UI.
- **Web UI:** live camera list and counts, latest frame with a bounding-box
  overlay, an events browser with full-size image modal, per-camera settings
  modals, and system-wide Service settings — updated live via server-sent
  events, no polling.
- **MQTT is optional:** Jaeger runs fully — cameras, detection, buffer, web
  UI — with no broker at all. When MQTT is enabled it publishes a retained
  state tree, accepts remote configuration, and reconnects in the
  background if the broker drops; a down broker never blocks startup.
- **Node-RED friendly:** stable topic tree with per-class topics by class id
  and by class name (see the MQTT section).
- **systemd service:** the included unit auto-starts on boot and restarts on
  failure.
- **No accounts, no auth:** the web UI and API are unauthenticated by design
  and intended for a trusted LAN only (see DESIGN.md §13).

## How it works

Each camera gets a capture thread that writes its newest frame into a
latest-frame slot (frames are never queued — a slow consumer simply sees the
newest frame). A single inference worker owns the one shared YOLO model and
round-robins the cameras that are due: a camera's effective interval is
`max(sample_interval, N × inference_time)` for N cameras. Inference results
are compared against the camera's last confirmed counts; only per-class
changes that survive the debounce are published.

Those published changes go to MQTT (when enabled), are stored in the ring
buffer, and are shown in the web UI, which is served by a stdlib-only web
server on the same process. Zero cameras is a valid running state — the
service starts happily with none and you add them from the UI.

## Requirements

**Required**

- Raspberry Pi 4 or 5 running a 64-bit OS (Raspberry Pi OS / Debian 13
  verified on the reference install)
- Python 3.11 or newer (developed and verified on 3.13)
- Network access: LAN for the web UI/cameras, internet during installation
  (pip packages and model downloads)
- Disk space for the ring buffer (default cap 1 GB) plus ~1 GB for the
  Python environment and models

**Cameras** — none are required to install and start; add any mix later
from the web UI:

- Pi CSI camera (official Pi Camera or compatible module), or
- RTSP/IP camera reachable on the network, or
- USB (UVC) camera

**Optional**

- An MQTT broker (e.g. HiveMQ Cloud) — only if you want MQTT reporting and
  remote configuration
- Node-RED, and a Pushover account, for notifications
- `python3-picamera2` (system package) — only for a Pi CSI camera
- `v4l2-utils` (system package) — for USB camera scanning and UVC controls

## Installation

> **Installing with an AI agent?** Give it [AGENTS.md](AGENTS.md) — a self-contained install contract written for agents, with per-step verification and the done criteria. The steps below are the same procedure in human-readable form.

### Step 1 — Clone the repository

```bash
mkdir -p ~/projects
git clone https://github.com/Wovyn/jaeger.git ~/projects/jaeger
cd ~/projects/jaeger
```

The rest of this guide assumes the clone is at `~/projects/jaeger`; if you
clone elsewhere, adjust the paths (and the systemd unit in step 7).

### Step 2 — System packages

```bash
sudo apt update
sudo apt install -y python3-picamera2 v4l2-utils rpicam-apps
```

- `python3-picamera2` — only needed for a Pi CSI camera. Do NOT
  `pip install picamera2`: its `python-prctl` dependency needs libcap
  development headers and the pip build fails without sudo. The apt package
  is the supported route (and capturing through Picamera2's persistent
  camera object is far cheaper per frame than shelling out to a stills
  tool each capture).
- `v4l2-utils` — provides `v4l2-ctl`, required for USB camera scanning and
  for applying UVC exposure/white-balance controls. Skip it only if you
  will never use a USB camera.
- `rpicam-apps` — provides `rpicam-hello` / `rpicam-still`, used to verify
  a Pi CSI camera before Jaeger ever touches it.

### Step 3 — Python virtual environment

The venv MUST be created with `--system-site-packages` so the apt-installed
picamera2 package is visible inside it:

```bash
python3 -m venv --system-site-packages ~/projects/jaeger/venv
~/projects/jaeger/venv/bin/pip install --upgrade pip
```

### Step 4 — Python dependencies (order matters)

Install torch and torchvision FIRST, from the PyTorch CPU index. The
default PyPI torch is CUDA-bundled (~454 MB torch + ~651 MB cuDNN + more
NVIDIA packages, ~3 GB total) and useless on a Pi; and torchvision must be
the `+cpu` build matching torch, or ultralytics fails at warmup with
`RuntimeError: operator torchvision::nms does not exist`.

```bash
V=~/projects/jaeger/venv/bin
$V/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
$V/pip install ultralytics paho-mqtt
```

(opencv-python arrives as an ultralytics dependency.)

Verified working set on the reference install: torch 2.14.1+cpu,
torchvision 0.29.1+cpu, ultralytics 8.4.176, paho-mqtt 2.1.0,
opencv-python 5.0.0.93, numpy 2.5.4. Treat this as a known-good set, not a
pin — newer versions from the same sources should work.

### Step 5 — Download the YOLO models

Both models are downloaded into `models/`. One model is shared by all
cameras and is selectable later in Service settings (default: yolov8n).

```bash
mkdir -p ~/projects/jaeger/models && cd ~/projects/jaeger/models
~/projects/jaeger/venv/bin/python -c \
  "from ultralytics import YOLO; YOLO('yolov8n.pt'); YOLO('yolov8s.pt')"
ls -la
# yolov8n.pt ~= 6.2 MB, yolov8s.pt ~= 21.5 MB
```

### Step 6 — First run

```bash
cd ~/projects/jaeger && ./venv/bin/python -u yolo_sensor.py
```

On first run there is no `config.json`, so the service creates a working
default (mode 0600: MQTT disabled, zero cameras, yolov8n, web UI on
0.0.0.0:8082) and prints that it created a default config and to add
cameras via the web UI. This is the standard path — no config file editing
is needed to get running.

Verify from another terminal:

```bash
curl http://127.0.0.1:8082/api/status
# JSON, including "version": "0.4.0" and "mqtt_configured": false
```

Then open `http://<pi-address>:8082` in a browser: the Jaeger UI loads with
an empty Cameras panel ("No cameras configured"). Leave the service
running and add your first camera (next section), or stop it with Ctrl-C
and continue with step 7 to run it as a service.

### Step 7 — Run as a service (systemd)

Stop any foreground run first and confirm it is gone (`ps`). Never run two
instances at once: they would fight over port 8082, the cameras, and the
MQTT connection.

The shipped unit `yolo-mqtt.service` was written for the reference
install, so edit these three lines to YOUR user and clone path before
installing it:

```
User=<your-user>
WorkingDirectory=/home/<your-user>/projects/jaeger
ExecStart=/home/<your-user>/projects/jaeger/venv/bin/python -u yolo_sensor.py
```

```bash
cd ~/projects/jaeger
nano yolo-mqtt.service   # make the three edits above
sudo cp yolo-mqtt.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yolo-mqtt.service
```

Verify:

```bash
systemctl status yolo-mqtt.service
curl http://127.0.0.1:8082/api/status
journalctl -u yolo-mqtt.service -f
```

The unit runs the sensor unbuffered (`python -u`) so journalctl shows log
lines as they happen, restarts on failure after 10 seconds, and auto-starts
on boot.

### Optional: smoke-test the capture → inference chain (Pi camera only)

Proves capture and inference work before the service is involved. This
uses `rpicam-still`, so it applies to a Pi CSI camera only (if your module
needs the ArduCam setup in the next section, do that first). RTSP and USB
cameras are tested from the Add-camera flow instead.

```bash
cd ~/projects/jaeger
V=~/projects/jaeger/venv/bin
rpicam-still -t 1500 -o /tmp/yolo-smoke.jpg
$V/python - <<'EOF2'
from ultralytics import YOLO
import time
m = YOLO('models/yolov8n.pt')
t = time.time()
r = m('/tmp/yolo-smoke.jpg', verbose=False)[0]
print('inference ms:', round((time.time() - t) * 1000))
for b in r.boxes:
    print(m.names[int(b.cls)], round(float(b.conf), 3))
EOF2
rm /tmp/yolo-smoke.jpg
```

On the reference Pi 4 a cold first inference takes ~4.6 s (imgsz 640);
warmed steady-state inference is ~1 s — see Performance notes.

## Setting up cameras

All cameras are added and edited in the web UI: click **[+]** in the
Cameras panel, pick the camera type, fill in the form, and use **Test**
before saving — saving re-runs the test and a failed test persists
nothing. Per-camera settings (sample interval, confidence threshold,
watchlist, heartbeat, and more) live in each camera modal's Detection tab.

The defaults are a 5 s sample interval and a 0.5 confidence threshold.
Cameras can be paused (capture and inference stop; for RTSP/USB, pausing
also disconnects the device), resumed, and — except the Pi camera —
deleted, all from the UI.

### Pi camera (CSI)

Attach the camera to the Pi's CSI port and make sure the OS can see it:

```bash
rpicam-hello --list-cameras
```

Official Pi Camera modules are auto-detected by the firmware
(`camera_auto_detect=1`, the default) and need no configuration.

Once the camera shows up there, add it in the UI: **[+] → Found on this
device** shows the Pi camera (if it was not detected, the **Rescan** /
Retry detection action re-checks). Jaeger captures through Picamera2 at
1280×720 by default. Exposure and white-balance controls for the camera
are in its modal's Camera tab — see the controls reference below.

#### Example: ArduCam IMX219 modules

Third-party modules such as the ArduCam 8MP v2.3 (Sony IMX219 sensor) do
NOT carry the identification data that `camera_auto_detect=1` looks for,
so the firmware never detects them. Symptoms:

```
$ vcgencmd get_camera
supported=0 detected=0, libcamera interfaces=0
$ rpicam-hello --list-cameras
No cameras available!
```

They need an explicit device-tree overlay (needs sudo):

> Note: on Debian 13 / current Raspberry Pi OS the live boot config is
> `/boot/firmware/config.txt`. `/boot/config.txt` is a 91-byte stub that
> says "DO NOT EDIT THIS FILE". Articles written for older Pi OS give the
> old path — edits there have no effect.

```bash
sudo nano /boot/firmware/config.txt
# change:  camera_auto_detect=1  ->  camera_auto_detect=0
# under [all], add:  dtoverlay=imx219
sudo reboot
```

Verify:

```bash
rpicam-hello --list-cameras
# expect: 0 : imx219 [3280x2464 10-bit RGGB] ...

rpicam-still -t 1500 -o /tmp/cam-test.jpg && file /tmp/cam-test.jpg
# expect: JPEG image data ... 3280x2464 ...
rm /tmp/cam-test.jpg
```

If detection still fails: reseat the ribbon cable (blue-strip orientation
matters; the Pi 4 has a single CSI port) and confirm which camera model
is attached — non-IMX219 ArduCam modules need their own overlay or
driver.

#### Pi camera controls (Picamera2)

Configured per camera under `camera_controls` (in `config.json`, via the
camera modal's Camera tab, via the API, or via MQTT `config/set`).
AEC/AGC stay on by default.

| Key | Effect |
|---|---|
| `exposure_value` | EV compensation in stops, clamped to −8…8 (positive = brighter) |
| `ae_exposure_mode` | `Short` (less blur, more noise), `Normal`, `Long` (less noise, more blur) |
| `exposure_time` | Manual exposure in microseconds; setting it (or `analogue_gain`) turns AEC off |
| `analogue_gain` | Manual sensor gain, clamped to 1.0…16.0 |
| `ae_enable` | Auto exposure on/off |
| `awb_enable` | Auto white balance on/off |

Out-of-range values are clamped, unknown keys are logged and ignored, and
a bad value never crashes the capture loop — previous settings are kept.
Note: `Brightness`, `Contrast`, `Saturation`, `Sharpness`,
`AeMeteringMode`, `NoiseReductionMode`, and HDR are NOT Picamera2 controls
in this context; do not assume they exist.

### RTSP cameras

Add via **[+] → Add manually → Network camera (RTSP)**. Find the
camera's RTSP URL format in its own manual/admin page (typical shapes:
`/h264/ch1/main/av_stream`, `/Streaming/Channels/101`,
`/cam/realmonitor?channel=1&subtype=0`). In the Add modal, put the path in
Path.

If the path differs between main and sub streams only by a `main`/`sub`
token, write `{stream}` in its place and pick the Stream — Jaeger
substitutes it. The form shows a live resolved-URL preview with the
password always masked.

Test connection opens the stream (or the snapshot URL, when set) with a
hard timeout, grabs one frame, and reports the actual resolution + codec
without persisting anything. Saving re-runs the test; a failed test
persists nothing. The RTSP URL is built server-side from the form parts at
connect time and never stored as a full URL; camera passwords are never
returned by any API and never logged. On edit, leaving the password blank
keeps the stored password.

Connection mode matters because the cameras are NOT dedicated to Jaeger —
other processes also check in on them:

- **`Persistent`** — holds one RTSP connection open. Lowest per-frame
  overhead. Risk: holds one of the camera's stream slots, which can block
  other apps.
- **`Per-capture`** — connects, grabs one frame, and disconnects every
  sample_interval. Frees the camera between captures. Cost: every capture
  re-negotiates RTSP, waits for a keyframe (1–3 s), and software-decodes
  video — slower, more jitter, more CPU per frame. Watch the per-camera
  grab timing in the Cameras panel to judge whether it works for a given
  camera: the panel splits the grab into open time (RTSP handshake +
  auth) and keyframe-wait time (a fresh connect cannot decode until the
  next keyframe), so the dominant cost is visible.

Snapshot URL: if the camera serves a JPEG snapshot endpoint, set it and
Jaeger polls it instead of holding an RTSP stream (cheaper). RTSP remains
the fallback when a snapshot fetch fails. Snapshot polling composes with
either connection mode.

Test-then-add is sequential: the test fully closes its stream before the
live capture thread opens one, because some cameras allow only 1–2
concurrent streams. The same stream lock serializes a re-test against a
live capture thread on edit.

### USB cameras

Add via **[+] → Found on this device**.

- **Scanning:** the scan covers the Pi's video devices (uvcvideo capture
  nodes only — the Pi's own ISP/codec nodes are excluded) and reports
  each device's real formats.
- **Format:** pick a format (MJPG is preferred — YUYV costs more CPU to
  convert), a resolution, and a frame rate.
- **Stable identity:** the camera opens persistently over V4L2 and is
  stored by a stable by-id device id, never `/dev/videoN`, so it survives
  reboots and USB reordering.
- **UVC controls (optional):** in the camera's Capture/Device tab —
  auto exposure + `exposure_time_absolute` (1–10000) and auto white
  balance + `white_balance_temperature` (0–10000), applied with
  `v4l2-ctl` on open and on edit (this is why `v4l2-utils` is in step 2).
- **Unplugging:** unplugging a USB camera marks it offline; its config is
  kept and capture resumes when it reappears.

## Web UI guide

Open `http://<pi-ip>:8082` in a browser (no login — LAN-only by design;
see DESIGN.md §13 for the no-auth decision).

### Layout at a glance

- Header: Jaeger logo + version, MQTT status dot, human-readable
  uptime (service start time on mouseover), hamburger menu (Settings,
  About, buffer usage). Favicon is the Jaeger logo.
- Left column: the cameras list (click a camera to select it), the
  counts panel for the selected camera, and below them the
  latest-frame panel.
- Right column: the events list.
- Live updates: the UI subscribes to server-sent events
  (`GET /api/stream`); a new event refreshes the list and counts,
  a new capture refreshes Latest Frame, a config change refreshes
  cameras/counts/status. No timer polling (uptime ticks locally).

### Cameras and counts

- Cameras panel rows show the icon, name, type, status dot
  (online/degraded/paused/offline), last image-grab time, last inference
  time, and grab timing, with per-row pause/resume + edit + delete
  (the Pi camera has no delete control). The [+] button opens the
  Add-camera modal; Rescan retries Pi-camera detection. With zero cameras
  the panel shows an empty state pointing at [+].
- Counts rows are `name: count`, aligned; the show-zero toggle
  (default off) hides zero counts, and an empty result shows a centered
  "No objects detected" line; clicking a row filters the events list
  to that class.
- Inference load indicator: saturation = sum over cameras of (measured
  inference time / sample interval, excluding paused cameras and
  cameras with no live backend). Above 1.0 the UI warns that inference
  is saturated (frames are superseded, per-camera effective intervals
  grow).

### Latest frame

- Shows the most recent capture regardless of object detections,
  refreshed on every capture.
- Below the image, a text list shows the current detections with
  confidences ("car 0.83"); sub-threshold ("weak") detections appear
  muted with a "(weak)" marker.
- The image also carries a bounding-box overlay: confirmed detections
  get a solid green box with a "name 0.81" label, weak detections a
  dashed amber box with a "(weak)" label.
- If the selected camera is paused, the panel instead shows
  "[name] is paused — no live frame" with a Resume button (page load
  selects the first non-paused camera), and a failed frame fetch
  shows "No frame available".
- On first load the panel shows a "Loading latest frame…" placeholder
  and the cameras list a "Loading cameras…" placeholder until the
  first data arrives.

### Events

- Newest first, last 25 with infinite scroll for older events, with
  camera, class, and "Filter no object detections" (default on)
  filters.
- Each row shows camera, local time (UTC on mouseover), objects +
  counts, and a thumbnail.
- Click a row for the full-size image in a modal; the bounding-box
  overlay toggle (default on) draws boxes from the sidecar metadata.
- The modal Download button saves the full-size image as
  {camera name}-{YYYYMMDD-HHMMSS}.jpg (event time in browser-local
  time).
- Esc closes the modal; arrow keys step through events.

### Camera add/edit modals

- Add/Edit camera modals are tabbed: RTSP cameras get Connection and
  Detection tabs; the Pi camera gets Camera and Detection tabs. A tab
  with an invalid field gets a red error dot on Save, and the first
  error tab opens.
- Both share ONE Detection tab (sample every, confidence threshold,
  image size, heartbeat, Confirm absent cycles, publish toggles,
  watchlist) with a note naming the live service model and a link to
  Service settings.
- The Connection tab groups Identity, Connection, Access, and Capture
  fields with a live resolved-URL preview (password always masked);
  the Pi Camera tab adds a read-only Sensor card, exposure and
  white-balance controls, a live preview, and Test capture.
- Test connection fetches a sample image (thumbnail + resolution +
  codec) without persisting anything; saving connection changes
  re-runs the test before persisting. On edit, leaving the password
  blank keeps the stored password.

### Service settings

Service settings (hamburger menu) is system-wide only, with a left
nav. One Save applies all panels:

- General: portal port, with a Check availability button and the
  current portal URL.
- Storage limit: image-history ring-buffer limit, with a live In-use bar.
- Detection model: shared YOLO model, yolov8n / yolov8s.
- MQTT: a single card with an enable switch, broker host with an
  mqtts:// or mqtt:// scheme prefix that follows the TLS toggle, port,
  TLS, topic root, username, password; blank password keeps the stored
  password; the MQTT nav item shows a green dot while MQTT is enabled.

#### Changing the portal port

- Saving an unchanged port restarts nothing.
- Saving a different port (1024-65535) restarts the whole service on
  the new port after the save response is sent, and every open browser
  tab is moved automatically (SSE restart broadcast plus
  poll-new-port-then-old-port fallback in the saving tab).
- Closed tabs and bookmarks to the old port are not moved — update
  bookmarks after a move.
- If the new port becomes unavailable before the restart, the restart
  is aborted, the saved port reverts to the old port, and the tab
  falls back to the old port.
- If the exec that restarts the service fails, the process exits;
  restart it manually from ~/projects/jaeger with
  venv/bin/python -u yolo_sensor.py.

#### Saving MQTT changes

- When MQTT is enabled, Save tests the connection first; a failed test
  saves nothing.
- Changing broker or topic root switches the live client (background
  reconnect on failure); retained topics under an old topic root are
  not cleared automatically.

Per-camera detection settings live in each camera modal Detection
tab, and Pi camera controls in its Camera tab. UI config writes go
through the same apply + persist path as MQTT `config/set`.

## MQTT (optional)

Jaeger needs no broker: with MQTT disabled (the default) everything else
works. To enable it, open **Service settings → MQTT** in the web UI,
switch MQTT on, and fill in the broker host, port, TLS toggle, topic root,
username, and password. **Test connection** checks the values without
saving; **Save** runs the test again first and saves nothing if it fails.
No config-file editing is needed. If the broker later becomes unreachable,
the service keeps running and reconnects in the background.

### Topic reference

Root: `Wovyn/RaspberryPi/Jaeger/<cpu-serial>/`, where `<cpu-serial>` is
the Pi's CPU serial. Find yours in the `cpu_serial` field of
`GET /api/status`, or in the `Serial` line of `/proc/cpuinfo`. All
payloads JSON, timestamps ISO-8601 UTC, QoS 1.

```
<cpu-serial>/
├── config                  (retained) service identity: version, model,
│                           camera list (ids, names, types, statuses)
├── status                  (retained, LWT) online/offline
└── cameras/
    └── <camera-id>/       (camera0, camera1, ...; stable IDs, never the name)
        ├── config          (retained) camera details + tunables: name, type
        │                   (picamera|rtsp|usb), icon, resolution, access method,
        │                   sample interval, confidence threshold, watchlist,
        │                   buffer stats, heartbeat interval, paused
        ├── config/set      incoming commands (see Remote configuration)
        ├── status          (retained) camera online/degraded/paused/offline
        ├── events          scene-change summary {timestamp, counts, image_ref}
        ├── classId/<id>    (retained) per-class {count, detections, image_ref}
        ├── className/<name> (retained) same, by name
        └── images/
            ├── request     {event_id} → ask for an image
            └── response    {event_id, timestamp, jpeg_base64, detections}
```

Camera names stay OUT of topic segments: names have spaces, slashes, unicode,
and they change; a rename would orphan retained topics and break subscribers.
Subscribers that need names read the retained Pi-level or per-camera config.

Detection detail: `{confidence, bbox}` with bbox normalized 0–1
`[x1,y1,x2,y2]`. A class publishes only when its count changes (including
→ 0, which clears the retained state).

- **Confirm-2 debounce:** a change must persist for 2 consecutive
  inference cycles before it publishes — a one-cycle flicker is
  swallowed.
- **Disappearances:** a count dropping to zero instead needs
  `disappear_confirm_cycles` consecutive empty cycles (per-camera,
  default 4, valid 2..20, set in the Detection tab).
- **While a disappearance is pending,** counts, /api/counts and MQTT keep
  the last confirmed count.
- **Ring buffer:** the ring buffer (`buffer/<camera-id>/`) stores the
  frame for every published change; `image_ref` is the buffer event id.
  Every stored frame has a `<event_id>.json` sidecar with the full
  metadata (camera, timestamp, full counts, detections incl. bboxes,
  model, threshold); `images/response` reads detections from the sidecar,
  so they survive a restart.
- **Heartbeat:** each camera also republishes its retained config on its
  heartbeat interval (default 600 s).

> Upgrading from v0.2.x: in v0.3.0 the tree moved from
> `Wovyn/RaspberryPi/YOLOSensor/<serial>/camera{id}/...` to the Jaeger tree
> above (hard cutover, no dual-publish). Node-RED flows referencing the old
> tree need a one-time update.

### Remote configuration (MQTT)

Publish JSON to `.../cameras/camera0/config/set` — e.g. via Node-RED or mosquitto_pub:

| Key | Effect |
|---|---|
| `sample_interval` | seconds between captures (float) |
| `confidence_threshold` | 0–1 (float) |
| `watchlist` | list of COCO class names |
| `buffer_cap_mb` | ring-buffer cap in MB |
| `heartbeat_interval` | seconds between config republishes |
| `disappear_confirm_cycles` | consecutive empty cycles (2-20, default 4) before a disappearance (count to 0) is published |
| `publish` | `{"classId": bool, "className": bool, "events": bool}` |
| `camera_controls` | `{"exposure_value": float, "ae_exposure_mode": "Short"/"Normal"/"Long", "exposure_time": µs int, "analogue_gain": float, "ae_enable": bool, "awb_enable": bool}` — see Pi camera controls |
| `imgsz` | YOLO input size (e.g. 640, 416) |
| `icon` | icon key (`camera`, `door`, `garage`, `driveway`, `garden`, `entrance`, `room`, `board`) |
| `rotate` | 0/90/180/270 |
| `name` | rename (names must stay unique) |
| `paused` | `true`/`false` — pause/resume the camera |
| `rtsp` | partial `rtsp` block — connection changes restart the capture thread |
| `capture_now` | `true` triggers an immediate capture cycle |

`model` is service-level: a per-camera `model` key in `config/set`
is ignored with a logged warning. Change the model via the web Service settings
modal (one dropdown, shared by all cameras). Changes persist back to
`config.json` (mode 0600 preserved) and the camera's retained `config`
topic is republished. Example:

```bash
mosquitto_pub -h <broker> -p 8883 --capath /etc/ssl/certs \
  -u <user> -P <pass> \
  -t 'Wovyn/RaspberryPi/Jaeger/<cpu-serial>/cameras/camera0/config/set' \
  -m '{"sample_interval": 10}' -q 1
```

### Node-RED

Selective consumers sharing the cameras + inference (replace `camera0`
with your camera's id):

- Person/occupancy: `Wovyn/RaspberryPi/Jaeger/+/cameras/camera0/className/person`
- Vehicles: `.../cameras/camera0/className/car` (or by id: `.../cameras/camera0/classId/2`)
- Second camera: `.../cameras/camera1/className/person`
- Simple notifier → Pushover: `.../cameras/camera0/events` (counts, no per-class state)
- Image on demand: publish `{event_id}` to `.../cameras/camera0/images/request`,
  read the JPEG from `.../cameras/camera0/images/response`.

## Configuration reference

### config.json

You normally never edit `config.json` by hand — the web UI and MQTT
`config/set` write it for you, and it is kept at mode 0600 because it can
hold credentials. On first run with no `config.json`, the service creates
the working default described in step 6.

`config.json` layout — the top-level keys:

- `model` — service-level, `yolov8n`/`yolov8s`.
- `next_camera_id` — monotonic counter, never reused after a delete.
- `mqtt` — enabled/host/port/username/password/tls/topic_root;
  enabled=false or an empty host means MQTT is not configured and the
  service runs without MQTT reporting.
- `cameras` — list; each entry: id, name, type
  [`picamera`|`rtsp`|`usb`], icon, paused, rotate, resolution,
  sample_interval, imgsz, confidence_threshold, watchlist, publish
  toggles, heartbeat_interval, disappear_confirm_cycles, camera_controls.
  RTSP cameras add an `rtsp` block:
  scheme/host/port/path/stream/transport/connection_mode/timeout_s/
  snapshot_url/tls_allow_self_signed/username/password. USB cameras add a
  `usb` block (device_id/model/pixel_format/fps) plus `usb_controls`
  (auto_exposure/exposure_time_absolute/white_balance_automatic/
  white_balance_temperature).
- `buffer` — dir, cap_bytes, max_files, jpeg_quality.
- `web` — enabled, host, port (default 0.0.0.0:8082).

See `config.json.example` for the full schema. The RTSP URL is built
server-side from the `rtsp` parts at connect time and never stored as a
full URL; camera passwords are never returned by any API and never logged.

Optional helper: if you keep HiveMQ credentials in
`~/Documents/HiveMQ.txt` (lines `TLS MQTT URL:`, `Username:`, `Password:`),
`setup_config.py` pre-seeds a `config.json` from `config.json.example`
with those credentials:

```bash
cd ~/projects/jaeger
./venv/bin/python setup_config.py
# writes config.json with mode 0600
```

Most users skip this — start with the default config and set MQTT up in
the web UI instead (see the MQTT section). Credentials belong in
`config.json` (mode 0600, gitignored) only — never in git.

Upgrading from v0.2.x: on first v0.3.0+ start, `mqtt.topic_root` ending in
`YOLOSensor` is rewritten to `Jaeger` (hard cutover, logged loudly), the
per-camera `model` moves to service level, and `next_camera_id` is derived
from the existing camera ids. The config is re-saved automatically.

### API reference

The web server also exposes a JSON API (same port, JSON unless noted):

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | version, service model, inference saturation, MQTT state (mqtt_configured + mqtt_connected), uptime, last inference, buffer usage |
| `GET /api/cameras` | per-camera config + buffer stats (never includes RTSP passwords) |
| `GET /api/counts?camera=` | current counts for a camera |
| `GET /api/classes?camera=` | COCO class names + watchlist |
| `GET /api/events?camera=&class=&hide_empty=&limit=&before=&after=` | paged events (newest first; `after=` fetches only events newer than a timestamp (incremental refresh); `hide_empty=1` hides all-zero-count events) |
| `GET /api/image?camera=&event=` | event JPEG bytes |
| `GET /api/latest?camera=` | latest frame as base64 JPEG + counts |
| `GET /api/latest_meta?camera=` | latest detections + weak (sub-threshold) detections with confidences |
| `GET /api/config?camera=` | camera config (passwords stripped) |
| `POST /api/config` | `{camera_id, ...keys}` — same keys as MQTT `config/set`; `model` + `buffer_cap_mb` + `mqtt` block are service-level |
| `GET /api/mqtt/settings` | MQTT settings without the password (`enabled, host, port, tls, topic_root, username, has_password`) |
| `POST /api/mqtt/test` | test a broker config without saving (blank password resolves to the stored password) |
| `GET /api/cameras/usb/scan` | USB cameras found on this Pi (uvcvideo capture nodes only, stable by-id, formats) plus configured-but-unplugged USB cameras |
| `POST /api/capture_now` | `{camera_id}` — trigger an immediate cycle |
| `POST /api/cameras/test` | connection test: `{...camera form, camera_id?}` → `{thumbnail_base64, width, height, codec, grab_seconds, source}`; persists nothing |
| `POST /api/cameras` | add a camera (tests the connection before persisting) |
| `PATCH` / `POST /api/cameras/<id>` | edit a camera (connection changes re-test before persisting) |
| `POST /api/cameras/<id>/pause` | pause (disconnects the RTSP stream) |
| `POST /api/cameras/<id>/resume` | resume |
| `DELETE /api/cameras/<id>` | delete (clears retained MQTT topics, keeps buffered images) |
| `POST /api/cameras/rescan` | retry Pi-camera detection at runtime |
| `GET /api/stream` | server-sent events: event/frame/config pushes |

## Performance notes

Inference throughput is the global bottleneck. Measured on the reference
install (Raspberry Pi 4, 8 GB): yolov8n at imgsz 640 takes ~4.6 s for a
cold first inference and ~1 s warmed (yolov8s ~6.7 s cold).

N cameras → per-camera effective interval ≈ max(configured interval,
N × inference_time); two cameras ≈ 2 s effective each, warmed, at
640px nano. The UI's load indicator (saturation = sum of inference_time /
sample_interval over running cameras only; paused and no-backend cameras
are excluded) is the limit signal: above 1.0 the worker cannot keep up,
frames are superseded, and effective intervals grow.

Mitigations:

- Lower `imgsz` (416/320).
- Lengthen sample intervals.
- Nano-only.
- Fewer cameras per Pi.

RTSP H.264 decode costs ~10–20% of one core at 720p (CPU decode);
H.265 costs more — choose H.264 when the camera offers it. There is no
hard camera limit; the stats are the limit.

### Security notes

- The web UI and API have **no auth** (LAN-only by decision). Camera and
  broker passwords flow through it in plaintext HTTP; do not expose it
  beyond a network you trust.
- RTSP cameras, especially old firmware: treat cameras as untrusted —
  isolated LAN segment, changed default credentials, no inbound exposure.
- Concurrent-stream limits: some cameras allow only 1–2 streams.
  Persistent mode holds one; per-capture mode exists for sharing.
- `config.json` holds broker and camera credentials: it is mode 0600 and
  gitignored. Keep it that way; never commit it.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `No cameras available!`, `detected=0` | ArduCam modules need `dtoverlay=imx219` + `camera_auto_detect=0` in `/boot/firmware/config.txt` (not `/boot/config.txt`), then reboot — see the IMX219 example above |
| `torchvision::nms does not exist` | torchvision must be the `+cpu` build from the PyTorch CPU index, matching the `+cpu` torch |
| pip tries to download ~3 GB of torch | default PyPI torch is CUDA-bundled; install torch+torchvision from `https://download.pytorch.org/whl/cpu` first |
| `pip install picamera2` build failure | needs `libcap-dev` (sudo) — use `sudo apt install python3-picamera2` instead |
| `import picamera2` fails in venv | venv needs `--system-site-packages` to see the apt package |
| service exits immediately at startup | a missing `config.json` is not an error (a default is created on first run) — check the log; usual causes are dependencies not installed in the venv, missing model files in `models/`, or (under systemd) unit paths not edited to your install |
| systemd service fails to start | the unit still has the reference install's `User=`, `WorkingDirectory=`, and `ExecStart=` — edit all three to your user and clone path, then `sudo systemctl daemon-reload` and start it again |
| port 8082 already in use | a foreground copy of the service is still running — stop it before starting the systemd service; never run two instances |
| `AttributeError: 'NoneType' ... publish` (old) | fixed: startup baselines now publish from `on_connect` |
| USB camera missing from the Add-camera scan | `v4l2-ctl` not installed — `sudo apt install v4l2-utils`; also confirm the device is a UVC capture device (`v4l2-ctl --list-devices`) |
| RTSP test: `connection refused` | camera not listening on that host/port — check IP, port, and that RTSP is enabled on the camera |
| RTSP test: `could not open the stream` | usually credentials, path, or stream (main/sub) — verify against the camera's own RTSP URL format |
| RTSP test: `timed out waiting for a frame` | stream opened but no keyframe arrived — try the other stream, or a longer timeout |
| RTSP camera stuck `degraded` | capture thread is failing/retrying with backoff; check the log for the (redacted) failure reason |
| Inference load above 1.0 | the worker cannot keep up — lengthen sample intervals, lower `imgsz`, use yolov8n, or drop a camera (see Performance notes) |

## Project layout

```
jaeger/
├── README.md             this file
├── DESIGN.md             plan & design (topic tree, multi-camera design §15)
├── CHANGELOG.md          release history
├── NOTICE                third-party attributions
├── LICENSE               Apache 2.0
├── yolo_sensor.py        the service
├── web_ui.py             Jaeger web UI server (port 8082, stdlib only)
├── static/               web UI files (index.html, app.js, style.css)
├── setup_config.py       optional helper: pre-seeds config.json with HiveMQ
│                         credentials from ~/Documents/HiveMQ.txt (most users
│                         skip it and configure MQTT in the web UI instead)
├── config.json.example   config schema (no secrets)
├── yolo-mqtt.service     systemd unit (edit User/paths before installing)
├── venv/                 python environment (not in git)
├── models/               yolov8n.pt, yolov8s.pt (not in git)
├── buffer/               per-camera ring-buffer JPEGs + JSON sidecars (not in git)
└── setup*.log            install logs (not in git)
```

## License

Apache License 2.0 — see LICENSE. Third-party attributions are in NOTICE.

Jaeger is a Wovyn R&D project, built with Meta Muse.
