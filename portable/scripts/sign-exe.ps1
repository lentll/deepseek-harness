#
# Sign the portable executable with a local code-signing certificate.
#
# A self-signed certificate makes the binary tamper-evident and gives it a
# "Digital Signatures" tab in the Windows file properties. It does NOT create
# public trust, so SmartScreen still shows its warning until the certificate is
# replaced by a paid OV/EV one. Re-signing is required after every rebuild,
# because stamping the icon and version resource invalidates the digest.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sign-exe.ps1 [-ExePath <path>]
#
param(
  [string]$ExePath = "",
  [string]$Subject = "CN=JiYuan LvDong Studio, O=JiYuan LvDong, C=CN"
)

$ErrorActionPreference = "Stop"

# No hard-coded drive letter: mirror build-portable.mjs and default to
# "<project drive>:\AI\deepseek-harness-protable".
if (-not $ExePath) {
  $drive = [System.IO.Path]::GetPathRoot((Split-Path -Parent $PSScriptRoot))
  $ExePath = Join-Path $drive "AI\deepseek-harness-protable\DeepSeek Harness.exe"
}

if (-not (Test-Path -LiteralPath $ExePath)) {
  Write-Error "executable not found: $ExePath"
  exit 1
}

# Reuse the certificate across rebuilds so every build carries the same signer.
$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1

if (-not $cert) {
  Write-Host "[sign] creating self-signed code-signing certificate"
  $cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -KeyUsage DigitalSignature `
    -KeyAlgorithm RSA `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears(10) `
    -CertStoreLocation Cert:\CurrentUser\My `
    -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}") `
    -FriendlyName "DeepSeek Harness Portable Code Signing"
}

Write-Host "[sign] signer: $($cert.Subject)"
Write-Host "[sign] thumbprint: $($cert.Thumbprint)"

$signArgs = @{
  FilePath      = $ExePath
  Certificate   = $cert
  HashAlgorithm = "SHA256"
}

try {
  Set-AuthenticodeSignature @signArgs -TimestampServer "http://timestamp.digicert.com" -ErrorAction Stop | Out-Null
} catch {
  # No network or the timestamp authority refused the self-signed chain: the
  # signature is still valid without a timestamp, only its lifetime is tied to
  # the certificate expiry.
  Write-Host "[sign] timestamp unavailable, signing without it"
  Set-AuthenticodeSignature @signArgs | Out-Null
}

$result = Get-AuthenticodeSignature -FilePath $ExePath
# Print the status enum only: StatusMessage is localized by Windows, and a GBK
# message relayed through Node's UTF-8 console renders as mojibake.
Write-Host "[sign] status: $($result.Status)"
Write-Host "[sign] signer: $($result.SignerCertificate.Subject)"
Write-Host "[sign] expires: $($result.SignerCertificate.NotAfter)"
if ($result.Status -ne "Valid") {
  Write-Host "[sign] note: self-signed chain is not publicly trusted (expected); the digest is still valid"
}

# Signing just invalidated the cached icon, so no exit code on the trust state:
# an untrusted root is expected for self-signed builds.
exit 0
