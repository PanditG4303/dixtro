param(
  [string]$TaskName = "goGreen-activity",

  [ValidateSet("commits", "issues", "prs", "reviews")]
  [string]$Activity = "commits",

  [string]$Days = "MON,WED,FRI",
  [string]$StartTime = "09:00",

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
$runnerPath = Join-Path $repoRoot "scripts\run-activity.ps1"

$taskParts = @(
  "powershell.exe",
  "-NoProfile",
  "-ExecutionPolicy Bypass",
  "-File `"$runnerPath`"",
  "-Activity $Activity",
  "-CommitCount $CommitCount",
  "-IssueCount $IssueCount",
  "-PrCount $PrCount",
  "-ReviewCount $ReviewCount",
  "-BaseBranch $BaseBranch"
)

if ($DryRun) {
  $taskParts += "-DryRun"
}

if ($Owner) {
  $taskParts += "-Owner $Owner"
}

if ($Repo) {
  $taskParts += "-Repo $Repo"
}

$taskAction = $taskParts -join " "

schtasks /Create /SC WEEKLY /D $Days /ST $StartTime /TN $TaskName /TR $taskAction /F

if ($LASTEXITCODE -eq 0) {
  Write-Host "Scheduled task created: $TaskName"
} else {
  Write-Error "Failed to create scheduled task."
}
