#!/usr/bin/env bash
set -euo pipefail

# Build Neovim WASM and runtime tarball, then drop them into monaco-neovim-wasm/public/.
# Assumes the nvim-wasm repo is available (default: ./nvim-wasm submodule).
# This script deliberately avoids cleaning or overriding nvim-wasm internals.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/public"
NVIM_WASM_DIR="${NVIM_WASM_DIR:-$ROOT_DIR/nvim-wasm}"
HOST_BUILD_DIR="$NVIM_WASM_DIR/build-host"
HOST_DEPS_DIR="$HOST_BUILD_DIR/.deps"
HOST_DEPS_PREFIX="$HOST_DEPS_DIR/usr"
HOST_CMAKE_GENERATOR="${CMAKE_GENERATOR:-Unix Makefiles}"

if [ ! -d "$NVIM_WASM_DIR" ]; then
  echo "nvim-wasm repo not found. Set NVIM_WASM_DIR to the clone path." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

pushd "$NVIM_WASM_DIR" >/dev/null

# Ensure CMake toolchain is present before building host deps/host Lua.
make wasm-build-tools

# Build bundled host deps (Lua, libuv, etc.) required by host-lua when the host lacks dev headers.
CMAKE_BIN="$(find "$NVIM_WASM_DIR/.toolchains" -path '*/bin/cmake' -type f -print -quit)"
CMAKE_BIN="${CMAKE_BIN:-$(command -v cmake || true)}"
if [ -z "$CMAKE_BIN" ]; then
  echo "CMake not found (tried toolchain + PATH). Install cmake or rerun wasm-build-tools." >&2
  exit 1
fi

if [ ! -f "$HOST_DEPS_PREFIX/include/lua.h" ]; then
  "$CMAKE_BIN" -S neovim/cmake.deps -B "$HOST_DEPS_DIR" -G "$HOST_CMAKE_GENERATOR" \
    -DUSE_BUNDLED=ON \
    -DUSE_BUNDLED_LUA=ON -DUSE_BUNDLED_LUAJIT=OFF
  "$CMAKE_BIN" --build "$HOST_DEPS_DIR"
fi

# Drop stale cache if it points at a different deps prefix to avoid misconfigured host-lua.
if [ -f "$HOST_BUILD_DIR/CMakeCache.txt" ] && ! grep -q "$HOST_DEPS_PREFIX" "$HOST_BUILD_DIR/CMakeCache.txt"; then
  rm -f "$HOST_BUILD_DIR/CMakeCache.txt"
  rm -rf "$HOST_BUILD_DIR/CMakeFiles"
fi

# Respect upstream Makefile; HOST_LUA_PRG can be provided by the caller if needed.
# Build host Lua/codegen helpers, then dependencies so CI can execute in a clean workspace.
DEPS_BUILD_DIR="$HOST_DEPS_DIR" make host-lua
# Some host builds drop libnlua0 into build-host/lib/; copy it to the expected host path
# so host_lua_gen.py uses the native lib instead of the wasm one.
if [ ! -f "$HOST_BUILD_DIR/libnlua0-host.so" ] && [ -f "$HOST_BUILD_DIR/lib/libnlua0.so" ]; then
  cp "$HOST_BUILD_DIR/lib/libnlua0.so" "$HOST_BUILD_DIR/libnlua0-host.so"
fi
make wasm-deps
make wasm
cp build-wasm/bin/nvim "$OUT_DIR/nvim.wasm"
tar -czf "$OUT_DIR/nvim-runtime.tar.gz" \
  -C "$NVIM_WASM_DIR/neovim" runtime \
  -C "$NVIM_WASM_DIR/build-wasm" usr nvim_version.lua
popd >/dev/null

echo "Artifacts written to: $OUT_DIR/nvim.wasm and $OUT_DIR/nvim-runtime.tar.gz"
