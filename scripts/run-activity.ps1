param(
  [ValidateSet("commits", "issues", "prs", "reviews")]
  [string]$Activity = "commits",

  [switch]$DryRun,

  [int]$CommitCount = 3,
  [int]$IssueCount = 1,
  [int]$PrCount = 1,
  [int]$ReviewCount = 1,

  [string]$Owner = "",
  [string]$Repo = "",
  [string]$BaseBranch = "main"
)

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

$env:ACTIVITY_TYPE = $Activity
$env:COMMIT_COUNT = "$CommitCount"
$env:ISSUE_COUNT = "$IssueCount"
$env:PR_COUNT = "$PrCount"
$env:REVIEW_COUNT = "$ReviewCount"
$env:GITHUB_BASE_BRANCH = $BaseBranch
$env:MAX_PER_RUN = "10"

if ($Owner) { $env:GITHUB_OWNER = $Owner }
if ($Repo) { $env:GITHUB_REPO = $Repo }

if ($DryRun) {
  $env:DRY_RUN = "true"
  $env:CONFIRM_LIVE = ""
} else {
  $env:DRY_RUN = "false"
  $env:CONFIRM_LIVE = "YES"
}

node index.js
