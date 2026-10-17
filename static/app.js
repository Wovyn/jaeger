// Jaeger web UI (v0.3.0) — vanilla JS, no frameworks.
(function () {
  "use strict";
  var state = {
    cameras: [],
    selectedCamera: null,
    events: [],
    eventsCursor: null,
    eventsHasMore: true,
    eventsLoading: false,
    classFilter: null,
    cameraFilter: "",
    hideEmpty: true,
    lastStatus: null,
    startedAt: null,
    eventsStale: false,
    stream: null,
    modalIndex: -1,
    editingCameraId: null, // null = add mode
    cameraIcon: "camera",
  };

  // Camera icons: ~8 simple ORIGINAL SVGs, hand-written for Jaeger
  // (generic camera, door, garage, driveway, garden/yard, entrance,
  // room, board/chip for the Pi camera). 24x24, stroke-based.
  var ICONS = {
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="13" rx="2"/><circle cx="12" cy="12.5" r="3"/><path d="M8 6l1.5-2h5L16 6"/></svg>',
    door: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="12" height="18" rx="1"/><circle cx="14.5" cy="12" r="0.8" fill="currentColor" stroke="none"/></svg>',
    garage: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l8-7 8 7"/><rect x="5" y="11" width="14" height="10"/><path d="M8 21v-6h8v6"/><path d="M5 15.5h14"/></svg>',
    driveway: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21L11 3h2l3 18"/><path d="M5 21h14"/><path d="M6.5 15h11"/></svg>',
    garden: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21v-8"/><path d="M12 13c0-4 3-6 6-6 0 4-3 6-6 6z"/><path d="M12 13c0-4-3-6-6-6 0 4 3 6 6 6z"/><path d="M4 21h16"/></svg>',
    entrance: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21V8l6-5 6 5v13"/><path d="M10 21v-6h4v6"/><path d="M3 21h18"/></svg>',
    room: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18"/><path d="M4 12h8"/><path d="M12 12v9"/><circle cx="15.5" cy="16.5" r="0.8" fill="currentColor" stroke="none"/></svg>',
    board: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="1"/><path d="M9 3v4M12 3v4M15 3v4M9 17v4M12 17v4M15 17v4M3 9h4M3 12h4M3 15h4M17 9h4M17 12h4M17 15h4"/></svg>',
  };
  var ICON_LABELS = {
    camera: "Camera", door: "Door", garage: "Garage", driveway: "Driveway",
    garden: "Garden", entrance: "Entrance", room: "Room", board: "Board",
  };
  function iconSVG(key) {
    return ICONS[key] || ICONS.camera;
  }
  function escHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;",
               '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function $(id) { return document.getElementById(id); }
  function fmtLocal(ts) {
    if (!ts) return "—";
    var d = new Date(ts);
    return isNaN(d.getTime()) ? ts : d.toLocaleString();
  }
  function fmtUTC(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    return isNaN(d.getTime()) ? ts : d.toISOString();
  }
  function fmtBytes(n) {
    if (n == null) return "—";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    return (n / 1048576).toFixed(0) + " MB";
  }
  function fmtSecs(v) {
    return v == null ? "—" : v + "s";
  }
  function countsSummary(counts) {
    var parts = [];
    Object.keys(counts || {}).sort().forEach(function (k) {
      if (counts[k] > 0) parts.push(k + ": " + counts[k]);
    });
    return parts.length ? parts.join(", ") : "no object detections";
  }

  function api(path, options) {
    return fetch(path, options).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ("HTTP " + r.status));
        return j;
      });
    });
  }

  // ---- status / cameras / counts ----
  // Human-readable uptime: years (365d) / days / hours / minutes /
  // seconds, zero-valued units omitted, seconds always shown.
  // 45 -> "45s"; 863 -> "14m 23s"; 37338765 -> "1y 67d 3h 52m 45s".
  function fmtDuration(totalSeconds) {
    var s = Math.max(0, Math.floor(totalSeconds));
    var years = Math.floor(s / 31536000); s %= 31536000;
    var days = Math.floor(s / 86400); s %= 86400;
    var hours = Math.floor(s / 3600); s %= 3600;
    var minutes = Math.floor(s / 60); s %= 60;
    var parts = [];
    if (years) parts.push(years + "y");
    if (days) parts.push(days + "d");
    if (hours) parts.push(hours + "h");
    if (minutes) parts.push(minutes + "m");
    parts.push(s + "s");
    return parts.join(" ");
  }

  // Re-render the status line from the last fetched status. Fetch-free,
  // so the 1 s uptime tick below never polls the server. Uptime is
  // recomputed from the service start time, so it keeps ticking.
  function renderStatusLine() {
    var s = state.lastStatus;
    if (!s) return;
    var up = state.startedAt
      ? fmtDuration((Date.now() - new Date(state.startedAt).getTime()) / 1000)
      : Math.round(s.uptime_seconds) + "s";
    $("statusText").textContent =
      "up " + up +
      (s.last_cycle_seconds != null
        ? " · last inference " + s.last_cycle_seconds + "s" : "");
    $("statusText").title = state.startedAt
      ? "Started " + fmtLocal(state.startedAt) : "";
    $("bufferUsage").textContent =
      "Buffer: " + fmtBytes(s.buffer.bytes) + " / " +
      fmtBytes(s.buffer.cap_bytes) + " (" + s.buffer.files + " images)";
    var load = $("loadIndicator");
    if (s.saturation != null) {
      load.textContent = "Inference load: " + s.saturation +
        (s.saturation > 1.0 ? " — saturated, frames are being superseded" : "");
      load.classList.toggle("warn", s.saturation > 1.0);
    }
  }

  function loadStatus() {
    return api("/api/status").then(function (s) {
      state.lastStatus = s;
      state.startedAt = s.started_at || null;
      $("version").textContent = "v" + s.version;
      var dot = $("statusDot");
      dot.className = "dot " + (s.mqtt_connected ? "online" : "offline");
      dot.title = s.mqtt_connected ? "MQTT connected" : "MQTT disconnected";
      renderStatusLine();
    }).catch(function () { /* keep last good state */ });
  }

  function loadCameras() {
    return api("/api/cameras").then(function (r) {
      state.cameras = r.cameras || [];
      if (!state.selectedCamera && state.cameras.length) {
        state.selectedCamera = state.cameras[0].camera_id;
      }
      renderCameras();
      renderCameraFilter();
    });
  }

  function renderCameras() {
    var list = $("cameraList");
    list.innerHTML = "";
    state.cameras.forEach(function (c) {
      var li = document.createElement("li");
      if (c.camera_id === state.selectedCamera) li.className = "selected";
      var status = c.status || "online";
      var row = document.createElement("div");
      row.className = "cam-row";
      var icon = document.createElement("span");
      icon.className = "cam-icon";
      icon.innerHTML = iconSVG(c.icon);
      icon.title = c.icon || "";
      row.appendChild(icon);
      var main = document.createElement("div");
      main.className = "cam-main";
      main.innerHTML =
        "<div><b>" + escHtml(c.name) + "</b> (" + escHtml(c.camera_id) + ")</div>" +
        "<div class='cam-meta'><span class='dot " + escHtml(status) + "'></span>" +
        escHtml(c.type) + " · " + escHtml(c.resolution.join("x")) + " · " +
        escHtml(status) + (c.paused ? " (paused)" : "") +
        "<br>last grab: " + fmtLocal(c.last_grab_at) +
        " (" + fmtSecs(c.last_grab_seconds) + ") · last inference: " +
        fmtLocal(c.last_inference_at) + " (" + fmtSecs(c.last_inference_seconds) + ")" +
        (c.grab_error ? "<br>error: " + escHtml(c.grab_error) : "") +
        "</div>";
      row.appendChild(main);
      var controls = document.createElement("div");
      controls.className = "cam-controls";
      var pauseBtn = document.createElement("button");
      pauseBtn.textContent = c.paused ? "Resume" : "Pause";
      pauseBtn.title = c.paused ? "Resume this camera" : "Pause this camera (disconnects the RTSP stream)";
      pauseBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        api("/api/cameras/" + encodeURIComponent(c.camera_id) +
          (c.paused ? "/resume" : "/pause"),
          { method: "POST" }).then(function () {
            loadCameras(); loadStatus();
          }).catch(function (err) { alert("Failed: " + err.message); });
      });
      controls.appendChild(pauseBtn);
      if (c.type === "rtsp") {
        var editBtn = document.createElement("button");
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          openCameraModal("edit", c);
        });
        controls.appendChild(editBtn);
        var delBtn = document.createElement("button");
        delBtn.textContent = "Delete";
        delBtn.className = "danger";
        delBtn.title = "Delete this camera (buffered images are kept)";
        delBtn.addEventListener("click", function (e) {
          e.stopPropagation();
          if (confirm("Delete camera '" + c.name + "'? Buffered images are kept, but its MQTT topics are cleared.")) {
            api("/api/cameras/" + encodeURIComponent(c.camera_id),
              { method: "DELETE" }).then(function () {
                if (state.selectedCamera === c.camera_id) state.selectedCamera = null;
                loadCameras(); loadStatus(); loadEvents(true);
              }).catch(function (err) { alert("Delete failed: " + err.message); });
          }
        });
        controls.appendChild(delBtn);
      }
      row.appendChild(controls);
      li.appendChild(row);
      li.addEventListener("click", function () {
        state.selectedCamera = c.camera_id;
        renderCameras();
        loadCounts();
        loadLatest();
      });
      list.appendChild(li);
    });
    $("noCamerasEmpty").classList.toggle("hidden", state.cameras.length > 0);
    var hasPi = state.cameras.some(function (c) { return c.type === "picamera"; });
    $("rescanBtn").classList.toggle("hidden", hasPi);
  }

  function renderCameraFilter() {
    var sel = $("cameraFilter");
    var cur = state.cameraFilter;
    sel.innerHTML = "<option value=''>All cameras</option>";
    state.cameras.forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c.camera_id;
      opt.textContent = c.name + " (" + c.camera_id + ")";
      sel.appendChild(opt);
    });
    sel.value = cur;
  }

  function loadCounts() {
    if (!state.selectedCamera) return Promise.resolve();
    return api("/api/counts?camera=" + encodeURIComponent(state.selectedCamera))
      .then(function (r) {
        $("countsCamera").textContent = "— " + r.camera_id;
        var list = $("countsList");
        list.innerHTML = "";
        var shown = 0;
        var showZero = $("zeroToggle").checked;
        Object.keys(r.counts).sort().forEach(function (name) {
          var count = r.counts[name];
          if (count === 0 && !showZero) return;
          var row = document.createElement("li");
          row.className = "count-row";
          row.innerHTML = "<span class='count-name'>" + escHtml(name) +
            "</span><span class='count-value'>" + count + "</span>";
          row.addEventListener("click", function () {
            setClassFilter(name);
          });
          list.appendChild(row);
          shown++;
        });
        $("countsEmpty").classList.toggle("hidden", shown > 0);
      }).catch(function () { /* keep last good state */ });
  }

  function setClassFilter(name) {
    state.classFilter = name;
    $("classFilterChip").classList.remove("hidden");
    $("classFilterName").textContent = name;
    loadEvents(true);
  }
  function clearClassFilter() {
    state.classFilter = null;
    $("classFilterChip").classList.add("hidden");
    loadEvents(true);
  }

  // ---- events ----
  function eventsQuery(reset) {
    var q = "/api/events?limit=25";
    if (state.cameraFilter) q += "&camera=" + encodeURIComponent(state.cameraFilter);
    if (state.classFilter) q += "&class=" + encodeURIComponent(state.classFilter);
    if (state.hideEmpty) q += "&hide_empty=1";
    if (!reset && state.eventsCursor) {
      q += "&before=" + encodeURIComponent(state.eventsCursor);
    }
    return q;
  }

  function loadEvents(reset) {
    if (state.eventsLoading) return Promise.resolve();
    if (!reset && !state.eventsHasMore) return Promise.resolve();
    state.eventsLoading = true;
    if (reset) {
      state.events = [];
      state.eventsCursor = null;
      state.eventsHasMore = true;
      $("eventsList").innerHTML = "";
      $("eventsEnd").classList.add("hidden");
    }
    return api(eventsQuery(reset)).then(function (r) {
      r.events.forEach(function (e) { state.events.push(e); });
      state.eventsHasMore = r.has_more;
      state.eventsCursor = r.next_before;
      renderEvents();
      if (!state.eventsHasMore) $("eventsEnd").classList.remove("hidden");
    }).catch(function (e) {
      console.error("events load failed", e);
    }).then(function () { state.eventsLoading = false; });
  }

  function renderEvents() {
    var list = $("eventsList");
    list.innerHTML = "";
    state.events.forEach(function (e, i) {
      var li = document.createElement("li");
      var timeHtml = "<span class='event-time' title='" + fmtUTC(e.timestamp) +
        "'>" + fmtLocal(e.timestamp) + "</span>";
      li.innerHTML =
        "<div class='event-info'><b>" + escHtml(e.camera_id) + "</b> " + timeHtml +
        "<div class='event-objs'>" + escHtml(countsSummary(e.counts)) + "</div>" +
        (e.has_metadata ? "" : "<div class='event-objs'>no metadata</div>") +
        "</div>" +
        "<img src='" + e.image_url + "' alt='Event image' loading='lazy'>";
      li.addEventListener("click", function () { openModal(i); });
      list.appendChild(li);
    });
  }

  // ---- modal ----
  // Bboxes are normalized 0-1 and the SVG viewBox is "0 0 1 1", so the
  // coordinates are used as-is. Text offsets are viewBox fractions;
  // the text font-size comes from CSS (0.018 user units).
  function renderBboxes() {
    var svg = $("modalSvg");
    svg.innerHTML = "";
    var e = state.events[state.modalIndex];
    if (!e || !e.detections) return;
    Object.keys(e.detections).forEach(function (name) {
      e.detections[name].forEach(function (d) {
        var b = d.bbox || [0, 0, 0, 0];
        var rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", b[0]);
        rect.setAttribute("y", b[1]);
        rect.setAttribute("width", b[2] - b[0]);
        rect.setAttribute("height", b[3] - b[1]);
        svg.appendChild(rect);
        var text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", b[0] + 0.004);
        text.setAttribute("y", Math.min(b[1] + 0.028, 0.985));
        text.textContent = name + " " + d.confidence;
        svg.appendChild(text);
      });
    });
  }

  function openModal(i) {
    state.modalIndex = i;
    var e = state.events[i];
    if (!e) return;
    var img = $("modalImg");
    img.onload = function () { renderBboxes(); };
    img.src = e.image_url;
    $("modalSvg").style.display = $("bboxToggle").checked ? "" : "none";
    $("modalCaption").textContent =
      e.camera_id + " · " + fmtLocal(e.timestamp) + " · " + countsSummary(e.counts);
    $("modal").classList.remove("hidden");
  }
  function closeModal() {
    $("modal").classList.add("hidden");
    state.modalIndex = -1;
    if (state.eventsStale) {
      state.eventsStale = false;
      loadEvents(true);
    }
  }
  function modalStep(d) {
    var n = state.modalIndex + d;
    if (n >= 0 && n < state.events.length) openModal(n);
  }

  // ---- latest frame ----
  function loadLatest() {
    if (!state.selectedCamera) return Promise.resolve();
    return api("/api/latest?camera=" + encodeURIComponent(state.selectedCamera))
      .then(function (r) {
        $("latestImg").src = "data:image/jpeg;base64," + r.jpeg_base64;
        $("latestMeta").textContent =
          fmtLocal(r.timestamp) + " · " + countsSummary(r.counts);
      }).catch(function () { /* no frame yet */ });
  }

  // ---- camera add/edit modal ----
  function buildIconPicker() {
    var box = $("iconPicker");
    box.innerHTML = "";
    Object.keys(ICONS).forEach(function (key) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.icon = key;
      btn.title = ICON_LABELS[key] || key;
      btn.innerHTML = iconSVG(key) +
        "<span class='icon-label'>" + escHtml(ICON_LABELS[key] || key) + "</span>";
      if (key === state.cameraIcon) btn.classList.add("selected");
      btn.addEventListener("click", function () {
        state.cameraIcon = key;
        box.querySelectorAll("button").forEach(function (b) {
          b.classList.toggle("selected", b.dataset.icon === key);
        });
      });
      box.appendChild(btn);
    });
  }

  function cameraFormValues() {
    var form = $("cameraForm");
    return {
      name: form.name.value,
      icon: state.cameraIcon,
      scheme: form.scheme.value,
      host: form.host.value,
      port: parseInt(form.port.value, 10),
      path: form.path.value,
      stream: form.stream.value,
      transport: form.transport.value,
      connection_mode: form.connection_mode.value,
      timeout_s: parseInt(form.timeout_s.value, 10),
      credentials_on: form.credentials_on.checked,
      username: form.username.value,
      password: form.password.value,
      tls_allow_self_signed: form.tls_allow_self_signed.checked,
      sample_interval: parseFloat(form.sample_interval.value),
      snapshot_url: form.snapshot_url.value,
      rotate: parseInt(form.rotate.value, 10),
      start_paused: form.start_paused.checked,
    };
  }

  function openCameraModal(mode, cam) {
    var form = $("cameraForm");
    state.editingCameraId = mode === "edit" && cam ? cam.camera_id : null;
    state.cameraIcon = (mode === "edit" && cam && cam.icon) ? cam.icon : "camera";
    buildIconPicker();
    $("cameraTestResult").classList.add("hidden");
    $("cameraError").textContent = "";
    if (mode === "edit" && cam) {
      $("cameraModalTitle").textContent = "Edit camera — " + cam.name;
      $("cameraSaveBtn").textContent = "Save";
      form.name.value = cam.name || "";
      var rtsp = cam.rtsp || {};
      form.scheme.value = rtsp.scheme || "rtsp";
      form.host.value = rtsp.host || "";
      form.port.value = rtsp.port != null ? rtsp.port : 554;
      form.path.value = rtsp.path || "/";
      form.stream.value = rtsp.stream || "main";
      form.transport.value = rtsp.transport || "tcp";
      form.connection_mode.value = rtsp.connection_mode || "persistent";
      form.timeout_s.value = rtsp.timeout_s != null ? rtsp.timeout_s : 10;
      form.credentials_on.checked = !!(rtsp.username || rtsp.has_password);
      form.username.value = rtsp.username || "";
      form.password.value = ""; // never prefilled; blank keeps stored
      form.tls_allow_self_signed.checked = !!rtsp.tls_allow_self_signed;
      form.sample_interval.value = cam.sample_interval != null ? cam.sample_interval : 5;
      form.snapshot_url.value = rtsp.snapshot_url || "";
      form.rotate.value = cam.rotate != null ? cam.rotate : 0;
      form.start_paused.checked = !!cam.paused;
    } else {
      $("cameraModalTitle").textContent = "Add camera";
      $("cameraSaveBtn").textContent = "Add";
      form.reset();
      form.port.value = 554;
      form.timeout_s.value = 10;
      form.sample_interval.value = 5;
      form.rotate.value = 0;
    }
    updateCameraFormToggles();
    $("cameraModal").classList.remove("hidden");
  }

  function updateCameraFormToggles() {
    var form = $("cameraForm");
    var creds = form.credentials_on.checked;
    form.username.disabled = !creds;
    form.password.disabled = !creds;
    $("selfSignedRow").classList.toggle("hidden", form.scheme.value !== "rtsps");
  }

  function closeCameraModal() {
    $("cameraModal").classList.add("hidden");
    state.editingCameraId = null;
  }

  function testCameraConnection() {
    var body = cameraFormValues();
    if (state.editingCameraId) body.camera_id = state.editingCameraId;
    $("cameraError").textContent = "";
    $("cameraTestBtn").disabled = true;
    return api("/api/cameras/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      $("cameraTestThumb").src = "data:image/jpeg;base64," + r.thumbnail_base64;
      $("cameraTestMeta").textContent =
        r.width + "x" + r.height + " · " + r.codec + " · " + r.source +
        " · grab " + r.grab_seconds + "s";
      $("cameraTestResult").classList.remove("hidden");
    }).catch(function (e) {
      $("cameraError").textContent = "Test failed: " + e.message;
      $("cameraTestResult").classList.add("hidden");
    }).then(function () { $("cameraTestBtn").disabled = false; });
  }

  function submitCameraForm(ev) {
    ev.preventDefault();
    var body = cameraFormValues();
    $("cameraError").textContent = "";
    $("cameraSaveBtn").disabled = true;
    var req;
    if (state.editingCameraId) {
      req = api("/api/cameras/" + encodeURIComponent(state.editingCameraId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } else {
      req = api("/api/cameras", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }
    req.then(function () {
      closeCameraModal();
      loadCameras();
      loadStatus();
    }).catch(function (e) {
      $("cameraError").textContent = "Save failed: " + e.message;
    }).then(function () { $("cameraSaveBtn").disabled = false; });
  }

  // ---- menu / settings / about ----
  function openSettings() {
    if (!state.selectedCamera) return;
    var camId = state.selectedCamera;
    $("settingsCamera").textContent = camId;
    $("settingsError").textContent = "";
    Promise.all([
      api("/api/classes?camera=" + encodeURIComponent(camId)),
      api("/api/config?camera=" + encodeURIComponent(camId)),
      api("/api/status"),
    ]).then(function (res) {
      var classes = res[0], cfg = res[1], status = res[2];
      var form = $("settingsForm");
      form.sample_interval.value = cfg.sample_interval;
      form.confidence_threshold.value = cfg.confidence_threshold;
      form.model.value = status.model || "yolov8n";
      form.imgsz.value = cfg.imgsz || 640;
      form.buffer_cap_mb.value = Math.round(
        (cfg.buffer.cap_bytes || 1073741824) / 1048576);
      form.heartbeat_interval.value = cfg.heartbeat_interval;
      form.publish_classId.checked = cfg.publish.classId !== false;
      form.publish_className.checked = cfg.publish.className !== false;
      form.publish_events.checked = cfg.publish.events !== false;
      var box = $("watchlistBox");
      box.innerHTML = "";
      classes.classes.forEach(function (name) {
        var label = document.createElement("label");
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.name = "watchlist";
        cb.value = name;
        cb.checked = (cfg.watchlist || []).indexOf(name) !== -1;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(" " + name));
        box.appendChild(label);
      });
      var cc = cfg.camera_controls || {};
      form.cc_exposure_value.value = cc.exposure_value != null ? cc.exposure_value : "";
      form.cc_ae_exposure_mode.value = cc.ae_exposure_mode || "";
      form.cc_exposure_time.value = cc.exposure_time != null ? cc.exposure_time : "";
      form.cc_analogue_gain.value = cc.analogue_gain != null ? cc.analogue_gain : "";
      form.cc_ae_enable.checked = cc.ae_enable !== false;
      form.cc_awb_enable.checked = cc.awb_enable !== false;
      $("settingsModal").classList.remove("hidden");
    }).catch(function (e) {
      $("settingsError").textContent = "Failed to load settings: " + e.message;
      $("settingsModal").classList.remove("hidden");
    });
  }

  function submitSettings(ev) {
    ev.preventDefault();
    var form = $("settingsForm");
    var watchlist = [];
    form.querySelectorAll("input[name='watchlist']:checked").forEach(
      function (cb) { watchlist.push(cb.value); });
    var cc = {};
    if (form.cc_exposure_value.value !== "") {
      cc.exposure_value = parseFloat(form.cc_exposure_value.value);
    }
    if (form.cc_ae_exposure_mode.value !== "") {
      cc.ae_exposure_mode = form.cc_ae_exposure_mode.value;
    }
    if (form.cc_exposure_time.value !== "") {
      cc.exposure_time = parseInt(form.cc_exposure_time.value, 10);
    }
    if (form.cc_analogue_gain.value !== "") {
      cc.analogue_gain = parseFloat(form.cc_analogue_gain.value);
    }
    cc.ae_enable = form.cc_ae_enable.checked;
    cc.awb_enable = form.cc_awb_enable.checked;
    var cmd = {
      camera_id: state.selectedCamera,
      sample_interval: parseFloat(form.sample_interval.value),
      confidence_threshold: parseFloat(form.confidence_threshold.value),
      model: form.model.value,
      imgsz: parseInt(form.imgsz.value, 10),
      buffer_cap_mb: parseInt(form.buffer_cap_mb.value, 10),
      heartbeat_interval: parseInt(form.heartbeat_interval.value, 10),
      publish: {
        classId: form.publish_classId.checked,
        className: form.publish_className.checked,
        events: form.publish_events.checked,
      },
      watchlist: watchlist,
      camera_controls: cc,
    };
    $("settingsError").textContent = "";
    api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    }).then(function () {
      $("settingsModal").classList.add("hidden");
      loadCameras();
      loadCounts();
      loadStatus();
    }).catch(function (e) {
      $("settingsError").textContent = "Save failed: " + e.message;
    });
  }

  function init() {
    $("menuBtn").addEventListener("click", function (e) {
      e.stopPropagation();
      $("menu").classList.toggle("hidden");
    });
    document.addEventListener("click", function (e) {
      if (!$("menu").classList.contains("hidden") &&
          !$("menu").contains(e.target) && e.target.id !== "menuBtn") {
        $("menu").classList.add("hidden");
      }
    });
    $("menuSettings").addEventListener("click", function () {
      $("menu").classList.add("hidden");
      openSettings();
    });
    $("menuAbout").addEventListener("click", function () {
      $("menu").classList.add("hidden");
      $("aboutModal").classList.remove("hidden");
    });
    $("aboutClose").addEventListener("click", function () {
      $("aboutModal").classList.add("hidden");
    });
    $("settingsClose").addEventListener("click", function () {
      $("settingsModal").classList.add("hidden");
    });
    $("settingsForm").addEventListener("submit", submitSettings);
    $("zeroToggle").addEventListener("change", loadCounts);
    $("hideEmptyToggle").addEventListener("change", function () {
      state.hideEmpty = $("hideEmptyToggle").checked;
      loadEvents(true);
    });
    $("captureNowBtn").addEventListener("click", function () {
      if (!state.selectedCamera) return;
      api("/api/capture_now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ camera_id: state.selectedCamera }),
      }).catch(function (e) { console.error(e); });
    });
    $("cameraFilter").addEventListener("change", function () {
      state.cameraFilter = $("cameraFilter").value;
      loadEvents(true);
    });
    $("clearClassFilter").addEventListener("click", clearClassFilter);
    $("refreshEventsBtn").addEventListener("click", function () {
      loadEvents(true);
    });
    $("modalClose").addEventListener("click", closeModal);
    $("modalPrev").addEventListener("click", function () { modalStep(-1); });
    $("modalNext").addEventListener("click", function () { modalStep(1); });
    $("bboxToggle").addEventListener("change", function () {
      $("modalSvg").style.display = $("bboxToggle").checked ? "" : "none";
    });
    // Camera add/edit modal
    $("addCameraBtn").addEventListener("click", function () {
      openCameraModal("add", null);
    });
    $("cameraClose").addEventListener("click", closeCameraModal);
    $("cameraCancelBtn").addEventListener("click", closeCameraModal);
    $("cameraForm").addEventListener("submit", submitCameraForm);
    $("cameraTestBtn").addEventListener("click", testCameraConnection);
    $("cameraForm").credentials_on.addEventListener("change", updateCameraFormToggles);
    $("cameraForm").scheme.addEventListener("change", updateCameraFormToggles);
    $("rescanBtn").addEventListener("click", function () {
      api("/api/cameras/rescan", { method: "POST" }).then(function () {
        loadCameras(); loadStatus();
      }).catch(function (e) { alert("Rescan failed: " + e.message); });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closeModal();
        closeCameraModal();
        $("settingsModal").classList.add("hidden");
        $("aboutModal").classList.add("hidden");
      } else if (!$("modal").classList.contains("hidden")) {
        if (e.key === "ArrowLeft") modalStep(-1);
        if (e.key === "ArrowRight") modalStep(1);
      }
    });
    var observer = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) loadEvents(false);
    }, { rootMargin: "400px" });
    observer.observe($("scrollSentinel"));

    loadStatus();
    loadCameras().then(function () {
      loadCounts();
      loadLatest();
    });
    loadEvents(true);
    startStream();
    // Uptime tick only: re-renders from the last fetched status, no fetch.
    setInterval(renderStatusLine, 1000);
  }

  // Live updates via server-sent events (no polling). The server pushes
  // on every new event, every new capture, and every config change.
  function startStream() {
    var es = new EventSource("/api/stream");
    state.stream = es;
    es.onopen = function () {
      loadStatus();
      loadCameras();
      loadCounts();
      loadEvents(true);
      loadLatest();
    };
    es.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === "event") {
        // Don't yank the list out from under an open image modal;
        // refresh once the modal closes instead.
        if ($("modal").classList.contains("hidden")) {
          loadEvents(true);
        } else {
          state.eventsStale = true;
        }
        loadCounts();
        loadStatus();
      } else if (msg.type === "frame") {
        loadLatest();
        loadCameras();
      } else if (msg.type === "config") {
        loadCameras();
        loadCounts();
        loadStatus();
      }
      // "hello" needs nothing: onopen already resynced.
    };
    es.onerror = function () { /* EventSource auto-reconnects; onopen resyncs */ };
  }

  document.addEventListener("DOMContentLoaded", init);
})();
