#!/bin/bash
# Wrapper: run claude with proper environment
export PATH="/app:$PATH"
exec claude "$@"
