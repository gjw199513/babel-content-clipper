#!/bin/sh
set -eu

if [ "$#" -lt 2 ]; then
  echo "usage: $0 /absolute/path/to/dist/node/cli.js extension-id [install options]" >&2
  exit 64
fi

cli_path=$1
extension_id=$2
shift 2

exec "$cli_path" --mode=install --extension-id "$extension_id" "$@"
