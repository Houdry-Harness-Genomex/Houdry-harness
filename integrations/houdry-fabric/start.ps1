# Boot dsh's web profile against a Houdry fabric control plane.
#
# Resolution is a Node step because the connection rules live there: the UDP and
# mDNS browse, the pinned certificate authority, the credential, and the catalog
# the plane is serving right now. Its reply is tab-delimited and assigned
# literally — never invoked, because a value that came from anywhere on the LAN
# must not be able to inject a command into this launcher.
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$overlay = Join-Path $here 'houdry-fabric.overlay.yml'

# Diagnostics go to stderr; a non-zero exit means there is no plane to start
# against, and starting one anyway would turn that into a model error later.
$resolved = @(& node (Join-Path $here 'resolve.mjs'))
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$url = ''
$ca = ''
$key = ''
$models = ''
$launch = @()

foreach ($line in $resolved) {
    $parts = "$line" -split "`t", 2
    if ($parts.Count -lt 2) { continue }
    switch ($parts[0]) {
        'URL' { $url = $parts[1] }
        'CA' { $ca = $parts[1] }
        'KEY' { $key = $parts[1] }
        'MODELS' { $models = $parts[1] }
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

# The route reads these when dsh boots, so they must be in the environment
# before it starts. Node accepts one CA for the whole process, so the pinned PEM
# is trusted by being NODE_EXTRA_CA_CERTS.
$env:HOUDRY_FABRIC_URL = $url
if ($models) { $env:HOUDRY_FABRIC_MODELS = $models }
if ($ca) { $env:NODE_EXTRA_CA_CERTS = $ca }

# A token the caller set is left alone; the resolver only offers the placeholder
# that pi-ai's client needs when the plane asks for no credential.
if ($key -and -not $env:HOUDRY_FABRIC_KEY) { $env:HOUDRY_FABRIC_KEY = $key }

$argv = $launch + @('web', '--patch', $overlay) + @($args)
$exe = $argv[0]
$rest = @()
if ($argv.Count -gt 1) { $rest = $argv[1..($argv.Count - 1)] }

& $exe @rest
exit $LASTEXITCODE
