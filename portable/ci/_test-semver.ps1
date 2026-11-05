param([string[]]$Cases)

# Comparator used inside the workflow; kept here so it can be unit-tested.
function Compare-Semver([string]$a, [string]$b) {
  $pa = $a.Split('-', 2)
  $pb = $b.Split('-', 2)
  $ca = $pa[0].Split('.')
  $cb = $pb[0].Split('.')
  for ($i = 0; $i -lt 3; $i++) {
    $na = if ($i -lt $ca.Count) { [long]$ca[$i] } else { 0 }
    $nb = if ($i -lt $cb.Count) { [long]$cb[$i] } else { 0 }
    if ($na -ne $nb) { if ($na -gt $nb) { return 1 } else { return -1 } }
  }
  $ra = $pa.Count -gt 1
  $rb = $pb.Count -gt 1
  if (-not $ra -and -not $rb) { return 0 }
  if (-not $ra) { return 1 }
  if (-not $rb) { return -1 }
  $ia = $pa[1].Split('.')
  $ib = $pb[1].Split('.')
  $n = [Math]::Min($ia.Count, $ib.Count)
  for ($i = 0; $i -lt $n; $i++) {
    $x = $ia[$i]; $y = $ib[$i]
    $xn = $x -match '^\d+$'; $yn = $y -match '^\d+$'
    if ($xn -and $yn) {
      if ([long]$x -ne [long]$y) { if ([long]$x -gt [long]$y) { return 1 } else { return -1 } }
    } elseif ($xn) { return -1 }
    elseif ($yn) { return 1 }
    else {
      $c = [string]::CompareOrdinal($x, $y)
      if ($c -ne 0) { if ($c -gt 0) { return 1 } else { return -1 } }
    }
  }
  if ($ia.Count -eq $ib.Count) { return 0 }
  if ($ia.Count -gt $ib.Count) { return 1 } else { return -1 }
}

$expected = @(
  @('0.2.2-rc.1', '0.2.2-alpha.3', 1),
  @('0.2.2-alpha.3', '0.2.2-rc.1', -1),
  @('0.2.2-rc.1', '0.2.2-rc.1', 0),
  @('0.2.2', '0.2.2-rc.1', 1),
  @('0.2.2-rc.1', '0.2.2', -1),
  @('0.2.3-alpha.0', '0.2.2', 1),
  @('0.10.0', '0.9.9', 1),
  @('1.0.0', '1.0.0-rc.1', 1),
  @('0.2.2-rc.10', '0.2.2-rc.9', 1),
  @('0.2.2-alpha.3', '0.2.2-alpha.10', -1),
  @('0.2.2-beta.1', '0.2.2-alpha.5', 1),
  @('0.2', '0.2.0', 0)
)

$failed = 0
foreach ($case in $expected) {
  $got = Compare-Semver $case[0] $case[1]
  $want = [int]$case[2]
  $ok = ($got -eq $want)
  if (-not $ok) { $failed++ }
  "{0} {1,-16} vs {2,-16} => {3,2} (want {4,2})" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $case[0], $case[1], $got, $want
}
"failed: $failed"
