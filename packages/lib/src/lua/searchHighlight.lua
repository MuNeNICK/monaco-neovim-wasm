local api, fn = vim.api, vim.fn

local function get_visible_range(s, e)
  s = tonumber(s) or 1
  e = tonumber(e) or s
  if e < s then s, e = e, s end
  if s < 1 then s = 1 end
  if e < 1 then e = 1 end
  return s, e
end

local function to_matches(buf, s, e, pat)
  local ok, re = pcall(vim.regex, pat)
  if not ok or not re then
    return {}, nil
  end
  local lines = api.nvim_buf_get_lines(buf, s - 1, e, false)
  local matches = {}
  local cur = api.nvim_win_get_cursor(0)
  local cur_lnum = cur[1] or 1
  local cur_col0 = cur[2] or 0
  local current = nil

  local max_total = 3000
  local max_per_line = 200

  for idx, line in ipairs(lines) do
    if #matches >= max_total then break end
    local lnum = (s + idx - 1)
    local start = 0
    local safety = 0
    while start <= #line and safety < max_per_line do
      safety = safety + 1
      local ms, me = re:match_str(line, start)
      if ms == nil or me == nil then break end
      if me <= ms then
        start = ms + 1
      else
        table.insert(matches, { l = lnum - 1, s = ms, e = me })
        if current == nil and lnum == cur_lnum and cur_col0 >= ms and cur_col0 < me then
          current = { l = lnum - 1, s = ms, e = me }
        end
        start = me
      end
    end
  end

  if current == nil then
    local pos = fn.searchpos(pat, "nW")
    local lnum = tonumber(pos[1] or 0) or 0
    local col = tonumber(pos[2] or 0) or 0
    if lnum > 0 and col > 0 then
      local line = api.nvim_buf_get_lines(buf, lnum - 1, lnum, false)[1] or ""
      local ms, me = re:match_str(line, col - 1)
      if ms ~= nil and me ~= nil and me > ms then
        current = { l = lnum - 1, s = ms, e = me }
      end
    end
  end

  return matches, current
end

local function run(...)
  local cmdtype = fn.getcmdtype() or ""
  local pat = ""
  if cmdtype == "/" or cmdtype == "?" then
    pat = fn.getcmdline() or ""
    if pat == "" then
      return { enabled = false, matches = {}, current = nil }
    end
  else
    if vim.v.hlsearch ~= 1 then
      return { enabled = false, matches = {}, current = nil }
    end
    pat = fn.getreg("/") or ""
    if pat == "" then
      return { enabled = false, matches = {}, current = nil }
    end
  end
  local s, e = get_visible_range(select(1, ...), select(2, ...))
  local buf = api.nvim_get_current_buf()
  local matches, current = to_matches(buf, s, e, pat)
  return { enabled = true, matches = matches, current = current, start = s, finish = e }
end

return run(...)

