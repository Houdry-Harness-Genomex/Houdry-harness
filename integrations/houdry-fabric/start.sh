#!/usr/bin/env sh
# Boot dsh's web profile against a Houdry fabric control plane.
set -eu

HOUDRY_HOME="${HOUDRY_HOME:-$HOME/.houdry}"
ca="$HOUDRY_HOME/server/pki/root_ca.crt"
if [ ! -f "$ca" ]; then
	echo "start: no fabric root CA at $ca" >&2
	echo "start: run 'houdry serve' once to generate it." >&2
	exit 1
fi

overlay=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/houdry-fabric.overlay.yml

# Node trusts only its bundled roots, so the fabric's private CA is added here.
export NODE_EXTRA_CA_CERTS="$ca"
# The fabric authenticates only when 'serve --token' was used. pi-ai's OpenAI
# client still requires a key or header, so a placeholder carries an untokened
# plane and the real token carries an authorized one.
export HOUDRY_FABRIC_KEY="${HOUDRY_FABRIC_KEY:-houdry}"

# DSH_CMD='pnpm dsh' runs this against a source checkout instead of an install.
exec ${DSH_CMD:-dsh} web --patch "$overlay" "$@"
