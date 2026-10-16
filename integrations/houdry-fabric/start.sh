#!/usr/bin/env sh
# Boot dsh's web profile against a Houdry fabric control plane.
#
# Resolution is a Node step because the connection rules live there: the UDP and
# mDNS browse, the pinned certificate authority, the credential, and the catalog
# the plane is serving right now. Its reply is tab-delimited and read literally
# into variables — never eval'd, because a value that came from anywhere on the
# LAN must not be able to inject shell into this launcher. The resolved route is
# written by the resolver into the profile's patch document, the one file the
# running server watches, so no `--patch` overlay is carried here: an overlay is
# parsed once at boot and would outvote the document for the rest of the
# session. A watcher beside dsh keeps that document following the plane and its
# catalog while the session is open.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# HOUDRY_FABRIC_REPIN and --repin are handled inside resolve.mjs, so a launcher
# does not have to decide what counts as "on".
resolved=$(mktemp)
watcher=
cleanup() {
	rm -f "$resolved"
	if [ -n "$watcher" ]; then
		kill "$watcher" 2>/dev/null || true
	fi
}
trap cleanup EXIT INT TERM

if ! node "$here/resolve.mjs" >"$resolved"; then
	echo 'start: no Houdry fabric control plane to use (see the message above)' >&2
	exit 2
fi

# The watcher is the reconnect loop: it follows the plane across networks and
# refreshes the model catalog while dsh runs. --parent ties its life to this
# script's, which stays in the foreground with dsh below.
node "$here/houdry-fabric-watch.mjs" --parent $$ &
watcher=$!

TAB=$(printf '\t')
url=''
ca=''
key=''
launch=''

while IFS="$TAB" read -r field value; do
	case $field in
		URL) url=$value ;;
		CA) ca=$value ;;
		KEY) key=$value ;;
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

# Two exports remain process-level for dsh: the key is the route's apiKeyEnv,
# and Node trusts exactly one CA file per process, so the pinned PEM is trusted
# by being in the environment. The address and the model list are not exported
# — they live in the watched document, and a stale shell value must not outvote
# what the watcher keeps current.
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
set -- $launch web "$@"

status=0
"$@" || status=$?
exit "$status"
