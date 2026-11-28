#!/usr/bin/env bash
# Stage sdk/native-pathfinder changes before running this from the rs-sdk checkout.
# Requires Linux, a stable Rust toolchain, readelf and the Rust musl std targets:
# rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl
set -euo pipefail
repo=$(git rev-parse --show-toplevel)
index_tree=$(git -C "$repo" write-tree)
crate_tree=$(git -C "$repo" rev-parse "$index_tree:sdk/native-pathfinder")
dest="$repo/server/vendor/native-pathfinder"
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
git -C "$repo" archive "$crate_tree" | tar -x -C "$scratch"
export RS_PATHFINDER_SOURCE_TREE="$crate_tree"
export CARGO_PROFILE_RELEASE_STRIP=symbols CARGO_PROFILE_RELEASE_LTO=thin CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1
export CARGO_TARGET_DIR="$scratch/target"
sysroot=$(rustc --print sysroot)
host=$(rustc -vV | sed -n 's/^host: //p')
lld="$sysroot/lib/rustlib/$host/bin/rust-lld"
registry=$(realpath -m "${CARGO_HOME:-$HOME/.cargo}")
mkdir -p "$scratch/artifacts"
for platform in linux-x64 linux-arm64; do
    case "$platform" in
        linux-x64) target=x86_64-unknown-linux-musl ;;
        linux-arm64) target=aarch64-unknown-linux-musl ;;
    esac
    if [[ ! -d "$sysroot/lib/rustlib/$target/lib" ]]; then
        echo "Install the $target Rust standard library to build $platform." >&2
        exit 1
    fi
    key="CARGO_TARGET_${target^^}_RUSTFLAGS"
    key=${key//-/_}
    export "$key=-C linker=$lld -C linker-flavor=ld.lld -C link-self-contained=yes --remap-path-prefix=$scratch=/pathfinder --remap-path-prefix=$registry=/cargo --remap-path-prefix=$CARGO_TARGET_DIR=/build"
    cargo build --locked --release --manifest-path "$scratch/Cargo.toml" --target "$target"
    executable="$CARGO_TARGET_DIR/$target/release/pathfinder-native"
    if readelf -l "$executable" | grep INTERP >/dev/null || readelf -d "$executable" | grep NEEDED >/dev/null; then
        echo "$executable is not a self-contained ELF" >&2
        exit 1
    fi
    install -Dm755 "$executable" "$scratch/artifacts/$platform/pathfinder-native"
done
python3 - "$crate_tree" "$scratch/artifacts" <<'PY'
from pathlib import Path
import hashlib, json, sys
directory = Path(sys.argv[2])
hashes = {p.parent.name: hashlib.sha256(p.read_bytes()).hexdigest()
          for p in sorted(directory.glob("*/pathfinder-native"))}
(directory / "manifest.json").write_text(json.dumps({"sourceTree": sys.argv[1], "sha256": hashes}, indent=2) + "\n")
PY
mkdir -p "$dest"
for platform in linux-x64 linux-arm64; do
    install -Dm755 "$scratch/artifacts/$platform/pathfinder-native" "$dest/$platform/pathfinder-native"
done
install -m644 "$scratch/artifacts/manifest.json" "$dest/manifest.json"
