import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(__dirname, "public");
const basePort = Number.parseInt(process.env.GUI_PORT ?? "3040", 10);
const issueTemplatePath = process.env.ISSUE_TEMPLATE_PATH ?? path.join(rootDir, ".github", "ISSUE_TEMPLATE.md");
const prTemplatePath = process.env.PR_TEMPLATE_PATH ?? path.join(rootDir, ".github", "PULL_REQUEST_TEMPLATE.md");

const allowedActivity = new Set(["commits", "issues", "prs", "reviews", "all"]);
const allowedScheduleActivity = new Set(["commits", "issues", "prs", "reviews"]);
const allowedCommitStrategy = new Set(["random", "range"]);

let activeRun = null;

const asInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
};

const asString = (value, fallback = "") => {
  if (typeof value !== "string") return fallback;
  return value.trim();
};

const isYmdDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
};

const sendFile = async (res, filePath, contentType) => {
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
};

const parseBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });

const sanitizeWeekdayCommits = (weekdayCommits) => {
  if (!weekdayCommits || typeof weekdayCommits !== "object") {
    return null;
  }

  const result = {};
  let hasAny = false;
  for (let day = 0; day <= 6; day += 1) {
    const value = asInt(weekdayCommits[String(day)] ?? weekdayCommits[day], 0);
    result[String(day)] = value;
    hasAny ||= value > 0;
  }

  return hasAny ? result : null;
};

const isGitRepository = () =>
  new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: rootDir,
      windowsHide: true,
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("close", (code) => {
      resolve(code === 0 && output.trim() === "true");
    });

    child.on("error", () => {
      resolve(false);
    });
  });

const readGitConfigValue = (key, options = {}) =>
  new Promise((resolve) => {
    const args = ["config"];
    if (options.global) {
      args.push("--global");
    }
    args.push(key);

    const child = spawn("git", args, {
      cwd: rootDir,
      windowsHide: true,
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("close", (code) => {
      resolve(code === 0 ? output.trim() : "");
    });

    child.on("error", () => {
      resolve("");
    });
  });

const getGitAuthorIdentity = async () => {
  const userName = (await readGitConfigValue("user.name")) || (await readGitConfigValue("user.name", { global: true }));
  const userEmail = (await readGitConfigValue("user.email")) || (await readGitConfigValue("user.email", { global: true }));

  return {
    userName,
    userEmail,
    ok: Boolean(userName && userEmail),
  };
};

const runGitCommand = (args) =>
  new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: rootDir,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", (error) => {
      resolve({ ok: false, code: 1, stdout: "", stderr: error.message });
    });
  });

const refExists = async (refName) => (await runGitCommand(["rev-parse", "--verify", refName])).ok;

const getCurrentBranchName = async () => (await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"])).stdout;

const fetchRemoteBranch = async (remoteName, branchName) => {
  await runGitCommand(["fetch", remoteName, branchName]);
};

const hasMergeBase = async (leftRef, rightRef) => {
  const result = await runGitCommand(["merge-base", leftRef, rightRef]);
  return result.ok && /^[0-9a-f]{7,40}$/i.test(result.stdout);
};

const getAheadBehindCounts = async (leftRef, rightRef) => {
  const result = await runGitCommand(["rev-list", "--left-right", "--count", `${leftRef}...${rightRef}`]);
  const [aheadRaw = "0", behindRaw = "0"] = result.stdout.split(/\s+/);
  return {
    ahead: Number.parseInt(aheadRaw, 10) || 0,
    behind: Number.parseInt(behindRaw, 10) || 0,
  };
};

const getCurrentBranchPushStatus = async () => {
  const currentBranch = await getCurrentBranchName();
  const remoteName = await readGitConfigValue(`branch.${currentBranch}.remote`);
  const mergeRef = await readGitConfigValue(`branch.${currentBranch}.merge`);

  if (!remoteName || !mergeRef) {
    return {
      ok: false,
      message: `Current branch ${currentBranch} has no upstream branch. Run: git push --set-upstream origin ${currentBranch}`,
    };
  }

  const remoteBranchName = mergeRef.replace(/^refs\/heads\//, "");
  const remoteRef = `${remoteName}/${remoteBranchName}`;
  await fetchRemoteBranch(remoteName, remoteBranchName);

  if (!(await refExists(remoteRef))) {
    return {
      ok: false,
      message: `Remote branch ${remoteRef} was not found. Run: git push --set-upstream ${remoteName} ${currentBranch}`,
    };
  }

  if (!(await hasMergeBase(currentBranch, remoteRef))) {
    return {
      ok: false,
      message: `Current branch ${currentBranch} does not share history with ${remoteRef}. Clone the real repository or realign this branch before live commit runs.`,
    };
  }

  const { behind } = await getAheadBehindCounts(currentBranch, remoteRef);
  if (behind > 0) {
    return {
      ok: false,
      message: `Current branch ${currentBranch} is behind ${remoteRef} by ${behind} commit(s). Pull or rebase it before live commit runs.`,
    };
  }

  return {
    ok: true,
    message: `Current branch ${currentBranch} can push safely to ${remoteRef}.`,
  };
};

const getBaseBranchSyncStatus = async (baseBranch) => {
  const remoteRef = `origin/${baseBranch}`;
  await fetchRemoteBranch("origin", baseBranch);

  if (!(await refExists(baseBranch))) {
    return {
      ok: false,
      message: `Local base branch ${baseBranch} does not exist. Create or check out ${baseBranch} before live PR runs.`,
    };
  }

  if (!(await refExists(remoteRef))) {
    return {
      ok: false,
      message: `Remote base branch ${remoteRef} was not found. Verify GITHUB_BASE_BRANCH and origin remote configuration.`,
    };
  }

  if (!(await hasMergeBase(baseBranch, remoteRef))) {
    return {
      ok: false,
      message: `Local ${baseBranch} does not share history with ${remoteRef}. Clone the real repository or realign this branch before live PR runs.`,
    };
  }

  const { ahead, behind } = await getAheadBehindCounts(baseBranch, remoteRef);
  if (ahead > 0 && behind > 0) {
    return {
      ok: false,
      message: `Local ${baseBranch} has diverged from ${remoteRef}. Reconcile the branch before live PR runs.`,
    };
  }

  return {
    ok: true,
    message: behind > 0
      ? `Local ${baseBranch} is behind ${remoteRef} but can be fast-forwarded before PR creation.`
      : `Local ${baseBranch} is compatible with ${remoteRef} for PR creation.`,
  };
};

const buildEnvFromInput = (input) => {
  const activityType = asString(input.activityType, "commits").toLowerCase();
  if (!allowedActivity.has(activityType)) {
    throw new Error("activityType must be one of commits, issues, prs, reviews, all.");
  }

  const commitStrategy = asString(input.commitStrategy, "random").toLowerCase();
  if (!allowedCommitStrategy.has(commitStrategy)) {
    throw new Error("commitStrategy must be random or range.");
  }

  const dryRun = Boolean(input.dryRun);
  const maxCommitDate = asString(input.maxCommitDate);
  if (maxCommitDate && !isYmdDate(maxCommitDate)) {
    throw new Error("maxCommitDate must be in YYYY-MM-DD format.");
  }

  const commitStartDate = asString(input.commitStartDate);
  const commitEndDate = asString(input.commitEndDate);
  if (commitStrategy === "range") {
    if (!isYmdDate(commitStartDate) || !isYmdDate(commitEndDate)) {
      throw new Error("commitStartDate and commitEndDate are required for range strategy in YYYY-MM-DD format.");
    }
  }

  const weekdayCommits = sanitizeWeekdayCommits(input.weekdayCommits);

  const env = {
    ...process.env,
    ACTIVITY_TYPE: activityType,
    DRY_RUN: dryRun ? "true" : "false",
    CONFIRM_LIVE: dryRun ? "" : "YES",
    COMMIT_COUNT: String(asInt(input.commitCount, 3)),
    ISSUE_COUNT: String(asInt(input.issueCount, 1)),
    PR_COUNT: String(asInt(input.prCount, 1)),
    REVIEW_COUNT: String(asInt(input.reviewCount, 1)),
    MAX_PER_RUN: String(asInt(input.maxPerRun, 10)),
    COMMIT_STRATEGY: commitStrategy,
    COMMITS_PER_DAY: String(asInt(input.commitsPerDay, 1)),
    GITHUB_OWNER: asString(input.owner, process.env.GITHUB_OWNER ?? ""),
    GITHUB_REPO: asString(input.repo, process.env.GITHUB_REPO ?? ""),
    GITHUB_BASE_BRANCH: asString(input.baseBranch, process.env.GITHUB_BASE_BRANCH ?? "main"),
    GITHUB_TOKEN: input.useEnvToken
      ? asString(process.env.GITHUB_TOKEN ?? "")
      : asString(input.token, process.env.GITHUB_TOKEN ?? ""),
    ISSUE_LABELS: asString(input.issueLabels, process.env.ISSUE_LABELS ?? ""),
    ISSUE_ASSIGNEES: asString(input.issueAssignees, process.env.ISSUE_ASSIGNEES ?? ""),
    PR_LABELS: asString(input.prLabels, process.env.PR_LABELS ?? ""),
    PR_ASSIGNEES: asString(input.prAssignees, process.env.PR_ASSIGNEES ?? ""),
  };

  if (maxCommitDate) {
    env.MAX_COMMIT_DATE = maxCommitDate;
  }

  if (commitStrategy === "range") {
    env.COMMIT_START_DATE = commitStartDate;
    env.COMMIT_END_DATE = commitEndDate;
    if (weekdayCommits) {
      env.WEEKDAY_COMMITS_JSON = JSON.stringify(weekdayCommits);
    } else {
      delete env.WEEKDAY_COMMITS_JSON;
    }
  }

  return env;
};

const runAutomation = (env) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["index.js"], {
      cwd: rootDir,
      env,
      windowsHide: true,
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        exitCode: code,
        output,
      });
    });
  });

const runAutomationStream = (env, req, res) =>
  new Promise((resolve) => {
    const runId = randomUUID();
    const startedAt = Date.now();
    const child = spawn(process.execPath, ["index.js"], {
      cwd: rootDir,
      env,
      windowsHide: true,
    });

    activeRun = {
      id: runId,
      child,
      startedAt,
      stoppedByUser: false,
    };

    const sendEvent = (payload) => {
      res.write(`${JSON.stringify(payload)}\n`);
    };

    sendEvent({ type: "start", runId, startedAt });

    child.stdout.on("data", (chunk) => {
      sendEvent({ type: "log", level: "info", chunk: chunk.toString() });
    });

    child.stderr.on("data", (chunk) => {
      sendEvent({ type: "log", level: "error", chunk: chunk.toString() });
    });

    child.on("error", (error) => {
      sendEvent({ type: "error", message: error.message });
      sendEvent({ type: "done", ok: false, exitCode: 1, runId, durationMs: Date.now() - startedAt });
      activeRun = null;
      res.end();
      resolve();
    });

    child.on("close", (code) => {
      const userStopped = Boolean(activeRun?.stoppedByUser);
      sendEvent({
        type: "done",
        ok: code === 0 && !userStopped,
        exitCode: code,
        runId,
        userStopped,
        durationMs: Date.now() - startedAt,
      });
      activeRun = null;
      res.end();
      resolve();
    });

    req.on("close", () => {
      if (activeRun?.id === runId && !child.killed) {
        child.kill();
      }
    });
  });

const runScheduleCommand = (input) =>
  new Promise((resolve) => {
    const activity = asString(input.activity, "commits").toLowerCase();
    if (!allowedScheduleActivity.has(activity)) {
      resolve({ ok: false, output: "Activity must be commits, issues, prs, or reviews." });
      return;
    }

    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(rootDir, "scripts", "register-task.ps1"),
      "-TaskName",
      asString(input.taskName, `goGreen-${activity}`),
      "-Activity",
      activity,
      "-Days",
      asString(input.days, "MON,WED,FRI"),
      "-StartTime",
      asString(input.startTime, "09:00"),
      "-CommitCount",
      String(asInt(input.commitCount, 3)),
      "-IssueCount",
      String(asInt(input.issueCount, 1)),
      "-PrCount",
      String(asInt(input.prCount, 1)),
      "-ReviewCount",
      String(asInt(input.reviewCount, 1)),
      "-BaseBranch",
      asString(input.baseBranch, "main"),
    ];

    const owner = asString(input.owner);
    const repo = asString(input.repo);
    if (owner) args.push("-Owner", owner);
    if (repo) args.push("-Repo", repo);
    if (Boolean(input.dryRun)) args.push("-DryRun");

    const child = spawn("powershell.exe", args, {
      cwd: rootDir,
      windowsHide: true,
    });

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, output, exitCode: code });
    });
  });

const resolveTemplatePath = (type) => {
  if (type === "issue") return issueTemplatePath;
  if (type === "pr") return prTemplatePath;
  throw new Error("Template type must be issue or pr.");
};

const getPreflight = async (input) => {
  const checks = [];
  const activity = asString(input.activityType, "commits");
  const isLive = !Boolean(input.dryRun);
  const githubNeeded = ["issues", "prs", "reviews", "all"].includes(activity);
  const needsGitRepo = isLive && ["commits", "prs", "all"].includes(activity);
  const baseBranch = asString(input.baseBranch, process.env.GITHUB_BASE_BRANCH ?? "main");
  const maxPerRun = asInt(input.maxPerRun, 10);
  const countChecks = [
    { id: "count-commits", activity: "commits", label: "Commit count", value: asInt(input.commitCount, 3) },
    { id: "count-issues", activity: "issues", label: "Issue count", value: asInt(input.issueCount, 1) },
    { id: "count-prs", activity: "prs", label: "PR count", value: asInt(input.prCount, 1) },
    { id: "count-reviews", activity: "reviews", label: "Review count", value: asInt(input.reviewCount, 1) },
  ];

  checks.push({ id: "activity", ok: allowedActivity.has(activity), message: `Activity selected: ${activity}` });
  checks.push({ id: "max-per-run", ok: maxPerRun >= 0, message: `Max per run: ${maxPerRun}` });

  const activeCountChecks = activity === "all"
    ? countChecks
    : countChecks.filter((check) => check.activity === activity);
  activeCountChecks.forEach((check) => {
    checks.push({
      id: check.id,
      ok: check.value <= maxPerRun,
      message: check.value <= maxPerRun
        ? `${check.label} (${check.value}) is within Max per run (${maxPerRun}).`
        : `${check.label} (${check.value}) exceeds Max per run (${maxPerRun}).`,
    });
  });

  if (needsGitRepo) {
    const repoOk = await isGitRepository();
    checks.push({
      id: "git-repo",
      ok: repoOk,
      message: repoOk
        ? "Git repository detected for commit/PR operations."
        : "Git repository required for commits and pull requests.",
    });

    if (repoOk) {
      const identity = await getGitAuthorIdentity();
      checks.push({
        id: "git-user-name",
        ok: Boolean(identity.userName),
        message: identity.userName
          ? `Git user.name detected: ${identity.userName}`
          : 'Git user.name is required. Run: git config --global user.name "Your Name"',
      });
      checks.push({
        id: "git-user-email",
        ok: Boolean(identity.userEmail),
        message: identity.userEmail
          ? `Git user.email detected: ${identity.userEmail}`
          : 'Git user.email is required. Run: git config --global user.email "you@example.com"',
      });

      if (activity === "commits" || activity === "all") {
        const pushStatus = await getCurrentBranchPushStatus();
        checks.push({
          id: "git-push-sync",
          ok: pushStatus.ok,
          message: pushStatus.message,
        });
      }

      if (activity === "prs" || activity === "all") {
        const baseStatus = await getBaseBranchSyncStatus(baseBranch);
        checks.push({
          id: "git-base-sync",
          ok: baseStatus.ok,
          message: baseStatus.message,
        });
      }
    }
  }

  if (input.commitStrategy === "range") {
    checks.push({
      id: "range-dates",
      ok: isYmdDate(asString(input.commitStartDate)) && isYmdDate(asString(input.commitEndDate)),
      message: "Range strategy requires start and end date.",
    });
  }

  if (isLive && githubNeeded) {
    checks.push({ id: "owner", ok: Boolean(asString(input.owner)), message: "Owner is required for live GitHub actions." });
    checks.push({ id: "repo", ok: Boolean(asString(input.repo)), message: "Repo is required for live GitHub actions." });
    checks.push({
      id: "token",
      ok: Boolean(input.useEnvToken ? process.env.GITHUB_TOKEN : asString(input.token)),
      message: "Token must be supplied manually or via .env.",
    });
  }

  return {
    ok: checks.every((x) => x.ok),
    checks,
  };
};

const assertRunnable = async (input) => {
  const activity = asString(input.activityType, "commits");
  const isLive = !Boolean(input.dryRun);
  const needsGitRepo = isLive && ["commits", "prs", "all"].includes(activity);
  if (!needsGitRepo) {
    return;
  }

  if (!(await isGitRepository())) {
    throw new Error("Git repository required for commits and pull requests. Initialize this folder with git or run the GUI from a cloned repository.");
  }

  const identity = await getGitAuthorIdentity();
  if (!identity.userName || !identity.userEmail) {
    throw new Error('Git author identity is not configured. Run: git config --global user.name "Your Name" and git config --global user.email "you@example.com"');
  }

  const baseBranch = asString(input.baseBranch, process.env.GITHUB_BASE_BRANCH ?? "main");
  if (activity === "commits" || activity === "all") {
    const pushStatus = await getCurrentBranchPushStatus();
    if (!pushStatus.ok) {
      throw new Error(pushStatus.message);
    }
  }

  if (activity === "prs" || activity === "all") {
    const baseStatus = await getBaseBranchSyncStatus(baseBranch);
    if (!baseStatus.ok) {
      throw new Error(baseStatus.message);
    }
  }
};

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && reqUrl.pathname === "/") {
    await sendFile(res, path.join(publicDir, "index.html"), "text/html; charset=utf-8");
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/styles.css") {
    await sendFile(res, path.join(publicDir, "styles.css"), "text/css; charset=utf-8");
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/app.js") {
    await sendFile(res, path.join(publicDir, "app.js"), "application/javascript; charset=utf-8");
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/status") {
    sendJson(res, 200, {
      running: Boolean(activeRun),
      runId: activeRun?.id ?? null,
      startedAt: activeRun?.startedAt ?? null,
    });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/preflight") {
    try {
      const input = await parseBody(req);
      sendJson(res, 200, await getPreflight(input));
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    }
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/run") {
    try {
      const input = await parseBody(req);
      await assertRunnable(input);
      const env = buildEnvFromInput(input);
      const result = await runAutomation(env);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/run-stop") {
    if (!activeRun) {
      sendJson(res, 200, { ok: true, message: "No active run." });
      return;
    }

    activeRun.stoppedByUser = true;
    if (!activeRun.child.killed) {
      activeRun.child.kill();
    }

    sendJson(res, 200, { ok: true, message: "Stop signal sent." });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/run-stream") {
    if (activeRun) {
      sendJson(res, 409, { ok: false, error: "Another run is already active." });
      return;
    }

    try {
      const input = await parseBody(req);
      await assertRunnable(input);
      const env = buildEnvFromInput(input);

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });

      await runAutomationStream(env, req, res);
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/templates") {
    try {
      const type = reqUrl.searchParams.get("type");
      const templatePath = resolveTemplatePath(type);
      const content = await readFile(templatePath, "utf8");
      sendJson(res, 200, { ok: true, type, content, path: templatePath });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    }
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/templates") {
    try {
      const input = await parseBody(req);
      const templatePath = resolveTemplatePath(asString(input.type));
      const content = String(input.content ?? "");
      await writeFile(templatePath, content, "utf8");
      sendJson(res, 200, { ok: true, path: templatePath });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    }
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/schedule") {
    try {
      const input = await parseBody(req);
      const result = await runScheduleCommand(input);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : "Unknown error" });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
});

const listenWithFallback = async (startPort, maxHops) => {
  for (let i = 0; i <= maxHops; i += 1) {
    const candidatePort = startPort + i;
    const result = await new Promise((resolve) => {
      const onError = (error) => {
        server.off("listening", onListening);
        resolve({ ok: false, error });
      };
      const onListening = () => {
        server.off("error", onError);
        resolve({ ok: true, port: candidatePort });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidatePort);
    });

    if (result.ok) {
      return result.port;
    }

    if (!result.error || result.error.code !== "EADDRINUSE") {
      throw result.error;
    }
  }

  throw new Error(`No available port found from ${startPort} to ${startPort + maxHops}.`);
};

listenWithFallback(basePort, 15)
  .then((listeningPort) => {
    if (listeningPort !== basePort) {
      console.log(`Port ${basePort} busy. goGreen GUI running at http://localhost:${listeningPort}`);
      return;
    }

    console.log(`goGreen GUI running at http://localhost:${listeningPort}`);
  })
  .catch((error) => {
    console.error("GUI server failed to start.");
    console.error(error);
    process.exitCode = 1;
  });
