export type HostAutocmdsLuaOptions = {
  clipboard: boolean;
  wrappedLineMotions: boolean;
  scrollMotions: boolean;
  syncScrolloff: boolean;
  hostCommands: boolean;
};

export function buildHostAutocmdsLua(opts: HostAutocmdsLuaOptions): string {
  const clipboard = opts.clipboard ? "true" : "false";
  const wrapped = opts.wrappedLineMotions ? "true" : "false";
  const scroll = opts.scrollMotions ? "true" : "false";
  const scrolloff = opts.syncScrolloff ? "true" : "false";
  const hostCommands = opts.hostCommands ? "true" : "false";

  return `
local chan = ...
local api = vim.api
local fn = vim.fn
vim.g.monaco_neovim_wasm_chan = chan

local function setup_clipboard()
  -- If user provided a clipboard provider (or explicitly disabled it), don't override.
  if vim.g.clipboard ~= nil then return end
  local function copy(lines, regtype)
    vim.rpcnotify(chan, "wasm-clipboard-copy", lines, regtype)
  end
  local function paste()
    local ok, res = pcall(vim.rpcrequest, chan, "wasm-clipboard-paste")
    if not ok then return {}, "v" end
    local lines = res and res[1] or {}
    local regtype = res and res[2] or "v"
    return lines, regtype
  end
  vim.g.clipboard = {
    name = "wasm",
    copy = { ["+"] = copy, ["*"] = copy },
    paste = { ["+"] = paste, ["*"] = paste },
    cache_enabled = 0,
  }
end

if ${clipboard} then
  pcall(setup_clipboard)
end

local last_cursor = { line = nil, col = nil }
local cursor_timer = nil
local function flush_cursor()
  cursor_timer = nil
  local cur = api.nvim_win_get_cursor(0)
  if last_cursor.line == cur[1] and last_cursor.col == cur[2] then
    return
  end
  last_cursor.line = cur[1]
  last_cursor.col = cur[2]
  vim.rpcnotify(chan, "monaco_cursor", cur[1], cur[2])
end

local function send_cursor()
  if cursor_timer then return end
  cursor_timer = vim.defer_fn(flush_cursor, 5)
end

local function send_mode()
  local info = api.nvim_get_mode() or {}
  local m = info.mode or ""
  local blocking = info.blocking and true or false
  vim.rpcnotify(chan, "monaco_mode", m, blocking)
end

local function send_scrolloff()
  local so = vim.o.scrolloff or 0
  vim.rpcnotify(chan, "monaco_scrolloff", so)
end

local function send_recording()
  local r = fn.reg_recording() or ""
  vim.rpcnotify(chan, "monaco_recording", r)
end

if ${wrapped} then
  pcall(vim.cmd, "silent! source $HOME/.config/nvim/monaco-neovim-wasm/motion.vim")
end

if ${scroll} then
  pcall(vim.cmd, "silent! source $HOME/.config/nvim/monaco-neovim-wasm/scrolling.vim")
end
if ${hostCommands} then
  pcall(vim.cmd, "silent! source $HOME/.config/nvim/monaco-neovim-wasm/host-commands.vim")
end

local group = api.nvim_create_augroup("MonacoNeovimWasm", { clear = true })
local function setup_visual_changed()
  local ok = pcall(function()
    local visual_ns = api.nvim_create_namespace("monaco.visual.changed")
    local is_visual, last_visual_pos, last_curr_pos
    local function fire_visual_changed()
      vim.rpcnotify(chan, "monaco_visual_changed")
    end
    api.nvim_create_autocmd({ "ModeChanged" }, {
      group = group,
      callback = function(ev)
        local mode = api.nvim_get_mode().mode
        is_visual = mode:match("[vV\\022]")
        if ev.match:match("[vV\\022]") then
          last_visual_pos = fn.getpos("v")
          last_curr_pos = fn.getpos(".")
          fire_visual_changed()
        end
      end,
    })
    api.nvim_set_decoration_provider(visual_ns, {
      on_win = function()
        if is_visual then
          local visual_pos = fn.getpos("v")
          local curr_pos = fn.getpos(".")
          if not (vim.deep_equal(visual_pos, last_visual_pos) and vim.deep_equal(curr_pos, last_curr_pos)) then
            last_visual_pos = visual_pos
            last_curr_pos = curr_pos
            fire_visual_changed()
          end
        end
      end,
    })
  end)
  if not ok then
    return
  end
end
api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI" }, {
  group = group,
  callback = function() send_cursor() end,
})
api.nvim_create_autocmd({ "ModeChanged", "InsertEnter", "InsertLeave" }, {
  group = group,
  callback = function() send_mode(); send_cursor() end,
})
api.nvim_create_autocmd({ "VisualEnter", "VisualLeave" }, {
  group = group,
  callback = function() send_mode(); send_cursor() end,
})
api.nvim_create_autocmd({ "RecordingEnter", "RecordingLeave" }, {
  group = group,
  callback = function() send_recording() end,
})
if ${scrolloff} then
  api.nvim_create_autocmd({ "OptionSet" }, {
    group = group,
    pattern = { "scrolloff" },
    callback = function() send_scrolloff() end,
  })
end
api.nvim_create_autocmd({ "BufEnter", "BufWinEnter" }, {
  group = group,
  callback = function()
    local b = api.nvim_get_current_buf()
    local name = api.nvim_buf_get_name(b) or ""
    local ft = (vim.bo[b] and vim.bo[b].filetype) or ""
    vim.rpcnotify(chan, "monaco_buf_enter", { buf = b, name = name, filetype = ft })
    send_cursor()
  end,
})
api.nvim_create_autocmd({ "BufDelete" }, {
  group = group,
  callback = function(ev)
    local b = (ev and ev.buf) or api.nvim_get_current_buf()
    vim.rpcnotify(chan, "monaco_buf_delete", { buf = b })
  end,
})

setup_visual_changed()
send_mode()
send_cursor()
send_scrolloff()
send_recording()
vim.rpcnotify(chan, "monaco_buf_enter", {
  buf = api.nvim_get_current_buf(),
  name = api.nvim_buf_get_name(api.nvim_get_current_buf()) or "",
  filetype = (vim.bo[api.nvim_get_current_buf()] and vim.bo[api.nvim_get_current_buf()].filetype) or "",
})
`;
}

