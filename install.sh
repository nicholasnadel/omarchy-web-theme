#!/bin/bash

# Register Omarchy Theme Sync and its native messaging host.
#
# Everything here is per-user and needs no root: the host manifest lives in each
# browser's profile config, and the extension is loaded unpacked through
# chromium-flags.conf, which is how Omarchy already ships copy-url, yt-dlp and
# whatsapp-slim.

set -euo pipefail

REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
EXTENSION_DIR="${OMARCHY_THEME_EXTENSION_DIR:-$REPO_DIR/extension}"
HOST_BIN="${OMARCHY_THEME_HOST_BIN:-$REPO_DIR/bin/omarchy-browser-theme-host}"
HOST_NAME="com.omarchy.theme"

# The Arch chromium launcher resolves its flags file through the XDG config dir,
# not $HOME/.config, so a user who moves XDG_CONFIG_HOME would otherwise get the
# flag written somewhere the launcher never reads.
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
FLAGS_FILE="$CONFIG_HOME/chromium-flags.conf"

# The id is derived from the manifest's "key", so it is identical for the
# unpacked dev load and any future packed build. The native host refuses
# connections from any other origin, so this has to match exactly.
EXTENSION_ID="ppnnomfimbfcofidkfmghapellfbgklc"

# Same profile roots omarchy's own browser migrations walk.
PROFILE_ROOTS=(
  "$CONFIG_HOME/chromium"
  "$CONFIG_HOME/google-chrome"
  "$CONFIG_HOME/google-chrome-beta"
  "$CONFIG_HOME/google-chrome-unstable"
  "$CONFIG_HOME/BraveSoftware/Brave-Browser"
  "$CONFIG_HOME/BraveSoftware/Brave-Browser-Beta"
  "$CONFIG_HOME/BraveSoftware/Brave-Browser-Nightly"
  "$CONFIG_HOME/microsoft-edge"
  "$CONFIG_HOME/microsoft-edge-beta"
  "$CONFIG_HOME/microsoft-edge-dev"
  "$CONFIG_HOME/vivaldi"
  "$CONFIG_HOME/vivaldi-snapshot"
  "$CONFIG_HOME/opera"
  "$CONFIG_HOME/helium"
)

uninstall=0
[[ ${1:-} == "--uninstall" ]] && uninstall=1

install_hosts() {
  local root manifest_dir manifest count=0

  for root in "${PROFILE_ROOTS[@]}"; do
    # Only browsers that actually exist get a host manifest; creating the config
    # root here would hand a browser a profile directory it never asked for.
    [[ -d $root ]] || continue

    manifest_dir="$root/NativeMessagingHosts"
    manifest="$manifest_dir/$HOST_NAME.json"

    if (( uninstall )); then
      rm -f "$manifest"
      continue
    fi

    mkdir -p "$manifest_dir"
    jq -n \
      --arg name "$HOST_NAME" \
      --arg path "$HOST_BIN" \
      --arg origin "chrome-extension://$EXTENSION_ID/" \
      '{name: $name,
        description: "Omarchy Theme Sync native host",
        path: $path,
        type: "stdio",
        allowed_origins: [$origin]}' >"$manifest"

    count=$((count + 1))
  done

  if (( uninstall )); then
    echo "Removed $HOST_NAME host manifests"
  else
    echo "Registered $HOST_NAME for $count browser profile(s)"
  fi
}

# --load-extension takes one comma-separated list and Chromium honours only the
# last occurrence of the flag, so this edits the existing list in place rather
# than appending a second flag line.
update_flags() {
  local line paths=() kept=() joined found=0

  [[ -f $FLAGS_FILE ]] || {
    (( uninstall )) && return 0
    mkdir -p "$(dirname "$FLAGS_FILE")"
    : >"$FLAGS_FILE"
  }

  while IFS= read -r line || [[ -n $line ]]; do
    if [[ $line == --load-extension=* ]]; then
      found=1
      IFS=',' read -ra paths <<<"${line#--load-extension=}"
      continue
    fi
    kept+=("$line")
  done <"$FLAGS_FILE"

  local rebuilt=()
  local path
  for path in "${paths[@]}"; do
    [[ -n $path && $path != "$EXTENSION_DIR" ]] && rebuilt+=("$path")
  done
  (( uninstall )) || rebuilt+=("$EXTENSION_DIR")

  {
    # printf on an empty array still emits one blank line, which would accumulate
    # a leading newline in the flags file on every run.
    (( ${#kept[@]} )) && printf '%s\n' "${kept[@]}"
    if (( ${#rebuilt[@]} )); then
      joined=$(IFS=','; echo "${rebuilt[*]}")
      printf -- '--load-extension=%s\n' "$joined"
    fi
  } >"$FLAGS_FILE.tmp"

  mv "$FLAGS_FILE.tmp" "$FLAGS_FILE"

  if (( uninstall )); then
    echo "Removed $EXTENSION_DIR from $FLAGS_FILE"
  elif (( found )); then
    echo "Updated --load-extension in $FLAGS_FILE"
  else
    echo "Added --load-extension to $FLAGS_FILE"
  fi
}

[[ -x $HOST_BIN ]] || { echo "install.sh: host binary not executable: $HOST_BIN" >&2; exit 1; }
[[ -f $EXTENSION_DIR/manifest.json ]] || { echo "install.sh: no manifest at $EXTENSION_DIR" >&2; exit 1; }

install_hosts
update_flags

echo
if (( uninstall )); then
  echo "Done. Restart your browser."
else
  echo "Done. Restart your browser, then check chrome://extensions for \"Omarchy Theme Sync\"."
  echo "Extension id: $EXTENSION_ID"
fi
