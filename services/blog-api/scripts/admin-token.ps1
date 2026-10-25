[CmdletBinding()]
param(
    [switch]$Reveal,
    [string]$CredentialPath = (Join-Path $env:USERPROFILE '.config\xht37-blog-api\admin-token.dpapi')
)

$ErrorActionPreference = 'Stop'
if (-not $Reveal) {
    Write-Output 'The administrator token is encrypted outside this public repository.'
    Write-Output 'Run this script yourself with -Reveal to display it in your terminal.'
    exit 0
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This credential uses Windows DPAPI. Open it under the Windows user who created it.'
}
if (-not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) {
    throw 'No encrypted administrator token was found at the private credential path.'
}
$secureToken = Get-Content -Raw -LiteralPath $CredentialPath | ConvertTo-SecureString
try {
    Write-Output ([Net.NetworkCredential]::new('', $secureToken).Password)
} finally {
    $secureToken.Dispose()
}
