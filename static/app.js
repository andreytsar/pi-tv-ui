(() => {
  const WEATHER_EMOJI = {
    clear: (isDay) => (isDay ? "☀️" : "🌙"),
    "partly-cloudy": (isDay) => (isDay ? "⛅" : "☁️"),
    cloudy: () => "☁️",
    fog: () => "🌫️",
    drizzle: () => "🌦️",
    rain: () => "🌧️",
    snow: () => "❄️",
    storm: () => "⛈️",
  };

  const SECTION_EMOJI = {
    tv: "📺",
    gamepad: "🎮",
    sparkles: "🕹️",
    grid: "🧩",
  };

  const FALLBACK_GLYPH = {
    youtube: `<svg viewBox="0 0 64 46" class="app-icon-img" aria-hidden="true"><rect width="64" height="46" rx="12" fill="#ef4444"/><polygon points="26,14 26,32 43,23" fill="#ffffff"/></svg>`,
    vlc: "🎬",
    dosbox: "⚔️",
    "utilities-terminal": ">_",
  };

  const state = {
    config: null,
    weather: null,
    runningWindows: [],
    runningItemIds: new Set(),
    runningSignature: "",
    // Focus grid: row 0 = topbar, optional row 1 = running bar, remaining rows = sections
    rows: [],
    sectionRowOffset: 1,
    rowIndex: 1,
    colIndex: 0,
    lastColPerRow: {},
    activeModal: null,
    modalFocusIndex: 0,
    confirmPowerAction: null,
    toastTimer: null,
    installedApps: [],
    appsFilter: "available",
    appsSearch: "",
    appsTargetSection: "auto",
  };

  const $ = (id) => document.getElementById(id);

  function weatherIcon(kind, isDay = true) {
    const fn = WEATHER_EMOJI[kind] || WEATHER_EMOJI.cloudy;
    return fn(isDay);
  }

  function showToast(msg, duration = 2600) {
    const toast = $("toast");
    toast.textContent = msg;
    toast.classList.add("visible");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      toast.classList.remove("visible");
    }, duration);
  }

  async function apiGet(url) {
    const res = await fetch(url, { cache: "no-store" });
    return res.json();
  }

  async function apiPost(url, payload) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  /* ---------- Clock ---------- */
  let lastClockTimeText = "";
  let lastClockDateText = "";
  let clockTimer = null;

  function stopClockTimer() {
    if (clockTimer !== null) {
      clearTimeout(clockTimer);
      clockTimer = null;
    }
  }

  function scheduleClockTick() {
    stopClockTimer();
    if (document.hidden) return;
    const now = new Date();
    const showSeconds = state.config?.clock?.showSeconds ?? false;
    const delayMs = showSeconds
      ? 1000 - now.getMilliseconds() + 20
      : (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 50;
    clockTimer = setTimeout(updateClock, Math.max(50, delayMs));
  }

  function updateClock() {
    const now = new Date();
    const hour24 = state.config?.clock?.hour24 ?? true;
    const showSeconds = state.config?.clock?.showSeconds ?? false;

    const timeOpts = {
      hour: "2-digit",
      minute: "2-digit",
      hour12: !hour24,
    };
    if (showSeconds) timeOpts.second = "2-digit";

    const timeText = now.toLocaleTimeString([], timeOpts);
    if (timeText !== lastClockTimeText) {
      lastClockTimeText = timeText;
      $("clockTime").textContent = timeText;
    }
    const dateText = now.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    if (dateText !== lastClockDateText) {
      lastClockDateText = dateText;
      $("clockDate").textContent = dateText;
    }
    scheduleClockTick();
  }

  /* ---------- Weather ---------- */
  async function loadWeather(force = false) {
    try {
      const data = await apiGet(`/api/weather${force ? "?force=1" : ""}`);
      state.weather = data;
      renderWeather();
    } catch {
      $("weatherCond").textContent = "Offline";
      $("weatherCity").textContent = "Weather unavailable";
    }
  }

  function renderWeather() {
    const w = state.weather;
    if (!w || !w.ok) {
      const isCityError = w?.error && w.error.toLowerCase().includes("not found");
      $("weatherIcon").textContent = "☁️";
      $("weatherTemp").textContent = "--°";
      $("weatherCond").textContent = isCityError ? "City not found" : "Offline";
      $("weatherCity").textContent = isCityError ? "Click to change city" : "Weather unavailable";
      return;
    }

    $("weatherIcon").textContent = weatherIcon(w.icon, w.isDay);
    $("weatherTemp").textContent = `${w.temperature}°${w.unit}`;
    $("weatherCond").textContent = w.condition;
    $("weatherCity").textContent = w.city + (w.stale ? " (cached)" : "");
  }

  function renderWeatherModal() {
    const body = $("weatherModalBody");
    const w = state.weather;
    if (!w || !w.ok) {
      body.innerHTML = `<p style="color:#cbd5e1">Weather data is currently unavailable (${w?.error || "check internet connection or city name"}).</p>`;
      return;
    }

    const daysHtml = (w.forecast || [])
      .map((d, idx) => {
        const dt = new Date(d.date + "T12:00:00");
        const label = idx === 0 ? "Today" : dt.toLocaleDateString([], { weekday: "short" });
        return `
          <div class="forecast-day">
            <div class="forecast-day-name">${label}</div>
            <div class="forecast-day-icon">${weatherIcon(d.icon, true)}</div>
            <div class="forecast-day-temps">${d.max ?? "--"}°<span>${d.min ?? "--"}°</span></div>
          </div>
        `;
      })
      .join("");

    body.innerHTML = `
      <div class="weather-hero">
        <div class="weather-hero-left">
          <div class="weather-hero-icon">${weatherIcon(w.icon, w.isDay)}</div>
          <div>
            <div class="weather-hero-temp">${w.temperature}°${w.unit}</div>
            <div class="weather-hero-meta">${w.condition} · ${w.city}</div>
          </div>
        </div>
        <div class="weather-hero-stats">
          <div>Feels like: <strong>${w.feelsLike}°${w.unit}</strong></div>
          <div>Humidity: <strong>${w.humidity ?? "--"}%</strong></div>
          <div>Wind: <strong>${w.windKmh ?? "--"} km/h</strong></div>
        </div>
      </div>
      <div class="forecast-grid">${daysHtml}</div>
    `;
  }

  /* ---------- System Status ---------- */
  async function loadSystemStatus() {
    try {
      const sys = await apiGet("/api/system");
      const netDot = $("netDot");
      const netLabel = $("netLabel");
      netDot.classList.toggle("offline", !sys.online);
      netLabel.textContent = sys.online ? "Online" : "Offline";

      $("tempChip").textContent = sys.cpuTempC != null ? `${sys.cpuTempC}°C` : "Pi";
      if (sys.volume != null) {
        $("volIcon").textContent = sys.muted || sys.volume === 0 ? "🔇" : sys.volume < 45 ? "🔉" : "🔊";
        $("volLabel").textContent = sys.muted ? "Mute" : `${sys.volume}%`;
      } else {
        $("volLabel").textContent = "Audio";
      }
    } catch {
      // Ignore transient errors
    }
  }

  /* ---------- Live Background Running Apps ---------- */
  function rebuildFocusRows(preserveElement = null) {
    const pills = Array.from(document.querySelectorAll("#sectionPills .section-pill"));
    const topbarRow = [...pills];
    if (!$("runningPillBtn").classList.contains("hidden")) {
      topbarRow.push($("runningPillBtn"));
    }
    topbarRow.push($("volBtn"), $("weatherWidget"), $("settingsBtn"), $("powerBtn"));

    const rows = [topbarRow];
    const runningControls = Array.from(document.querySelectorAll("#runningBarList .focusable"));
    if (runningControls.length > 0 && !$("runningBar").classList.contains("hidden")) {
      rows.push(runningControls);
      state.sectionRowOffset = 2;
    } else {
      state.sectionRowOffset = 1;
    }

    document.querySelectorAll("#sectionsContainer .tv-section").forEach((secEl, idx) => {
      const cards = Array.from(secEl.querySelectorAll(".app-card"));
      if (cards.length > 0) {
        const targetRow = state.sectionRowOffset + idx;
        cards.forEach((card, cIdx) => {
          card.dataset.rowIdx = String(targetRow);
          card.dataset.colIdx = String(cIdx);
        });
        rows.push(cards);
      }
    });

    state.rows = rows;

    // Keep focus stable on the exact same element if still present
    if (preserveElement && document.contains(preserveElement)) {
      for (let r = 0; r < rows.length; r++) {
        const c = rows[r].indexOf(preserveElement);
        if (c !== -1) {
          state.rowIndex = r;
          state.colIndex = c;
          state.lastColPerRow[r] = c;
          return;
        }
      }
    }
    state.rowIndex = Math.max(0, Math.min(state.rowIndex, rows.length - 1));
    const rowLen = rows[state.rowIndex]?.length || 1;
    state.colIndex = Math.max(0, Math.min(state.colIndex, rowLen - 1));
  }

  function syncRunningBadges() {
    document.querySelectorAll(".app-card").forEach((card) => {
      const isOpen = state.runningItemIds.has(card.dataset.itemId);
      card.classList.toggle("is-running", isOpen);
    });
  }

  async function focusRunningWindow(win) {
    showToast(`Switching to ${win.name}…`);
    try {
      const res = await apiPost("/api/window", {
        action: "focus",
        appId: win.appId,
        title: win.title,
        itemId: win.itemId,
        pid: win.pid,
      });
      if (!res.ok) {
        showToast(res.message || "Could not focus window", 3000);
      }
    } catch {
      showToast("Backend unreachable", 3000);
    }
  }

  async function closeRunningWindow(win) {
    showToast(`Closing ${win.name}…`);
    try {
      const res = await apiPost("/api/window", {
        action: "close",
        appId: win.appId,
        title: win.title,
        itemId: win.itemId,
        pid: win.pid,
      });
      showToast(res.message || (res.ok ? `Closed ${win.name}` : "Could not close"), 2600);
      setTimeout(loadRunningApps, 450);
    } catch {
      showToast("Backend unreachable", 3000);
    }
  }

  function renderRunningBar() {
    const bar = $("runningBar");
    const list = $("runningBarList");
    const pill = $("runningPillBtn");
    const wins = state.runningWindows;
    const prevFocused = state.rows[state.rowIndex]?.[state.colIndex] || null;
    const wasInRunningBar = prevFocused && prevFocused.closest("#runningBarList");

    list.innerHTML = "";
    syncRunningBadges();

    if (!wins.length) {
      bar.classList.add("hidden");
      pill.classList.add("hidden");
      rebuildFocusRows(wasInRunningBar ? null : prevFocused);
      if (wasInRunningBar && !state.activeModal) {
        focusPosition(Math.min(state.sectionRowOffset, state.rows.length - 1), 0);
      }
      return;
    }

    pill.classList.remove("hidden");
    $("runningPillLabel").textContent = `${wins.length} Running`;
    $("runningBarCount").textContent = String(wins.length);
    bar.classList.remove("hidden");

    wins.forEach((win) => {
      const group = document.createElement("div");
      group.className = "running-item-group";

      const chip = document.createElement("button");
      chip.className = "running-chip focusable";
      chip.dataset.runningKey = win.key;
      chip.title = `Switch to ${win.name} — ${win.title}`;

      if (win.icon && win.icon !== "youtube") {
        const img = document.createElement("img");
        img.className = "running-chip-icon";
        img.alt = "";
        img.src = `/api/icon?name=${encodeURIComponent(win.icon)}`;
        img.onerror = () => {
          const fb = document.createElement("span");
          fb.className = "running-chip-fallback";
          fb.textContent = (win.name || "?").slice(0, 2).toUpperCase();
          img.replaceWith(fb);
        };
        chip.appendChild(img);
      } else {
        const fb = document.createElement("span");
        fb.className = "running-chip-fallback";
        fb.textContent = (win.name || "?").slice(0, 2).toUpperCase();
        chip.appendChild(fb);
      }

      const textWrap = document.createElement("span");
      textWrap.className = "running-chip-text";
      const nameEl = document.createElement("span");
      nameEl.className = "running-chip-name";
      nameEl.textContent = win.name;
      const titleEl = document.createElement("span");
      titleEl.className = "running-chip-title";
      titleEl.textContent = win.title !== win.name ? win.title : "Open in background";
      textWrap.appendChild(nameEl);
      textWrap.appendChild(titleEl);
      chip.appendChild(textWrap);

      chip.addEventListener("click", () => focusRunningWindow(win));
      group.appendChild(chip);

      if (win.canClose) {
        const closeBtn = document.createElement("button");
        closeBtn.className = "running-close-btn focusable";
        closeBtn.textContent = "✕";
        closeBtn.title = `Close ${win.name}`;
        closeBtn.setAttribute("aria-label", `Close ${win.name}`);
        closeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          closeRunningWindow(win);
        });
        group.appendChild(closeBtn);
      }

      list.appendChild(group);
    });

    rebuildFocusRows(wasInRunningBar ? null : prevFocused);
    if (wasInRunningBar && !state.activeModal) {
      focusPosition(1, Math.min(state.colIndex, (state.rows[1]?.length || 1) - 1), { scroll: false });
    }
  }

  async function loadRunningApps() {
    try {
      const data = await apiGet("/api/running");
      if (!data || !data.ok) return;
      const wins = data.windows || [];
      const ids = data.runningItemIds || [];
      const sig = JSON.stringify({
        w: wins.map((w) => [w.appId, w.title, w.itemId, w.canClose]),
        ids,
      });
      if (sig === state.runningSignature) return;
      state.runningSignature = sig;
      state.runningWindows = wins;
      state.runningItemIds = new Set(ids);
      renderRunningBar();
    } catch {
      // Ignore transient polling errors
    }
  }

  /* ---------- Render Sections & Cards ---------- */
  function buildIconNode(item) {
    const wrap = document.createElement("div");
    wrap.className = "app-icon-wrap";

    const createFallback = () => {
      const glyph = FALLBACK_GLYPH[item.icon];
      if (glyph && glyph.startsWith("<svg")) {
        wrap.innerHTML = glyph;
      } else {
        const fallback = document.createElement("span");
        fallback.className = "app-icon-fallback";
        fallback.textContent = glyph || item.name.slice(0, 2).toUpperCase();
        wrap.appendChild(fallback);
      }
    };

    if (item.icon && item.icon !== "youtube") {
      const img = document.createElement("img");
      img.className = "app-icon-img";
      img.alt = "";
      img.loading = "lazy";
      img.src = `/api/icon?name=${encodeURIComponent(item.icon)}`;
      img.onerror = () => {
        img.remove();
        createFallback();
      };
      wrap.appendChild(img);
    } else {
      createFallback();
    }
    return wrap;
  }

  function renderUI() {
    const cfg = state.config;
    $("brandTitle").textContent = cfg.title || "Pi TV";
    document.title = cfg.title || "Pi TV";

    const pillsEl = $("sectionPills");
    const containerEl = $("sectionsContainer");
    pillsEl.innerHTML = "";
    containerEl.innerHTML = "";

    const sections = cfg.sections || [];
    sections.forEach((sec, sIdx) => {
      const pill = document.createElement("button");
      pill.className = "section-pill focusable";
      pill.textContent = sec.title;
      pill.dataset.jumpSection = String(sIdx);
      pill.addEventListener("click", () => focusPosition(state.sectionRowOffset + sIdx, 0));
      pillsEl.appendChild(pill);
    });

    sections.forEach((sec, sIdx) => {
      const sectionEl = document.createElement("section");
      sectionEl.className = "tv-section";
      sectionEl.dataset.sectionIndex = String(sIdx);

      const header = document.createElement("div");
      header.className = "section-header";
      const emoji = SECTION_EMOJI[sec.icon] || "⭐";
      header.innerHTML = `
        <h2 class="section-title"><span>${emoji}</span><span>${sec.title}</span></h2>
        <span class="section-count">${(sec.items || []).length} items</span>
      `;
      sectionEl.appendChild(header);

      const rowEl = document.createElement("div");
      rowEl.className = "cards-row";

      (sec.items || []).forEach((item) => {
        const card = document.createElement("button");
        card.className = "app-card focusable";
        card.style.setProperty("--card-accent", item.accent || "#38bdf8");
        card.dataset.itemId = item.id;
        card.dataset.sectionTitle = sec.title;

        const top = document.createElement("div");
        top.className = "app-card-top";
        top.appendChild(buildIconNode(item));

        const badges = document.createElement("div");
        badges.className = "app-card-badges";
        if (item.badge) {
          const badge = document.createElement("span");
          badge.className = "app-badge";
          badge.textContent = item.badge;
          badges.appendChild(badge);
        }
        const runTag = document.createElement("span");
        runTag.className = "app-card-running-tag";
        runTag.innerHTML = `<span class="running-dot" style="width:6px;height:6px"></span>OPEN`;
        badges.appendChild(runTag);
        top.appendChild(badges);

        const bottom = document.createElement("div");
        bottom.className = "app-card-bottom";
        bottom.innerHTML = `
          <div class="app-name">${item.name}</div>
          <div class="app-subtitle">${item.subtitle || ""}</div>
        `;

        card.appendChild(top);
        card.appendChild(bottom);

        card.addEventListener("mouseenter", () => {
          if (!state.activeModal) {
            const r = Number(card.dataset.rowIdx);
            const c = Number(card.dataset.colIdx);
            if (!Number.isNaN(r) && !Number.isNaN(c)) {
              focusPosition(r, c, { scroll: false });
            }
          }
        });
        card.addEventListener("click", () => launchTile(item, card));

        rowEl.appendChild(card);
      });

      sectionEl.appendChild(rowEl);
      containerEl.appendChild(sectionEl);
    });

    rebuildFocusRows();
    syncRunningBadges();

    // Focus first item in first section (only when no modal is open)
    if (!state.activeModal) {
      const startRow = state.rows.length > state.sectionRowOffset ? state.sectionRowOffset : 0;
      focusPosition(startRow, 0);
    }
  }

  /* ---------- Spatial Focus Engine ---------- */
  function clearFocusedClass() {
    document.querySelectorAll(".is-focused").forEach((el) => el.classList.remove("is-focused"));
  }

  function updateSpotlightForElement(el, rowIdx) {
    // Highlight active section pill
    const activeSecIdx = rowIdx - state.sectionRowOffset;
    document.querySelectorAll(".section-pill").forEach((pill, i) => {
      pill.classList.toggle("active", i === activeSecIdx);
    });

    if (el && el.classList.contains("running-chip")) {
      const win = state.runningWindows.find((w) => w.key === el.dataset.runningKey);
      if (win) {
        $("spotlightSection").textContent = "Running in Background";
        $("spotlightBadge").textContent = "LIVE";
        $("spotlightTitle").textContent = win.name;
        $("spotlightSubtitle").textContent = `${win.title} · Press Enter to switch`;
        document.documentElement.style.setProperty("--accent", win.accent || "#22c55e");
        document.documentElement.style.setProperty("--accent-glow", `${win.accent || "#22c55e"}66`);
      }
      return;
    }

    if (!el || !el.classList.contains("app-card")) return;

    const itemId = el.dataset.itemId;
    const sectionTitle = el.dataset.sectionTitle || "";
    let found = null;
    for (const sec of state.config?.sections || []) {
      found = (sec.items || []).find((it) => it.id === itemId);
      if (found) break;
    }
    if (!found) return;

    const isOpen = state.runningItemIds.has(found.id);
    $("spotlightSection").textContent = sectionTitle;
    $("spotlightBadge").textContent = isOpen ? "OPEN" : found.badge || "APP";
    $("spotlightTitle").textContent = found.name;
    $("spotlightSubtitle").textContent =
      (found.subtitle || "Press Enter to launch") + (isOpen ? " · Already running in background" : "");

    if (found.accent) {
      document.documentElement.style.setProperty("--accent", found.accent);
      document.documentElement.style.setProperty("--accent-glow", `${found.accent}66`);
    }
  }

  function focusPosition(rowIdx, colIdx, opts = { scroll: true }) {
    if (!state.rows.length) return;
    const r = Math.max(0, Math.min(rowIdx, state.rows.length - 1));
    const row = state.rows[r];
    if (!row || !row.length) return;

    const c = Math.max(0, Math.min(colIdx, row.length - 1));
    state.rowIndex = r;
    state.colIndex = c;
    state.lastColPerRow[r] = c;

    clearFocusedClass();
    const el = row[c];
    el.classList.add("is-focused");
    el.focus({ preventScroll: true });

    if (opts.scroll) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      if (r >= 1) {
        const secEl = el.closest(".tv-section");
        if (secEl) {
          secEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      }
    }

    updateSpotlightForElement(el, r);
  }

  async function launchTile(item, cardEl) {
    if (cardEl) {
      cardEl.classList.add("launching");
      setTimeout(() => cardEl.classList.remove("launching"), 380);
    }
    showToast(`Launching ${item.name}…`);
    try {
      const res = await apiPost("/api/launch", { id: item.id });
      if (!res.ok) {
        showToast(`Error: ${res.message || "Could not launch"}`, 3600);
      } else {
        setTimeout(loadRunningApps, 900);
      }
    } catch {
      showToast("Backend unreachable", 3200);
    }
  }

  /* ---------- Modals ---------- */
  function getModalFocusables(modalId) {
    const modal = $(modalId);
    if (!modal) return [];
    return Array.from(modal.querySelectorAll(".focusable")).filter((el) => !el.disabled);
  }

  function openModal(modalId) {
    closeAllModals(false);
    const modal = $(modalId);
    if (!modal) return;

    if (modalId === "weatherModal") {
      renderWeatherModal();
    } else if (modalId === "settingsModal") {
      $("inputCity").value = state.config?.weather?.city || "";
      $("inputUnit").value = state.config?.weather?.unit || "C";
      $("inputClock24").value = String(state.config?.clock?.hour24 ?? true);
      $("inputShowSeconds").checked = Boolean(state.config?.clock?.showSeconds);
    } else if (modalId === "appsModal") {
      populateAppsSectionSelect();
      $("appsSearchInput").value = "";
      state.appsSearch = "";
      state.appsFilter = "available";
      syncAppsFilterTabs();
      loadInstalledApps();
    } else if (modalId === "powerModal") {
      state.confirmPowerAction = null;
      resetPowerLabels();
    }

    modal.classList.remove("hidden");
    state.activeModal = modalId;
    state.modalFocusIndex = 0;

    const focusables = getModalFocusables(modalId);
    // Prefer first primary/content control rather than close X
    const preferredIdx = focusables.length > 1 ? 1 : 0;
    focusModalElement(preferredIdx);
  }

  function focusModalElement(idx) {
    if (!state.activeModal) return;
    const focusables = getModalFocusables(state.activeModal);
    if (!focusables.length) return;
    const safeIdx = ((idx % focusables.length) + focusables.length) % focusables.length;
    state.modalFocusIndex = safeIdx;
    clearFocusedClass();
    const el = focusables[safeIdx];
    el.classList.add("is-focused");
    el.focus({ preventScroll: true });
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closeAllModals(restoreFocus = true) {
    ["weatherModal", "settingsModal", "appsModal", "powerModal"].forEach((id) => {
      $(id).classList.add("hidden");
    });
    state.activeModal = null;
    state.confirmPowerAction = null;
    if (restoreFocus) {
      focusPosition(state.rowIndex, state.colIndex);
    }
  }

  /* ---------- Installed Apps Picker ---------- */
  function populateAppsSectionSelect() {
    const sel = $("appsTargetSection");
    sel.innerHTML = `<option value="auto">Auto (Smart)</option>`;
    for (const sec of state.config?.sections || []) {
      const opt = document.createElement("option");
      opt.value = sec.id;
      opt.textContent = sec.title;
      sel.appendChild(opt);
    }
    sel.value = state.appsTargetSection || "auto";
    if (!sel.value) sel.value = "auto";
  }

  function syncAppsFilterTabs() {
    document.querySelectorAll("#appsFilterTabs .apps-tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.appsFilter === state.appsFilter);
    });
  }

  function sectionTitleById(secId) {
    const sec = (state.config?.sections || []).find((s) => s.id === secId);
    return sec ? sec.title : secId || "Apps & Tools";
  }

  async function loadInstalledApps() {
    const list = $("appsPickerList");
    $("appsModalCount").textContent = "Scanning…";
    list.innerHTML = `<div class="picker-empty">Scanning installed Raspberry Pi apps &amp; games…</div>`;
    try {
      const data = await apiGet("/api/installed-apps");
      if (!data || !data.ok) {
        list.innerHTML = `<div class="picker-empty">Could not scan installed apps.</div>`;
        return;
      }
      state.installedApps = data.apps || [];
      renderInstalledApps();
    } catch {
      list.innerHTML = `<div class="picker-empty">Backend unreachable.</div>`;
    }
  }

  async function addInstalledApp(app, btnEl) {
    const chosenSection =
      state.appsTargetSection && state.appsTargetSection !== "auto"
        ? state.appsTargetSection
        : app.suggestedSection;
    if (btnEl) btnEl.disabled = true;
    try {
      const res = await apiPost("/api/apps/add", {
        sectionId: chosenSection,
        app: {
          suggestedId: app.suggestedId,
          name: app.name,
          subtitle: app.subtitle,
          icon: app.icon,
          accent: app.accent,
          badge: app.badge,
          command: app.command,
          cwd: app.cwd,
        },
      });
      if (!res.ok) {
        showToast(res.message || "Could not add app", 3200);
        if (btnEl) btnEl.disabled = false;
        return;
      }
      state.config = res.config;
      renderUI();
      app.alreadyAdded = true;
      app.existingItemId = res.item?.id || app.suggestedId;
      app.addedSectionId = res.sectionId;
      app.addedSectionTitle = res.sectionTitle;
      showToast(res.message || `Added ${app.name}`);
      renderInstalledApps(true);
    } catch {
      showToast("Backend unreachable", 3000);
      if (btnEl) btnEl.disabled = false;
    }
  }

  async function removeInstalledApp(app, btnEl) {
    if (!app.existingItemId) return;
    if (btnEl) btnEl.disabled = true;
    try {
      const res = await apiPost("/api/apps/remove", { id: app.existingItemId });
      if (!res.ok) {
        showToast(res.message || "Could not remove app", 3200);
        if (btnEl) btnEl.disabled = false;
        return;
      }
      state.config = res.config;
      renderUI();
      app.alreadyAdded = false;
      app.existingItemId = null;
      app.addedSectionId = null;
      app.addedSectionTitle = null;
      showToast(res.message || `Removed ${app.name}`);
      renderInstalledApps(true);
    } catch {
      showToast("Backend unreachable", 3000);
      if (btnEl) btnEl.disabled = false;
    }
  }

  function renderInstalledApps(preserveModalFocus = false) {
    const list = $("appsPickerList");
    const q = state.appsSearch.trim().toLowerCase();
    const filter = state.appsFilter;

    const totalAvailable = state.installedApps.filter((a) => !a.alreadyAdded).length;
    const totalAdded = state.installedApps.length - totalAvailable;
    $("appsModalCount").textContent = `${totalAvailable} new · ${totalAdded} on home`;

    const filtered = state.installedApps.filter((app) => {
      if (filter === "available" && app.alreadyAdded) return false;
      if (filter === "added" && !app.alreadyAdded) return false;
      if (filter === "games" && app.categoryGroup !== "games") return false;
      if (filter === "media" && app.categoryGroup !== "media") return false;
      if (filter === "apps" && app.categoryGroup !== "apps") return false;
      if (q) {
        const hay = `${app.name} ${app.subtitle} ${app.badge} ${(app.command || []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    list.innerHTML = "";
    if (!filtered.length) {
      const msg = q
        ? `No installed apps matching "${state.appsSearch}".`
        : filter === "available"
        ? "All detected apps are already on your home screen."
        : "No apps found in this category.";
      list.innerHTML = `<div class="picker-empty">${msg}</div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    filtered.forEach((app) => {
      const row = document.createElement("div");
      row.className = "picker-row" + (app.alreadyAdded ? " is-added" : "");

      const iconWrap = document.createElement("div");
      iconWrap.className = "picker-icon-wrap";
      const makeFallback = () => {
        const fb = document.createElement("span");
        fb.className = "picker-icon-fallback";
        fb.textContent = (app.name || "?").slice(0, 2).toUpperCase();
        iconWrap.appendChild(fb);
      };
      if (app.icon) {
        const img = document.createElement("img");
        img.className = "picker-icon-img";
        img.alt = "";
        img.loading = "lazy";
        img.src = `/api/icon?name=${encodeURIComponent(app.icon)}`;
        img.onerror = () => {
          img.remove();
          makeFallback();
        };
        iconWrap.appendChild(img);
      } else {
        makeFallback();
      }
      row.appendChild(iconWrap);

      const info = document.createElement("div");
      info.className = "picker-info";

      const titleLine = document.createElement("div");
      titleLine.className = "picker-title-line";
      const nameEl = document.createElement("span");
      nameEl.className = "picker-name";
      nameEl.textContent = app.name;
      titleLine.appendChild(nameEl);
      if (app.badge) {
        const badgeEl = document.createElement("span");
        badgeEl.className = "picker-badge";
        badgeEl.textContent = app.badge;
        titleLine.appendChild(badgeEl);
      }
      info.appendChild(titleLine);

      const subEl = document.createElement("div");
      subEl.className = "picker-sub";
      subEl.textContent = app.subtitle || "";
      info.appendChild(subEl);

      const metaEl = document.createElement("div");
      metaEl.className = "picker-meta";
      if (app.alreadyAdded) {
        metaEl.textContent = `✓ In ${app.addedSectionTitle || sectionTitleById(app.addedSectionId)}`;
      } else {
        const destId =
          state.appsTargetSection && state.appsTargetSection !== "auto"
            ? state.appsTargetSection
            : app.suggestedSection;
        metaEl.textContent = `→ ${sectionTitleById(destId)}`;
      }
      info.appendChild(metaEl);
      row.appendChild(info);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "picker-action-btn focusable" + (app.alreadyAdded ? " remove" : "");
      btn.textContent = app.alreadyAdded ? "✕ Remove" : "+ Add";
      btn.addEventListener("click", () => {
        if (app.alreadyAdded) {
          removeInstalledApp(app, btn);
        } else {
          addInstalledApp(app, btn);
        }
      });
      row.appendChild(btn);

      frag.appendChild(row);
    });
    list.appendChild(frag);

    if (preserveModalFocus && state.activeModal === "appsModal") {
      const focusables = getModalFocusables("appsModal");
      if (focusables.length) {
        focusModalElement(Math.min(state.modalFocusIndex, focusables.length - 1));
      }
    }
  }

  function resetPowerLabels() {
    document.querySelectorAll(".power-tile").forEach((tile) => {
      const act = tile.dataset.power;
      const desc = tile.querySelector(".power-desc");
      if (act === "reboot") desc.textContent = "Restart Raspberry Pi";
      if (act === "shutdown") desc.textContent = "Safely shut down Pi";
    });
  }

  async function runPowerAction(action, tileEl) {
    if (action === "reload_ui") {
      closeAllModals(false);
      showToast("Reloading TV UI…");
      window.location.reload();
      return;
    }

    if ((action === "reboot" || action === "shutdown") && state.confirmPowerAction !== action) {
      state.confirmPowerAction = action;
      resetPowerLabels();
      if (tileEl) {
        tileEl.querySelector(".power-desc").textContent = "Press Enter again to confirm!";
      }
      showToast(`Press again to confirm ${action}`);
      return;
    }

    const res = await apiPost("/api/power", { action });
    showToast(res.message || action);
    if (action === "exit_kiosk") {
      window.close();
    }
  }

  /* ---------- Topbar Button Bindings ---------- */
  function bindStaticControls() {
    $("runningPillBtn").addEventListener("click", () => {
      if (state.sectionRowOffset === 2 && state.rows[1]?.length) {
        focusPosition(1, 0);
      }
    });

    $("volBtn").addEventListener("click", async () => {
      await apiPost("/api/power", { action: "volume_mute" });
      await loadSystemStatus();
    });

    $("weatherWidget").addEventListener("click", () => openModal("weatherModal"));
    $("settingsBtn").addEventListener("click", () => openModal("settingsModal"));
    $("powerBtn").addEventListener("click", () => openModal("powerModal"));

    $("refreshWeatherBtn").addEventListener("click", async () => {
      showToast("Refreshing weather…");
      await loadWeather(true);
      renderWeatherModal();
      showToast("Weather updated");
    });

    $("weatherToSettingsBtn").addEventListener("click", () => openModal("settingsModal"));
    $("openAppsPickerBtn").addEventListener("click", () => openModal("appsModal"));
    $("rescanAppsBtn").addEventListener("click", () => {
      loadInstalledApps();
      showToast("Rescanned installed apps");
    });
    $("appsSearchInput").addEventListener("input", (e) => {
      state.appsSearch = e.target.value;
      renderInstalledApps(false);
    });
    $("appsTargetSection").addEventListener("change", (e) => {
      state.appsTargetSection = e.target.value;
      renderInstalledApps(false);
    });
    document.querySelectorAll("#appsFilterTabs .apps-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        state.appsFilter = tab.dataset.appsFilter || "available";
        syncAppsFilterTabs();
        renderInstalledApps(false);
      });
    });

    $("reloadConfigBtn").addEventListener("click", async () => {
      closeAllModals(false);
      await initApp();
      showToast("Reloaded config.json");
    });

    $("settingsForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        weather: {
          city: $("inputCity").value.trim(),
          unit: $("inputUnit").value,
        },
        clock: {
          hour24: $("inputClock24").value === "true",
          showSeconds: $("inputShowSeconds").checked,
        },
      };
      showToast("Saving settings…");
      const res = await apiPost("/api/settings", payload);
      if (res.ok) {
        state.config = res.config;
        state.weather = res.weather;
        updateClock();
        renderWeather();
        closeAllModals(true);
        showToast("Settings saved");
      } else {
        showToast("Failed to save settings");
      }
    });

    document.querySelectorAll("[data-close-modal]").forEach((btn) => {
      btn.addEventListener("click", () => closeAllModals(true));
    });

    document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) closeAllModals(true);
      });
    });

    document.querySelectorAll(".power-tile").forEach((tile) => {
      tile.addEventListener("click", () => runPowerAction(tile.dataset.power, tile));
    });
  }

  /* ---------- Keyboard & TV Remote Navigation ---------- */
  function handleNavigationKey(e) {
    const key = e.key;
    const isTyping =
      document.activeElement &&
      (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "SELECT");

    // Inside a modal
    if (state.activeModal) {
      if (key === "Escape" || (key === "Backspace" && !isTyping)) {
        e.preventDefault();
        closeAllModals(true);
        return;
      }
      if (isTyping && key !== "ArrowDown" && key !== "ArrowUp" && key !== "Tab") {
        return;
      }
      if (key === "ArrowRight" || key === "ArrowDown") {
        e.preventDefault();
        focusModalElement(state.modalFocusIndex + 1);
      } else if (key === "ArrowLeft" || key === "ArrowUp") {
        e.preventDefault();
        focusModalElement(state.modalFocusIndex - 1);
      } else if (key === "Enter" && !isTyping) {
        e.preventDefault();
        const focusables = getModalFocusables(state.activeModal);
        focusables[state.modalFocusIndex]?.click();
      }
      return;
    }

    // Main TV UI navigation
    if (key === "ArrowRight") {
      e.preventDefault();
      focusPosition(state.rowIndex, state.colIndex + 1);
    } else if (key === "ArrowLeft") {
      e.preventDefault();
      focusPosition(state.rowIndex, state.colIndex - 1);
    } else if (key === "ArrowDown") {
      e.preventDefault();
      const nextRow = Math.min(state.rows.length - 1, state.rowIndex + 1);
      const targetCol = state.lastColPerRow[nextRow] ?? 0;
      focusPosition(nextRow, targetCol);
    } else if (key === "ArrowUp") {
      e.preventDefault();
      const prevRow = Math.max(0, state.rowIndex - 1);
      const targetCol = state.lastColPerRow[prevRow] ?? 0;
      focusPosition(prevRow, targetCol);
    } else if (key === "PageDown" || key === "]") {
      e.preventDefault();
      focusPosition(Math.min(state.rows.length - 1, Math.max(state.sectionRowOffset, state.rowIndex + 1)), 0);
    } else if (key === "PageUp" || key === "[") {
      e.preventDefault();
      focusPosition(Math.max(state.sectionRowOffset, state.rowIndex - 1), 0);
    } else if (key === "Home") {
      e.preventDefault();
      focusPosition(state.sectionRowOffset, 0);
    } else if (key === "Enter" || key === " ") {
      e.preventDefault();
      const el = state.rows[state.rowIndex]?.[state.colIndex];
      el?.click();
    } else if (key === "Escape" || key === "Backspace") {
      e.preventDefault();
      if (state.rowIndex === state.sectionRowOffset && state.colIndex === 0) {
        openModal("powerModal");
      } else {
        focusPosition(state.sectionRowOffset, 0);
      }
    } else if (key === "+" || key === "=" || key === "AudioVolumeUp") {
      e.preventDefault();
      apiPost("/api/power", { action: "volume_up" }).then(loadSystemStatus);
    } else if (key === "-" || key === "_" || key === "AudioVolumeDown") {
      e.preventDefault();
      apiPost("/api/power", { action: "volume_down" }).then(loadSystemStatus);
    } else if (key.toLowerCase() === "m" || key === "AudioVolumeMute") {
      e.preventDefault();
      apiPost("/api/power", { action: "volume_mute" }).then(loadSystemStatus);
    }
  }

  /* ---------- Optional Gamepad Support (Event-Driven, 0% Idle CPU) ---------- */
  let lastPadMove = 0;
  let lastButtons = [];
  let gamepadLoopId = null;

  function hasConnectedGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return Array.from(pads).some((p) => p && p.connected);
  }

  function startGamepadLoop() {
    if (gamepadLoopId !== null || document.hidden || !hasConnectedGamepad()) return;
    gamepadLoopId = requestAnimationFrame(pollGamepads);
  }

  function stopGamepadLoop() {
    if (gamepadLoopId !== null) {
      cancelAnimationFrame(gamepadLoopId);
      gamepadLoopId = null;
    }
  }

  function pollGamepads() {
    gamepadLoopId = null;
    if (document.hidden) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected);
    if (!pad) return;

    const now = performance.now();
    const axX = pad.axes[0] || 0;
    const axY = pad.axes[1] || 0;
    const up = pad.buttons[12]?.pressed || axY < -0.6;
    const down = pad.buttons[13]?.pressed || axY > 0.6;
    const left = pad.buttons[14]?.pressed || axX < -0.6;
    const right = pad.buttons[15]?.pressed || axX > 0.6;

    if (now - lastPadMove > 180) {
      if (up) {
        handleNavigationKey({ key: "ArrowUp", preventDefault() {} });
        lastPadMove = now;
      } else if (down) {
        handleNavigationKey({ key: "ArrowDown", preventDefault() {} });
        lastPadMove = now;
      } else if (left) {
        handleNavigationKey({ key: "ArrowLeft", preventDefault() {} });
        lastPadMove = now;
      } else if (right) {
        handleNavigationKey({ key: "ArrowRight", preventDefault() {} });
        lastPadMove = now;
      }
    }

    const btnA = Boolean(pad.buttons[0]?.pressed);
    const btnB = Boolean(pad.buttons[1]?.pressed);
    if (btnA && !lastButtons[0]) handleNavigationKey({ key: "Enter", preventDefault() {} });
    if (btnB && !lastButtons[1]) handleNavigationKey({ key: "Escape", preventDefault() {} });
    lastButtons = [btnA, btnB];

    gamepadLoopId = requestAnimationFrame(pollGamepads);
  }

  /* ---------- Auto-Hide Mouse Cursor for TV Mode ---------- */
  let cursorHideTimer = null;
  function showCursorTemporarily() {
    document.body.classList.remove("cursor-hidden");
    clearTimeout(cursorHideTimer);
    cursorHideTimer = setTimeout(() => {
      document.body.classList.add("cursor-hidden");
    }, 3000);
  }

  function hideCursorNow() {
    clearTimeout(cursorHideTimer);
    document.body.classList.add("cursor-hidden");
  }

  /* ---------- Init ---------- */
  async function initApp() {
    state.config = await apiGet("/api/config");
    state.runningSignature = "";
    renderUI();
    updateClock();
    await Promise.all([loadWeather(false), loadSystemStatus(), loadRunningApps()]);
  }

  bindStaticControls();
  window.addEventListener("mousemove", showCursorTemporarily, { passive: true });
  window.addEventListener("mousedown", showCursorTemporarily, { passive: true });
  window.addEventListener("keydown", (e) => {
    if (e.key.startsWith("Arrow") || e.key === "Enter" || e.key === "Escape") {
      hideCursorNow();
    }
    handleNavigationKey(e);
  });

  window.addEventListener("gamepadconnected", startGamepadLoop);
  window.addEventListener("gamepaddisconnected", () => {
    if (!hasConnectedGamepad()) stopGamepadLoop();
  });

  let lastSystemPollAt = 0;
  let lastRunningPollAt = 0;

  async function pollSystemIfDue(force = false) {
    if (document.hidden) return;
    const now = Date.now();
    const intervalMs = document.hasFocus() ? 15 * 1000 : 60 * 1000;
    if (!force && now - lastSystemPollAt < intervalMs) return;
    lastSystemPollAt = now;
    await loadSystemStatus();
  }

  async function pollRunningIfDue(force = false) {
    if (document.hidden) return;
    const now = Date.now();
    const intervalMs = document.hasFocus() ? 5000 : 30 * 1000;
    if (!force && now - lastRunningPollAt < intervalMs) return;
    lastRunningPollAt = now;
    await loadRunningApps();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopGamepadLoop();
      stopClockTimer();
    } else {
      updateClock();
      pollSystemIfDue(true);
      pollRunningIfDue(true);
      startGamepadLoop();
    }
  });

  window.addEventListener("focus", () => {
    if (!document.hidden) {
      updateClock();
      pollRunningIfDue(true);
      pollSystemIfDue(false);
    }
  });

  initApp().then(() => {
    lastSystemPollAt = Date.now();
    lastRunningPollAt = Date.now();
    showCursorTemporarily();
    setInterval(() => {
      if (!document.hidden) loadWeather(false);
    }, 10 * 60 * 1000);
    setInterval(() => {
      pollSystemIfDue(false);
    }, 15 * 1000);
    setInterval(() => {
      pollRunningIfDue(false);
    }, 5000);
    startGamepadLoop();
  });
})();
