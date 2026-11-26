#!/bin/sh
set -eu
umask 022
root=/opt/freedomgate/current
. "$root/scripts/platform-support.sh"
arch=$(platform_arch "$(uname -m)")
python3 "$root/scripts/seed-container-modules.py" --source /opt/freedomgate/module-seed --target /opt/freedomgate/modules --platform "linux-$arch"
exec "$@"
