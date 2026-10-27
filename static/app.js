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
        // Edit opens the camera modal for the camera's type; Delete
        // shows only for types that allow it (CAM_TYPES[type].canDelete).
        openCamModal(c.type, "edit", c);
      });
      controls.appendChild(editBtn);
      if (CAM_TYPES[c.type] && CAM_TYPES[c.type].canDelete) {
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

  // Extra state for the camera modal, Add camera chooser + Pi preview.
  state.camModal = null; // CAM_TYPES key of the open camera modal, or null
  state.camTab = null; // tab id of the open camera modal (see camTabs)
  state.camAddSeq = 0; // Add camera chooser scan generation
  state.piExpMode = "auto"; // "auto" | "manual"
  state.svcBufferBytes = 0;
  state.piPreviewTs = null;
  state.piPreviewSeq = 0;

  // Info "i" bubble for a hint that would otherwise take a line of its
  // own. The text shows in the shared #tipPop on hover, focus or tap.
  function tipHtml(text) {
    return '<span class="tip" tabindex="0" data-tip="' + escHtml(text) + '">i</span>';
  }

  function buildDetectionPanel() {
    var root = document.createElement("div");
    root.id = "detPanel";
    root.className = "det-grid";
    root.innerHTML =
      '<section class="det-card"><h3>Detection</h3>' +
      '<div class="det-row">' +
      '<label class="det-field det-narrow">Sample every' +
      '<span class="suffix-input"><input type="number" id="detSample" value="5" step="0.1" min="0.5"><span>sec</span></span></label>' +
      '<label class="det-field det-grow">Confidence threshold' +
      '<span class="slider-row"><input type="range" id="detConf" min="0" max="1" step="0.05" value="0.5"><span class="readout" id="detConfOut">0.50</span></span></label>' +
      '</div>' +
      '<div class="det-row">' +
      '<label class="det-field det-narrow">Image size ' +
      tipHtml("Inference resolution. Larger finds smaller objects but runs slower.") +
      '<select id="detImgsz"><option value="320">320</option><option value="480">480</option><option value="640">640</option><option value="960">960</option><option value="1280">1280</option></select></label>' +
      '<label class="det-field det-narrow">Heartbeat' +
      '<span class="suffix-input"><input type="number" id="detHeartbeat" value="600" step="1" min="30"><span>sec</span></span></label>' +
      '</div>' +
      '<div class="det-row">' +
      '<label class="det-field det-narrow">Confirm absent ' +
      tipHtml("A disappearance (count dropping to zero) is published only after this many consecutive empty cycles. Default 4.") +
      '<span class="suffix-input"><input type="number" id="detDisappear" value="4" step="1" min="2" max="20"><span>cycles</span></span></label>' +
      '</div>' +
      '</section>' +
      '<div class="det-right">' +
      '<section class="det-card"><h3>Publish</h3>' +
      '<div class="det-publish">' +
      '<label><input type="checkbox" id="detPubClassId"> classId <span class="dim">topics</span></label>' +
      '<label><input type="checkbox" id="detPubClassName"> className <span class="dim">topics</span></label>' +
      '<label><input type="checkbox" id="detPubEvents"> events <span class="dim">topic</span></label>' +
      '</div></section>' +
      '<div class="det-note">Using <b id="detModelName">yolov8n</b>. The model and image history limit apply to all cameras. Change them in <a href="#" id="detSvcLink">Service settings</a>.</div>' +
      '</div>';
    root.querySelector("#detConf").addEventListener("input", function () {
      root.querySelector("#detConfOut").textContent =
        parseFloat(this.value).toFixed(2);
    });
    root.querySelector("#detSvcLink").addEventListener("click", function (e) {
      e.preventDefault();
      openServiceSettings();
    });
    return root;
  }

  function buildWatchPanel() {
    var root = document.createElement("section");
    root.id = "watchPanel";
    root.className = "det-card det-watch";
    root.innerHTML =
      '<div class="det-watch-tools"><span class="det-search"><input id="detWatchFilter" placeholder="Filter classes&hellip;"></span>' +
      '<label><input type="checkbox" id="detWatchSelOnly">Selected only</label>' +
      '<div class="det-watch-count"><span id="detWatchCount">0 of 0 selected</span> <button type="button" id="detWatchClear">Clear</button></div></div>' +
      '<div id="detWatchGroups" class="det-watch-groups"></div>';
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
    var tabCount = $("camWatchTabCount");
    if (tabCount) tabCount.textContent = String(selCount);
    var filter = $("detWatchFilter");
    filter.placeholder = total ? ("Filter " + total + " classes…") : "Filter classes…";
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
        chip.textContent = (detState.sel[n] ? "✓ " : "") + n;
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
    if (!(d.confidence_threshold >= 0 && d.confidence_threshold <= 1)) errs.push({ field: "confidence_threshold", message: "Confidence threshold must be 0–1." });
    if (!(d.imgsz > 0)) errs.push({ field: "imgsz", message: "Image size must be a positive number." });
    if (!(d.heartbeat_interval >= 30)) errs.push({ field: "heartbeat_interval", message: "Heartbeat must be at least 30 sec." });
    if (!Number.isInteger(d.disappear_confirm_cycles) || d.disappear_confirm_cycles < 2 || d.disappear_confirm_cycles > 20) errs.push({ field: "disappear_confirm_cycles", message: "Confirm absent must be 2-20 cycles." });
    return errs;
  }

  // Detection values as stored on a camera (the /api/cameras payload).
  function detectionFromCamera(cam) {
    return {
      sample_interval: cam.sample_interval,
      confidence_threshold: cam.confidence_threshold,
      imgsz: cam.imgsz,
      heartbeat_interval: cam.heartbeat_interval,
      disappear_confirm_cycles: cam.disappear_confirm_cycles,
      publish: cam.publish,
      watchlist: cam.watchlist,
    };
  }

  var DET_ADD_DEFAULTS = {
    sample_interval: 5, confidence_threshold: 0.5, imgsz: 640,
    heartbeat_interval: 600, disappear_confirm_cycles: 4,
    publish: { classId: true, className: true, events: true },
    watchlist: DET_DEFAULT_WATCHLIST,
  };

  // Mount the shared Detection + Watchlist nodes (built on first use).
  function mountDetection() {
    if (!detNode) {
      detNode = buildDetectionPanel();
      $("camDetPanel").appendChild(detNode);
      $("camWatchPanel").appendChild(buildWatchPanel());
    }
  }

  // ---- icon picker (one builder, parameterized by container) ----
  function buildIconPicker(box, selected, onPick) {
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
        if (onPick) onPick(key);
      });
      box.appendChild(btn);
    });
  }

  function setCamIcon(key) {
    state.cameraIcon = key;
    var btn = $("camIconBtn");
    btn.innerHTML = iconSVG(key);
    btn.title = "Icon: " + (ICON_LABELS[key] || key) + " (click to change)";
    btn.setAttribute("aria-label", btn.title);
  }

  function toggleIconPop(open) {
    var pop = $("camIconPop");
    if (open == null) open = pop.classList.contains("hidden");
    pop.classList.toggle("hidden", !open);
    $("camIconBtn").setAttribute("aria-expanded", open ? "true" : "false");
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
      var pw = v.password ? "•••" : (isEdit ? "•••" : "");
      auth = quoteStrict(v.username) + ":" + pw + "@";
    }
    return v.scheme + "://" + auth + v.host + ":" + v.port + path;
  }

  // ---- Camera modal shell ----
  // One modal (#camModal) serves every camera type. The shell owns the
  // header (name + icon), the tab bar, the shared Detection and
  // Watchlist tabs, validation dots, Save and the footer test status.
  // Each CAM_TYPES entry (below) supplies only what differs per type.
  var SHARED_TABS = [
    { id: "detection", label: "Detection", panel: "camDetPanel",
      errorKeys: ["sample", "confidence", "imgsz", "image size", "heartbeat", "disappear", "absent", "publish"] },
    { id: "watchlist", label: "Watchlist", panel: "camWatchPanel", errorKeys: ["watchlist"] },
  ];

  function camType() { return state.camModal ? CAM_TYPES[state.camModal] : null; }
  function camTabs(t) { return t.tabs.concat(SHARED_TABS); }

  function buildCamTabBar(t) {
    var bar = $("camTabBar");
    bar.innerHTML = "";
    camTabs(t).forEach(function (tab) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "tab-btn";
      b.setAttribute("role", "tab");
      b.dataset.tab = tab.id;
      b.innerHTML = escHtml(tab.label) +
        (tab.id === "watchlist" ? ' <span class="tab-count" id="camWatchTabCount"></span>' : "") +
        ' <span class="tab-dot hidden"></span>';
      b.addEventListener("click", function () { switchCamTab(tab.id); });
      bar.appendChild(b);
    });
  }

  function switchCamTab(tabId) {
    var t = camType();
    if (!t) return;
    state.camTab = tabId;
    var shown = {};
    camTabs(t).forEach(function (tab) { shown[tab.panel] = tab.id === tabId; });
    $("camBody").querySelectorAll(".tab-panel").forEach(function (p) {
      p.classList.toggle("hidden", !shown[p.id]);
    });
    $("camTabBar").querySelectorAll(".tab-btn").forEach(function (b) {
      var on = b.dataset.tab === tabId;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    $("camBody").scrollTop = 0;
  }

  // All form errors as [{field, message, tab}]; tab null = the header
  // (the name field), which has no tab of its own.
  function camErrors() {
    var t = camType();
    var errs = [];
    if (!$("camName").value.trim()) errs.push({ field: "name", message: "Name is required.", tab: null });
    t.validate().forEach(function (e) { errs.push(e); });
    validateDetection().forEach(function (e) { e.tab = "detection"; errs.push(e); });
    return errs;
  }

  function setTabDots(badTabs) {
    $("camTabBar").querySelectorAll(".tab-btn").forEach(function (b) {
      b.querySelector(".tab-dot").classList.toggle("hidden", badTabs.indexOf(b.dataset.tab) === -1);
    });
    $("camName").classList.toggle("invalid", badTabs.indexOf(null) !== -1);
  }

  // Dots clear as errors are fixed (revalidate on input/change, but
  // never newly show a dot outside of Save).
  function refreshTabDots() {
    if (!camType() || !detNode) return;
    var bad = camErrors().map(function (e) { return e.tab; });
    $("camTabBar").querySelectorAll(".tab-btn").forEach(function (b) {
      if (bad.indexOf(b.dataset.tab) === -1) b.querySelector(".tab-dot").classList.add("hidden");
    });
    if (bad.indexOf(null) === -1) $("camName").classList.remove("invalid");
  }

  // Server errors map to a tab by keyword: shared tabs first, then the
  // type's own tabs (errorKeys), then the name; anything else lands on
  // the type's first tab.
  function mapServerErrorToTab(t, msg) {
    var m = (msg || "").toLowerCase();
    var tabs = SHARED_TABS.concat(t.tabs);
    for (var i = 0; i < tabs.length; i++) {
      var keys = tabs[i].errorKeys || [];
      for (var k = 0; k < keys.length; k++) {
        if (m.indexOf(keys[k]) !== -1) return tabs[i].id;
      }
    }
    if (/\bnamed?\b/.test(m)) return null;
    return t.tabs[0].id;
  }

  function showTestStatus(kind, text, jpegBase64) {
    var box = $("camTestStatus");
    box.className = "test-status " + kind;
    $("camTestMeta").textContent = text;
    box.title = text;
    var thumb = $("camTestThumb");
    if (jpegBase64) thumb.src = "data:image/jpeg;base64," + jpegBase64;
    thumb.classList.toggle("hidden", !jpegBase64);
  }

  function hideTestStatus() {
    $("camTestStatus").classList.add("hidden");
    $("camTestThumb").classList.add("hidden");
  }

  // Open the camera modal. mode "add" | "edit"; cam = the /api/cameras
  // entry (edit); prefill = type-specific starting values for add (for
  // example a device picked in the Add camera chooser).
  function openCamModal(typeKey, mode, cam, prefill) {
    var t = CAM_TYPES[typeKey];
    if (!t) {
      alert("This version of the web UI has no editor for '" + typeKey + "' cameras.");
      return;
    }
    var isEdit = mode === "edit" && !!cam;
    state.camModal = typeKey;
    state.editingCameraId = isEdit ? cam.camera_id : null;
    // Mount FIRST: fillDetection/updateDetModelNote/loadDetClasses below
    // all touch the shared Detection node (built here on first open).
    mountDetection();
    $("camForm").reset();
    Object.keys(CAM_TYPES).forEach(function (k) {
      $(CAM_TYPES[k].fields).classList.toggle("hidden", k !== typeKey);
    });
    $("camEyebrow").textContent = isEdit ? t.editTitle : t.addTitle;
    $("camName").value = isEdit ? (cam.name || "") : ((prefill && prefill.name) || "");
    setCamIcon((isEdit && cam.icon) || (prefill && prefill.icon) || t.defaultIcon);
    buildIconPicker($("camIconPicker"), state.cameraIcon, function (key) {
      setCamIcon(key);
      toggleIconPop(false);
    });
    toggleIconPop(false);
    $("camSaveBtn").textContent = isEdit ? "Save" : "Add";
    $("camError").textContent = "";
    var test = t.test;
    $("camTestBtn").classList.toggle("hidden", !test);
    $("camTestBtn").disabled = false;
    $("camTestBtn").textContent = test ? test.label : "";
    $("camTestTip").dataset.tip = (test && test.hint) || "";
    $("camTestTip").classList.toggle("hidden", !(test && test.hint));
    hideTestStatus();
    buildCamTabBar(t);
    setTabDots([]);
    fillDetection(isEdit ? detectionFromCamera(cam) : DET_ADD_DEFAULTS);
    t.fill(isEdit ? cam : null, prefill || null);
    updateDetModelNote();
    loadDetClasses();
    switchCamTab(t.tabs[0].id);
    $("camModal").classList.remove("hidden");
    if (t.onOpen) t.onOpen(isEdit ? cam : null);
    if (!isEdit) $("camName").focus();
  }

  function closeCamModal() {
    var t = camType();
    if (t && t.onClose) t.onClose();
    $("camModal").classList.add("hidden");
    toggleIconPop(false);
    hideTip();
    state.camModal = null;
    state.editingCameraId = null;
  }

  // Request body: the type's own fields plus the shared name, icon and
  // Detection/Watchlist fields.
  function camRequestBody() {
    var body = camType().collect();
    var det = collectDetection();
    body.name = $("camName").value;
    body.icon = state.cameraIcon;
    Object.keys(det).forEach(function (k) { body[k] = det[k]; });
    return body;
  }

  function runCamTest() {
    var t = camType();
    if (!t || !t.test) return;
    var typeKey = state.camModal;
    var btn = $("camTestBtn");
    btn.disabled = true;
    if (t.test.showTab) switchCamTab(t.test.showTab);
    showTestStatus("busy", t.test.busyText || "Testing…", null);
    t.test.run().then(function (r) {
      if (state.camModal !== typeKey) return;
      showTestStatus("ok", r.text, r.jpeg_base64 || null);
    }, function (e) {
      if (state.camModal !== typeKey) return;
      showTestStatus("fail", (t.test.failPrefix || "Failed: ") + e.message, null);
    }).then(function () { btn.disabled = false; });
  }

  function submitCamForm(ev) {
    ev.preventDefault();
    var t = camType();
    var errs = camErrors();
    var bad = [];
    errs.forEach(function (e) { if (bad.indexOf(e.tab) === -1) bad.push(e.tab); });
    setTabDots(bad);
    if (errs.length) {
      if (errs[0].tab) switchCamTab(errs[0].tab); else $("camName").focus();
      $("camError").textContent = errs[0].message;
      return;
    }
    $("camError").textContent = "";
    $("camSaveBtn").disabled = true;
    var id = state.editingCameraId;
    var url = id ? "/api/cameras/" + encodeURIComponent(id) : t.addUrl;
    api(url, {
      method: id ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(camRequestBody()),
    }).then(function () {
      closeCamModal();
      loadCameras();
      loadStatus();
    }).catch(function (e) {
      $("camError").textContent = "Save failed: " + e.message;
      var tab = mapServerErrorToTab(t, e.message);
      setTabDots([tab]);
      if (tab) switchCamTab(tab); else $("camName").focus();
    }).then(function () { $("camSaveBtn").disabled = false; });
  }

  // ---- RTSP camera type ----
  function rtspField(name) {
    return $("rtspFields").querySelector('[name="' + name + '"]');
  }

  function collectRtspConn() {
    var f = rtspField;
    return {
      scheme: f("scheme").value, host: f("host").value,
      port: parseInt(f("port").value, 10), path: f("path").value,
      stream: f("stream").value, transport: f("transport").value,
      connection_mode: f("connection_mode").value,
      timeout_s: parseInt(f("timeout_s").value, 10),
      credentials_on: f("credentials_on").checked,
      username: f("username").value, password: f("password").value,
      tls_allow_self_signed: f("tls_allow_self_signed").checked,
    };
  }

  function updateResolvedUrl() {
    $("resolvedUrl").textContent = buildResolvedUrl(collectRtspConn(), !!state.editingCameraId);
  }

  function updateRtspToggles() {
    var creds = rtspField("credentials_on").checked;
    rtspField("username").disabled = !creds;
    rtspField("password").disabled = !creds;
    $("rtspSelfSignedRow").classList.toggle("hidden", rtspField("scheme").value !== "rtsps");
    updateResolvedUrl();
  }

  // ---- Pi camera type ----
  function piField(name) {
    return $("piFields").querySelector('[name="' + name + '"]');
  }

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

  function loadPiPreview(camId) {
    return api("/api/latest?camera=" + encodeURIComponent(camId)).then(function (r) {
      $("piPreviewImg").src = "data:image/jpeg;base64," + r.jpeg_base64;
      state.piPreviewTs = r.timestamp;
      $("piPreviewMeta").textContent = r.timestamp ? fmtLocal(r.timestamp) : "";
      return r;
    }).catch(function () { /* no frame yet */ });
  }

  // Ask for a fresh capture and poll /api/latest until the frame
  // changes. Resolves when the preview shows the new frame.
  function refreshPiPreview() {
    var camId = state.editingCameraId;
    if (!camId) return Promise.reject(new Error("no camera"));
    var seq = ++state.piPreviewSeq;
    var btn = $("piPreviewRefresh");
    var testBtn = $("camTestBtn");
    btn.disabled = true;
    testBtn.disabled = true;
    var before = state.piPreviewTs;
    function done() {
      btn.disabled = false;
      testBtn.disabled = false;
    }
    return api("/api/capture_now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ camera_id: camId }),
    }).then(function () {
      return new Promise(function (resolve, reject) {
        var tries = 0;
        (function poll() {
          if (seq !== state.piPreviewSeq) return reject(new Error("superseded")); // modal closed / superseded
          if (tries++ >= 10) return reject(new Error("timed out — the camera may be paused."));
          loadPiPreview(camId).then(function (r) {
            if (seq !== state.piPreviewSeq) return reject(new Error("superseded"));
            if (r && r.timestamp && r.timestamp !== before) return resolve(r);
            setTimeout(poll, 1000);
          });
        })();
      });
    }).then(function (r) { done(); return r; }, function (e) { done(); throw e; });
  }

  // ---- Camera type registry ----
  // Contract for an entry (add a new camera type by adding one):
  //   label        name in the Add camera chooser
  //   fields       id of the type's .cam-type-fields block in index.html
  //   tabs         the type's own tabs, before Detection + Watchlist:
  //                [{id, label, panel (element id), errorKeys?}]
  //   addTitle / editTitle   eyebrow text; defaultIcon  ICONS key
  //   addUrl       POST endpoint for a new camera (omit if never added)
  //   canDelete    show Delete in the camera list
  //   manual       chooser subtitle; set it if the user adds this type by
  //                hand (listed under "Add manually")
  //   discover(opts)  optional; resolves [{title, detail, status, icon?,
  //                actionLabel?, action?}] for "Found on this device".
  //                status: "new" | "added" | "missing" | "error". action()
  //                may return a promise; the list rescans when it settles.
  //                opts.scan is true when the user pressed Scan.
  //   fill(cam, prefill)  load the type's fields (cam null on add)
  //   collect()    the type's request-body fields (the shell adds name,
  //                icon and the Detection/Watchlist fields)
  //   validate()   [{field, message, tab}] for the type's own fields
  //   test         optional {label, hint?, busyText?, failPrefix?, showTab?,
  //                run() -> Promise<{text, jpeg_base64?}>}
  //   onInput()    optional, on any form input/change
  //   onOpen(cam) / onClose()  optional lifecycle hooks
  var CAM_TYPES = {
    rtsp: {
      label: "Network camera (RTSP)",
      manual: "Enter the address and credentials by hand",
      fields: "rtspFields",
      tabs: [
        { id: "conn", label: "Connection", panel: "rtspConnPanel",
          errorKeys: ["host", "port", "scheme", "path", "stream", "transport", "username", "password", "credential", "tls"] },
        { id: "capture", label: "Capture", panel: "rtspCapturePanel",
          errorKeys: ["rotate", "snapshot", "paused", "connection mode", "connection_mode", "timeout"] },
      ],
      addTitle: "ADD NETWORK CAMERA",
      editTitle: "EDIT NETWORK CAMERA",
      defaultIcon: "camera",
      addUrl: "/api/cameras",
      canDelete: true,
      fill: function (cam) {
        var f = rtspField;
        var rtsp = (cam && cam.rtsp) || {};
        f("scheme").value = rtsp.scheme || "rtsp";
        f("host").value = rtsp.host || "";
        f("port").value = rtsp.port != null ? rtsp.port : 554;
        f("path").value = rtsp.path || "/";
        f("stream").value = rtsp.stream || "main";
        f("transport").value = rtsp.transport || "tcp";
        f("connection_mode").value = rtsp.connection_mode || "persistent";
        f("timeout_s").value = rtsp.timeout_s != null ? rtsp.timeout_s : 10;
        f("credentials_on").checked = !!(rtsp.username || rtsp.has_password);
        f("username").value = rtsp.username || "";
        f("password").value = ""; // blank keeps the stored password
        f("password").placeholder = cam ? "•••••• (unchanged)" : "";
        f("tls_allow_self_signed").checked = !!rtsp.tls_allow_self_signed;
        f("snapshot_url").value = rtsp.snapshot_url || "";
        f("rotate").value = cam && cam.rotate != null ? cam.rotate : 0;
        f("start_paused").checked = !!(cam && cam.paused);
        updateRtspToggles();
      },
      collect: function () {
        var body = collectRtspConn();
        body.snapshot_url = rtspField("snapshot_url").value;
        body.rotate = parseInt(rtspField("rotate").value, 10);
        body.start_paused = rtspField("start_paused").checked;
        return body;
      },
      validate: function () {
        var f = rtspField;
        var errs = [];
        if (!f("host").value.trim()) errs.push({ field: "host", tab: "conn", message: "Host / IP is required." });
        var port = parseInt(f("port").value, 10);
        if (!(port >= 1 && port <= 65535)) errs.push({ field: "port", tab: "conn", message: "Port must be 1–65535." });
        var to = parseInt(f("timeout_s").value, 10);
        if (!(to >= 1 && to <= 120)) errs.push({ field: "timeout_s", tab: "capture", message: "Timeout must be 1–120 sec." });
        var snap = f("snapshot_url").value.trim();
        if (snap && snap.indexOf("http://") !== 0 && snap.indexOf("https://") !== 0) errs.push({ field: "snapshot_url", tab: "capture", message: "Snapshot URL must start with http:// or https://." });
        return errs;
      },
      test: {
        label: "↻ Test connection",
        hint: "Tip: pick H.264 on the camera — H.265 is costly to decode on a Pi 4.",
        busyText: "Testing…",
        failPrefix: "Connection failed: ",
        run: function () {
          return api("/api/cameras/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(camRequestBody()),
          }).then(function (r) {
            return {
              text: "OK — " + (r.resolution ? r.resolution.join("x") : "") +
                " · " + (r.grab_seconds != null ? r.grab_seconds.toFixed(2) + "s" : "") +
                (r.camera ? " · " + r.camera : ""),
              jpeg_base64: r.jpeg_base64,
            };
          });
        },
      },
      onInput: updateRtspToggles,
    },

    picamera: {
      label: "Pi camera",
      fields: "piFields",
      tabs: [
        { id: "camera", label: "Camera", panel: "piCameraPanel",
          errorKeys: ["rotate", "paused", "awb", "white balance"] },
        { id: "exposure", label: "Exposure", panel: "piExposurePanel",
          errorKeys: ["exposure", "shutter", "gain", "ae_"] },
      ],
      addTitle: "ADD PI CAMERA",
      editTitle: "EDIT PI CAMERA",
      defaultIcon: "board",
      canDelete: false, // the Pi camera cannot be deleted
      // The Pi camera is detected, never added by hand: the chooser
      // shows it as found, or offers a detection retry (rescan).
      discover: function () {
        var pi = state.cameras.filter(function (c) { return c.type === "picamera"; })[0];
        if (pi) {
          return [{ title: pi.name, icon: pi.icon || "board", status: "added",
            detail: "Pi camera · " + (pi.sensor_model || "detected") }];
        }
        return [{ title: "Pi camera", icon: "board", status: "missing",
          detail: "Not detected on the camera port",
          actionLabel: "Retry detection",
          action: function () {
            return api("/api/cameras/rescan", { method: "POST" }).then(function () {
              return Promise.all([loadCameras(), loadStatus()]);
            });
          } }];
      },
      fill: function (cam) {
        piField("rotate").value = cam.rotate != null ? cam.rotate : 0;
        piField("start_paused").checked = !!cam.paused;
        var statusTxt = cam.status === "online" ? "Detected" : (cam.status || "Unknown");
        $("piSensorStatus").textContent = statusTxt;
        $("piSensorDot").className = "dot " + (cam.status || "offline");
        $("piSensorModel").textContent = cam.sensor_model || "Unknown";
        $("piSensorPort").textContent = cam.camera_port || "—";
        $("piSensorRes").textContent = cam.resolution ? cam.resolution.join("x") : "—";
        var cc = cam.camera_controls || {};
        piField("awb_enable").checked = cc.awb_enable !== false;
        // Manual iff a stored manual value exists (Auto always nulls them).
        state.piExpMode = (cc.exposure_time != null || cc.analogue_gain != null) ? "manual" : "auto";
        $("piEvSlider").value = cc.exposure_value != null ? snap05(cc.exposure_value) : 0;
        $("piEvOut").textContent = fmtEv(parseFloat($("piEvSlider").value));
        $("piAeMode").value = cc.ae_exposure_mode || "";
        $("piShutter").value = cc.exposure_time != null ? cc.exposure_time : 20000;
        $("piGain").value = cc.analogue_gain != null ? cc.analogue_gain : 1.0;
        updatePiExpFields();
        $("piPreviewImg").removeAttribute("src");
        $("piPreviewMeta").textContent = "";
        $("piPreviewRefresh").disabled = false;
      },
      collect: function () {
        var cc = {};
        cc.awb_enable = piField("awb_enable").checked;
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
          rotate: parseInt(piField("rotate").value, 10),
          start_paused: piField("start_paused").checked,
          camera_controls: cc,
        };
      },
      validate: function () {
        var errs = [];
        if (state.piExpMode === "manual") {
          var sh = parseInt($("piShutter").value, 10);
          if (!(sh >= 1 && sh <= 10000000)) errs.push({ field: "exposure_time", tab: "exposure", message: "Shutter must be 1–10,000,000 µs." });
          var g = parseFloat($("piGain").value);
          if (!(g >= 1.0 && g <= 16.0)) errs.push({ field: "analogue_gain", tab: "exposure", message: "Analogue gain must be 1.0–16.0." });
        }
        return errs;
      },
      test: {
        label: "◉ Test capture",
        hint: "Grabs a fresh frame to preview the current exposure.",
        busyText: "Capturing…",
        failPrefix: "Capture failed: ",
        showTab: "exposure",
        run: function () {
          var camId = state.editingCameraId;
          return refreshPiPreview().then(function () {
            return api("/api/cameras").then(function (r) {
              var c = (r.cameras || []).filter(function (x) { return x.camera_id === camId; })[0];
              return {
                text: "Capture OK — " +
                  (c && c.resolution ? c.resolution.join("x") : "") +
                  (c && c.last_grab_seconds != null ? " · grab " + c.last_grab_seconds.toFixed(2) + "s" : ""),
              };
            });
          });
        },
      },
      onOpen: function (cam) { loadPiPreview(cam.camera_id); },
      onClose: function () { state.piPreviewSeq++; }, // invalidate any in-flight preview poll
    },
  };

  // ---- Add camera chooser ----
  // "Found on this device" lists what each type's discover() reports;
  // "Add manually" lists the types with a `manual` subtitle.
  function addRowHtml(icon, title, detail) {
    return '<span class="add-row-icon">' + iconSVG(icon) + '</span>' +
      '<span class="add-row-main"><b>' + escHtml(title) + '</b>' +
      '<span class="dim">' + escHtml(detail || "") + '</span></span>';
  }

  function openCamAdd() {
    var man = $("camAddManual");
    man.innerHTML = "";
    Object.keys(CAM_TYPES).forEach(function (k) {
      var t = CAM_TYPES[k];
      if (!t.manual) return;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "add-row";
      b.innerHTML = addRowHtml(t.defaultIcon, t.label, t.manual) + '<span class="add-row-go">›</span>';
      b.addEventListener("click", function () {
        closeCamAdd();
        openCamModal(k, "add", null, null);
      });
      man.appendChild(b);
    });
    $("camAddModal").classList.remove("hidden");
    scanCamAdd(false);
  }

  function closeCamAdd() {
    state.camAddSeq++; // drop any scan still in flight
    $("camAddModal").classList.add("hidden");
  }

  var ADD_STATUS_LABELS = { "new": "New", added: "Added", missing: "Not found", error: "Error" };

  function scanCamAdd(userScan) {
    var box = $("camAddFound");
    var seq = ++state.camAddSeq;
    var keys = Object.keys(CAM_TYPES).filter(function (k) { return CAM_TYPES[k].discover; });
    var scanBtn = $("camAddScanBtn");
    scanBtn.disabled = true;
    box.innerHTML = '<div class="add-empty">Scanning…</div>';
    Promise.all(keys.map(function (k) {
      return Promise.resolve().then(function () {
        return CAM_TYPES[k].discover({ scan: userScan });
      }).then(function (items) {
        return items || [];
      }, function (e) {
        return [{ title: CAM_TYPES[k].label, icon: CAM_TYPES[k].defaultIcon,
          status: "error", detail: "Scan failed: " + e.message }];
      });
    })).then(function (lists) {
      if (seq !== state.camAddSeq) return;
      box.innerHTML = "";
      var items = [].concat.apply([], lists);
      if (!items.length) {
        box.innerHTML = '<div class="add-empty">No cameras found.</div>';
      }
      items.forEach(function (it) {
        var row = document.createElement("div");
        row.className = "add-row";
        row.innerHTML = addRowHtml(it.icon || "camera", it.title, it.detail) +
          '<span class="add-badge ' + escHtml(it.status) + '">' +
          escHtml(ADD_STATUS_LABELS[it.status] || it.status) + '</span>';
        if (it.action) {
          var b = document.createElement("button");
          b.type = "button";
          b.className = "add-row-action" + (it.status === "new" ? "" : " secondary");
          b.textContent = it.actionLabel || "Add";
          b.addEventListener("click", function () {
            var p = it.action();
            if (!p || !p.then) return;
            b.disabled = true;
            b.textContent = "Working…";
            p.then(function () {
              scanCamAdd(false);
            }, function (e) {
              b.disabled = false;
              b.textContent = it.actionLabel || "Add";
              row.querySelector(".dim").textContent = e.message;
            });
          });
          row.appendChild(b);
        }
        box.appendChild(row);
      });
    }).then(function () {
      if (seq === state.camAddSeq) scanBtn.disabled = false;
    });
  }

  // ---- info tips ----
  function showTip(el) {
    var text = el.dataset.tip;
    if (!text) return;
    var pop = $("tipPop");
    pop.textContent = text;
    pop.classList.remove("hidden");
    var r = el.getBoundingClientRect();
    var w = pop.offsetWidth;
    var h = pop.offsetHeight;
    var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = r.top - h - 6;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  }

  function hideTip() { $("tipPop").classList.add("hidden"); }

  function initTips() {
    function tipOf(e) { return e.target.closest ? e.target.closest(".tip") : null; }
    document.addEventListener("mouseover", function (e) { var t = tipOf(e); if (t) showTip(t); });
    document.addEventListener("mouseout", function (e) { if (tipOf(e)) hideTip(); });
    document.addEventListener("focusin", function (e) { var t = tipOf(e); if (t) showTip(t); });
    document.addEventListener("focusout", function (e) { if (tipOf(e)) hideTip(); });
    // A tip sits inside a <label>: keep a tap from toggling the field.
    document.addEventListener("click", function (e) {
      var t = tipOf(e);
      if (t) { e.preventDefault(); showTip(t); }
    });
    document.addEventListener("scroll", hideTip, true);
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
    // Add camera chooser -> camera modal (one modal for every type).
    $("addCameraBtn").addEventListener("click", openCamAdd);
    $("camAddClose").addEventListener("click", closeCamAdd);
    $("camAddScanBtn").addEventListener("click", function () { scanCamAdd(true); });
    $("camClose").addEventListener("click", closeCamModal);
    $("camCancelBtn").addEventListener("click", closeCamModal);
    $("camForm").addEventListener("submit", submitCamForm);
    $("camTestBtn").addEventListener("click", runCamTest);
    $("camForm").addEventListener("input", function () {
      var t = camType();
      if (t && t.onInput) t.onInput();
      refreshTabDots();
    });
    $("camForm").addEventListener("change", function () {
      var t = camType();
      if (t && t.onInput) t.onInput();
      refreshTabDots();
    });
    $("camIconBtn").addEventListener("click", function (e) {
      e.stopPropagation();
      toggleIconPop();
    });
    document.addEventListener("click", function (e) {
      if (!$("camIconPop").classList.contains("hidden") &&
          !$("camIconPop").contains(e.target) && e.target !== $("camIconBtn")) {
        toggleIconPop(false);
      }
    });
    $("camTestThumb").addEventListener("click", function () {
      $("camThumbZoomImg").src = this.src;
      $("camThumbZoom").classList.remove("hidden");
    });
    $("camThumbZoom").addEventListener("click", function () {
      $("camThumbZoom").classList.add("hidden");
    });
    $("piPreviewRefresh").addEventListener("click", function () {
      refreshPiPreview().catch(function () { /* the preview keeps the last frame */ });
    });
    $("piExpAutoBtn").addEventListener("click", function () { setPiExpMode("auto"); });
    $("piExpManualBtn").addEventListener("click", function () { setPiExpMode("manual"); });
    $("piEvSlider").addEventListener("input", function () {
      $("piEvOut").textContent = fmtEv(parseFloat(this.value));
    });
    initTips();
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        // Close only the topmost layer: Service settings stacks above
        // the camera modal (and its icon picker / enlarged test frame),
        // which sits above the image modal.
        if (!$("settingsModal").classList.contains("hidden")) {
          $("settingsModal").classList.add("hidden");
        } else if (!$("camThumbZoom").classList.contains("hidden")) {
          $("camThumbZoom").classList.add("hidden");
        } else if (!$("camIconPop").classList.contains("hidden")) {
          toggleIconPop(false);
        } else if (!$("camModal").classList.contains("hidden")) {
          closeCamModal();
        } else if (!$("camAddModal").classList.contains("hidden")) {
          closeCamAdd();
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
