#!/bin/sh
# Build bw for the platforms other machines run, into ~/.local/share/bellwether/dist/<target>/bw
# with a SHA256SUMS beside each, which `bw machine install` checks before copying.
# macOS builds here; the Linux musl targets need cargo-zigbuild and are skipped without it.
set -eu
src=$(cd "$(dirname "$0")/.." && pwd)
export PATH=/opt/homebrew/opt/rustup/bin:$PATH
dist=$HOME/.local/share/bellwether/dist

put() {
  target=$1
  dir=$dist/$target
  mkdir -p "$dir"
  cp "$src/target/$target/release/bw" "$dir/bw.new.$$"
  chmod 755 "$dir/bw.new.$$"
  mv -f "$dir/bw.new.$$" "$dir/bw"
  (cd "$dir" && shasum -a 256 bw > SHA256SUMS)
  echo "built $target: $dir/bw"
}

if [ "$(uname -s)" = Darwin ]; then
  cargo build --release --locked -p bw --manifest-path "$src/Cargo.toml" --target aarch64-apple-darwin >&2
  put aarch64-apple-darwin
else
  echo "aarch64-apple-darwin skipped: macOS builds need a Mac"
fi

for target in x86_64-unknown-linux-musl aarch64-unknown-linux-musl; do
  if ! cargo zigbuild --version >/dev/null 2>&1; then
    echo "$target skipped: cargo-zigbuild not installed"
    continue
  fi
  rustup target add "$target" >&2
  cargo zigbuild --release --locked -p bw --manifest-path "$src/Cargo.toml" --target "$target" >&2
  put "$target"
done
