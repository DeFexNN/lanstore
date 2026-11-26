param(
  [int]$Port = 8787,
  [int]$DiscoveryPort = 8788,
  [string]$Profile = 'Private,Domain',
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$tcpName = "lanstore $Port"
$udpName = "lanstore discovery $DiscoveryPort"

if ($Remove) {
  Remove-NetFirewallRule -DisplayName $tcpName -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName $udpName -ErrorAction SilentlyContinue
  Write-Host "Firewall rules removed."
  exit 0
}

Get-NetFirewallRule -DisplayName $tcpName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName $udpName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

New-NetFirewallRule -DisplayName $tcpName -Direction Inbound -Action Allow -Protocol TCP `
  -LocalPort $Port -Profile $Profile | Out-Null

New-NetFirewallRule -DisplayName $udpName -Direction Inbound -Action Allow -Protocol UDP `
  -LocalPort $DiscoveryPort -Profile $Profile | Out-Null

Write-Host "Firewall rules created: TCP $Port (HTTP/MCP), UDP $DiscoveryPort (auto-discovery)."
Write-Host "Profiles: $Profile"
Write-Host "If the LAN interface is marked Public, either set it to Private or re-run with:"
Write-Host "  -Profile Private,Domain,Public"
