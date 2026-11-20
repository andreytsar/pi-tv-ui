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
    youtube: `<svg viewBox="0 0 64 46" width="44" height="32" aria-hidden="true"><rect width="64" height="46" rx="12" fill="#ef4444"/><polygon points="26,14 26,32 43,23" fill="#ffffff"/></svg>`,
    vlc: "🎬",
    dosbox: "⚔️",
    "utilities-terminal": ">_",
  };

  const state = {
    config: null,
    weather: null,
    // Focus grid: row 0 = topbar controls, rows 1..N = sections
    rows: [],
    rowIndex: 1,
    colIndex: 0,
    lastColPerRow: {},
    activeModal: null,
    modalFocusIndex: 0,
    confirmPowerAction: null,
    toastTimer: null,
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

    $("clockTime").textContent = now.toLocaleTimeString([], timeOpts);
    $("clockDate").textContent = now.toLocaleDateString([], {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
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
      $("weatherIcon").textContent = "☁️";
      $("weatherTemp").textContent = "--°";
      $("weatherCond").textContent = w?.error ? "Not found" : "Offline";
      $("weatherCity").textContent = w?.error || "Click to configure";
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
    const topbarRow = [];

    sections.forEach((sec, sIdx) => {
      const pill = document.createElement("button");
      pill.className = "section-pill focusable";
      pill.textContent = sec.title;
      pill.dataset.jumpSection = String(sIdx + 1);
      pill.addEventListener("click", () => focusPosition(sIdx + 1, 0));
      pillsEl.appendChild(pill);
      topbarRow.push(pill);
    });

    topbarRow.push($("volBtn"), $("weatherWidget"), $("settingsBtn"), $("powerBtn"));

    state.rows = [topbarRow];

    sections.forEach((sec, sIdx) => {
      const sectionEl = document.createElement("section");
      sectionEl.className = "tv-section";
      sectionEl.dataset.sectionIndex = String(sIdx + 1);

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

      const cardNodes = [];
      (sec.items || []).forEach((item, cIdx) => {
        const card = document.createElement("button");
        card.className = "app-card focusable";
        card.style.setProperty("--card-accent", item.accent || "#38bdf8");
        card.dataset.itemId = item.id;
        card.dataset.sectionTitle = sec.title;
        card.dataset.rowIdx = String(sIdx + 1);
        card.dataset.colIdx = String(cIdx);

        const top = document.createElement("div");
        top.className = "app-card-top";
        top.appendChild(buildIconNode(item));

        if (item.badge) {
          const badge = document.createElement("span");
          badge.className = "app-badge";
          badge.textContent = item.badge;
          top.appendChild(badge);
        }

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
            focusPosition(sIdx + 1, cIdx, { scroll: false });
          }
        });
        card.addEventListener("click", () => launchTile(item, card));

        rowEl.appendChild(card);
        cardNodes.push(card);
      });

      sectionEl.appendChild(rowEl);
      containerEl.appendChild(sectionEl);
      if (cardNodes.length > 0) {
        state.rows.push(cardNodes);
      }
    });

    // Focus first item in first section
    const startRow = state.rows.length > 1 ? 1 : 0;
    focusPosition(startRow, 0);
  }

  /* ---------- Spatial Focus Engine ---------- */
  function clearFocusedClass() {
    document.querySelectorAll(".is-focused").forEach((el) => el.classList.remove("is-focused"));
  }

  function updateSpotlightForElement(el, rowIdx) {
    // Highlight active section pill
    document.querySelectorAll(".section-pill").forEach((pill, i) => {
      pill.classList.toggle("active", i + 1 === rowIdx);
    });

    if (!el || !el.classList.contains("app-card")) return;

    const itemId = el.dataset.itemId;
    const sectionTitle = el.dataset.sectionTitle || "";
    let found = null;
    for (const sec of state.config?.sections || []) {
      found = (sec.items || []).find((it) => it.id === itemId);
      if (found) break;
    }
    if (!found) return;

    $("spotlightSection").textContent = sectionTitle;
    $("spotlightBadge").textContent = found.badge || "APP";
    $("spotlightTitle").textContent = found.name;
    $("spotlightSubtitle").textContent = found.subtitle || "Press Enter to launch";

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
    el.focus();
  }

  function closeAllModals(restoreFocus = true) {
    ["weatherModal", "settingsModal", "powerModal"].forEach((id) => {
      $(id).classList.add("hidden");
    });
    state.activeModal = null;
    state.confirmPowerAction = null;
    if (restoreFocus) {
      focusPosition(state.rowIndex, state.colIndex);
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
      await initApp();
      showToast("TV UI reloaded");
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
      focusPosition(Math.min(state.rows.length - 1, Math.max(1, state.rowIndex + 1)), 0);
    } else if (key === "PageUp" || key === "[") {
      e.preventDefault();
      focusPosition(Math.max(1, state.rowIndex - 1), 0);
    } else if (key === "Home") {
      e.preventDefault();
      focusPosition(1, 0);
    } else if (key === "Enter" || key === " ") {
      e.preventDefault();
      const el = state.rows[state.rowIndex]?.[state.colIndex];
      el?.click();
    } else if (key === "Escape" || key === "Backspace") {
      e.preventDefault();
      if (state.rowIndex === 1 && state.colIndex === 0) {
        openModal("powerModal");
      } else {
        focusPosition(1, 0);
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

  /* ---------- Optional Gamepad Support (D-pad / Stick + A/B) ---------- */
  let lastPadMove = 0;
  let lastButtons = [];
  function pollGamepads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = Array.from(pads).find((p) => p && p.connected);
    if (pad) {
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
    }
    requestAnimationFrame(pollGamepads);
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
    renderUI();
    updateClock();
    await Promise.all([loadWeather(false), loadSystemStatus()]);
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

  initApp().then(() => {
    showCursorTemporarily();
    setInterval(updateClock, 1000);
    setInterval(() => loadWeather(false), 10 * 60 * 1000);
    setInterval(loadSystemStatus, 15 * 1000);
    requestAnimationFrame(pollGamepads);
  });
})();
