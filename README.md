# goGreen

goGreen is a Node.js automation script for generating repository activity.

It can perform all of the following:

- Backdated commits
- GitHub Issues creation
- GitHub Pull Request creation
- Pull Request review comments

## Requirements

- Node.js 18+
- Git configured locally and authenticated with your remote
- A GitHub personal access token with permissions to write issues and pull requests

## Install

```bash
npm install
```

## .env Loader

The script auto-loads `.env` from the project root using `dotenv`.

Quick setup:

```powershell
Copy-Item .env.example .env
```

Then edit `.env` and run:

```bash
node index.js
```

## Configuration

Set these environment variables before running:

- `ACTIVITY_TYPE`: Activity per run: `commits`, `issues`, `prs`, `reviews`, or `all`
- `DRY_RUN`: Safety mode. Default is `true` (no write operations)
- `CONFIRM_LIVE`: Required for live mode. Must be `YES` when `DRY_RUN=false`
- `MAX_PER_RUN`: Hard cap per run for safety (default: `10`)
- `MAX_COMMIT_DATE`: Upper bound date for generated commit timestamps in `YYYY-MM-DD` format
- `STATE_PATH`: File used to store last-run timestamps for cooldown checks
- `GITHUB_TOKEN`: GitHub token used by the API
- `GITHUB_OWNER`: Repository owner (user or org)
- `GITHUB_REPO`: Repository name
- `GITHUB_BASE_BRANCH`: Base branch for PRs (default: `main`)
- `COMMIT_COUNT`: Number of backdated commits (default: `3`)
- `ISSUE_COUNT`: Number of issues to create (default: `1`)
- `PR_COUNT`: Number of pull requests to create (default: `1`)
- `REVIEW_COUNT`: Number of PR review comments to add (default: `1`)
- `COMMITS_PER_DAY`: Commits per day for range strategy (default: `1`)
- `WEEKDAY_COMMITS_JSON`: Optional JSON object for range strategy daily counts by weekday index (`0`=Sun ... `6`=Sat)

Issue/PR enrichment options:

- `ISSUE_LABELS`: Comma-separated labels for new issues
- `ISSUE_ASSIGNEES`: Comma-separated GitHub usernames for issue assignees
- `PR_LABELS`: Comma-separated labels for new PRs
- `PR_ASSIGNEES`: Comma-separated GitHub usernames for PR assignees
- `ISSUE_TEMPLATE_PATH`: Issue template file path (default: `./.github/ISSUE_TEMPLATE.md`)
- `PR_TEMPLATE_PATH`: PR template file path (default: `./.github/PULL_REQUEST_TEMPLATE.md`)

Cooldown options (hours):

- `COOLDOWN_HOURS_DEFAULT`: Fallback cooldown for all activities (default: `24`)
- `COOLDOWN_HOURS_COMMITS`: Cooldown for commits runs
- `COOLDOWN_HOURS_ISSUES`: Cooldown for issues runs
- `COOLDOWN_HOURS_PRS`: Cooldown for PR runs
- `COOLDOWN_HOURS_REVIEWS`: Cooldown for review runs

GitHub pacing and retry options:

- `API_DELAY_MS_DEFAULT`: Delay after each GitHub write request (default: `1500`)
- `API_DELAY_MS_ISSUES`: Delay between issue creations
- `API_DELAY_MS_PRS`: Delay between PR-related API writes
- `API_DELAY_MS_REVIEWS`: Delay between review submissions
- `RETRY_MAX_ATTEMPTS`: Max retry attempts for temporary GitHub failures (default: `5`)
- `RETRY_BASE_DELAY_MS`: Base retry delay for temporary failures (default: `5000`)
- `SECONDARY_RATE_LIMIT_DELAY_MS`: Retry delay used for GitHub secondary rate limits (default: `60000`)

## Run

```bash
node index.js
```

## GUI (Manual Control)

You can run a local GUI to configure and execute activities without editing environment variables manually.

Start the GUI:

```bash
npm run start:gui
```

Open:

```text
http://localhost:3040
```

If port `3040` is already in use, the GUI automatically falls back to the next available port.

GUI supports:

- Create backdated commits
- Create GitHub issues
- Create GitHub pull requests
- Add pull request review comments
- Run one activity type or all activity types
- Select max commit date and range-based commit dates
- Choose dry-run or live mode
- Stream logs in real-time while a run is executing
- Apply quick presets and save your default form values locally in the browser
- Stop an active run from the UI
- Run pre-flight checks before execution
- Review run history and re-apply previous settings
- Create Windows scheduled tasks from the UI
- Edit issue/PR templates from the UI
- Use range calendar preview with per-weekday commit counts

### Step-by-Step GUI Use

1. Start the GUI with `npm run start:gui`.
2. Open the URL shown in terminal. If `3040` is busy, use the fallback port shown in output.
3. Choose token source: use `GITHUB_TOKEN` from `.env` or paste a token manually.
4. Paste the GitHub repository link to auto-fill Owner and Repo.
5. Select an activity type.
6. Start with `Dry run` so you can verify behavior safely.
7. Set counts, labels, assignees, and commit date options as needed.
8. For range commits, choose start and end date and preview the calendar plan.
9. Run `Pre-flight` to catch missing settings before execution.
10. Use `Live run` only after dry-run looks correct.
11. For live `commits`, `prs`, or `all`, this folder must be a real Git repository.
12. If this folder is not a Git repository, clone the real repo here or initialize Git before live commit/PR runs.

## Safe Mode Examples (PowerShell)

Dry-run commits only:

```powershell
$env:ACTIVITY_TYPE="commits"
$env:COMMIT_COUNT="3"
$env:DRY_RUN="true"
node index.js
```

Live issues only:

```powershell
$env:ACTIVITY_TYPE="issues"
$env:ISSUE_COUNT="1"
$env:DRY_RUN="false"
$env:CONFIRM_LIVE="YES"
$env:GITHUB_TOKEN="<token>"
$env:GITHUB_OWNER="<owner>"
$env:GITHUB_REPO="<repo>"
node index.js
```

Live PRs only with labels and assignees:

```powershell
$env:ACTIVITY_TYPE="prs"
$env:PR_COUNT="1"
$env:PR_LABELS="automation,activity"
$env:PR_ASSIGNEES="octocat"
$env:DRY_RUN="false"
$env:CONFIRM_LIVE="YES"
$env:GITHUB_TOKEN="<token>"
$env:GITHUB_OWNER="<owner>"
$env:GITHUB_REPO="<repo>"
node index.js
```

## Templates

Default templates are included:

- `.github/ISSUE_TEMPLATE.md`
- `.github/PULL_REQUEST_TEMPLATE.md`

Supported placeholders in templates:

- `{{timestamp}}`
- `{{activity}}`
- `{{index}}`

## Task Scheduler (Windows)

Helper scripts:

- `scripts/run-activity.ps1`
- `scripts/register-task.ps1`

Create a scheduled task for selected days:

```powershell
Set-Location E:\goGreen-main
.\scripts\register-task.ps1 -TaskName "goGreen-commits" -Activity commits -Days "MON,THU" -StartTime "10:00" -DryRun -CommitCount 2
```

Create a live scheduled task (uses same script with live mode):

```powershell
Set-Location E:\goGreen-main
.\scripts\register-task.ps1 -TaskName "goGreen-issues" -Activity issues -Days "TUE" -StartTime "11:30" -IssueCount 1 -Owner "<owner>" -Repo "<repo>"
```

Note: For scheduled live runs, configure `GITHUB_TOKEN` for the account that runs the task.

## Notes

- One activity type runs per execution (`ACTIVITY_TYPE`).
- Dry run is enabled by default.
- Live writes are blocked unless `CONFIRM_LIVE=YES`.
- Cooldown guard blocks live runs when minimum hours have not elapsed since the same activity type last ran.
- GitHub content creation is now paced and retried automatically to reduce secondary rate limit failures.
- Large batches can still be throttled by GitHub, so prefer smaller runs for issues and PRs when possible.
- Review creation skips PRs opened by the authenticated user.
- If there are fewer eligible open PRs than `REVIEW_COUNT`, the script logs how many were actually reviewed.
- Pull requests are created by generating a new branch and committing a small markdown file.
