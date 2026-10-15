# Boot dsh's web profile against a Houdry fabric control plane.
$ErrorActionPreference = 'Stop'

$houdryHome = if ($env:HOUDRY_HOME) { $env:HOUDRY_HOME } else { Join-Path $HOME '.houdry' }
$ca = Join-Path $houdryHome 'server\pki\root_ca.crt'
if (-not (Test-Path -LiteralPath $ca)) {
    Write-Error "start: no fabric root CA at $ca. Run 'houdry serve' once to generate it."
    exit 1
}

$overlay = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'houdry-fabric.overlay.yml'

# Node trusts only its bundled roots, so the fabric's private CA is added here.
$env:NODE_EXTRA_CA_CERTS = $ca
# The fabric demands no credential unless 'serve --token' was used; a placeholder
# keeps pi-ai's OpenAI client from refusing a keyless route.
if (-not $env:HOUDRY_FABRIC_KEY) { $env:HOUDRY_FABRIC_KEY = 'houdry' }

# DSH_CMD carries the launcher, so a source checkout runs 'pnpm dsh'.
if ($env:DSH_CMD) { $cmd = $env:DSH_CMD -split ' ' } else { $cmd = @('dsh') }
& $cmd[0] $cmd[1..($cmd.Count-1)] web --patch $overlay @args
