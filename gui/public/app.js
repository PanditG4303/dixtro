const form = document.querySelector("#run-form");
const output = document.querySelector("#output");
const statusEl = document.querySelector("#status");
const runBtn = document.querySelector("#runBtn");
const stopRunBtn = document.querySelector("#stopRunBtn");
const clearBtn = document.querySelector("#clearBtn");
const copyLogsBtn = document.querySelector("#copyLogsBtn");
const downloadLogsBtn = document.querySelector("#downloadLogsBtn");
const logFilterEl = document.querySelector("#logFilter");
const clearSecretsBtn = document.querySelector("#clearSecretsBtn");
const commitStrategyEl = document.querySelector("#commitStrategy");
const runModeEl = document.querySelector("#runMode");
const activityTypeEl = document.querySelector("#activityType");
const activityChip = document.querySelector("#activityChip");
const modeChip = document.querySelector("#modeChip");
const runStateChip = document.querySelector("#runStateChip");
const validationHint = document.querySelector("#validationHint");
const githubFieldset = document.querySelector("#githubFieldset");
const repoUrlEl = document.querySelector("#repoUrl");
const autoScrollEl = document.querySelector("#autoScroll");
const saveDefaultsBtn = document.querySelector("#saveDefaultsBtn");
const preflightBtn = document.querySelector("#preflightBtn");
const preflightStatus = document.querySelector("#preflightStatus");
const preflightList = document.querySelector("#preflightList");
const presetButtons = document.querySelectorAll(".preset");
const tokenInputEl = document.querySelector("#token");
const toggleTokenBtn = document.querySelector("#toggleTokenBtn");
const useEnvTokenEl = document.querySelector("#useEnvToken");
const previewCalendarBtn = document.querySelector("#previewCalendarBtn");
const calendarPreview = document.querySelector("#calendarPreview");
const calendarSummary = document.querySelector("#calendarSummary");
const historyList = document.querySelector("#historyList");
const clearHistoryBtn = document.querySelector("#clearHistoryBtn");
const scheduleBtn = document.querySelector("#scheduleBtn");
const scheduleStatus = document.querySelector("#scheduleStatus");
const templateTypeEl = document.querySelector("#templateType");
const loadTemplateBtn = document.querySelector("#loadTemplateBtn");
const saveTemplateBtn = document.querySelector("#saveTemplateBtn");
const templateEditor = document.querySelector("#templateEditor");
const templatePreview = document.querySelector("#templatePreview");
const confirmDialog = document.querySelector("#confirmDialog");
const confirmForm = document.querySelector("#confirmForm");
const confirmInput = document.querySelector("#confirmInput");

const STORAGE_KEY = "goGreen.gui.defaults.v2";
const HISTORY_KEY = "goGreen.gui.history.v1";
const HISTORY_LIMIT = 20;
let running = false;
let activeRunId = null;
let logStore = [];
let pendingPayload = null;

const postJson = async (url, payload) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error ?? "Request failed.");
  }
  return result;
};

const getJson = async (url) => {
  const response = await fetch(url);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(result.error ?? "Request failed.");
  }
  return result;
};

const setStatus = (text, type = "neutral") => {
  statusEl.textContent = text;
  statusEl.dataset.type = type;
};

const setRunState = (state) => {
  runStateChip.textContent = `Run: ${state}`;
};

const classifyLevel = (text, fallback = "info") => {
  const lowered = String(text).toLowerCase();
  if (lowered.includes("error") || lowered.includes("failed")) return "error";
  if (lowered.includes("warn") || lowered.includes("cooldown")) return "warn";
  return fallback;
};

const appendLog = (text, level = "info") => {
  const lines = String(text).split("\n").filter(Boolean);
  lines.forEach((line) => {
    logStore.push({ level: classifyLevel(line, level), line });
  });
  renderLogs();
};

const renderLogs = () => {
  const filter = logFilterEl.value;
  output.innerHTML = "";
  logStore
    .filter((entry) => filter === "all" || entry.level === filter)
    .forEach((entry) => {
      const row = document.createElement("div");
      row.className = `log-line ${entry.level}`;
      row.textContent = entry.line;
      output.appendChild(row);
    });

  if (autoScrollEl.checked) {
    output.scrollTop = output.scrollHeight;
  }
};

const setRangeState = () => {
  const isRange = commitStrategyEl.value === "range";
  ["commitStartDate", "commitEndDate", "commitsPerDay", "previewCalendarBtn", "weekday0", "weekday1", "weekday2", "weekday3", "weekday4", "weekday5", "weekday6"].forEach((id) => {
    const field = document.getElementById(id);
    if (field) field.disabled = !isRange;
  });
};

const setActivityState = () => {
  const activity = activityTypeEl.value;
  const mode = runModeEl.value;
  const githubNeeded = activity === "issues" || activity === "prs" || activity === "reviews" || activity === "all";

  githubFieldset.classList.toggle("muted", !githubNeeded);
  activityChip.textContent = `Activity: ${activity}`;
  modeChip.textContent = `Mode: ${mode === "live" ? "live" : "dry-run"}`;
};

const parseRepoLink = (value) => {
  const input = String(value ?? "").trim();
  if (!input) return null;

  const sshMatch = input.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    };
  }

  try {
    const url = new URL(input);
    if (!/github\.com$/i.test(url.hostname)) {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }

    return {
      owner: parts[0],
      repo: parts[1].replace(/\.git$/i, ""),
    };
  } catch {
    return null;
  }
};

const syncRepoLinkToFields = () => {
  const parsed = parseRepoLink(repoUrlEl.value);
  if (!parsed) {
    return;
  }

  const ownerEl = document.getElementById("owner");
  const repoEl = document.getElementById("repo");
  ownerEl.value = parsed.owner;
  repoEl.value = parsed.repo;
  setStatus("Repository link parsed", "success");
};

const getWeekdayCommits = () => {
  const out = {};
  for (let i = 0; i <= 6; i += 1) {
    out[String(i)] = Number(document.getElementById(`weekday${i}`).value || 0);
  }
  return out;
};

const validateForm = () => {
  const activity = activityTypeEl.value;
  const maxPerRun = Number(document.getElementById("maxPerRun").value || 0);
  const countChecks = [
    { activity: "commits", label: "Commit count", value: Number(document.getElementById("commitCount").value || 0) },
    { activity: "issues", label: "Issue count", value: Number(document.getElementById("issueCount").value || 0) },
    { activity: "prs", label: "PR count", value: Number(document.getElementById("prCount").value || 0) },
    { activity: "reviews", label: "Review count", value: Number(document.getElementById("reviewCount").value || 0) },
  ];

  const activeChecks = activity === "all"
    ? countChecks
    : countChecks.filter((check) => check.activity === activity);

  const invalidCount = activeChecks.find((check) => check.value > maxPerRun);
  if (invalidCount) {
    validationHint.textContent = `${invalidCount.label} (${invalidCount.value}) cannot exceed Max per run (${maxPerRun}).`;
    return false;
  }

  if (runModeEl.value === "live") {
    const token = tokenInputEl.value.trim();
    const owner = document.getElementById("owner").value.trim();
    const repo = document.getElementById("repo").value.trim();
    const githubNeeded = activity === "issues" || activity === "prs" || activity === "reviews" || activity === "all";

    if (githubNeeded && (!owner || !repo)) {
      validationHint.textContent = "Live mode for issues/PRs/reviews/all requires owner and repo.";
      return false;
    }

    if (githubNeeded && !useEnvTokenEl.checked && !token) {
      validationHint.textContent = "Provide a token or enable 'Use token from .env'.";
      return false;
    }
  }

  if (commitStrategyEl.value === "range") {
    const start = document.getElementById("commitStartDate").value;
    const end = document.getElementById("commitEndDate").value;
    if (!start || !end) {
      validationHint.textContent = "Range strategy requires both start and end dates.";
      return false;
    }
  }

  validationHint.textContent = "";
  return true;
};

const payloadFromForm = () => {
  const formData = new FormData(form);
  return {
    activityType: formData.get("activityType"),
    dryRun: formData.get("runMode") !== "live",
    commitCount: Number(formData.get("commitCount")),
    issueCount: Number(formData.get("issueCount")),
    prCount: Number(formData.get("prCount")),
    reviewCount: Number(formData.get("reviewCount")),
    maxPerRun: Number(formData.get("maxPerRun")),
    maxCommitDate: formData.get("maxCommitDate"),
    commitStrategy: formData.get("commitStrategy"),
    commitStartDate: formData.get("commitStartDate"),
    commitEndDate: formData.get("commitEndDate"),
    commitsPerDay: Number(formData.get("commitsPerDay")),
    weekdayCommits: getWeekdayCommits(),
    owner: formData.get("owner"),
    repo: formData.get("repo"),
    repoUrl: formData.get("repoUrl"),
    baseBranch: formData.get("baseBranch"),
    token: useEnvTokenEl.checked ? "" : formData.get("token"),
    useEnvToken: useEnvTokenEl.checked,
    issueLabels: formData.get("issueLabels"),
    issueAssignees: formData.get("issueAssignees"),
    prLabels: formData.get("prLabels"),
    prAssignees: formData.get("prAssignees"),
  };
};

const redactSecrets = (payload) => {
  const safe = { ...payload };
  delete safe.token;
  return safe;
};

const setTokenInputState = () => {
  const useEnv = useEnvTokenEl.checked;
  tokenInputEl.disabled = useEnv;
  toggleTokenBtn.disabled = useEnv;
  tokenInputEl.placeholder = useEnv ? "Using GITHUB_TOKEN from .env" : "ghp_...";
};

const applyValues = (values) => {
  Object.entries(values).forEach(([key, value]) => {
    const input = form.elements.namedItem(key);
    if (!input) return;
    if (typeof value === "boolean") {
      input.checked = value;
      return;
    }
    input.value = value;
  });

  if (values.weekdayCommits && typeof values.weekdayCommits === "object") {
    for (let i = 0; i <= 6; i += 1) {
      const target = document.getElementById(`weekday${i}`);
      if (target) {
        target.value = Number(values.weekdayCommits[String(i)] ?? values.weekdayCommits[i] ?? 0);
      }
    }
  }

  setRangeState();
  setActivityState();
  setTokenInputState();
};

const saveDefaults = () => {
  const safe = redactSecrets(payloadFromForm());
  localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
  setStatus("Defaults saved", "success");
};

const loadDefaults = () => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    applyValues(parsed);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
};

const loadHistory = () => {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const saveHistory = (history) => {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
};

const renderHistory = () => {
  const history = loadHistory();
  historyList.innerHTML = "";
  if (history.length === 0) {
    historyList.textContent = "No runs yet.";
    return;
  }

  history.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "history-row";
    const meta = document.createElement("div");
    meta.textContent = `${item.at} | ${item.activityType} | ${item.dryRun ? "dry" : "live"} | exit ${item.exitCode}`;
    const btn = document.createElement("button");
    btn.className = "ghost";
    btn.textContent = "Reapply";
    btn.addEventListener("click", () => applyValues(item.payload));
    row.append(meta, btn);
    historyList.appendChild(row);

    if (index >= HISTORY_LIMIT - 1) {
      return;
    }
  });
};

const addHistory = (payload, result) => {
  const history = loadHistory();
  history.unshift({
    at: new Date().toISOString(),
    activityType: payload.activityType,
    dryRun: payload.dryRun,
    exitCode: result.exitCode,
    payload: redactSecrets(payload),
  });
  saveHistory(history);
  renderHistory();
};

const applyPreset = (name) => {
  const today = new Date().toISOString().slice(0, 10);
  const presets = {
    "safe-commits": {
      activityType: "commits",
      runMode: "dry",
      commitStrategy: "random",
      commitCount: 3,
      maxPerRun: 10,
      maxCommitDate: today,
    },
    "safe-all": {
      activityType: "all",
      runMode: "dry",
      commitStrategy: "random",
      commitCount: 2,
      issueCount: 1,
      prCount: 1,
      reviewCount: 1,
      maxPerRun: 10,
      maxCommitDate: today,
    },
    "live-issues": {
      activityType: "issues",
      runMode: "live",
      issueCount: 1,
    },
    "range-commits": {
      activityType: "commits",
      runMode: "dry",
      commitStrategy: "range",
      commitStartDate: today,
      commitEndDate: today,
      commitsPerDay: 1,
    },
  };

  if (!presets[name]) return;
  applyValues(presets[name]);
  setStatus(`Preset loaded: ${name}`, "neutral");
};

const renderPreflight = (result) => {
  preflightList.innerHTML = "";
  preflightStatus.textContent = result.ok ? "Pre-flight passed." : "Pre-flight needs attention.";
  result.checks.forEach((check) => {
    const row = document.createElement("div");
    row.className = `preflight-item ${check.ok ? "ok" : "bad"}`;
    row.textContent = `${check.ok ? "PASS" : "FAIL"}: ${check.message}`;
    preflightList.appendChild(row);
  });
};

const runPreflight = async () => {
  const result = await postJson("/api/preflight", payloadFromForm());
  renderPreflight(result);
  return result;
};

const showConfirmDialog = () =>
  new Promise((resolve) => {
    confirmInput.value = "";
    confirmDialog.showModal();
    const onClose = () => {
      confirmDialog.removeEventListener("close", onClose);
      resolve(confirmDialog.returnValue === "ok" && confirmInput.value.trim() === "YES");
    };
    confirmDialog.addEventListener("close", onClose, { once: true });
  });

const runWithStream = async (payload) => {
  const response = await fetch("/api/run-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok || !response.body) {
    const failed = await response.json().catch(() => ({ error: "Run failed." }));
    throw new Error(failed.error ?? "Run failed.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult = { ok: false, exitCode: 1 };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        appendLog(line);
        continue;
      }

      if (event.type === "start") {
        activeRunId = event.runId;
      }

      if (event.type === "log") {
        appendLog(String(event.chunk ?? ""), event.level ?? "info");
      }

      if (event.type === "error") {
        appendLog(`ERROR: ${event.message}`, "error");
      }

      if (event.type === "done") {
        finalResult = {
          ok: Boolean(event.ok),
          exitCode: Number(event.exitCode ?? 1),
          userStopped: Boolean(event.userStopped),
        };
      }
    }
  }

  return finalResult;
};

const renderCalendarPreview = () => {
  const startRaw = document.getElementById("commitStartDate").value;
  const endRaw = document.getElementById("commitEndDate").value;
  if (!startRaw || !endRaw) {
    calendarSummary.textContent = "Select start and end dates first.";
    calendarPreview.innerHTML = "";
    return;
  }

  const start = new Date(`${startRaw}T00:00:00`);
  const end = new Date(`${endRaw}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    calendarSummary.textContent = "Invalid date range.";
    calendarPreview.innerHTML = "";
    return;
  }

  const weekday = getWeekdayCommits();
  let total = 0;
  calendarPreview.innerHTML = "";

  const grid = document.createElement("div");
  grid.className = "calendar-grid";

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  days.forEach((d) => {
    const h = document.createElement("div");
    h.className = "calendar-head";
    h.textContent = d;
    grid.appendChild(h);
  });

  for (let i = 0; i < start.getDay(); i += 1) {
    const blank = document.createElement("div");
    blank.className = "calendar-cell blank";
    grid.appendChild(blank);
  }

  const cursor = new Date(start);
  while (cursor <= end) {
    const day = cursor.getDay();
    const count = Number(weekday[String(day)] ?? 0);
    total += count;
    const cell = document.createElement("div");
    cell.className = "calendar-cell";
    cell.innerHTML = `<span>${cursor.getDate()}</span><strong>${count}</strong>`;
    grid.appendChild(cell);
    cursor.setDate(cursor.getDate() + 1);
  }

  calendarSummary.textContent = `Planned commits in range: ${total}`;
  calendarPreview.appendChild(grid);
};

const refreshTemplatePreview = () => {
  const content = templateEditor.value;
  const preview = content
    .replaceAll("{{timestamp}}", new Date().toISOString())
    .replaceAll("{{activity}}", activityTypeEl.value)
    .replaceAll("{{index}}", "1");
  templatePreview.textContent = preview.slice(0, 260) || "Preview appears here.";
};

const loadTemplate = async () => {
  const result = await getJson(`/api/templates?type=${templateTypeEl.value}`);
  templateEditor.value = result.content;
  refreshTemplatePreview();
  setStatus(`${templateTypeEl.value} template loaded`, "success");
};

const saveTemplate = async () => {
  await postJson("/api/templates", {
    type: templateTypeEl.value,
    content: templateEditor.value,
  });
  setStatus(`${templateTypeEl.value} template saved`, "success");
};

const createSchedule = async () => {
  const payload = {
    taskName: document.getElementById("taskName").value,
    days: document.getElementById("taskDays").value,
    startTime: document.getElementById("taskStartTime").value,
    activity: activityTypeEl.value === "all" ? "commits" : activityTypeEl.value,
    dryRun: runModeEl.value !== "live",
    commitCount: Number(document.getElementById("commitCount").value),
    issueCount: Number(document.getElementById("issueCount").value),
    prCount: Number(document.getElementById("prCount").value),
    reviewCount: Number(document.getElementById("reviewCount").value),
    owner: document.getElementById("owner").value,
    repo: document.getElementById("repo").value,
    baseBranch: document.getElementById("baseBranch").value,
  };

  const result = await postJson("/api/schedule", payload);
  scheduleStatus.textContent = result.output || "Task created.";
};

const syncRunButtons = () => {
  runBtn.disabled = running;
  saveDefaultsBtn.disabled = running;
  stopRunBtn.disabled = !running;
};

const stopRun = async () => {
  await postJson("/api/run-stop", {});
  appendLog("Stop requested by user.", "warn");
};

commitStrategyEl.addEventListener("change", setRangeState);
activityTypeEl.addEventListener("change", setActivityState);
runModeEl.addEventListener("change", setActivityState);
useEnvTokenEl.addEventListener("change", setTokenInputState);
repoUrlEl.addEventListener("change", syncRepoLinkToFields);
repoUrlEl.addEventListener("blur", syncRepoLinkToFields);
logFilterEl.addEventListener("change", renderLogs);
previewCalendarBtn.addEventListener("click", renderCalendarPreview);
preflightBtn.addEventListener("click", async () => {
  try {
    await runPreflight();
  } catch (error) {
    preflightStatus.textContent = error.message;
  }
});
loadTemplateBtn.addEventListener("click", loadTemplate);
saveTemplateBtn.addEventListener("click", saveTemplate);
templateTypeEl.addEventListener("change", loadTemplate);
templateEditor.addEventListener("input", refreshTemplatePreview);
scheduleBtn.addEventListener("click", async () => {
  scheduleStatus.textContent = "Creating...";
  try {
    await createSchedule();
    setStatus("Schedule created", "success");
  } catch (error) {
    scheduleStatus.textContent = error.message;
    setStatus("Schedule failed", "failed");
  }
});

setRangeState();
setActivityState();
loadDefaults();
setTokenInputState();
renderHistory();
renderCalendarPreview();
refreshTemplatePreview();
loadTemplate().catch(() => {
  templatePreview.textContent = "Template could not be loaded yet.";
});

presetButtons.forEach((button) => {
  button.addEventListener("click", () => {
    applyPreset(button.dataset.preset);
    renderCalendarPreview();
  });
});

saveDefaultsBtn.addEventListener("click", saveDefaults);

toggleTokenBtn.addEventListener("click", () => {
  if (useEnvTokenEl.checked) return;
  const showing = tokenInputEl.type === "text";
  tokenInputEl.type = showing ? "password" : "text";
  toggleTokenBtn.textContent = showing ? "Show" : "Hide";
});

clearSecretsBtn.addEventListener("click", () => {
  tokenInputEl.value = "";
  setStatus("Sensitive fields cleared", "success");
});

clearBtn.addEventListener("click", () => {
  logStore = [];
  renderLogs();
  setStatus("Idle");
});

copyLogsBtn.addEventListener("click", async () => {
  const text = logStore.map((x) => `[${x.level.toUpperCase()}] ${x.line}`).join("\n");
  await navigator.clipboard.writeText(text);
  setStatus("Logs copied", "success");
});

downloadLogsBtn.addEventListener("click", () => {
  const text = logStore.map((x) => `[${x.level.toUpperCase()}] ${x.line}`).join("\n");
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `goGreen-logs-${Date.now()}.txt`;
  a.click();
  URL.revokeObjectURL(url);
});

clearHistoryBtn.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
  setStatus("History cleared", "success");
});

stopRunBtn.addEventListener("click", () => {
  stopRun().catch((error) => {
    appendLog(`Stop failed: ${error.message}`, "error");
  });
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!validateForm()) {
    setStatus("Validation required", "failed");
    return;
  }

  const preflight = await runPreflight();
  if (!preflight.ok) {
    setStatus("Pre-flight failed", "failed");
    return;
  }

  const payload = payloadFromForm();
  if (!payload.dryRun) {
    pendingPayload = payload;
    const confirmed = await showConfirmDialog();
    if (!confirmed) {
      setStatus("Live run canceled", "neutral");
      return;
    }
  }

  running = true;
  syncRunButtons();
  setRunState("running");
  appendLog(`== ${new Date().toISOString()} | Starting ${payload.dryRun ? "DRY" : "LIVE"} run ==`, "info");
  setStatus("Running...", "running");

  try {
    const result = await runWithStream(payload);
    appendLog(`Exit code: ${result.exitCode}`, result.ok ? "info" : "error");
    if (result.userStopped) {
      setStatus("Stopped", "failed");
    } else {
      setStatus(result.ok ? "Completed" : "Failed", result.ok ? "success" : "failed");
    }
    addHistory(payload, result);
  } catch (error) {
    appendLog(error instanceof Error ? error.message : "Unknown network error", "error");
    setStatus("Failed", "failed");
  } finally {
    running = false;
    activeRunId = null;
    syncRunButtons();
    setRunState("idle");
  }
});
