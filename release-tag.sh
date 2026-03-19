#!/usr/bin/env bash

set -euo pipefail

version="${1:-}"

if [[ -z "$version" ]]; then
  echo "Usage: $0 <version>"
  exit 1
fi

if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Invalid version: $version"
  echo "Expected format like: 1.2.3 or 1.2.3-beta.1"
  exit 1
fi

if [[ ! -f manifest.json ]]; then
  echo "manifest.json not found in current directory."
  exit 1
fi

tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

VERSION="$version" node -e '
const fs = require("fs");
const version = process.env.VERSION;
const path = "manifest.json";
const manifest = JSON.parse(fs.readFileSync(path, "utf8"));
manifest.version = version;
fs.writeFileSync(path, JSON.stringify(manifest, null, "\t") + "\n");
'

git tag -a $version -m "$version"
echo "git push origin $version"
