param()

# Mirrors the "Resolve target version" step of ci/build-portable.yml, with the
# npm lookup stubbed so the selection logic can be exercised offline.

function Compare-Semver([string]$a, [string]$b) {
  $pa = $a.Split('-', 2); $pb = $b.Split('-', 2)
  $ca = $pa[0].Split('.'); $cb = $pb[0].Split('.')
  for ($i = 0; $i -lt 3; $i++) {
    $na = if ($i -lt $ca.Count) { [long]$ca[$i] } else { 0 }
    $nb = if ($i -lt $cb.Count) { [long]$cb[$i] } else { 0 }
    if ($na -ne $nb) { if ($na -gt $nb) { return 1 } else { return -1 } }
  }
  $ra = $pa.Count -gt 1; $rb = $pb.Count -gt 1
  if (-not $ra -and -not $rb) { return 0 }
  if (-not $ra) { return 1 }
  if (-not $rb) { return -1 }
  $ia = $pa[1].Split('.'); $ib = $pb[1].Split('.')
  $n = [Math]::Min($ia.Count, $ib.Count)
  for ($i = 0; $i -lt $n; $i++) {
    $x = $ia[$i]; $y = $ib[$i]
    $xn = $x -match '^\d+$'; $yn = $y -match '^\d+$'
    if ($xn -and $yn) {
      if ([long]$x -ne [long]$y) { if ([long]$x -gt [long]$y) { return 1 } else { return -1 } }
    } elseif ($xn) { return -1 } elseif ($yn) { return 1 }
    else { $c = [string]::CompareOrdinal($x, $y); if ($c -ne 0) { if ($c -gt 0) { return 1 } else { return -1 } } }
  }
  if ($ia.Count -eq $ib.Count) { return 0 }
  if ($ia.Count -gt $ib.Count) { return 1 } else { return -1 }
}

$script:Available = @()

function Test-NpmVersion([string]$v) {
  if (-not $v) { return $false }
  return ($script:Available -contains $v)
}

function Select-Version([string]$repoVersion, [string]$upstream) {
  $candidates = @($repoVersion, $upstream) | Where-Object { $_ }
  if (-not $candidates) { throw 'no candidates' }
  $winner = $candidates[0]
  foreach ($c in $candidates) { if ((Compare-Semver $c $winner) -gt 0) { $winner = $c } }
  $version = $winner
  if (-not (Test-NpmVersion $version)) {
    $fallback = $candidates | Where-Object { $_ -ne $version } | Select-Object -First 1
    if (-not $fallback -or -not (Test-NpmVersion $fallback)) { throw "no usable version on npm ($repoVersion / $upstream)" }
    $version = $fallback
  }
  return $version
}

$cases = @(
  @{ repo = '0.2.2-alpha.3'; upstream = '0.2.2-rc.1'; npm = @('0.2.2-alpha.3', '0.2.2-rc.1'); want = '0.2.2-rc.1'; why = 'upstream release is newer than a lagging master' },
  @{ repo = '0.2.3-alpha.0'; upstream = '0.2.2-rc.1'; npm = @('0.2.2-rc.1'); want = '0.2.2-rc.1'; why = 'merged-but-unreleased master falls back to npm' },
  @{ repo = '0.2.3-alpha.0'; upstream = '0.2.2-rc.1'; npm = @('0.2.2-rc.1', '0.2.3-alpha.0'); want = '0.2.3-alpha.0'; why = 'published master version wins when newer' },
  @{ repo = '0.2.2'; upstream = '0.2.2-rc.1'; npm = @('0.2.2', '0.2.2-rc.1'); want = '0.2.2'; why = 'final release beats its own rc' },
  @{ repo = '0.2.2-alpha.3'; upstream = ''; npm = @('0.2.2-alpha.3'); want = '0.2.2-alpha.3'; why = 'upstream API empty -> repo version' },
  @{ repo = '0.2.2-alpha.3'; upstream = ''; npm = @(); want = 'THROW'; why = 'nothing published -> fail loudly' }
)

$failed = 0
foreach ($c in $cases) {
  $script:Available = $c.npm
  $got = ''
  try { $got = Select-Version $c.repo $c.upstream } catch { $got = 'THROW' }
  $ok = ($got -eq $c.want)
  if (-not $ok) { $failed++ }
  "{0} repo={1,-14} upstream={2,-12} npm=[{3}] => {4} (want {5}) // {6}" -f `
    $(if ($ok) { 'PASS' } else { 'FAIL' }), $c.repo, $(if ($c.upstream) { $c.upstream } else { '<none>' }), ($c.npm -join ','), $got, $c.want, $c.why
}
"failed: $failed"
