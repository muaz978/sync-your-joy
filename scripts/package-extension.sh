#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
output_dir="${RELEASE_OUTPUT_DIR:-$project_root/release}"
room_server_url="${SYNCYOURJOY_ROOM_SERVER_URL:-wss://sync-your-joy-rooms.sync-your-joy.workers.dev/rooms}"
version="$(node "$script_dir/check-release-version.mjs" "${RELEASE_VERSION:-}")"
staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/sync-your-joy-release.XXXXXX")"
package_dir="$staging_dir/sync-your-joy-extension"
archive_path="$output_dir/sync-your-joy-extension.zip"
checksum_path="$archive_path.sha256"

cleanup() {
  rm -rf -- "$staging_dir"
}
trap cleanup EXIT

mkdir -p "$output_dir" "$package_dir"

SYNCYOURJOY_ROOM_SERVER_URL="$room_server_url" node "$script_dir/build-extension.mjs"
cp -R "$project_root/apps/extension/dist/." "$package_dir/"

rm -f -- "$archive_path" "$checksum_path"
(
  cd "$staging_dir"
  zip -r -q -X "$archive_path" sync-your-joy-extension
)

unzip -t "$archive_path"
if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$output_dir"
    sha256sum "$(basename "$archive_path")" > "$(basename "$checksum_path")"
  )
else
  (
    cd "$output_dir"
    shasum -a 256 "$(basename "$archive_path")" > "$(basename "$checksum_path")"
  )
fi

echo "Packaged SyncYourJoy $version at $archive_path"
cat "$checksum_path"
