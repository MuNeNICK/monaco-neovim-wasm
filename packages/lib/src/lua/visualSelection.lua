local api, fn = vim.api, vim.fn
local ok_lsp, lsp = pcall(require, "vim.lsp")
local has_lsp = ok_lsp and lsp and lsp.util and lsp.util.make_position_params and lsp.util.make_given_range_params

local function get_line(buf, line0)
  local lines = api.nvim_buf_get_lines(buf, line0, line0 + 1, false)
  return lines[1] or ""
end

local function byte_col_to_character(buf, line0, col0)
  local line = get_line(buf, line0)
  return vim.str_utfindex(line, "utf-16", col0, false)
end

local function make_position(buf, line1, col0)
  local line0 = line1 - 1
  local char = byte_col_to_character(buf, line0, col0)
  return { line = line0, character = char }
end

local function make_position_params(win, buf)
  if has_lsp then
    return lsp.util.make_position_params(win, "utf-16").position
  end
  local cur = api.nvim_win_get_cursor(win)
  return make_position(buf, cur[1], cur[2])
end

local function make_range(buf, start_pos, end_pos)
  local s_line0 = start_pos[1] - 1
  local e_line0 = end_pos[1] - 1
  local s_char = byte_col_to_character(buf, s_line0, start_pos[2])
  local e_char = byte_col_to_character(buf, e_line0, end_pos[2])
  if vim.o.selection ~= "exclusive" then
    e_char = e_char + 1
  end
  return { start = { line = s_line0, character = s_char }, ["end"] = { line = e_line0, character = e_char } }
end

local function make_range_params(buf, start_pos, end_pos)
  if has_lsp then
    return lsp.util.make_given_range_params(start_pos, end_pos, buf, "utf-16").range
  end
  return make_range(buf, start_pos, end_pos)
end

local function get_char_at(line, byte_col, buf)
  buf = buf or api.nvim_get_current_buf()
  local line_str = fn.getbufoneline(buf, line)
  local char_idx = fn.charidx(line_str, (byte_col - 1))
  local char_nr = fn.strgetchar(line_str, char_idx)
  if char_nr ~= -1 then
    return fn.nr2char(char_nr)
  end
  return nil
end

local function virtcol2col(winid, lnum, virtcol)
  if fn.has("nvim-0.10.0") == 0 then
    return fn.virtcol2col(winid, lnum, virtcol)
  end
  local byte_idx = fn.virtcol2col(winid, lnum, virtcol) - 1
  local buf = api.nvim_win_get_buf(winid)
  local line = api.nvim_buf_get_lines(buf, lnum - 1, lnum, false)[1] or ""
  local char_idx = fn.charidx(line, byte_idx)
  local prefix = fn.strcharpart(line, 0, char_idx + 1)
  return #prefix
end

local function get_selections(win)
  win = win or api.nvim_get_current_win()
  local buf = api.nvim_win_get_buf(win)
  local mode = api.nvim_get_mode().mode
  local is_visual = mode:match("[vV\\022]")

  local function wincall(cb)
    return api.nvim_win_call(win, cb)
  end

  if not is_visual then
    local pos = make_position_params(win, buf)
    return { { start = pos, ["end"] = pos } }
  end

  if mode:lower() == "v" then
    local start_pos, end_pos
    wincall(function()
      start_pos = { fn.line("v"), fn.col("v") - 1 }
      end_pos = { fn.line("."), fn.col(".") - 1 }
    end)
    local start_from_left = true
    if start_pos[1] > end_pos[1] or (start_pos[1] == end_pos[1] and start_pos[2] > end_pos[2]) then
      start_from_left = false
      start_pos, end_pos = end_pos, start_pos
    end
    if mode == "V" then
      start_pos = { start_pos[1], 0 }
      end_pos = { end_pos[1], #(fn.getbufline(buf, end_pos[1])[1] or "") }
    end
    local range = make_range_params(buf, start_pos, end_pos)
    if not start_from_left then
      range = { start = range["end"], ["end"] = range.start }
    end
    return { range }
  end

  local ranges = {}
  local start_line_1, end_line_1, start_vcol, end_vcol
  wincall(function()
    start_line_1 = fn.line("v")
    end_line_1 = fn.line(".")
    start_vcol = fn.virtcol("v")
    end_vcol = fn.virtcol(".")
  end)
  local curr_line_1 = end_line_1
  local top_to_bottom = start_line_1 < end_line_1 or (start_line_1 == end_line_1 and start_vcol <= end_vcol)
  local start_from_left = end_vcol >= start_vcol
  if start_line_1 > end_line_1 then
    start_line_1, end_line_1 = end_line_1, start_line_1
  end
  if start_vcol > end_vcol then
    start_vcol, end_vcol = end_vcol, start_vcol
  end

  for line_1 = start_line_1, end_line_1 do
    local line_0 = line_1 - 1
    local line_text = fn.getbufline(buf, line_1)[1] or ""
    local line_diswidth = wincall(function()
      return fn.strdisplaywidth(line_text)
    end)
    if start_vcol > line_diswidth then
      if line_1 == curr_line_1 then
        local pos = { line = line_0, character = ({ vim.str_utfindex(line_text) })[2] }
        table.insert(ranges, { start = pos, ["end"] = pos })
      end
    else
      local start_col = virtcol2col(win, line_1, start_vcol)
      local end_col = virtcol2col(win, line_1, end_vcol)
      local start_col_offset = fn.strlen(get_char_at(line_1, start_col, buf) or "")
      local end_col_offset = fn.strlen(get_char_at(line_1, end_col, buf) or "")
      local range = make_range_params(
        buf,
        { line_1, math.max(0, start_col - start_col_offset) },
        { line_1, math.max(0, end_col - end_col_offset) }
      )
      if not start_from_left then
        range = { start = range["end"], ["end"] = range.start }
      end
      table.insert(ranges, range)
    end
  end

  if #ranges == 0 then
    local pos = make_position_params(win, buf)
    return { { start = pos, ["end"] = pos } }
  end

  if top_to_bottom then
    local ret = {}
    for i = #ranges, 1, -1 do
      table.insert(ret, ranges[i])
    end
    return ret
  end
  return ranges
end

return get_selections(...)

