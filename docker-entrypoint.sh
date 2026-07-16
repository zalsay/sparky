#!/bin/sh
set -eu

mkdir -p /projects /home/app/.ssh /home/app/go /home/app/.local /home/app/.cache/pip /home/app/.cache/uv /home/app/.npm /etc/sparky
chown -R app:app /projects /home/app/.ssh /home/app/go /home/app/.local /home/app/.cache /home/app/.npm
if [ -d /home/app/.codex ]; then
    chown -R app:app /home/app/.codex
fi

if [ -S /var/run/docker.sock ]; then
    docker_gid=$(stat -c '%g' /var/run/docker.sock)
    docker_group=$(getent group "$docker_gid" | cut -d: -f1 || true)
    if [ -z "$docker_group" ]; then
        docker_group=docker-host
        groupadd -g "$docker_gid" "$docker_group"
    fi
    usermod -aG "$docker_group" app
fi

mkdir -p /home/app/.local/share/sparky/code-server
chown -R app:app /home/app/.local/share /home/app/.local/share/sparky /home/app/.local/share/sparky/code-server

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
