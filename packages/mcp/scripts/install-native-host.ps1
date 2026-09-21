param(
  [Parameter(Mandatory = $true)][string]$CliPath,
  [Parameter(Mandatory = $true)][string]$ExtensionId,
  [string]$NodePath = "node",
  [string]$ManifestDir,
  [string]$ConfigDir,
  [string]$OutputRoot,
  [string]$ProfileId,
  [string]$McpConfigOut,
  [switch]$Overwrite
)

$arguments = @("--mode=install", "--extension-id", $ExtensionId)
if ($ManifestDir) { $arguments += @("--manifest-dir", $ManifestDir) }
if ($ConfigDir) { $arguments += @("--config-dir", $ConfigDir) }
if ($OutputRoot) { $arguments += @("--output-root", $OutputRoot) }
if ($ProfileId) { $arguments += @("--profile-id", $ProfileId) }
if ($McpConfigOut) { $arguments += @("--mcp-config-out", $McpConfigOut) }
if ($Overwrite) { $arguments += "--overwrite" }

& $NodePath $CliPath @arguments
exit $LASTEXITCODE
