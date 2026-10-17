# Boot dsh's web profile against a Houdry fabric control plane.
#
# Resolution is a Node step because the connection rules live there: the UDP and
# mDNS browse, the pinned certificate authority, the credential, and the catalog
# the plane is serving right now. Its reply is tab-delimited and assigned
# literally — never invoked, because a value that came from anywhere on the LAN
# must not be able to inject a command into this launcher. The resolved route is
# written by the resolver into the profile's patch document, the one file the
# running server watches, so no --patch overlay is carried here: an overlay is
# parsed once at boot and would outvote the document for the rest of the
# session. A watcher beside dsh keeps that document following the plane and its
# catalog while the session is open.
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# Diagnostics go to stderr; a non-zero exit means there is no plane to start
# against, and starting one anyway would turn that into a model error later.
$resolved = @(& node (Join-Path $here 'resolve.mjs'))
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$url = ''
$ca = ''
$key = ''
$launch = @()

foreach ($line in $resolved) {
    $parts = "$line" -split "`t", 2
    if ($parts.Count -lt 2) { continue }
    switch ($parts[0]) {
        'URL' { $url = $parts[1] }
        'CA' { $ca = $parts[1] }
        'KEY' { $key = $parts[1] }
        # One ARG line per word of the dsh command line, already split with the
        # same rules as start.sh. Slicing $env:DSH_CMD on spaces here is what
        # produced the duplicated-word bug this replaces.
        'ARG' { $launch += $parts[1] }
    }
}

if (-not $url) {
    Write-Error 'start: resolver returned no control-plane address.'
    exit 2
}

if ($launch.Count -eq 0) { $launch = @('dsh') }

# The watcher follows the plane across networks and refreshes the model
# catalog while dsh runs; --parent ties its life to this PowerShell process.
$watcher = Start-Process -FilePath 'node' -ArgumentList @(
        (Join-Path $here 'houdry-fabric-watch.mjs'), '--parent', "$PID"
    ) -NoNewWindow -PassThru

# Two exports remain process-level for dsh: the key is the route's apiKeyEnv,
# and Node trusts exactly one CA file per process, so the pinned PEM is trusted
# by being in the environment. The address and the model list are not exported
# — they live in the watched document, and a stale shell value must not outvote
# what the watcher keeps current.
if ($ca) { $env:NODE_EXTRA_CA_CERTS = $ca }

# A token the caller set is left alone; the resolver only offers the placeholder
# that pi-ai's client needs when the plane asks for no credential.
if ($key -and -not $env:HOUDRY_FABRIC_KEY) { $env:HOUDRY_FABRIC_KEY = $key }

$argv = $launch + @('web') + @($args)
$exe = $argv[0]
$rest = @()
if ($argv.Count -gt 1) { $rest = $argv[1..($argv.Count - 1)] }

$status = 0
try {
    & $exe @rest
    $status = $LASTEXITCODE
} finally {
    if ($watcher -and -not $watcher.HasExited) {
        Stop-Process -Id $watcher.Id -Force -ErrorAction 'SilentlyContinue'
    }
}

exit $status
