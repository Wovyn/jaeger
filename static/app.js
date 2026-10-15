// Jaeger web UI (v0.2.0) — vanilla JS, no frameworks.
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
    modalIndex: -1,
  };

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
  function countsSummary(counts) {
    var parts = [];
    Object.keys(counts || {}).sort().forEach(function (k) {
      if (counts[k] > 0) parts.push(k + ": " + counts[k]);
    });
    return parts.length ? parts.join(", ") : "no detections";
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
  function loadStatus() {
    return api("/api/status").then(function (s) {
      $("version").textContent = "v" + s.version;
      var dot = $("statusDot");
      dot.className = "dot " + (s.mqtt_connected ? "online" : "offline");
      dot.title = s.mqtt_connected ? "MQTT connected" : "MQTT disconnected";
      $("statusText").textContent =
        "up " + Math.round(s.uptime_seconds) + "s" +
        (s.last_cycle_seconds != null
          ? " · last inference " + s.last_cycle_seconds + "s" : "");
      $("bufferUsage").textContent =
        "Buffer: " + fmtBytes(s.buffer.bytes) + " / " +
        fmtBytes(s.buffer.cap_bytes) + " (" + s.buffer.files + " images)";
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
      li.innerHTML =
        "<div><b>" + c.name + "</b> (" + c.camera_id + ")</div>" +
        "<div class='cam-meta'>" + c.type + " · " +
        c.resolution.join("x") + " · " + status + "<br>last capture: " +
        fmtLocal(c.last_capture_at) + "</div>";
      li.addEventListener("click", function () {
        state.selectedCamera = c.camera_id;
        renderCameras();
        loadCounts();
        loadLatest();
      });
      list.appendChild(li);
    });
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
        var showZero = $("zeroToggle").checked;
        Object.keys(r.counts).sort().forEach(function (name) {
          var count = r.counts[name];
          if (count === 0 && !showZero) return;
          var row = document.createElement("li");
          row.className = "count-row";
          row.innerHTML = "<span class='count-name'>" + name +
            "</span><span class='count-value'>" + count + "</span>";
          row.addEventListener("click", function () {
            setClassFilter(name);
          });
          list.appendChild(row);
        });
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
        "<div class='event-info'><b>" + e.camera_id + "</b> " + timeHtml +
        "<div class='event-objs'>" + countsSummary(e.counts) + "</div>" +
        (e.has_metadata ? "" : "<div class='event-objs'>no metadata</div>") +
        "</div>" +
        "<img src='" + e.image_url + "' alt='Event image' loading='lazy'>";
      li.addEventListener("click", function () { openModal(i); });
      list.appendChild(li);
    });
  }

  // ---- modal ----
  function renderBboxes() {
    var svg = $("modalSvg");
    svg.innerHTML = "";
    var img = $("modalImg");
    var e = state.events[state.modalIndex];
    if (!e || !e.detections) return;
    var w = img.naturalWidth || 0, h = img.naturalHeight || 0;
    if (!w || !h) return;
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    Object.keys(e.detections).forEach(function (name) {
      e.detections[name].forEach(function (d) {
        var b = d.bbox || [0, 0, 0, 0];
        var x = b[0] * w, y = b[1] * h,
            bw = (b[2] - b[0]) * w, bh = (b[3] - b[1]) * h;
        var rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        rect.setAttribute("x", x);
        rect.setAttribute("y", y);
        rect.setAttribute("width", bw);
        rect.setAttribute("height", bh);
        svg.appendChild(rect);
        var text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", x + 2);
        text.setAttribute("y", y + Math.max(14, h * 0.025));
        text.setAttribute("font-size", Math.max(12, h * 0.022));
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

  // ---- menu / settings / about ----
  function openSettings() {
    if (!state.selectedCamera) return;
    var camId = state.selectedCamera;
    $("settingsCamera").textContent = camId;
    $("settingsError").textContent = "";
    Promise.all([
      api("/api/classes?camera=" + encodeURIComponent(camId)),
      api("/api/config?camera=" + encodeURIComponent(camId)),
    ]).then(function (res) {
      var classes = res[0], cfg = res[1];
      var form = $("settingsForm");
      form.sample_interval.value = cfg.sample_interval;
      form.confidence_threshold.value = cfg.confidence_threshold;
      form.model.value = cfg.model;
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
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closeModal();
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
    setInterval(function () { loadStatus(); loadCounts(); loadLatest(); }, 5000);
    setInterval(function () { loadCameras(); }, 15000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
