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

  function grabSplit(c) {
    if (c.last_grab_open_seconds == null || c.last_grab_wait_seconds == null) return "";
    return " open " + fmtSecs(c.last_grab_open_seconds) +
      " + keyframe " + fmtSecs(c.last_grab_wait_seconds);
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
        " (" + fmtSecs(c.last_grab_seconds) + grabSplit(c) + ") · last inference: " +
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
      var editBtn = document.createElement("button");
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        // Edit opens the modal matching the camera type; Delete stays
        // RTSP-only (the Pi camera cannot be deleted).
        if (c.type === "rtsp") openRtspModal("edit", c);
        else openPiModal(c);
      });
      controls.appendChild(editBtn);
      if (c.type === "rtsp") {
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
  function eventsQuery(reset, after) {
    var q = "/api/events?limit=25";
    if (state.cameraFilter) q += "&camera=" + encodeURIComponent(state.cameraFilter);
    if (state.classFilter) q += "&class=" + encodeURIComponent(state.classFilter);
    if (state.hideEmpty) q += "&hide_empty=1";
    if (after) {
      q += "&after=" + encodeURIComponent(after);
    } else if (!reset && state.eventsCursor) {
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

  function loadNewEvents() {
    if (state.eventsLoading) return Promise.resolve();
    if (!state.events.length) return loadEvents(true);
    state.eventsLoading = true;
    var newest = state.events[0].event_id;
    return api(eventsQuery(false, newest)).then(function (r) {
      var fresh = (r.events || []).filter(function (e) {
        return !state.events.some(function (old) {
          return old.event_id === e.event_id;
        });
      });
      var list = $("eventsList");
      for (var k = fresh.length - 1; k >= 0; k--) {
        state.events.unshift(fresh[k]);
        list.insertBefore(eventRow(fresh[k]), list.firstChild);
      }
    }).catch(function (e) {
      console.error("events load failed", e);
    }).then(function () { state.eventsLoading = false; });
  }

  function eventRow(e) {
    var li = document.createElement("li");
    var timeHtml = "<span class=\"event-time\" title=\"" + fmtUTC(e.timestamp) +
      "\">" + fmtLocal(e.timestamp) + "</span>";
    li.innerHTML =
      "<div class=\"event-info\"><b>" + escHtml(e.camera_id) + "</b> " + timeHtml +
      "<div class=\"event-objs\">" + escHtml(countsSummary(e.counts)) + "</div>" +
      (e.has_metadata ? "" : "<div class=\"event-objs\">no metadata</div>") +
      "</div>" +
      "<img src=\"" + e.image_url + "\" alt=\"Event image\" loading=\"lazy\">";
    li.addEventListener("click", function () {
      var idx = state.events.findIndex(function (ev) {
        return ev.event_id === e.event_id;
      });
      if (idx >= 0) openModal(idx);
    });
    return li;
  }

  function renderEvents() {
    var list = $("eventsList");
    list.innerHTML = "";
    state.events.forEach(function (e) {
      list.appendChild(eventRow(e));
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

  function sanitizeFilename(s) {
    var t = String(s == null ? "" : s);
    var bad = "<>:\"/|?*" + String.fromCharCode(92);
    var out = "";
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      out += (bad.indexOf(ch) >= 0 || ch < " ") ? "-" : ch;
    }
    out = out.replace(/-+/g, "-").replace(/^[-. ]+|[-. ]+$/g, "");
    return out || "camera";
  }
  function fmtFileTs(iso) {
    var d = new Date(iso);
    function p2(n) { n = String(n); return n.length < 2 ? "0" + n : n; }
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + "-" + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds());
  }
  function cameraName(cid) {
    for (var i = 0; i < state.cameras.length; i++) {
      if (state.cameras[i].camera_id === cid) return state.cameras[i].name || cid;
    }
    return cid;
  }
  function downloadModalImage() {
    var e = state.events[state.modalIndex];
    if (!e || !e.image_url) return;
    var a = document.createElement("a");
    a.href = e.image_url;
    a.download = sanitizeFilename(cameraName(e.camera_id)) + "-" + fmtFileTs(e.timestamp) + ".jpg";
    document.body.appendChild(a);
    a.click();
    a.remove();
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
      loadNewEvents();
    }
  }
  function modalStep(d) {
    var n = state.modalIndex + d;
    if (n >= 0 && n < state.events.length) openModal(n);
  }

  // ---- latest frame ----
  function loadLatest() {
    if (!state.selectedCamera) return Promise.resolve();
    loadLatestDets();
    return api("/api/latest?camera=" + encodeURIComponent(state.selectedCamera))
      .then(function (r) {
        $("latestImg").src = "data:image/jpeg;base64," + r.jpeg_base64;
        $("latestMeta").textContent =
          fmtLocal(r.timestamp) + " · " + countsSummary(r.counts);
      }).catch(function () { /* no frame yet */ });
  }
  // Weak (sub-threshold) detections are a Latest Frame diagnostic only:
  // text list, no bbox overlay. Confirmed entries render in normal text,
  // weak entries are muted with a "(weak)" marker.
  function loadLatestDets() {
    if (!state.selectedCamera) return;
    api("/api/latest_meta?camera=" + encodeURIComponent(state.selectedCamera))
      .then(renderLatestDets)
      .catch(function () { /* no frame yet */ });
  }
  function renderLatestDets(m) {
    var el = $("latestDets");
    var items = [];
    Object.keys(m.detections || {}).forEach(function (cls) {
      (m.detections[cls] || []).forEach(function (d) {
        items.push({ label: cls + " " + d.confidence.toFixed(2), weak: false });
      });
    });
    (m.weak_detections || []).forEach(function (w) {
      items.push({ label: w.class + " " + w.confidence.toFixed(2) + " (weak)", weak: true });
    });
    el.innerHTML = "";
    if (!items.length) {
      var s = document.createElement("span");
      s.className = "counts-empty";
      s.textContent = "No object detections";
      el.appendChild(s);
      return;
    }
    items.forEach(function (it) {
      var s = document.createElement("span");
      if (it.weak) s.className = "dim";
      s.textContent = it.label;
      el.appendChild(s);
      el.appendChild(document.createTextNode("  "));
    });
  }


  // ---- shared Detection tab ----
  // ONE instance, built once and moved between the camera modals
  // (appendChild moves the node), so there is a single builder, a
  // single collect/validate path, and no duplicate element IDs.
  var DET_GROUPS = [
    ["People", ["person"]],
    ["Vehicles", ["bicycle", "car", "motorcycle", "bus", "truck", "train", "boat", "airplane"]],
    ["Animals", ["cat", "dog", "bird", "horse", "sheep", "cow", "bear", "elephant", "zebra", "giraffe"]],
    ["Street", ["traffic light", "stop sign", "fire hydrant", "parking meter", "bench"]],
    ["Carried", ["backpack", "handbag", "suitcase", "umbrella", "tie"]],
    ["Sports", ["sports ball", "frisbee", "kite", "skateboard", "surfboard", "skis", "snowboard", "baseball bat", "baseball glove", "tennis racket"]],
    ["Electronics", ["cell phone", "laptop", "tv", "keyboard", "mouse", "remote"]],
    ["Furniture", ["chair", "couch", "bed", "dining table", "toilet", "potted plant"]],
    ["Appliances", ["refrigerator", "microwave", "oven", "toaster", "sink"]],
    ["Kitchen", ["bottle", "cup", "wine glass", "bowl", "fork", "knife", "spoon"]],
    ["Food", ["apple", "banana", "orange", "broccoli", "carrot", "sandwich", "hot dog", "pizza", "donut", "cake"]],
    ["Household", ["book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"]]
  ];
  // Mirrors the server DEFAULT_WATCHLIST (yolo_sensor.py): the Add
  // flow starts with the service default, never an empty watchlist.
  var DET_DEFAULT_WATCHLIST = ["person", "car", "truck", "bus",
    "dog", "cat", "bicycle", "motorcycle"];
  var DET_IMG_SIZES = [320, 480, 640, 960, 1280];
  var detNode = null;
  var detState = { sel: {}, q: "", selOnly: false, classes: [] };

  // Extra state for the tabbed camera modals + Pi preview.
  state.camModal = null; // "rtsp" | "pi" | null — which camera modal is open
  state.camTab = "main"; // "main" | "detection" — active tab of the open modal
  state.piExpMode = "auto"; // "auto" | "manual"
  state.svcBufferBytes = 0;
  state.piPreviewTs = null;
  state.piPreviewSeq = 0;

  function buildDetectionPanel() {
    var root = document.createElement("div");
    root.id = "detPanel";
    root.className = "det-grid";
    root.innerHTML =
      '<div class="det-left">' +
      '<section class="det-card"><h3>Detection</h3>' +
      '<div class="det-row">' +
      '<label class="det-field det-narrow">Sample every' +
      '<span class="suffix-input"><input type="number" id="detSample" value="5" step="0.1" min="0.5"><span>sec</span></span></label>' +
      '<label class="det-field det-grow">Confidence threshold' +
      '<span class="slider-row"><input type="range" id="detConf" min="0" max="1" step="0.05" value="0.5"><span class="readout" id="detConfOut">0.50</span></span></label>' +
      '</div>' +
      '<div class="det-row">' +
      '<label class="det-field det-narrow">Image size' +
      '<select id="detImgsz"><option value="320">320</option><option value="480">480</option><option value="640">640</option><option value="960">960</option><option value="1280">1280</option></select></label>' +
      '<label class="det-field det-narrow">Heartbeat' +
      '<span class="suffix-input"><input type="number" id="detHeartbeat" value="600" step="1" min="30"><span>sec</span></span></label>' +
      '</div>' +
      '<div class="det-row">' +
      '<label class="det-field det-narrow">Confirm absent (cycles)' +
      '<input type="number" id="detDisappear" value="4" step="1" min="2" max="20"></label>' +
      '</div>' +
      '<p class="hint">Image size is the inference resolution. Larger finds smaller objects but runs slower.</p>' +
      '<p class="hint">Confirm absent: a disappearance (count dropping to zero) is published only after this many consecutive empty cycles. Default 4.</p>' +
      '</section>' +
      '<section class="det-card"><h3>Publish</h3>' +
      '<div class="det-publish">' +
      '<label><input type="checkbox" id="detPubClassId"> classId <span class="dim">topics</span></label>' +
      '<label><input type="checkbox" id="detPubClassName"> className <span class="dim">topics</span></label>' +
      '<label><input type="checkbox" id="detPubEvents"> events <span class="dim">topic</span></label>' +
      '</div></section>' +
      '<div class="det-note">Using <b id="detModelName">yolov8n</b>. The model and image history limit apply to all cameras. Change them in <a href="#" id="detSvcLink">Service settings</a>.</div>' +
      '</div>' +
      '<section class="det-card det-watch">' +
      '<div class="det-watch-head"><h3>Watchlist</h3>' +
      '<div class="det-watch-count"><span id="detWatchCount">0 of 0 selected</span> <button type="button" id="detWatchClear">Clear</button></div></div>' +
      '<div class="det-watch-tools"><span class="det-search"><input id="detWatchFilter" placeholder="Filter classes&hellip;"></span>' +
      '<label><input type="checkbox" id="detWatchSelOnly">Selected only</label></div>' +
      '<div id="detWatchGroups" class="det-watch-groups"></div>' +
      '</section>';
    root.querySelector("#detConf").addEventListener("input", function () {
      root.querySelector("#detConfOut").textContent =
        parseFloat(this.value).toFixed(2);
    });
    root.querySelector("#detWatchFilter").addEventListener("input", function () {
      detState.q = this.value;
      renderDetWatch();
    });
    root.querySelector("#detWatchSelOnly").addEventListener("change", function () {
      detState.selOnly = this.checked;
      renderDetWatch();
    });
    root.querySelector("#detWatchClear").addEventListener("click", function () {
      detState.sel = {};
      renderDetWatch();
    });
    root.querySelector("#detSvcLink").addEventListener("click", function (e) {
      e.preventDefault();
      openServiceSettings();
    });
    return root;
  }

  function detGroups() {
    // Designer groups + an "Other" bucket for any live class the
    // mapping does not cover (keeps every class reachable).
    var groups = DET_GROUPS.map(function (g) {
      return { name: g[0], classes: g[1].slice() };
    });
    var mapped = {};
    DET_GROUPS.forEach(function (g) {
      g[1].forEach(function (n) { mapped[n] = true; });
    });
    var other = detState.classes.filter(function (n) { return !mapped[n]; });
    if (other.length) groups.push({ name: "Other", classes: other });
    return groups;
  }

  function renderDetWatch() {
    var box = $("detWatchGroups");
    if (!box) return;
    box.innerHTML = "";
    var q = detState.q.trim().toLowerCase();
    var total = detState.classes.length;
    var selCount = 0;
    detState.classes.forEach(function (n) { if (detState.sel[n]) selCount++; });
    $("detWatchCount").textContent = selCount + " of " + total + " selected";
    var filter = $("detWatchFilter");
    filter.placeholder = total ? ("Filter " + total + " classes\u2026") : "Filter classes\u2026";
    var any = false;
    detGroups().forEach(function (g) {
      var on = g.classes.filter(function (n) { return detState.sel[n]; }).length;
      var items = g.classes.filter(function (n) {
        if (q && n.indexOf(q) === -1 && g.name.toLowerCase().indexOf(q) === -1) return false;
        if (detState.selOnly && !detState.sel[n]) return false;
        return true;
      });
      if (!items.length) return;
      any = true;
      var row = document.createElement("div");
      row.className = "det-group-row";
      var head = document.createElement("div");
      head.className = "det-group-head";
      head.innerHTML = "<span class=\"det-group-name\">" + escHtml(g.name) +
        "</span><span class=\"det-group-count\">" + on + " / " + g.classes.length + "</span>";
      row.appendChild(head);
      var chips = document.createElement("div");
      chips.className = "det-chips";
      items.forEach(function (n) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "det-chip" + (detState.sel[n] ? " selected" : "");
        chip.setAttribute("aria-pressed", detState.sel[n] ? "true" : "false");
        chip.textContent = (detState.sel[n] ? "\u2713 " : "") + n;
        chip.addEventListener("click", function () {
          if (detState.sel[n]) delete detState.sel[n]; else detState.sel[n] = true;
          renderDetWatch();
        });
        chips.appendChild(chip);
      });
      row.appendChild(chips);
      box.appendChild(row);
    });
    if (!any) {
      var empty = document.createElement("div");
      empty.className = "det-watch-empty";
      empty.textContent = "No classes match.";
      box.appendChild(empty);
    }
  }

  // Load the live class list (any camera's list is the full model
  // list). Falls back to an empty list; the server also serves the
  // service-level list when no cameras exist.
  function loadDetClasses() {
    return api("/api/classes").then(function (r) {
      detState.classes = (r.classes || []).slice().sort();
      renderDetWatch();
    }).catch(function () { /* keep previous list */ });
  }

  function updateDetModelNote() {
    var el = $("detModelName");
    if (el) el.textContent = (state.lastStatus && state.lastStatus.model) || "yolov8n";
  }

  function fillDetection(v) {
    $("detSample").value = v.sample_interval != null ? v.sample_interval : 5;
    var conf = $("detConf");
    conf.value = v.confidence_threshold != null ? v.confidence_threshold : 0.5;
    $("detConfOut").textContent = parseFloat(conf.value).toFixed(2);
    var sel = $("detImgsz");
    // Drop a previous stored-value passthrough, then re-add it if
    // the stored imgsz is still off-list (never silently change it).
    Array.prototype.slice.call(sel.querySelectorAll("option.det-extra")).forEach(function (o) {
      sel.removeChild(o);
    });
    var iv = parseInt(v.imgsz != null ? v.imgsz : 640, 10);
    if (DET_IMG_SIZES.indexOf(iv) === -1) {
      var o = document.createElement("option");
      o.value = String(iv);
      o.textContent = String(iv) + " (current)";
      o.className = "det-extra";
      sel.appendChild(o);
    }
    sel.value = String(iv);
    $("detHeartbeat").value = v.heartbeat_interval != null ? v.heartbeat_interval : 600;
    $("detDisappear").value = v.disappear_confirm_cycles != null ? v.disappear_confirm_cycles : 4;
    var pub = v.publish || {};
    $("detPubClassId").checked = pub.classId !== false;
    $("detPubClassName").checked = pub.className !== false;
    $("detPubEvents").checked = pub.events !== false;
    detState.sel = {};
    (v.watchlist || []).forEach(function (n) { detState.sel[n] = true; });
    detState.q = "";
    detState.selOnly = false;
    $("detWatchFilter").value = "";
    $("detWatchSelOnly").checked = false;
    renderDetWatch();
  }

  function collectDetection() {
    var watch = [];
    detState.classes.forEach(function (n) {
      if (detState.sel[n]) watch.push(n);
    });
    return {
      sample_interval: parseFloat($("detSample").value),
      confidence_threshold: parseFloat($("detConf").value),
      imgsz: parseInt($("detImgsz").value, 10),
      heartbeat_interval: parseInt($("detHeartbeat").value, 10),
      disappear_confirm_cycles: parseInt($("detDisappear").value, 10),
      publish: {
        classId: $("detPubClassId").checked,
        className: $("detPubClassName").checked,
        events: $("detPubEvents").checked,
      },
      watchlist: watch,
    };
  }

  function validateDetection() {
    var errs = [];
    var d = collectDetection();
    if (!(d.sample_interval >= 0.5)) errs.push({ field: "sample_interval", message: "Sample every must be at least 0.5 sec." });
    if (!(d.confidence_threshold >= 0 && d.confidence_threshold <= 1)) errs.push({ field: "confidence_threshold", message: "Confidence threshold must be 0\u20131." });
    if (!(d.imgsz > 0)) errs.push({ field: "imgsz", message: "Image size must be a positive number." });
    if (!(d.heartbeat_interval >= 30)) errs.push({ field: "heartbeat_interval", message: "Heartbeat must be at least 30 sec." });
    if (!Number.isInteger(d.disappear_confirm_cycles) || d.disappear_confirm_cycles < 2 || d.disappear_confirm_cycles > 20) errs.push({ field: "disappear_confirm_cycles", message: "Confirm absent must be 2-20 cycles." });
    return errs;
  }

  // ---- icon picker (one builder, parameterized by container) ----
  function buildIconPicker(box, selected) {
    box.innerHTML = "";
    Object.keys(ICONS).forEach(function (key) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.icon = key;
      btn.title = ICON_LABELS[key] || key;
      btn.setAttribute("aria-label", ICON_LABELS[key] || key);
      btn.innerHTML = iconSVG(key); // icon-only button; name stays in the title tooltip
      if (key === selected) btn.classList.add("selected");
      btn.addEventListener("click", function () {
        state.cameraIcon = key;
        box.querySelectorAll("button").forEach(function (b) {
          b.classList.toggle("selected", b.dataset.icon === key);
        });
      });
      box.appendChild(btn);
    });
  }

  // ---- camera modal tabs + error dots ----
  function camTabEls(which) {
    var p = which === "rtsp" ? "rtsp" : "pi";
    return {
      mainTab: $(p + (which === "rtsp" ? "TabConn" : "TabCam")),
      detTab: $(p + "TabDet"),
      mainPanel: $(p + "MainPanel"),
      detPanel: $(p + "DetPanel"),
    };
  }

  function switchCamTab(which, tab) {
    state.camTab = tab;
    var els = camTabEls(which);
    els.mainTab.classList.toggle("active", tab === "main");
    els.detTab.classList.toggle("active", tab === "detection");
    els.mainTab.setAttribute("aria-selected", tab === "main" ? "true" : "false");
    els.detTab.setAttribute("aria-selected", tab === "detection" ? "true" : "false");
    els.mainPanel.classList.toggle("hidden", tab !== "main");
    els.detPanel.classList.toggle("hidden", tab !== "detection");
  }

  function setTabDots(which, badTabs) {
    var els = camTabEls(which);
    els.mainTab.querySelector(".tab-dot").classList.toggle("hidden", badTabs.indexOf("main") === -1);
    els.detTab.querySelector(".tab-dot").classList.toggle("hidden", badTabs.indexOf("detection") === -1);
  }

  function clearTabDots(which) { setTabDots(which, []); }

  // Dots clear as errors are fixed (revalidate on input/change, but
  // never newly show a dot outside of Save).
  function refreshTabDots() {
    if (!state.camModal || !detNode) return;
    var which = state.camModal;
    var mainErrs = which === "rtsp" ? validateRtspMain() : validatePiMain();
    var detErrs = validateDetection();
    var els = camTabEls(which);
    if (!mainErrs.length) els.mainTab.querySelector(".tab-dot").classList.add("hidden");
    if (!detErrs.length) els.detTab.querySelector(".tab-dot").classList.add("hidden");
  }

  function mountDetection(intoPanel) {
    if (!detNode) detNode = buildDetectionPanel();
    intoPanel.appendChild(detNode); // appendChild moves the single node
  }

  // Percent-encode like Python urllib.parse.quote(safe=""): everything
  // except letters, digits, and _.-~ gets percent-encoded.
  function quoteStrict(s) {
    return encodeURIComponent(s).replace(/[!'()*]/g, function (c) {
      return "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
    });
  }

  // Mirror the server build_rtsp_url() for DISPLAY ONLY, with the
  // password always masked as literal bullets. NEVER put the real
  // password in the DOM: a non-blank password field shows bullets;
  // on edit, a blank password means the stored password (bullets);
  // on add, a blank password means the server sends an empty one.
  function buildResolvedUrl(v, isEdit) {
    var path = v.path || "/";
    if (path.indexOf("{stream}") !== -1) path = path.replace("{stream}", v.stream);
    if (path.charAt(0) !== "/") path = "/" + path;
    var auth = "";
    if (v.credentials_on && v.username) {
      var pw = v.password ? "\u2022\u2022\u2022" : (isEdit ? "\u2022\u2022\u2022" : "");
      auth = quoteStrict(v.username) + ":" + pw + "@";
    }
    return v.scheme + "://" + auth + v.host + ":" + v.port + path;
  }

  function updateResolvedUrl() {
    var el = $("resolvedUrl");
    if (!el) return;
    el.textContent = buildResolvedUrl(collectRtspConn(), !!state.editingCameraId);
  }

  function updateCameraFormToggles() {
    var form = $("rtspForm");
    var creds = form.credentials_on.checked;
    form.username.disabled = !creds;
    form.password.disabled = !creds;
    $("rtspSelfSignedRow").classList.toggle("hidden", form.scheme.value !== "rtsps");
    updateResolvedUrl();
  }

  // ---- RTSP camera modal ----
  function collectRtspConn() {
    var form = $("rtspForm");
    return {
      scheme: form.scheme.value, host: form.host.value,
      port: parseInt(form.port.value, 10), path: form.path.value,
      stream: form.stream.value, transport: form.transport.value,
      connection_mode: form.connection_mode.value,
      timeout_s: parseInt(form.timeout_s.value, 10),
      credentials_on: form.credentials_on.checked,
      username: form.username.value, password: form.password.value,
      tls_allow_self_signed: form.tls_allow_self_signed.checked,
    };
  }

  function collectRtsp() {
    var form = $("rtspForm");
    var det = collectDetection();
    var body = collectRtspConn();
    body.name = form.name.value;
    body.icon = state.cameraIcon;
    body.snapshot_url = form.snapshot_url.value;
    body.rotate = parseInt(form.rotate.value, 10);
    body.start_paused = form.start_paused.checked;
    body.sample_interval = det.sample_interval;
    body.confidence_threshold = det.confidence_threshold;
    body.imgsz = det.imgsz;
    body.heartbeat_interval = det.heartbeat_interval;
    body.disappear_confirm_cycles = det.disappear_confirm_cycles;
    body.publish = det.publish;
    body.watchlist = det.watchlist;
    return body;
  }

  function validateRtspMain() {
    var form = $("rtspForm");
    var errs = [];
    if (!form.name.value.trim()) errs.push({ field: "name", message: "Name is required." });
    if (!form.host.value.trim()) errs.push({ field: "host", message: "Host / IP is required." });
    var port = parseInt(form.port.value, 10);
    if (!(port >= 1 && port <= 65535)) errs.push({ field: "port", message: "Port must be 1\u201365535." });
    var to = parseInt(form.timeout_s.value, 10);
    if (!(to >= 1 && to <= 120)) errs.push({ field: "timeout_s", message: "Timeout must be 1\u2013120 sec." });
    var snap = form.snapshot_url.value.trim();
    if (snap && snap.indexOf("http://") !== 0 && snap.indexOf("https://") !== 0) errs.push({ field: "snapshot_url", message: "Snapshot URL must start with http:// or https://." });
    return errs;
  }

  function closeRtspModal() {
    $("rtspCameraModal").classList.add("hidden");
    state.camModal = null;
    state.editingCameraId = null;
  }

  function openRtspModal(mode, cam) {
    state.camModal = "rtsp";
    state.editingCameraId = (mode === "edit" && cam) ? cam.camera_id : null;
    state.cameraIcon = (mode === "edit" && cam && cam.icon) ? cam.icon : "camera";
    buildIconPicker($("rtspIconPicker"), state.cameraIcon);
    $("rtspTestResult").classList.add("hidden");
    $("rtspError").textContent = "";
    clearTabDots("rtsp");
    // Mount FIRST: fillDetection/updateDetModelNote/loadDetClasses below
    // all touch the shared Detection node (built here on first open).
    mountDetection($("rtspDetPanel"));
    var form = $("rtspForm");
    if (mode === "edit" && cam) {
      $("rtspEyebrow").textContent = "EDIT CAMERA";
      $("rtspTitle").textContent = cam.name;
      $("rtspSaveBtn").textContent = "Save";
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
      form.password.value = ""; // blank keeps the stored password
      form.password.placeholder = "\u2022\u2022\u2022\u2022\u2022\u2022 (unchanged)";
      form.tls_allow_self_signed.checked = !!rtsp.tls_allow_self_signed;
      form.snapshot_url.value = rtsp.snapshot_url || "";
      form.rotate.value = cam.rotate != null ? cam.rotate : 0;
      form.start_paused.checked = !!cam.paused;
      fillDetection({
        sample_interval: cam.sample_interval,
        confidence_threshold: cam.confidence_threshold,
        imgsz: cam.imgsz,
        heartbeat_interval: cam.heartbeat_interval,
        publish: cam.publish,
        watchlist: cam.watchlist,
      });
    } else {
      $("rtspEyebrow").textContent = "ADD CAMERA";
      $("rtspTitle").textContent = "Add camera";
      $("rtspSaveBtn").textContent = "Add";
      form.reset();
      form.port.value = 554;
      form.timeout_s.value = 10;
      form.rotate.value = 0;
      form.password.placeholder = "";
      fillDetection({
        sample_interval: 5, confidence_threshold: 0.5, imgsz: 640,
        heartbeat_interval: 600,
        publish: { classId: true, className: true, events: true },
        watchlist: DET_DEFAULT_WATCHLIST,
      });
    }
    updateCameraFormToggles();
    updateDetModelNote();
    loadDetClasses();
    switchCamTab("rtsp", "main");
    $("rtspCameraModal").classList.remove("hidden");
  }

  function testRtspConnection() {
    var result = $("rtspTestResult");
    result.classList.remove("hidden");
    $("rtspTestMeta").textContent = "Testing…";
    api("/api/cameras/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectRtsp()),
    }).then(function (r) {
      if (r.jpeg_base64) $("rtspTestThumb").src = "data:image/jpeg;base64," + r.jpeg_base64;
      $("rtspTestMeta").textContent = "OK — " + (r.resolution ? r.resolution.join("x") : "") +
        " · " + (r.grab_seconds != null ? r.grab_seconds.toFixed(2) + "s" : "") +
        (r.camera ? " · " + r.camera : "");
    }).catch(function (e) {
      $("rtspTestMeta").textContent = "Connection failed: " + e.message;
    });
  }

  function submitRtspForm(ev) {
    ev.preventDefault();
    var mainErrs = validateRtspMain();
    var detErrs = validateDetection();
    var bad = [];
    if (mainErrs.length) bad.push("main");
    if (detErrs.length) bad.push("detection");
    setTabDots("rtsp", bad);
    if (bad.length) {
      switchCamTab("rtsp", bad[0]);
      $("rtspError").textContent = (bad[0] === "main" ? mainErrs[0] : detErrs[0]).message;
      return;
    }
    $("rtspError").textContent = "";
    $("rtspSaveBtn").disabled = true;
    var url = state.editingCameraId
      ? "/api/cameras/" + encodeURIComponent(state.editingCameraId)
      : "/api/cameras";
    var method = state.editingCameraId ? "PATCH" : "POST";
    api(url, { method: method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(collectRtsp()) })
      .then(function () {
        closeRtspModal();
        loadCameras();
        loadStatus();
      })
      .catch(function (e) {
        $("rtspError").textContent = "Save failed: " + e.message;
        var tab = mapServerErrorToTab(e.message);
        setTabDots("rtsp", [tab]);
        switchCamTab("rtsp", tab);
      })
      .then(function () { $("rtspSaveBtn").disabled = false; });
  }

  // ---- Pi camera modal ----
  function fmtEv(v) {
    return (v > 0 ? "+" : "") + v.toFixed(1);
  }

  function snap05(v) {
    return Math.round(v / 0.5) * 0.5;
  }

  function updatePiExpFields() {
    var auto = state.piExpMode === "auto";
    $("piExpAutoBtn").classList.toggle("active", auto);
    $("piExpManualBtn").classList.toggle("active", !auto);
    $("piExpAutoBtn").setAttribute("aria-pressed", auto ? "true" : "false");
    $("piExpManualBtn").setAttribute("aria-pressed", !auto ? "true" : "false");
    $("piExpAutoFields").classList.toggle("hidden", !auto);
    $("piExpManualFields").classList.toggle("hidden", auto);
  }

  function setPiExpMode(mode) {
    state.piExpMode = mode;
    updatePiExpFields();
  }

  function validatePiMain() {
    var form = $("piForm");
    var errs = [];
    if (!form.name.value.trim()) errs.push({ field: "name", message: "Name is required." });
    if (state.piExpMode === "manual") {
      var sh = parseInt($("piShutter").value, 10);
      if (!(sh >= 1 && sh <= 10000000)) errs.push({ field: "exposure_time", message: "Shutter must be 1\u201310,000,000 \u00b5s." });
      var g = parseFloat($("piGain").value);
      if (!(g >= 1.0 && g <= 16.0)) errs.push({ field: "analogue_gain", message: "Analogue gain must be 1.0\u201316.0." });
    }
    return errs;
  }

  function collectPi() {
    var form = $("piForm");
    var det = collectDetection();
    var cc = {};
    cc.awb_enable = form.awb_enable.checked;
    if (state.piExpMode === "auto") {
      cc.ae_enable = true;
      cc.exposure_value = parseFloat($("piEvSlider").value);
      var m = $("piAeMode").value;
      cc.ae_exposure_mode = m ? m : null;
      // Explicit nulls CLEAR the stored manual values server-side
      // (the merge deletes null keys); without them the old merged
      // dict would keep exposure_time/analogue_gain forever.
      cc.exposure_time = null;
      cc.analogue_gain = null;
    } else {
      cc.ae_enable = false;
      cc.exposure_time = parseInt($("piShutter").value, 10);
      cc.analogue_gain = parseFloat($("piGain").value);
    }
    return {
      name: form.name.value, icon: state.cameraIcon,
      rotate: parseInt(form.rotate.value, 10),
      start_paused: form.start_paused.checked,
      sample_interval: det.sample_interval,
      confidence_threshold: det.confidence_threshold,
      imgsz: det.imgsz, heartbeat_interval: det.heartbeat_interval,
      disappear_confirm_cycles: det.disappear_confirm_cycles,
      publish: det.publish, watchlist: det.watchlist,
      camera_controls: cc,
    };
  }

  function closePiModal() {
    state.piPreviewSeq++; // invalidate any in-flight preview poll
    $("piCameraModal").classList.add("hidden");
    state.camModal = null;
    state.editingCameraId = null;
  }

  function openPiModal(cam) {
    state.camModal = "pi";
    state.editingCameraId = cam.camera_id;
    state.cameraIcon = cam.icon || "board";
    buildIconPicker($("piIconPicker"), state.cameraIcon);
    $("piTestResult").classList.add("hidden");
    $("piError").textContent = "";
    clearTabDots("pi");
    // Mount FIRST: fillDetection/updateDetModelNote/loadDetClasses below
    // all touch the shared Detection node (built here on first open).
    mountDetection($("piDetPanel"));
    var form = $("piForm");
    $("piEyebrow").textContent = "EDIT PI CAMERA";
    $("piTitle").textContent = cam.name;
    form.name.value = cam.name || "";
    form.rotate.value = cam.rotate != null ? cam.rotate : 0;
    form.start_paused.checked = !!cam.paused;
    var statusTxt = cam.status === "online" ? "Detected" : (cam.status || "Unknown");
    $("piSensorStatus").textContent = statusTxt;
    $("piSensorDot").className = "dot " + (cam.status || "offline");
    $("piSensorModel").textContent = cam.sensor_model || "Unknown";
    $("piSensorPort").textContent = cam.camera_port || "\u2014";
    $("piSensorRes").textContent = cam.resolution ? cam.resolution.join("x") : "\u2014";
    var cc = cam.camera_controls || {};
    form.awb_enable.checked = cc.awb_enable !== false;
    // Manual iff a stored manual value exists (Auto always nulls them).
    state.piExpMode = (cc.exposure_time != null || cc.analogue_gain != null) ? "manual" : "auto";
    $("piEvSlider").value = cc.exposure_value != null ? snap05(cc.exposure_value) : 0;
    $("piEvOut").textContent = fmtEv(parseFloat($("piEvSlider").value));
    $("piAeMode").value = cc.ae_exposure_mode || "";
    $("piShutter").value = cc.exposure_time != null ? cc.exposure_time : 20000;
    $("piGain").value = cc.analogue_gain != null ? cc.analogue_gain : 1.0;
    updatePiExpFields();
    fillDetection({
      sample_interval: cam.sample_interval,
      confidence_threshold: cam.confidence_threshold,
      imgsz: cam.imgsz,
      heartbeat_interval: cam.heartbeat_interval,
      publish: cam.publish,
      watchlist: cam.watchlist,
    });
    updateDetModelNote();
    loadDetClasses();
    switchCamTab("pi", "main");
    $("piCameraModal").classList.remove("hidden");
    loadPiPreview(cam.camera_id, false);
  }

  function loadPiPreview(camId, showResult) {
    return api("/api/latest?camera=" + encodeURIComponent(camId)).then(function (r) {
      $("piPreviewImg").src = "data:image/jpeg;base64," + r.jpeg_base64;
      state.piPreviewTs = r.timestamp;
      $("piPreviewMeta").textContent = r.timestamp ? fmtLocal(r.timestamp) : "";
      return r;
    }).catch(function () { /* no frame yet */ });
  }

  function refreshPiPreview(showResult) {
    var camId = state.editingCameraId;
    if (!camId) return;
    var seq = ++state.piPreviewSeq;
    var btn = $("piPreviewRefresh");
    var testBtn = $("piTestBtn");
    btn.disabled = true;
    testBtn.disabled = true;
    var before = state.piPreviewTs;
    if (showResult) {
      $("piTestResult").classList.remove("hidden");
      $("piTestMeta").textContent = "Capturing\u2026";
    }
    api("/api/capture_now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ camera_id: camId }),
    }).then(function () {
      var tries = 0;
      (function poll() {
        if (seq !== state.piPreviewSeq) return; // modal closed / superseded
        if (tries++ >= 10) {
          btn.disabled = false;
          testBtn.disabled = false;
          if (showResult) $("piTestMeta").textContent = "Timed out — the camera may be paused.";
          return;
        }
        loadPiPreview(camId, false).then(function (r) {
          if (seq !== state.piPreviewSeq) return;
          if (r && r.timestamp && r.timestamp !== before) {
            btn.disabled = false;
            testBtn.disabled = false;
            if (showResult) {
              api("/api/cameras").then(function (list) {
                var c = list.filter(function (x) { return x.camera_id === camId; })[0];
                $("piTestMeta").textContent = "Capture OK — " +
                  (c && c.resolution ? c.resolution.join("x") : "") +
                  (c && c.last_grab_seconds != null ? " · grab " + c.last_grab_seconds.toFixed(2) + "s" : "");
              });
            }
            return;
          }
          setTimeout(poll, 1000);
        });
      })();
    }).catch(function (e) {
      btn.disabled = false;
      testBtn.disabled = false;
      if (showResult) $("piTestMeta").textContent = "Capture failed: " + e.message;
    });
  }

  function submitPiForm(ev) {
    ev.preventDefault();
    var mainErrs = validatePiMain();
    var detErrs = validateDetection();
    var bad = [];
    if (mainErrs.length) bad.push("main");
    if (detErrs.length) bad.push("detection");
    setTabDots("pi", bad);
    if (bad.length) {
      switchCamTab("pi", bad[0]);
      $("piError").textContent = (bad[0] === "main" ? mainErrs[0] : detErrs[0]).message;
      return;
    }
    $("piError").textContent = "";
    $("piSaveBtn").disabled = true;
    api("/api/cameras/" + encodeURIComponent(state.editingCameraId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectPi()),
    }).then(function () {
      closePiModal();
      loadCameras();
      loadStatus();
    }).catch(function (e) {
      $("piError").textContent = "Save failed: " + e.message;
      var tab = mapServerErrorToTab(e.message);
      setTabDots("pi", [tab]);
      switchCamTab("pi", tab);
    }).then(function () { $("piSaveBtn").disabled = false; });
  }

  // Server errors map to a tab: detection keywords -> Detection,
  // everything else (name, connection, access, camera controls) ->
  // the first tab.
  function mapServerErrorToTab(msg) {
    var m = (msg || "").toLowerCase();
    var detKeys = ["sample", "confidence", "imgsz", "image size", "heartbeat", "disappear", "absent", "publish", "watchlist"];
    for (var i = 0; i < detKeys.length; i++) {
      if (m.indexOf(detKeys[i]) !== -1) return "detection";
    }
    return "main";
  }

  // ---- Service settings (system-wide only) ----
  function openServiceSettings() {
    $("svcError").textContent = "";
    api("/api/status").then(function (s) {
      $("svcModel").value = s.model || "yolov8n";
      var capMb = Math.round((s.buffer.cap_bytes || 1073741824) / 1048576);
      $("svcBufferCap").value = capMb;
      state.svcBufferBytes = s.buffer.bytes || 0;
      updateSvcInUse();
      $("settingsModal").classList.remove("hidden");
    }).catch(function (e) {
      $("svcError").textContent = "Could not load service status: " + e.message;
      $("settingsModal").classList.remove("hidden");
    });
  }

  function updateSvcInUse() {
    var usedMb = Math.round((state.svcBufferBytes || 0) / 1048576);
    var cap = parseInt($("svcBufferCap").value, 10);
    if (!(cap > 0)) {
      $("svcInUseLabel").textContent = usedMb + " MB / \u2014";
      $("svcInUseFill").style.width = "0%";
      return;
    }
    $("svcInUseLabel").textContent = usedMb + " MB / " + cap + " MB";
    $("svcInUseFill").style.width = Math.min(100, (usedMb / cap) * 100) + "%";
  }

  function submitServiceSettings(ev) {
    ev.preventDefault();
    var model = $("svcModel").value;
    var cap = parseInt($("svcBufferCap").value, 10);
    if (model !== "yolov8n" && model !== "yolov8s") {
      $("svcError").textContent = "Model must be yolov8n or yolov8s.";
      return;
    }
    if (!(cap >= 1)) {
      $("svcError").textContent = "Image history limit must be at least 1 MB.";
      return;
    }
    $("svcSaveBtn").disabled = true;
    // Service-level path: the sentinel camera_id "service" routes to
    // apply_service_config. Only model + buffer cap are sent — no
    // per-camera keys, no per-camera id.
    api("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ camera_id: "service", model: model, buffer_cap_mb: cap }),
    }).then(function () {
      $("settingsModal").classList.add("hidden");
      loadStatus().then(updateDetModelNote);
      loadCameras();
    }).catch(function (e) {
      $("svcError").textContent = "Save failed: " + e.message;
    }).then(function () { $("svcSaveBtn").disabled = false; });
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
      // Service settings is system-wide only: no camera required.
      openServiceSettings();
    });
    $("menuAbout").addEventListener("click", function () {
      $("menu").classList.add("hidden");
      $("aboutModal").classList.remove("hidden");
    });
    $("aboutClose").addEventListener("click", function () {
      $("aboutModal").classList.add("hidden");
    });
    // Service settings modal (system-wide only).
    $("settingsClose").addEventListener("click", function () {
      $("settingsModal").classList.add("hidden");
    });
    $("svcCancelBtn").addEventListener("click", function () {
      $("settingsModal").classList.add("hidden");
    });
    $("svcForm").addEventListener("submit", submitServiceSettings);
    $("svcBufferCap").addEventListener("input", updateSvcInUse);
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
    $("modalDownload").addEventListener("click", downloadModalImage);
    // Camera modals: RTSP (Connection | Detection) and Pi (Camera | Detection).
    $("addCameraBtn").addEventListener("click", function () {
      openRtspModal("add", null);
    });
    $("rtspClose").addEventListener("click", closeRtspModal);
    $("rtspCancelBtn").addEventListener("click", closeRtspModal);
    $("rtspForm").addEventListener("submit", submitRtspForm);
    $("rtspTestBtn").addEventListener("click", testRtspConnection);
    $("rtspForm").credentials_on.addEventListener("change", updateCameraFormToggles);
    $("rtspForm").addEventListener("input", function () {
      updateResolvedUrl();
      refreshTabDots();
    });
    $("rtspForm").addEventListener("change", function () {
      updateCameraFormToggles();
      refreshTabDots();
    });
    $("rtspForm").scheme.addEventListener("change", updateCameraFormToggles);
    $("rtspTabConn").addEventListener("click", function () { switchCamTab("rtsp", "main"); });
    $("rtspTabDet").addEventListener("click", function () { switchCamTab("rtsp", "detection"); });
    $("piClose").addEventListener("click", closePiModal);
    $("piCancelBtn").addEventListener("click", closePiModal);
    $("piForm").addEventListener("submit", submitPiForm);
    $("piTestBtn").addEventListener("click", function () { refreshPiPreview(true); });
    $("piPreviewRefresh").addEventListener("click", function () { refreshPiPreview(false); });
    $("piExpAutoBtn").addEventListener("click", function () { setPiExpMode("auto"); });
    $("piExpManualBtn").addEventListener("click", function () { setPiExpMode("manual"); });
    $("piEvSlider").addEventListener("input", function () {
      $("piEvOut").textContent = fmtEv(parseFloat(this.value));
    });
    $("piForm").addEventListener("input", refreshTabDots);
    $("piForm").addEventListener("change", refreshTabDots);
    $("piTabCam").addEventListener("click", function () { switchCamTab("pi", "main"); });
    $("piTabDet").addEventListener("click", function () { switchCamTab("pi", "detection"); });
    $("rescanBtn").addEventListener("click", function () {
      api("/api/cameras/rescan", { method: "POST" }).then(function () {
        loadCameras(); loadStatus();
      }).catch(function (e) { alert("Rescan failed: " + e.message); });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        // Close only the topmost modal: Service settings stacks above
        // the camera modals, which sit above the image modal.
        if (!$("settingsModal").classList.contains("hidden")) {
          $("settingsModal").classList.add("hidden");
        } else if (!$("rtspCameraModal").classList.contains("hidden")) {
          closeRtspModal();
        } else if (!$("piCameraModal").classList.contains("hidden")) {
          closePiModal();
        } else {
          closeModal();
          $("aboutModal").classList.add("hidden");
        }
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
          loadNewEvents();
        } else {
          state.eventsStale = true;
        }
        loadCounts();
        loadStatus();
      } else if (msg.type === "frame") {
        loadLatest();
        loadCameras();
        loadStatus(); // keep header (last inference, load) live
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
