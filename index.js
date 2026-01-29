import jsonfile from "jsonfile";
import moment from "moment";
import simpleGit from "simple-git";
import random from "random";
import { Octokit } from "@octokit/rest";
import { config as loadEnv } from "dotenv";
import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";

loadEnv({ quiet: true });

const parseIntSetting = (name, value, fallback) => {
  const n = Number.parseInt(value ?? "", 10);
  if (Number.isInteger(n) && n >= 0) {
    return n;
  }

  if (value === undefined) {
    return fallback;
  }

  throw new Error(`${name} must be a non-negative integer.`);
};

const DATA_PATH = "./data.json";
const STATE_PATH = process.env.STATE_PATH ?? "./.activity-state.json";
const git = simpleGit();

const COMMIT_COUNT = Number.parseInt(process.env.COMMIT_COUNT ?? "3", 10);
const ISSUE_COUNT = Number.parseInt(process.env.ISSUE_COUNT ?? "1", 10);
const PR_COUNT = Number.parseInt(process.env.PR_COUNT ?? "1", 10);
const REVIEW_COUNT = Number.parseInt(process.env.REVIEW_COUNT ?? "1", 10);
const MAX_PER_RUN = Number.parseInt(process.env.MAX_PER_RUN ?? "10", 10);

const ACTIVITY_TYPE = (process.env.ACTIVITY_TYPE ?? "commits").toLowerCase();
const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() !== "false";
const CONFIRM_LIVE = (process.env.CONFIRM_LIVE ?? "").toUpperCase() === "YES";
const MAX_COMMIT_DATE = process.env.MAX_COMMIT_DATE ?? moment().format("YYYY-MM-DD");
const COMMIT_STRATEGY = (process.env.COMMIT_STRATEGY ?? "random").toLowerCase();
const COMMIT_START_DATE = process.env.COMMIT_START_DATE;
const COMMIT_END_DATE = process.env.COMMIT_END_DATE;
const COMMITS_PER_DAY = parseIntSetting("COMMITS_PER_DAY", process.env.COMMITS_PER_DAY, 1);
const WEEKDAY_COMMITS_JSON = process.env.WEEKDAY_COMMITS_JSON;

const OWNER = process.env.GITHUB_OWNER;
const REPO = process.env.GITHUB_REPO;
const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH ?? "main";
const TOKEN = process.env.GITHUB_TOKEN;

const ISSUE_LABELS = (process.env.ISSUE_LABELS ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const ISSUE_ASSIGNEES = (process.env.ISSUE_ASSIGNEES ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const PR_LABELS = (process.env.PR_LABELS ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const PR_ASSIGNEES = (process.env.PR_ASSIGNEES ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const ISSUE_TEMPLATE_PATH = process.env.ISSUE_TEMPLATE_PATH ?? "./.github/ISSUE_TEMPLATE.md";
const PR_TEMPLATE_PATH = process.env.PR_TEMPLATE_PATH ?? "./.github/PULL_REQUEST_TEMPLATE.md";

const API_DELAY_MS_DEFAULT = parseIntSetting("API_DELAY_MS_DEFAULT", process.env.API_DELAY_MS_DEFAULT, 1500);
const API_DELAY_MS_ISSUES = parseIntSetting(
  "API_DELAY_MS_ISSUES",
  process.env.API_DELAY_MS_ISSUES,
  API_DELAY_MS_DEFAULT,
);
const API_DELAY_MS_PRS = parseIntSetting(
  "API_DELAY_MS_PRS",
  process.env.API_DELAY_MS_PRS,
  API_DELAY_MS_DEFAULT,
);
const API_DELAY_MS_REVIEWS = parseIntSetting(
  "API_DELAY_MS_REVIEWS",
  process.env.API_DELAY_MS_REVIEWS,
  API_DELAY_MS_DEFAULT,
);
const RETRY_MAX_ATTEMPTS = parseIntSetting("RETRY_MAX_ATTEMPTS", process.env.RETRY_MAX_ATTEMPTS, 5);
const RETRY_BASE_DELAY_MS = parseIntSetting("RETRY_BASE_DELAY_MS", process.env.RETRY_BASE_DELAY_MS, 5000);
const SECONDARY_RATE_LIMIT_DELAY_MS = parseIntSetting(
  "SECONDARY_RATE_LIMIT_DELAY_MS",
  process.env.SECONDARY_RATE_LIMIT_DELAY_MS,
  60000,
);

const parsedMaxCommitDate = moment(MAX_COMMIT_DATE, "YYYY-MM-DD", true);
if (!parsedMaxCommitDate.isValid()) {
  throw new Error("MAX_COMMIT_DATE must be in YYYY-MM-DD format.");
}
const MAX_COMMIT_MOMENT = parsedMaxCommitDate.endOf("day");

const parseCooldown = (name, value, fallback) => {
  const n = Number.parseFloat(value ?? "");
  if (Number.isFinite(n) && n >= 0) {
    return n;
  }

  if (value === undefined) {
    return fallback;
  }

  throw new Error(`${name} must be a non-negative number.`);
};

const COOLDOWN_HOURS_DEFAULT = parseCooldown(
  "COOLDOWN_HOURS_DEFAULT",
  process.env.COOLDOWN_HOURS_DEFAULT,
  24,
);
const COOLDOWN_HOURS_COMMITS = parseCooldown(
  "COOLDOWN_HOURS_COMMITS",
  process.env.COOLDOWN_HOURS_COMMITS,
  COOLDOWN_HOURS_DEFAULT,
);
const COOLDOWN_HOURS_ISSUES = parseCooldown(
  "COOLDOWN_HOURS_ISSUES",
  process.env.COOLDOWN_HOURS_ISSUES,
  COOLDOWN_HOURS_DEFAULT,
);
const COOLDOWN_HOURS_PRS = parseCooldown(
  "COOLDOWN_HOURS_PRS",
  process.env.COOLDOWN_HOURS_PRS,
  COOLDOWN_HOURS_DEFAULT,
);
const COOLDOWN_HOURS_REVIEWS = parseCooldown(
  "COOLDOWN_HOURS_REVIEWS",
  process.env.COOLDOWN_HOURS_REVIEWS,
  COOLDOWN_HOURS_DEFAULT,
);

const randomPastDate = () => {
  const start = moment().subtract(1, "y").add(1, "d").startOf("day");
  const end = MAX_COMMIT_MOMENT;

  if (end.isBefore(start)) {
    throw new Error("MAX_COMMIT_DATE is earlier than the generated date range start.");
  }

  const minTs = start.valueOf();
  const maxTs = end.valueOf();
  const ts = random.int(minTs, maxTs);
  return moment(ts).format();
};

const createRangeCommitPlan = () => {
  if (!COMMIT_START_DATE || !COMMIT_END_DATE) {
    throw new Error("COMMIT_START_DATE and COMMIT_END_DATE are required for COMMIT_STRATEGY=range.");
  }

  const start = moment(COMMIT_START_DATE, "YYYY-MM-DD", true).startOf("day");
  const end = moment(COMMIT_END_DATE, "YYYY-MM-DD", true).startOf("day");

  if (!start.isValid() || !end.isValid()) {
    throw new Error("COMMIT_START_DATE and COMMIT_END_DATE must be in YYYY-MM-DD format.");
  }

  if (end.isBefore(start)) {
    throw new Error("COMMIT_END_DATE must be on or after COMMIT_START_DATE.");
  }

  if (end.isAfter(MAX_COMMIT_MOMENT)) {
    throw new Error("COMMIT_END_DATE cannot be later than MAX_COMMIT_DATE.");
  }

  let weekdayCommits = null;
  if (WEEKDAY_COMMITS_JSON) {
    try {
      const parsed = JSON.parse(WEEKDAY_COMMITS_JSON);
      if (parsed && typeof parsed === "object") {
        weekdayCommits = parsed;
      }
    } catch {
      throw new Error("WEEKDAY_COMMITS_JSON must be valid JSON.");
    }
  }

  const getCommitsForDay = (momentDate) => {
    if (!weekdayCommits) {
      return COMMITS_PER_DAY;
    }

    const dayIndex = String(momentDate.day());
    const candidate = Number.parseInt(weekdayCommits[dayIndex] ?? "", 10);
    if (Number.isInteger(candidate) && candidate >= 0) {
      return candidate;
    }

    return COMMITS_PER_DAY;
  };

  const dates = [];
  const current = start.clone();
  while (current.isSameOrBefore(end, "day")) {
    const commitsForDay = getCommitsForDay(current);
    for (let i = 0; i < commitsForDay; i += 1) {
      dates.push(current.clone().hour(12).minute(i).second(0).format());
    }
    current.add(1, "day");
  }

  return dates;
};

const createRandomCommitPlan = (count) => Array.from({ length: count }, () => randomPastDate());

const createCommitPlan = (count) => {
  if (COMMIT_STRATEGY === "range") {
    return createRangeCommitPlan();
  }

  if (COMMIT_STRATEGY !== "random") {
    throw new Error("COMMIT_STRATEGY must be either random or range.");
  }

  return createRandomCommitPlan(count);
};

const readTemplate = async (templatePath, fallbackText) => {
  try {
    return await readFile(templatePath, "utf8");
  } catch {
    return fallbackText;
  }
};

const renderTemplate = (template, values) =>
  Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{{${key}}}`, String(value)),
    template,
  );

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const getApiDelayMs = (activityType) => {
  if (activityType === "issues") return API_DELAY_MS_ISSUES;
  if (activityType === "prs") return API_DELAY_MS_PRS;
  return API_DELAY_MS_REVIEWS;
};

const getRetryDelayMs = (error, attempt) => {
  const message = error?.message?.toLowerCase?.() ?? "";
  if (message.includes("secondary rate limit")) {
    return SECONDARY_RATE_LIMIT_DELAY_MS * attempt;
  }
  return RETRY_BASE_DELAY_MS * attempt;
};

const isRetriableGithubError = (error) => {
  const message = error?.message?.toLowerCase?.() ?? "";
  const status = error?.status;
  return message.includes("secondary rate limit") || status === 429 || status === 502 || status === 503;
};

const runGithubRequest = async (activityType, label, request) => {
  if (DRY_RUN) {
    return request();
  }

  let attempt = 0;
  while (attempt < RETRY_MAX_ATTEMPTS) {
    attempt += 1;
    try {
      const result = await request();
      const delayMs = getApiDelayMs(activityType);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
      return result;
    } catch (error) {
      if (!isRetriableGithubError(error) || attempt >= RETRY_MAX_ATTEMPTS) {
        throw error;
      }

      const delayMs = getRetryDelayMs(error, attempt);
      console.log(`${label} hit a temporary GitHub limit. Retrying in ${delayMs}ms (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}).`);
      await sleep(delayMs);
    }
  }

  throw new Error(`${label} failed after ${RETRY_MAX_ATTEMPTS} retry attempts.`);
};

const ensureSafeInput = (name, value) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  if (value > MAX_PER_RUN) {
    throw new Error(`${name} exceeds MAX_PER_RUN (${MAX_PER_RUN}).`);
  }
};

const ensureSingleActivityMode = () => {
  const allowed = new Set(["commits", "issues", "prs", "reviews", "all"]);
  if (!allowed.has(ACTIVITY_TYPE)) {
    throw new Error("ACTIVITY_TYPE must be one of: commits, issues, prs, reviews, all.");
  }
};

const ensureLiveConfirmed = () => {
  if (!DRY_RUN && !CONFIRM_LIVE) {
    throw new Error("Live mode requires CONFIRM_LIVE=YES.");
  }
};

const logSettings = () => {
  console.log(`Activity: ${ACTIVITY_TYPE}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Max actions per run: ${MAX_PER_RUN}`);
  console.log(`Max commit date: ${MAX_COMMIT_DATE}`);
  console.log(`Commit strategy: ${COMMIT_STRATEGY}`);
  console.log(`State file: ${STATE_PATH}`);
  console.log(`API pacing (issues/prs/reviews): ${API_DELAY_MS_ISSUES}/${API_DELAY_MS_PRS}/${API_DELAY_MS_REVIEWS}ms`);
};

const ensureGitRepository = async () => {
  try {
    const result = await git.revparse(["--is-inside-work-tree"]);
    if (String(result).trim() === "true") {
      return;
    }
  } catch {
    // Fall through to the clearer error below.
  }

  throw new Error("Git repository required for commits and pull requests. Initialize this folder with git or run inside a cloned repository.");
};

const getGitConfigValue = async (key, options = {}) => {
  try {
    const args = [];
    if (options.global) {
      args.push("--global");
    }
    args.push(key);
    const value = await git.raw(["config", ...args]);
    return String(value).trim();
  } catch {
    return "";
  }
};

const getCurrentBranchName = async () => String(await git.revparse(["--abbrev-ref", "HEAD"])).trim();

const fetchRemoteBranch = async (remoteName, branchName) => {
  try {
    await git.fetch(remoteName, branchName);
  } catch {
    // Validation below will surface the actionable error.
  }
};

const refExists = async (refName) => {
  try {
    await git.raw(["rev-parse", "--verify", refName]);
    return true;
  } catch {
    return false;
  }
};

const hasMergeBase = async (leftRef, rightRef) => {
  try {
    const result = String(await git.raw(["merge-base", leftRef, rightRef])).trim();
    return /^[0-9a-f]{7,40}$/i.test(result);
  } catch {
    return false;
  }
};

const getAheadBehindCounts = async (leftRef, rightRef) => {
  const raw = String(await git.raw(["rev-list", "--left-right", "--count", `${leftRef}...${rightRef}`])).trim();
  const [aheadRaw = "0", behindRaw = "0"] = raw.split(/\s+/);
  return {
    ahead: Number.parseInt(aheadRaw, 10) || 0,
    behind: Number.parseInt(behindRaw, 10) || 0,
  };
};

const ensureCurrentBranchPushReady = async () => {
  const currentBranch = await getCurrentBranchName();
  const remoteName = await getGitConfigValue(`branch.${currentBranch}.remote`);
  const mergeRef = await getGitConfigValue(`branch.${currentBranch}.merge`);

  if (!remoteName || !mergeRef) {
    throw new Error(`Current branch ${currentBranch} has no upstream branch. Set tracking first with: git push --set-upstream origin ${currentBranch}`);
  }

  const remoteBranchName = mergeRef.replace(/^refs\/heads\//, "");
  const remoteRef = `${remoteName}/${remoteBranchName}`;
  await fetchRemoteBranch(remoteName, remoteBranchName);

  if (!(await refExists(remoteRef))) {
    throw new Error(`Remote branch ${remoteRef} was not found. Push the branch with: git push --set-upstream ${remoteName} ${currentBranch}`);
  }

  if (!(await hasMergeBase(currentBranch, remoteRef))) {
    throw new Error(`Current branch ${currentBranch} does not share history with ${remoteRef}. Clone the real repository or align this branch before live commit runs.`);
  }

  const { behind } = await getAheadBehindCounts(currentBranch, remoteRef);
  if (behind > 0) {
    throw new Error(`Current branch ${currentBranch} is behind ${remoteRef} by ${behind} commit(s). Pull or rebase it before live commit runs.`);
  }
};

const ensureBaseBranchSyncReady = async () => {
  const remoteRef = `origin/${BASE_BRANCH}`;
  await fetchRemoteBranch("origin", BASE_BRANCH);

  if (!(await refExists(BASE_BRANCH))) {
    throw new Error(`Local base branch ${BASE_BRANCH} does not exist. Create or check out ${BASE_BRANCH} before live PR runs.`);
  }

  if (!(await refExists(remoteRef))) {
    throw new Error(`Remote base branch ${remoteRef} was not found. Verify GITHUB_BASE_BRANCH and origin remote configuration.`);
  }

  if (!(await hasMergeBase(BASE_BRANCH, remoteRef))) {
    throw new Error(`Local ${BASE_BRANCH} does not share history with ${remoteRef}. Clone the real repository or realign this branch before live PR runs.`);
  }

  const { ahead, behind } = await getAheadBehindCounts(BASE_BRANCH, remoteRef);
  if (ahead > 0 && behind > 0) {
    throw new Error(`Local ${BASE_BRANCH} has diverged from ${remoteRef}. Reconcile the branch before live PR runs.`);
  }
};

const ensureGitAuthorIdentity = async () => {
  const userName = (await getGitConfigValue("user.name")) || (await getGitConfigValue("user.name", { global: true }));
  const userEmail = (await getGitConfigValue("user.email")) || (await getGitConfigValue("user.email", { global: true }));

  if (!userName || !userEmail) {
    throw new Error(
      'Git author identity is not configured. Run: git config --global user.name "Your Name" and git config --global user.email "you@example.com"',
    );
  }
};

const getCooldownHours = (activityType) => {
  if (activityType === "commits") return COOLDOWN_HOURS_COMMITS;
  if (activityType === "issues") return COOLDOWN_HOURS_ISSUES;
  if (activityType === "prs") return COOLDOWN_HOURS_PRS;
  return COOLDOWN_HOURS_REVIEWS;
};

const loadActivityState = async () => {
  try {
    const raw = await readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
};

const saveActivityState = async (state) => {
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
};

const ensureCooldownAllowed = async (activityType) => {
  void activityType;
  // Cooldown has been intentionally disabled.
};

const markActivityRun = async (activityType) => {
  void activityType;
  // Cooldown state writes are disabled because cooldown enforcement is disabled.
};

const makeBackdatedCommits = async (count) => {
  const commitPlan = createCommitPlan(count);

  ensureSafeInput("COMMIT_PLAN_LENGTH", commitPlan.length);

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would create ${commitPlan.length} backdated commit(s) and push to origin.`);
    return;
  }

  for (let i = 0; i < commitPlan.length; i += 1) {
    const date = commitPlan[i];
    await jsonfile.writeFile(DATA_PATH, { date });
    await git.add([DATA_PATH]);
    await git.commit(`chore(activity): commit ${i + 1}`, { "--date": date });
    console.log(`commit ${i + 1}/${commitPlan.length}: ${date}`);
  }

  await git.push();
};

const ensureGithubConfig = () => {
  if (DRY_RUN) {
    return;
  }

  if (!TOKEN) {
    throw new Error("GITHUB_TOKEN is required for issues, PRs, and reviews.");
  }

  if (!OWNER || !REPO) {
    throw new Error("GITHUB_OWNER and GITHUB_REPO are required for GitHub API operations.");
  }
};

const createIssues = async (octokit, count) => {
  const template = await readTemplate(
    ISSUE_TEMPLATE_PATH,
    "## Summary\n\nAutomated issue created at {{timestamp}}.",
  );

  for (let i = 0; i < count; i += 1) {
    const id = `${Date.now()}-${i + 1}`;
    const title = `Activity issue ${id}`;
    const body = renderTemplate(template, {
      timestamp: new Date().toISOString(),
      activity: "issues",
      index: i + 1,
    });

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would create issue: ${title}`);
      continue;
    }

    await runGithubRequest("issues", `Issue ${i + 1}`, () => octokit.issues.create({
      owner: OWNER,
      repo: REPO,
      title,
      body,
      labels: ISSUE_LABELS,
      assignees: ISSUE_ASSIGNEES,
    }));

    console.log(`issue ${i + 1}/${count}: ${title}`);
  }
};

const createPullRequests = async (octokit, count) => {
  const template = await readTemplate(
    PR_TEMPLATE_PATH,
    "## Summary\n\nAutomated pull request created at {{timestamp}}.",
  );

  for (let i = 0; i < count; i += 1) {
    const id = `${Date.now()}-${i + 1}`;
    const branchName = `activity/pr-${id}`;
    const fileName = `activity-pr-${id}.md`;
    const title = `Activity PR ${id}`;
    const body = renderTemplate(template, {
      timestamp: new Date().toISOString(),
      activity: "pull_request",
      index: i + 1,
    });

    if (DRY_RUN) {
      console.log(`[DRY RUN] Would create branch ${branchName}, commit ${fileName}, and open PR: ${title}`);
      continue;
    }

    await git.checkout(BASE_BRANCH);
    await git.pull("origin", BASE_BRANCH);
    await git.checkoutLocalBranch(branchName);

    await writeFile(fileName, `# ${title}\n\nGenerated at ${new Date().toISOString()}\n`, "utf8");
    await git.add([fileName]);
    await git.commit(`chore(activity): open PR ${i + 1}`);
    await git.push(["-u", "origin", branchName]);

    const pull = await runGithubRequest("prs", `Pull request ${i + 1}`, () => octokit.pulls.create({
      owner: OWNER,
      repo: REPO,
      title,
      head: branchName,
      base: BASE_BRANCH,
      body,
    }));

    if (PR_LABELS.length > 0) {
      await runGithubRequest("prs", `PR labels ${i + 1}`, () => octokit.issues.addLabels({
        owner: OWNER,
        repo: REPO,
        issue_number: pull.data.number,
        labels: PR_LABELS,
      }));
    }

    if (PR_ASSIGNEES.length > 0) {
      await runGithubRequest("prs", `PR assignees ${i + 1}`, () => octokit.issues.addAssignees({
        owner: OWNER,
        repo: REPO,
        issue_number: pull.data.number,
        assignees: PR_ASSIGNEES,
      }));
    }

    await git.checkout(BASE_BRANCH);
    console.log(`pull request ${i + 1}/${count}: ${title}`);
  }
};

const createReviews = async (octokit, count) => {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would add up to ${count} review comment(s) on eligible open PR(s) not opened by you.`);
    return;
  }

  const me = await octokit.users.getAuthenticated();
  const myLogin = me.data.login;

  const pulls = await octokit.pulls.list({
    owner: OWNER,
    repo: REPO,
    state: "open",
    per_page: 100,
  });

  const candidates = pulls.data.filter((pr) => pr.user?.login !== myLogin);
  const reviewable = candidates.slice(0, count);

  for (let i = 0; i < reviewable.length; i += 1) {
    const pr = reviewable[i];

    await runGithubRequest("reviews", `Review ${i + 1}`, () => octokit.pulls.createReview({
      owner: OWNER,
      repo: REPO,
      pull_number: pr.number,
      event: "COMMENT",
      body: `Automated review comment ${i + 1}/${reviewable.length}`,
    }));

    console.log(`review ${i + 1}/${reviewable.length}: PR #${pr.number}`);
  }

  if (reviewable.length < count) {
    console.log(`Requested ${count} reviews, but only ${reviewable.length} eligible PR(s) were found.`);
  }
};

const main = async () => {
  ensureSingleActivityMode();
  ensureLiveConfirmed();
  ensureSafeInput("COMMIT_COUNT", COMMIT_COUNT);
  ensureSafeInput("ISSUE_COUNT", ISSUE_COUNT);
  ensureSafeInput("PR_COUNT", PR_COUNT);
  ensureSafeInput("REVIEW_COUNT", REVIEW_COUNT);
  logSettings();

  const runCommits = async () => {
    if (!DRY_RUN) {
      await ensureGitRepository();
      await ensureGitAuthorIdentity();
      await ensureCurrentBranchPushReady();
    }
    await ensureCooldownAllowed("commits");
    console.log(`Creating ${COMMIT_COUNT} commit(s)...`);
    await makeBackdatedCommits(COMMIT_COUNT);
    await markActivityRun("commits");
  };

  const runIssues = async (octokit) => {
    await ensureCooldownAllowed("issues");
    console.log(`Creating ${ISSUE_COUNT} issue(s)...`);
    await createIssues(octokit, ISSUE_COUNT);
    await markActivityRun("issues");
  };

  const runPrs = async (octokit) => {
    if (!DRY_RUN) {
      await ensureGitRepository();
      await ensureGitAuthorIdentity();
      await ensureBaseBranchSyncReady();
    }
    await ensureCooldownAllowed("prs");
    console.log(`Creating ${PR_COUNT} pull request(s)...`);
    await createPullRequests(octokit, PR_COUNT);
    await markActivityRun("prs");
  };

  const runReviews = async (octokit) => {
    await ensureCooldownAllowed("reviews");
    console.log(`Creating ${REVIEW_COUNT} review(s)...`);
    await createReviews(octokit, REVIEW_COUNT);
    await markActivityRun("reviews");
  };

  if (ACTIVITY_TYPE === "commits") {
    await runCommits();
    return;
  }

  if (ACTIVITY_TYPE === "all") {
    await runCommits();
    ensureGithubConfig();
    const octokit = new Octokit({ auth: TOKEN });
    await runIssues(octokit);
    await runPrs(octokit);
    await runReviews(octokit);
    return;
  }

  ensureGithubConfig();
  const octokit = new Octokit({ auth: TOKEN });

  if (ACTIVITY_TYPE === "issues") {
    await runIssues(octokit);
    return;
  }

  if (ACTIVITY_TYPE === "prs") {
    await runPrs(octokit);
    return;
  }

  await runReviews(octokit);
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
