#!/usr/bin/env bash
# Install the immutable native release for the checked-out SDK revision.
set -euo pipefail
umask 077
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
config=${RS_CONTROL_CONFIG_DIR:-"$HOME/.config/rs-sdk-control"}
if [[ $# == 2 && $1 == --binary ]]; then
    binary=$(realpath -- "$2")
elif [[ $# != 0 ]]; then
    echo "Usage: bash control/install-native-pathfinder.sh [--binary /path/to/pathfinder-native]" >&2
    exit 2
fi
commit=$(git -C "$repo" rev-parse --verify HEAD)
tree=$(git -C "$repo" rev-parse --verify "$commit:sdk/native-pathfinder")
release="$config/pathfinder-releases/$tree"
if [[ -x "$release/pathfinder-native" ]] && [[ $("$release/pathfinder-native" --source-tree) == "$tree" ]]; then
    echo "[fleet-pathfinding] Native release $tree is already installed."
    exit 0
fi
mkdir -p -- "$release"
scratch=$(mktemp -d "$release/.install.XXXXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
if [[ -z ${binary:-} ]]; then
    cargo=$(command -v cargo || true)
    cargo=${cargo:-"$HOME/.cargo/bin/cargo"}
    if [[ ! -x "$cargo" ]]; then
        echo "Install Cargo and a C linker, or provide a matching release using --binary." >&2
        exit 1
    fi
    mkdir "$scratch/source"
    git -C "$repo" archive "$tree" | tar -xf - -C "$scratch/source"
    RS_PATHFINDER_SOURCE_TREE="$tree" CARGO_TARGET_DIR="$scratch/target" \
        "$cargo" build --locked --release --manifest-path "$scratch/source/Cargo.toml"
    binary="$scratch/target/release/pathfinder-native"
fi
if [[ $("$binary" --source-tree) != "$tree" ]]; then
    echo "The pathfinder executable does not match native source tree $tree." >&2
    exit 1
fi
install -m 0755 -- "$binary" "$scratch/pathfinder-native"
mv -fT -- "$scratch/pathfinder-native" "$release/pathfinder-native"
echo "[fleet-pathfinding] Installed $release/pathfinder-native"
