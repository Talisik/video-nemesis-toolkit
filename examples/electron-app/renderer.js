const { invoke, onDownloadQueuePushed, onScraperStatus, channels } = window.toolkit;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let selectedScheduleId = null;

function formatNextRun(iso) {
  if (!iso) return "";
  try {
    return "Next run: " + new Date(iso).toLocaleString();
  } catch {
    return "";
  }
}

function setScraperStatus(phase, nextRunAt) {
  const phaseEl = document.getElementById("statusPhase");
  const textEl = document.getElementById("statusPhaseText");
  const nextEl = document.getElementById("statusNextRun");
  phaseEl.className = "phase-dot phase-" + phase;
  const labels = { idle: "Idle", sleeping: "Sleeping until schedule", running: "Running (scraping…)", finished: "Finished (queue pushed)" };
  textEl.textContent = labels[phase] || phase;
  if (phase === "sleeping" && nextRunAt) {
    nextEl.textContent = formatNextRun(nextRunAt);
  } else if (phase === "idle" || phase === "finished") {
    refreshNextRunDisplay(nextEl);
  } else {
    nextEl.textContent = "";
  }
}

async function refreshNextRunDisplay(nextEl) {
  const el = nextEl ?? document.getElementById("statusNextRun");
  if (!el) return;
  try {
    const iso = await invoke(channels.CHANNEL_SLOTS_GET_NEXT_RUN);
    el.textContent = iso ? "Next run: " + new Date(iso).toLocaleString() : "No run times scheduled. Add a run time to schedule the next scrape.";
    el.style.fontStyle = "normal";
    el.style.color = "inherit";
  } catch {
    el.textContent = "";
  }
}

function timeToMinutes(timeStr) {
  const [h, m] = (timeStr || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function formatIntervalMinutes(mins) {
  if (mins < 60) return mins + " min";
  if (mins < 24 * 60) return (mins / 60) + " hours";
  if (mins === 7 * 24 * 60) return "1 week";
  return (mins / (24 * 60)) + " days";
}

function slotToDisplay(slot) {
  const h = Math.floor(slot.time_minutes / 60);
  const m = slot.time_minutes % 60;
  return DAY_NAMES[slot.day_of_week] + " " + h + ":" + String(m).padStart(2, "0");
}

async function loadSchedules() {
  const list = await invoke(channels.SCHEDULES_LIST);
  const sel = document.getElementById("scheduleSelect");
  sel.innerHTML = "<option value=\"\">— Select or create —</option>";
  (list || []).forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = (s.name || "Schedule") + " (id " + s.id + ")";
    sel.appendChild(opt);
  });
  if (selectedScheduleId) sel.value = selectedScheduleId;
}

async function loadChannels() {
  const listEl = document.getElementById("channelsList");
  const intro = document.getElementById("channelsIntro");
  const addSection = document.getElementById("addChannelSection");
  if (selectedScheduleId == null) {
    intro.textContent = "Select a schedule above to see and add channels.";
    listEl.innerHTML = "";
    addSection.style.display = "none";
    return;
  }
  const list = await invoke(channels.CHANNELS_LIST, false, selectedScheduleId);
  intro.textContent = list.length ? "Channels in this schedule:" : "No channels yet. Add one below.";
  addSection.style.display = "block";
  listEl.innerHTML = "";
  for (const ch of list || []) {
    const slots = await invoke(channels.CHANNEL_SLOTS_LIST, ch.id);
    const slotDisplays = (slots || []).map((s) => slotToDisplay(s)).join(", ") || "(no run times)";
    const card = document.createElement("div");
    card.className = "channel-card";
    card.innerHTML = `
      <h3>${escapeHtml(ch.name || ch.url)}</h3>
      <div class="run-at-list">${escapeHtml(ch.url)}</div>
      <div class="run-at-list">Manual run times: ${escapeHtml(slotDisplays)}</div>
      <div style="margin-top:0.35rem;">
        <select class="add-slot-day inline" data-channel-id="${ch.id}">
          ${[0,1,2,3,4,5,6].map((d) => `<option value="${d}">${DAY_NAMES[d]}</option>`).join("")}
        </select>
        <input type="time" class="add-slot-time inline" value="14:00" data-channel-id="${ch.id}" />
        <button type="button" class="add-slot-btn" data-channel-id="${ch.id}">Add run time</button>
      </div>
    `;
    listEl.appendChild(card);
  }
  listEl.querySelectorAll(".add-slot-btn").forEach((btn) => {
    btn.onclick = async () => {
      const channelId = Number(btn.dataset.channelId);
      const dayOfWeek = Number(btn.closest(".channel-card").querySelector(".add-slot-day").value);
      const timeStr = btn.closest(".channel-card").querySelector(".add-slot-time").value;
      const timeMinutes = timeToMinutes(timeStr);
      await invoke(channels.CHANNEL_SLOTS_ADD, channelId, dayOfWeek, timeMinutes);
      await loadChannels();
      await invoke(channels.SCRAPER_STOP);
      try {
        await invoke(channels.SCRAPER_START);
      } catch (_err) {
        setScraperStatus("idle");
      }
    };
  });
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function showQueue(tasks, source) {
  const countEl = document.getElementById("pushCount");
  const listEl = document.getElementById("queueList");
  const count = Array.isArray(tasks) ? tasks.length : 0;
  countEl.textContent = count;
  if (!Array.isArray(tasks)) {
    listEl.innerHTML = "";
    listEl.textContent = source + " " + String(tasks);
    return;
  }
  listEl.innerHTML = "";
  listEl.appendChild(document.createTextNode(source + " (" + tasks.length + ")\n\n"));
  if (tasks.length === 0) return;
  tasks.forEach((t) => {
    const row = document.createElement("div");
    row.className = "queue-row";
    row.innerHTML = `<span class="queue-id">#${t.id}</span> <span class="queue-status">${t.status}</span> ${escapeHtml((t.video_url || "").slice(0, 50))}… `;
    const btn = document.createElement("button");
    btn.textContent = "Mark finished";
    btn.className = "btn-mark-finished";
    if (t.status === "downloaded") btn.disabled = true;
    btn.onclick = async () => {
      await invoke(channels.DOWNLOAD_TASK_MARK_FINISHED, t.id);
      const list = await invoke(channels.DOWNLOAD_TASKS_LIST, "pending");
      showQueue(list, "[Updated]");
    };
    row.appendChild(btn);
    listEl.appendChild(row);
  });
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

let lastCpu = null;
function startProcessLoadPolling() {
  setInterval(async () => {
    try {
      const load = await invoke(channels.PROCESS_LOAD);
      if (!load) return;
      const rss = load.memory?.rss;
      const heap = load.memory?.heapUsed;
      if (rss != null) document.getElementById("loadRss").textContent = formatBytes(rss);
      if (heap != null) document.getElementById("loadHeap").textContent = formatBytes(heap);
      const user = load.cpu?.user ?? 0;
      const system = load.cpu?.system ?? 0;
      if (lastCpu != null) {
        const deltaUser = user - lastCpu.user;
        const deltaSystem = system - lastCpu.system;
        const cpuPercent = ((deltaUser + deltaSystem) / 1e4).toFixed(1);
        document.getElementById("loadCpu").textContent = cpuPercent + "%";
      }
      lastCpu = { user, system };
    } catch (_) {
      document.getElementById("loadCpu").textContent = "—";
    }
  }, 1000);
}
startProcessLoadPolling();

onScraperStatus((event) => {
  setScraperStatus(event.phase, event.nextRunAt);
  if (event.phase === "finished") {
    invoke(channels.SCRAPER_STOP).then(async () => {
      setScraperStatus("idle");
      await refreshNextRunDisplay();
    });
    invoke(channels.DOWNLOAD_TASKS_LIST, "pending").then((list) => showQueue(list ?? [], "[Pushed after scraper run]"));
  }
});
onDownloadQueuePushed((tasks) => showQueue(tasks, "[Pushed after scraper run]"));

document.getElementById("scheduleSelect").onchange = () => {
  const v = document.getElementById("scheduleSelect").value;
  selectedScheduleId = v === "" ? null : Number(v);
  loadChannels();
};

document.getElementById("newScheduleBtn").onclick = async () => {
  const name = document.getElementById("newScheduleName").value.trim() || "Schedule " + new Date().toISOString().slice(0, 10);
  const schedule = await invoke(channels.SCHEDULES_CREATE, { name });
  selectedScheduleId = schedule?.id;
  document.getElementById("newScheduleName").value = "";
  await loadSchedules();
  document.getElementById("scheduleSelect").value = selectedScheduleId;
  loadChannels();
};

function showScheduleMode(mode) {
  const isAuto = mode === "auto";
  document.getElementById("addChannelAuto").style.display = isAuto ? "block" : "none";
  document.getElementById("addChannelManual").style.display = isAuto ? "none" : "block";
}
document.querySelectorAll('input[name="scheduleMode"]').forEach((radio) => {
  radio.onchange = () => showScheduleMode(radio.value);
});
showScheduleMode(document.querySelector('input[name="scheduleMode"]:checked')?.value || "manual");

document.getElementById("analyzeScheduleBtn").onclick = async () => {
  const url = document.getElementById("channelUrlAuto").value.trim();
  if (!url) return;
  const resultEl = document.getElementById("analyzeResult");
  const actionsEl = document.getElementById("addChannelAutoActions");
  resultEl.style.display = "block";
  resultEl.className = "analyze-result";
  resultEl.textContent = "Analyzing channel…";
  actionsEl.style.display = "none";
  let res;
  try {
    res = await invoke(channels.CHANNEL_ANALYZE_SCHEDULE, url, { maxVideos: 50 });
  } catch (e) {
    resultEl.className = "analyze-result error";
    resultEl.textContent = "Error: " + (e?.message || String(e));
    return;
  }
  if (res?.error) {
    resultEl.className = "analyze-result error";
    resultEl.textContent = res.message || res.error;
    return;
  }
  
  const name = document.getElementById("channelNameAuto").value.trim() || "Channel";
  let html = '<strong>Analysis:</strong> ' + escapeHtml(res.message) + (res.videoCount ? ` (${res.videoCount} videos found)` : "");
  
  // Show intelligent prediction
  if (res.intelligentPrediction) {
    const pred = res.intelligentPrediction;
    const nextTime = new Date(pred.nextScrapeTime).toLocaleString();
    html += '<div class="analyze-basis">';
    html += '<strong>Intelligent Prediction:</strong><br>';
    html += 'Next scrape: ' + escapeHtml(nextTime) + '<br>';
    html += 'Pattern: ' + escapeHtml(pred.pattern) + ' · ';
    html += 'Confidence: ' + (pred.confidence * 100).toFixed(0) + '% · ';
    html += 'Expected: ~' + Math.round(pred.expectedVideos) + ' videos<br>';
    if (pred.isErratic) {
      html += '<em class="analyze-caveat">Pattern is erratic (upload schedule varies widely)</em>';
    }
    html += '</div>';
  }
  
  // Show manual suggestions
  const slots = res.suggestedSlots || [];
  if (slots.length > 0) {
    html += '<div class="analyze-basis"><strong>Manual Mode Options:</strong><br>';
    const slotDisplays = slots.map(s => DAY_NAMES[s.day_of_week] + " " + Math.floor(s.time_minutes / 60) + ":" + String(s.time_minutes % 60).padStart(2, "0")).join(", ");
    html += 'Detected upload times: ' + escapeHtml(slotDisplays) + '</div>';
  }
  
  resultEl.className = "analyze-result";
  resultEl.innerHTML = html;
  actionsEl.style.display = "block";
  actionsEl.innerHTML = "";
  
  // Auto mode button (intelligent scheduler)
  if (res.intelligentPrediction) {
    const btnAuto = document.createElement("button");
    btnAuto.type = "button";
    btnAuto.textContent = "Add with intelligent scheduling";
    btnAuto.onclick = () => addChannelWithIntelligent(url, name);
    actionsEl.appendChild(btnAuto);
    actionsEl.appendChild(document.createTextNode(" "));
  }
  
  // Manual mode buttons (suggested slots)
  if (slots.length > 0) {
    const btnSlots = document.createElement("button");
    btnSlots.type = "button";
    btnSlots.textContent = "Add with suggested run times";
    btnSlots.onclick = () => addChannelWithSlots(url, name, slots);
    actionsEl.appendChild(btnSlots);
    actionsEl.appendChild(document.createTextNode(" "));
  }
  
  // Fallback: add without times
  const btnNone = document.createElement("button");
  btnNone.type = "button";
  btnNone.textContent = "Add with no run times (set later)";
  btnNone.onclick = () => addChannelWithSlots(url, name, []);
  actionsEl.appendChild(btnNone);
};

async function addChannelWithIntelligent(url, name) {
  if (selectedScheduleId == null) return;
  
  // Create channel
  const channel = await invoke(channels.CHANNELS_CREATE, {
    schedule_id: selectedScheduleId,
    url,
    name,
    active: 1,
  });
  const channelId = channel?.id;
  
  if (channelId != null) {
    // Show a loading message while fetching
    const statusEl = document.getElementById("statusNextRun");
    if (statusEl) {
      statusEl.textContent = "Fetching accurate timestamps for analysis... (this may take 30+ seconds)";
      statusEl.style.fontStyle = "italic";
      statusEl.style.color = "#666";
    }
    
    // Fetch accurate timestamps in background (don't wait)
    console.log("[Frontend] Fetching accurate timestamps for channel", channelId);
    invoke(channels.CHANNEL_FETCH_ACCURATE_TIMESTAMPS, url).then(async (result) => {
      console.log("[Frontend] Fetch result:", result);
      if (result?.videos && result.videos.length > 0) {
        console.log("[Frontend] Saving", result.videos.length, "analysis videos to channel", channelId);
        try {
          // Save accurate timestamps (auto-updates intelligent schedule)
          const saveResult = await invoke(channels.CHANNEL_ANALYSIS_VIDEOS_SAVE, channelId, result.videos);
          console.log("[Frontend] Save result:", saveResult);
          console.log("[Frontend] Intelligent schedule updated with accurate timestamps for:", name);
          
          // Refresh the next run display to show the newly created schedule
          await refreshNextRunDisplay(statusEl);
        } catch (saveErr) {
          console.error("[Frontend] Failed to save analysis videos:", saveErr);
          if (statusEl) {
            statusEl.textContent = "Error saving analysis videos. Check console.";
            statusEl.style.color = "red";
          }
        }
      } else {
        console.warn("[Frontend] No videos returned from fetch");
        if (statusEl) {
          statusEl.textContent = "No videos returned from fetch";
          statusEl.style.color = "#666";
        }
      }
    }).catch(err => {
      console.error("[Frontend] Failed to fetch accurate timestamps:", err);
      if (statusEl) {
        statusEl.textContent = "Error fetching timestamps: " + (err?.message || err);
        statusEl.style.color = "red";
      }
    });
  }
  
  document.getElementById("channelUrlAuto").value = "";
  document.getElementById("channelNameAuto").value = "";
  document.getElementById("analyzeResult").style.display = "none";
  document.getElementById("addChannelAutoActions").style.display = "none";
  await loadChannels();
  await invoke(channels.SCRAPER_STOP);
  try {
    await invoke(channels.SCRAPER_START);
  } catch (_err) {
    setScraperStatus("idle");
  }
}

async function addChannelWithSlots(url, name, slots) {
  if (selectedScheduleId == null) return;
  const channel = await invoke(channels.CHANNELS_CREATE, {
    schedule_id: selectedScheduleId,
    url,
    name,
    active: 1,
  });
  const channelId = channel?.id;
  if (channelId != null) await invoke(channels.CHANNEL_SLOTS_REPLACE, channelId, slots.map((s) => ({ day_of_week: s.day_of_week, time_minutes: s.time_minutes })));
  document.getElementById("channelUrlAuto").value = "";
  document.getElementById("channelNameAuto").value = "";
  document.getElementById("analyzeResult").style.display = "none";
  document.getElementById("addChannelAutoActions").style.display = "none";
  await loadChannels();
  await invoke(channels.SCRAPER_STOP);
  try {
    await invoke(channels.SCRAPER_START);
  } catch (_err) {
    setScraperStatus("idle");
  }
}

document.getElementById("addChannelBtn").onclick = async () => {
  if (selectedScheduleId == null) return;
  const url = document.getElementById("channelUrl").value.trim();
  if (!url) return;
  const name = document.getElementById("channelName").value.trim() || "Channel";
  const dayOfWeek = parseInt(document.getElementById("addChannelDay").value, 10);
  const timeStr = document.getElementById("addChannelTime").value;
  const timeMinutes = timeToMinutes(timeStr);
  const channel = await invoke(channels.CHANNELS_CREATE, {
    schedule_id: selectedScheduleId,
    url,
    name,
    active: 1,
  });
  const channelId = channel?.id;
  if (channelId != null) await invoke(channels.CHANNEL_SLOTS_REPLACE, channelId, [{ day_of_week: dayOfWeek, time_minutes: timeMinutes }]);
  document.getElementById("channelUrl").value = "";
  document.getElementById("channelName").value = "";
  await loadChannels();
  await invoke(channels.SCRAPER_STOP);
  try {
    await invoke(channels.SCRAPER_START);
  } catch (_err) {
    setScraperStatus("idle");
  }
};

document.getElementById("stopBtn").onclick = async () => {
  await invoke(channels.SCRAPER_STOP);
  setScraperStatus("idle");
};

(async () => {
  document.getElementById("addChannelDay").value = String(new Date().getDay());
  await loadSchedules();
  if (document.getElementById("scheduleSelect").options.length > 1) {
    document.getElementById("scheduleSelect").selectedIndex = 1;
    selectedScheduleId = Number(document.getElementById("scheduleSelect").value);
    loadChannels();
  }
  await refreshNextRunDisplay();
  // Auto-start scraper on app load so runOnce() runs (including past-due catch-up) then sleeps until next slot
  try {
    await invoke(channels.SCRAPER_START);
  } catch (_err) {
    setScraperStatus("idle");
  }
})();
