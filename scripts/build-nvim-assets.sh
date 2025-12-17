#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR_WASM="${OUT_DIR_WASM:-$ROOT_DIR/packages/wasm}"
OUT_DIR_ASYNC="${OUT_DIR_ASYNC:-$ROOT_DIR/packages/wasm-async}"
OUT_DIRS_EXTRA="${OUT_DIRS_EXTRA:-${OUT_DIRS:-}}"
NVIM_WASM_DIR="${NVIM_WASM_DIR:-$ROOT_DIR/nvim-wasm}"
if [[ "$NVIM_WASM_DIR" != /* ]]; then
  NVIM_WASM_DIR="$ROOT_DIR/$NVIM_WASM_DIR"
fi

if [ -n "${OUT_DIR:-}" ]; then
  OUT_DIRS_EXTRA="$OUT_DIR"
fi

if [ ! -d "$NVIM_WASM_DIR" ]; then
  echo "nvim-wasm repo not found. Set NVIM_WASM_DIR to the clone path." >&2
  exit 1
fi

NVIM_WASM_DIR="$(cd "$NVIM_WASM_DIR" && pwd)"
HOST_BUILD_DIR="$NVIM_WASM_DIR/build-host"
HOST_DEPS_PREFIX="$HOST_BUILD_DIR/.deps/usr"
HOST_LUA_PRG="$HOST_DEPS_PREFIX/bin/lua"
HOST_LUAC="$HOST_DEPS_PREFIX/bin/luac"
HOST_NLUA0=""
TOOLCHAINS_DIR="$NVIM_WASM_DIR/.toolchains"

# Ensure upstream neovim sources are available.
if [ ! -d "$NVIM_WASM_DIR/neovim" ]; then
  git -C "$NVIM_WASM_DIR" submodule update --init --recursive
fi

mkdir -p "$OUT_DIR_WASM" "$OUT_DIR_ASYNC"
if [ -n "$OUT_DIRS_EXTRA" ]; then
  for dir in $OUT_DIRS_EXTRA; do
    mkdir -p "$ROOT_DIR/$dir"
  done
fi

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
  HOST_LUA_PRG="$HOST_LUA_PRG" HOST_LUAC="$HOST_LUAC" \
  make host-lua

if [ ! -x "$HOST_LUA_PRG" ] || [ ! -x "$HOST_LUAC" ]; then
  echo "host lua/luac missing at $HOST_LUA_PRG / $HOST_LUAC" >&2
  exit 1
fi
for cand in \
  "$HOST_BUILD_DIR/lib/libnlua0.so" \
  "$HOST_BUILD_DIR/libnlua0-host.so" \
  "$HOST_BUILD_DIR/libnlua0.so" \
  "$HOST_BUILD_DIR/lib/libnlua0.dylib" \
  "$HOST_BUILD_DIR/libnlua0-host.dylib" \
  "$HOST_BUILD_DIR/libnlua0.dylib" \
  "$HOST_BUILD_DIR/nlua0.dll"; do
  if [ -f "$cand" ]; then
    HOST_NLUA0="$cand"
    break
  fi
done
if [ -z "$HOST_NLUA0" ]; then
  echo "host nlua0 missing under $HOST_BUILD_DIR" >&2
  find "$HOST_BUILD_DIR" -maxdepth 3 -name 'libnlua0*' -o -name 'nlua0.dll' >&2 || true
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

PATH="$HOST_DEPS_PREFIX/bin:$PATH" \
  CMAKE_PREFIX_PATH="$HOST_DEPS_PREFIX:$HOST_DEPS_PREFIX/lib/cmake:$HOST_DEPS_PREFIX/lib" \
  PKG_CONFIG_PATH="$HOST_DEPS_PREFIX/lib/pkgconfig" \
  HOST_LUA_PRG="$HOST_LUA_PRG" HOST_LUAC="$HOST_LUAC" HOST_NLUA0="$HOST_NLUA0" make wasm-asyncify

cp build-wasm/bin/nvim "$OUT_DIR_WASM/nvim.wasm"
tar -czf "$OUT_DIR_WASM/nvim-runtime.tar.gz" \
  -C "$NVIM_WASM_DIR/neovim" runtime \
  -C "$NVIM_WASM_DIR/build-wasm" usr nvim_version.lua

cp build-wasm/bin/nvim-asyncify.wasm "$OUT_DIR_ASYNC/nvim-asyncify.wasm"
tar -czf "$OUT_DIR_ASYNC/nvim-runtime.tar.gz" \
  -C "$NVIM_WASM_DIR/neovim" runtime \
  -C "$NVIM_WASM_DIR/build-wasm" usr nvim_version.lua

if [ -n "$OUT_DIRS_EXTRA" ]; then
  for dir in $OUT_DIRS_EXTRA; do
    cp build-wasm/bin/nvim "$ROOT_DIR/$dir/nvim.wasm"
    cp build-wasm/bin/nvim-asyncify.wasm "$ROOT_DIR/$dir/nvim-asyncify.wasm"
    tar -czf "$ROOT_DIR/$dir/nvim-runtime.tar.gz" \
      -C "$NVIM_WASM_DIR/neovim" runtime \
      -C "$NVIM_WASM_DIR/build-wasm" usr nvim_version.lua
  done
fi
popd >/dev/null

echo "Artifacts written to:"
echo " - $OUT_DIR_WASM/nvim.wasm"
echo " - $OUT_DIR_WASM/nvim-runtime.tar.gz"
echo " - $OUT_DIR_ASYNC/nvim.wasm"
echo " - $OUT_DIR_ASYNC/nvim-runtime.tar.gz"
if [ -n "$OUT_DIRS_EXTRA" ]; then
  for dir in $OUT_DIRS_EXTRA; do
    echo " - $dir/nvim.wasm"
    echo " - $dir/nvim-asyncify.wasm"
    echo " - $dir/nvim-runtime.tar.gz"
  done
fi
