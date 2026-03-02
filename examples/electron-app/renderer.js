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
    const res = await invoke(channels.CHANNEL_SLOTS_GET_NEXT_RUN);
    const iso = res?.nextRunAt;
    el.textContent = iso ? "Next run: " + new Date(iso).toLocaleString() : "No run times scheduled. Add a run time to schedule the next scrape.";
  } catch {
    el.textContent = "";
  }
}

function timeToMinutes(timeStr) {
  const [h, m] = (timeStr || "0:0").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
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
    const card = document.createElement("div");
    card.className = "channel-card";
    const slotDisplays = (slots || []).map((s) => slotToDisplay(s)).join(", ") || "(no run times)";
    card.innerHTML = `
      <h3>${escapeHtml(ch.name || ch.url)}</h3>
      <div class="run-at-list">${escapeHtml(ch.url)}</div>
      <div class="run-at-list">Run at: ${escapeHtml(slotDisplays)}</div>
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
