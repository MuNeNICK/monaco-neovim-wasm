#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -n "${OUT_DIR:-}" ]; then
  OUT_DIRS="$OUT_DIR"
else
  OUT_DIRS="${OUT_DIRS:-public dist}"
fi
NVIM_WASM_DIR="${NVIM_WASM_DIR:-$ROOT_DIR/nvim-wasm}"
HOST_BUILD_DIR="$NVIM_WASM_DIR/build-host"
HOST_DEPS_DIR="$HOST_BUILD_DIR/.deps"
HOST_DEPS_PREFIX="$HOST_DEPS_DIR/usr"
HOST_CMAKE_GENERATOR="${CMAKE_GENERATOR:-Unix Makefiles}"

if [ ! -d "$NVIM_WASM_DIR" ]; then
  echo "nvim-wasm repo not found. Set NVIM_WASM_DIR to the clone path." >&2
  exit 1
fi

# Ensure upstream neovim sources are available (nvim-wasm keeps them as a submodule).
if [ ! -d "$NVIM_WASM_DIR/neovim" ]; then
  if command -v git >/dev/null 2>&1 && [ -d "$NVIM_WASM_DIR/.git" ]; then
    git -C "$NVIM_WASM_DIR" submodule update --init --recursive
  else
    echo "missing neovim sources under $NVIM_WASM_DIR/neovim" >&2
    exit 1
  fi
fi

for dir in $OUT_DIRS; do
  mkdir -p "$ROOT_DIR/$dir"
done

pushd "$NVIM_WASM_DIR" >/dev/null
TOOLCHAINS_DIR="$(pwd)/.toolchains"
mkdir -p "$TOOLCHAINS_DIR"

# Ensure CMake toolchain is present before building host deps/host Lua.
make wasm-build-tools

# Build bundled host deps (Lua, libuv, etc.) required by host-lua when the host lacks dev headers.
CMAKE_BIN="$(find "$TOOLCHAINS_DIR" -path '*/bin/cmake' -type f -print -quit)"
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

# Respect upstream Makefile; ensure the bundled host Lua/luac are discoverable so configure does not fail.
export HOST_LUA_PRG="$HOST_DEPS_PREFIX/bin/lua"
export HOST_LUAC="$HOST_DEPS_PREFIX/bin/luac"
export CMAKE_PREFIX_PATH="$HOST_DEPS_PREFIX:$HOST_DEPS_PREFIX/lib/cmake:$HOST_DEPS_PREFIX/lib${CMAKE_PREFIX_PATH:+:$CMAKE_PREFIX_PATH}"
export PKG_CONFIG_PATH="$HOST_DEPS_PREFIX/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export LUV_LIBRARY="$HOST_DEPS_PREFIX/lib/libluv.a"
export LUV_INCLUDE_DIR="$HOST_DEPS_PREFIX/include"

# Build host Lua/codegen helpers with host-only environment.
PATH="$HOST_DEPS_PREFIX/bin:$PATH" \
  CMAKE_PREFIX_PATH="$CMAKE_PREFIX_PATH" \
  PKG_CONFIG_PATH="$PKG_CONFIG_PATH" \
  LUV_LIBRARY="$LUV_LIBRARY" LUV_INCLUDE_DIR="$LUV_INCLUDE_DIR" \
  HOST_LUA_PRG="$HOST_LUA_PRG" HOST_LUAC="$HOST_LUAC" \
  DEPS_BUILD_DIR="$HOST_DEPS_DIR" make host-lua

# Safety net: ensure host lua/luac exist where the Makefile expects them.
if [ ! -x "$HOST_LUA_PRG" ]; then
  found_lua="$(find "$HOST_BUILD_DIR" -path '*/bin/lua' -o -name 'lua' -type f -print -quit || true)"
  if [ -n "$found_lua" ]; then
    mkdir -p "$(dirname "$HOST_LUA_PRG")"
    cp "$found_lua" "$HOST_LUA_PRG"
    chmod +x "$HOST_LUA_PRG"
  else
    echo "host lua missing at $HOST_LUA_PRG" >&2
    exit 1
  fi
fi
if [ ! -x "$HOST_LUAC" ]; then
  found_luac="$(find "$HOST_BUILD_DIR" -path '*/bin/luac' -o -name 'luac' -type f -print -quit || true)"
  if [ -n "$found_luac" ]; then
    mkdir -p "$(dirname "$HOST_LUAC")"
    cp "$found_luac" "$HOST_LUAC"
    chmod +x "$HOST_LUAC"
  else
    echo "host luac missing at $HOST_LUAC" >&2
    exit 1
  fi
fi
# Mirror nvim-wasm/Makefile defaults so host_lua_gen.py resolves the same paths.
export HOST_LUA_PRG_DEFAULT="$HOST_LUA_PRG"
export HOST_LUAC_DEFAULT="$HOST_LUAC"
export HOST_NLUA0_DEFAULT="$HOST_BUILD_DIR/libnlua0-host.so"
export HOST_NLUA0="$HOST_NLUA0_DEFAULT"

# Build wasm deps and wasm with minimal overrides; PATH includes host bin so host_lua_gen.py finds lua.
PATH="$HOST_DEPS_PREFIX/bin:$PATH" HOST_LUA_PRG="$HOST_LUA_PRG" HOST_LUAC="$HOST_LUAC" make wasm-deps
PATH="$HOST_DEPS_PREFIX/bin:$PATH" HOST_LUA_PRG="$HOST_LUA_PRG" HOST_LUAC="$HOST_LUAC" make wasm
# Some host builds drop libnlua0 into build-host/lib/; copy it to the expected host path
# so host_lua_gen.py uses the native lib instead of the wasm one.
if [ ! -f "$HOST_BUILD_DIR/libnlua0-host.so" ] && [ -f "$HOST_BUILD_DIR/lib/libnlua0.so" ]; then
  cp "$HOST_BUILD_DIR/lib/libnlua0.so" "$HOST_BUILD_DIR/libnlua0-host.so"
fi
# Capture host nlua if placed elsewhere.
if [ ! -f "$HOST_BUILD_DIR/libnlua0-host.so" ]; then
  found_nlua="$(find "$HOST_BUILD_DIR" -name 'libnlua0*.so' -type f -print -quit || true)"
  if [ -n "$found_nlua" ]; then
    cp "$found_nlua" "$HOST_BUILD_DIR/libnlua0-host.so"
  fi
fi
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
