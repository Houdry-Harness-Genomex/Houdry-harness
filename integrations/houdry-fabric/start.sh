#!/usr/bin/env sh
# Boot dsh's web profile against a Houdry fabric control plane.
set -eu

# A plane started with `serve --data DIR` keeps its CA under DIR/pki, so the CA
# path is settable; the default is the plane's own state directory.
ca=${HOUDRY_FABRIC_CA:-${HOUDRY_HOME:-$HOME/.houdry}/server/pki/root_ca.crt}
if [ ! -f "$ca" ]; then
	echo "start: no fabric root CA at $ca" >&2
	echo "start: run 'houdry serve' once to generate it, or set HOUDRY_FABRIC_CA." >&2
	exit 1
fi

overlay=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/houdry-fabric.overlay.yml

# Node trusts only its bundled roots, so the fabric's private CA is added here.
export NODE_EXTRA_CA_CERTS="$ca"
# The plane's listen port is a deployment choice; 8080 is often taken on Windows.
export HOUDRY_FABRIC_URL="${HOUDRY_FABRIC_URL:-https://127.0.0.1:8080/v1}"
# The fabric authenticates only when 'serve --token' was used. pi-ai's OpenAI
# client still requires a key or header, so a placeholder carries an untokened
# plane and the real token carries an authorized one.
export HOUDRY_FABRIC_KEY="${HOUDRY_FABRIC_KEY:-houdry}"

# DSH_CMD='pnpm dsh' runs this against a source checkout instead of an install.
exec ${DSH_CMD:-dsh} web --patch "$overlay" "$@"
