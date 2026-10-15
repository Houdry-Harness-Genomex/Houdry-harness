#!/usr/bin/env sh
# Boot dsh's web profile against a Houdry fabric control plane.
#
# Resolution is a Node step because the connection rules live there: the UDP and
# mDNS browse, the pinned certificate authority, the credential, and the catalog
# the plane is serving right now. Its reply is tab-delimited and read literally
# into variables — never eval'd, because a value that came from anywhere on the
# LAN must not be able to inject shell into this launcher.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
overlay=$here/houdry-fabric.overlay.yml

# HOUDRY_FABRIC_REPIN and --repin are handled inside resolve.mjs, so a launcher
# does not have to decide what counts as "on".
resolved=$(mktemp)
trap 'rm -f "$resolved"' EXIT INT TERM

if ! node "$here/resolve.mjs" >"$resolved"; then
	echo 'start: no Houdry fabric control plane to use (see the message above)' >&2
	exit 2
fi

TAB=$(printf '\t')
url=''
ca=''
key=''
models=''
launch=''

while IFS="$TAB" read -r field value; do
	case $field in
		URL) url=$value ;;
		CA) ca=$value ;;
		KEY) key=$value ;;
		MODELS) models=$value ;;
		# One ARG line per word of the dsh command line, so a path containing a
		# space stays a single argument instead of being re-split here.
		ARG)
			if [ -z "$launch" ]; then
				launch=$value
			else
				launch="$launch
$value"
			fi
			;;
	esac
done <"$resolved"

if [ -z "$url" ]; then
	echo 'start: resolver returned no control-plane address' >&2
	exit 2
fi

if [ -z "$launch" ]; then
	launch='dsh'
fi

# The route reads these when dsh boots, so they must be set before it starts:
# baseURL and the model list come from the plane, and Node accepts one CA for the
# whole process — the pinned PEM is trusted by being in the environment.
export HOUDRY_FABRIC_URL="$url"
export HOUDRY_FABRIC_MODELS="$models"

if [ -n "$ca" ]; then
	export NODE_EXTRA_CA_CERTS="$ca"
fi

# A token the operator exported is left alone; the resolver only offers the
# placeholder that pi-ai's client needs when the plane asks for no credential.
if [ -n "$key" ]; then
	export HOUDRY_FABRIC_KEY="${HOUDRY_FABRIC_KEY:-$key}"
fi

# DSH_CMD='pnpm dsh' runs this against a source checkout instead of an install.
IFS='
'
# shellcheck disable=SC2086  # one word per line, split on newline by design
set -- $launch web --patch "$overlay" "$@"
exec "$@"
