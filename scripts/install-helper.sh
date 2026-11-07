#!/bin/sh
# Build bw in release and install it on this machine, then print the installed path.
#   ~/.local/share/bellwether/helper/<version>/bw, with helper/current linked to <version>
set -eu
src=$(cd "$(dirname "$0")/.." && pwd)
export PATH=/opt/homebrew/opt/rustup/bin:$PATH

cargo build --release --locked -p bw --manifest-path "$src/Cargo.toml" >&2
built=$src/target/release/bw
version=$("$built" version | jq -r .version)
helper=$HOME/.local/share/bellwether/helper
mkdir -p "$helper/$version"
# Copy then rename, so a bw that is running keeps its file and a new run never sees half of one.
cp "$built" "$helper/$version/bw.new.$$"
chmod 755 "$helper/$version/bw.new.$$"
mv -f "$helper/$version/bw.new.$$" "$helper/$version/bw"
ln -sfn "$version" "$helper/current"
echo "$helper/current/bw"
