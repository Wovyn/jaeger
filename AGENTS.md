# Installing Jaeger — instructions for AI agents

This file is the authoritative install procedure for automated installers.
README.md has the human-oriented detail behind every step; if the two
disagree on a command, follow this file and flag it.

## Ground rules

- Work through the steps in order. Run each step's verification before continuing; if a verification fails, stop and use the failure table.
- Steps that need sudo are marked [sudo]. No other step needs it, and the service itself runs unprivileged.
- Never run two Jaeger instances at once: they conflict on port 8082, the cameras, and the MQTT connection. Before starting any instance, confirm no other copy is running.
- Do NOT hand-edit config.json to set up MQTT. MQTT is configured after the install, via the web UI (README.md, "MQTT (optional)") or the API. The base install finishes with MQTT unconfigured, on purpose.
- Never write credentials into git-tracked files.
- config.json is mode 0600 and will contain secrets once MQTT is set up. Do not print its contents into logs or chat — report only whether it exists and its file mode.

## Done criteria (the target state)

The base install is complete when ALL of these hold:

1. The virtualenv exists at ~/projects/jaeger/venv and the dependencies import cleanly (step 4 verification).
2. Both model files are present in ~/projects/jaeger/models/ (step 5).
3. The service answers GET http://127.0.0.1:8082/api/status with "version": "0.4.0" and "mqtt_configured": false.
4. The web UI loads at http://<pi-address>:8082 showing zero cameras ("No cameras configured"). Zero cameras is SUCCESS: camera setup is a separate post-install task (README.md, "Setting up cameras").
5. If step 7 (systemd) was run: systemctl is-enabled yolo-mqtt prints "enabled" and systemctl is-active yolo-mqtt prints "active".

## Step 1 — Clone the repository

```bash
mkdir -p ~/projects
git clone https://github.com/Wovyn/jaeger.git ~/projects/jaeger
cd ~/projects/jaeger
```

Verify: ~/projects/jaeger contains yolo_sensor.py, web_ui.py, static/,
config.json.example, and yolo-mqtt.service. This file assumes the clone
is at ~/projects/jaeger; if it is elsewhere, adjust every path.

## Step 2 — System packages [sudo]

```bash
sudo apt update
sudo apt install -y python3-picamera2 v4l2-utils rpicam-apps
```

- python3-picamera2: the Pi CSI camera library. Install it ONLY this way
  — `pip install picamera2` is broken (its python-prctl dependency needs
  libcap headers and fails without sudo).
- v4l2-utils: provides v4l2-ctl, required for USB camera scanning and
  UVC controls.
- rpicam-apps: provides rpicam-hello / rpicam-still for verifying a Pi
  CSI camera later.

Verify: `python3 -c "import picamera2"` runs without an ImportError at
system level, and `v4l2-ctl --version` prints a version.

## Step 3 — Python virtual environment

The --system-site-packages flag is REQUIRED: without it the venv cannot
see the apt-installed picamera2 package.

```bash
python3 -m venv --system-site-packages ~/projects/jaeger/venv
~/projects/jaeger/venv/bin/pip install --upgrade pip
```

Verify: `~/projects/jaeger/venv/bin/python -c "import picamera2;
print('ok')"` prints ok.

## Step 4 — Python dependencies (order matters)

Install torch and torchvision FIRST, from the PyTorch CPU index. The
default PyPI torch is the CUDA build (~3 GB of NVIDIA packages) and is
wrong for a Pi.

```bash
V=~/projects/jaeger/venv/bin
$V/pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
$V/pip install ultralytics paho-mqtt
```

(opencv-python arrives as an ultralytics dependency.)

Verify:

```bash
$V/python -c "import torch, ultralytics, paho.mqtt; print(torch.__version__)"
```

The printed torch version MUST end in "+cpu" (e.g. 2.14.1+cpu). If it
does not, the wrong index was used — see the failure table.

## Step 5 — Download the YOLO models

```bash
mkdir -p ~/projects/jaeger/models && cd ~/projects/jaeger/models
~/projects/jaeger/venv/bin/python -c \
  "from ultralytics import YOLO; YOLO('yolov8n.pt'); YOLO('yolov8s.pt')"
ls -la
```

Verify: models/yolov8n.pt (~6.2 MB) and models/yolov8s.pt (~21.5 MB)
both exist and are non-trivial in size.

## Step 6 — First run

```bash
cd ~/projects/jaeger && ./venv/bin/python -u yolo_sensor.py
```

Expect this on first run: there is no config.json, so the service
CREATES a working default config (mode 0600: MQTT disabled, zero
cameras, yolov8n, web UI on 0.0.0.0:8082) and prints that it created
one. This is normal — do not create or edit config.json yourself.

Verify (from another shell, while it runs):

```bash
curl http://127.0.0.1:8082/api/status
```

The JSON must contain "version": "0.4.0" and "mqtt_configured": false.
Then stop the foreground service with Ctrl-C (SIGTERM is fine — shutdown
takes a couple of seconds).

## Step 7 — Run as a service (systemd) [sudo]

FIRST edit yolo-mqtt.service in the clone: it ships with the reference
install's values. Replace all three of these lines with the installing
user's name and the actual clone path:

```
User=<your-user>
WorkingDirectory=/home/<your-user>/projects/jaeger
ExecStart=/home/<your-user>/projects/jaeger/venv/bin/python -u yolo_sensor.py
```

Confirm no foreground instance is still running (step 6 was stopped).
Then:

```bash
sudo cp yolo-mqtt.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now yolo-mqtt.service
```

Verify: `systemctl is-enabled yolo-mqtt` prints enabled and
`systemctl is-active yolo-mqtt` prints active; `curl
http://127.0.0.1:8082/api/status` answers as in step 6; and
`journalctl -u yolo-mqtt -n 50` shows a clean startup.

## Failure table

| Symptom | Cause / fix |
|---|---|
| pip tries to download ~3 GB of torch | Wrong index: the default PyPI torch is CUDA-bundled. Redo step 4 with the PyTorch CPU index URL. |
| `RuntimeError: operator torchvision::nms does not exist` | torchvision is not the +cpu build. Reinstall torch + torchvision from the CPU index (step 4). |
| `import picamera2` fails inside the venv | The venv lacks --system-site-packages. Recreate it exactly as in step 3 and repeat step 4. |
| systemd service fails to start | The unit still has the reference install's User= / WorkingDirectory= / ExecStart=. Edit all three (step 7), daemon-reload, start again. |
| Port 8082 already in use | A foreground copy of the service is still running. Stop it before starting another instance. |

## Report back

Report to the human: the version and mqtt_configured fields from
/api/status, and whether the systemd unit is enabled and active. Do not
proceed to camera or MQTT setup unless the human asks — the base install
ends at the done criteria above.
