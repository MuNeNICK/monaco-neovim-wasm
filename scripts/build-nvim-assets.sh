#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIRS="${OUT_DIRS:-public dist}"
NVIM_WASM_DIR="${NVIM_WASM_DIR:-$ROOT_DIR/nvim-wasm}"
HOST_BUILD_DIR="$NVIM_WASM_DIR/build-host"
HOST_DEPS_PREFIX="$HOST_BUILD_DIR/.deps/usr"
HOST_LUA_PRG="$HOST_DEPS_PREFIX/bin/lua"
HOST_LUAC="$HOST_DEPS_PREFIX/bin/luac"
HOST_NLUA0="$HOST_BUILD_DIR/lib/libnlua0.so"
TOOLCHAINS_DIR="$NVIM_WASM_DIR/.toolchains"

if [ -n "${OUT_DIR:-}" ]; then
  OUT_DIRS="$OUT_DIR"
fi

if [ ! -d "$NVIM_WASM_DIR" ]; then
  echo "nvim-wasm repo not found. Set NVIM_WASM_DIR to the clone path." >&2
  exit 1
fi

# Ensure upstream neovim sources are available.
if [ ! -d "$NVIM_WASM_DIR/neovim" ]; then
  git -C "$NVIM_WASM_DIR" submodule update --init --recursive
fi

for dir in $OUT_DIRS; do
  mkdir -p "$ROOT_DIR/$dir"
done

pushd "$NVIM_WASM_DIR" >/dev/null
mkdir -p "$TOOLCHAINS_DIR"
make wasm-build-tools

CMAKE_BIN="$(find "$TOOLCHAINS_DIR" -path '*/bin/cmake' -type f -print -quit)"
CMAKE_BIN="${CMAKE_BIN:-$(command -v cmake || true)}"

# Ensure bundled host deps (Lua headers/libs) exist.
if [ ! -f "$HOST_DEPS_PREFIX/include/lua.h" ]; then
  if [ -z "$CMAKE_BIN" ]; then
    echo "CMake not found for deps build" >&2
    exit 1
  fi
  "$CMAKE_BIN" -S neovim/cmake.deps -B "$HOST_BUILD_DIR/.deps" -G "Unix Makefiles" \
    -DUSE_BUNDLED=ON -DUSE_BUNDLED_LUA=ON -DUSE_BUNDLED_LUAJIT=OFF
  "$CMAKE_BIN" --build "$HOST_BUILD_DIR/.deps"
fi

# Build host lua + nlua0 (native).
PATH="$HOST_DEPS_PREFIX/bin:$PATH" \
  CMAKE_PREFIX_PATH="$HOST_DEPS_PREFIX:$HOST_DEPS_PREFIX/lib/cmake:$HOST_DEPS_PREFIX/lib" \
  PKG_CONFIG_PATH="$HOST_DEPS_PREFIX/lib/pkgconfig" \
  HOST_LUA_PRG="$HOST_LUA_PRG" HOST_LUAC="$HOST_LUAC" HOST_NLUA0="$HOST_NLUA0" \
  make host-lua

if [ ! -x "$HOST_LUA_PRG" ] || [ ! -x "$HOST_LUAC" ]; then
  echo "host lua/luac missing at $HOST_LUA_PRG / $HOST_LUAC" >&2
  exit 1
fi
if [ ! -f "$HOST_NLUA0" ]; then
  echo "host nlua0 missing at $HOST_NLUA0" >&2
  exit 1
fi

# Always clean wasm build dir to avoid stale artifacts.
PATH="$HOST_DEPS_PREFIX/bin:$PATH" \
  HOST_LUA_PRG="$HOST_LUA_PRG" HOST_LUAC="$HOST_LUAC" HOST_NLUA0="$HOST_NLUA0" \
  make wasm-clean

# Build wasm deps and wasm using the host lua.
PATH="$HOST_DEPS_PREFIX/bin:$PATH" \
  CMAKE_PREFIX_PATH="$HOST_DEPS_PREFIX:$HOST_DEPS_PREFIX/lib/cmake:$HOST_DEPS_PREFIX/lib" \
  PKG_CONFIG_PATH="$HOST_DEPS_PREFIX/lib/pkgconfig" \
  HOST_LUA_PRG="$HOST_LUA_PRG" HOST_LUAC="$HOST_LUAC" HOST_NLUA0="$HOST_NLUA0" make wasm-deps
PATH="$HOST_DEPS_PREFIX/bin:$PATH" \
  CMAKE_PREFIX_PATH="$HOST_DEPS_PREFIX:$HOST_DEPS_PREFIX/lib/cmake:$HOST_DEPS_PREFIX/lib" \
  PKG_CONFIG_PATH="$HOST_DEPS_PREFIX/lib/pkgconfig" \
  HOST_LUA_PRG="$HOST_LUA_PRG" HOST_LUAC="$HOST_LUAC" HOST_NLUA0="$HOST_NLUA0" make wasm

for dir in $OUT_DIRS; do
  cp build-wasm/bin/nvim "$ROOT_DIR/$dir/nvim.wasm"
  tar -czf "$ROOT_DIR/$dir/nvim-runtime.tar.gz" \
    -C "$NVIM_WASM_DIR/neovim" runtime \
    -C "$NVIM_WASM_DIR/build-wasm" usr nvim_version.lua
done
popd >/dev/null

echo "Artifacts written to:"
for dir in $OUT_DIRS; do
  echo " - $dir/nvim.wasm"
  echo " - $dir/nvim-runtime.tar.gz"
done
