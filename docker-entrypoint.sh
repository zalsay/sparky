#!/bin/sh
set -eu

mkdir -p /projects /home/app/.ssh /home/app/go /home/app/.local /home/app/.cache/pip /home/app/.cache/uv /etc/sparky
chown -R app:app /projects /home/app/.ssh /home/app/go /home/app/.local /home/app/.cache

if [ -d /projects/.cc-bridge ] && [ ! -e /projects/.sparky ]; then
    mv /projects/.cc-bridge /projects/.sparky
fi

if [ -f /etc/sparky/known_hosts.raw ]; then
    install -m 0644 -o app -g app /etc/sparky/known_hosts.raw /etc/sparky/known_hosts
elif [ -f /etc/cc-bridge/known_hosts.raw ]; then
    install -m 0644 -o app -g app /etc/cc-bridge/known_hosts.raw /etc/sparky/known_hosts
fi

export HOME=/home/app
export USER=app
export LOGNAME=app

SPARKY_COMMAND=${SPARKY_COMMAND:-/usr/local/bin/sparky}

exec gosu app "$SPARKY_COMMAND"
