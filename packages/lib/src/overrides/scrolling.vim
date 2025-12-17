if !exists('g:monaco_neovim_wasm_chan')
  finish
endif

function! s:reveal(direction, resetCursor) abort
  if reg_recording() !=# '' || reg_executing() !=# ''
    execute 'normal! z' . (a:direction ==# 'top' ? 't' : (a:direction ==# 'bottom' ? 'b' : 'z'))
    if a:resetCursor
      execute 'normal! z' . (a:direction ==# 'top' ? "\<CR>" : (a:direction ==# 'bottom' ? '-' : '.'))
    endif
    return
  endif
  call rpcnotify(g:monaco_neovim_wasm_chan, 'monaco_reveal', { 'direction': a:direction, 'resetCursor': a:resetCursor })
endfunction

nnoremap <silent> z<CR> <Cmd>call <SID>reveal('top', v:true)<CR>
xnoremap <silent> z<CR> <Cmd>call <SID>reveal('top', v:true)<CR>
onoremap <silent> z<CR> <Cmd>call <SID>reveal('top', v:true)<CR>
nnoremap <silent> zt <Cmd>call <SID>reveal('top', v:false)<CR>
xnoremap <silent> zt <Cmd>call <SID>reveal('top', v:false)<CR>
onoremap <silent> zt <Cmd>call <SID>reveal('top', v:false)<CR>

nnoremap <silent> z. <Cmd>call <SID>reveal('center', v:true)<CR>
xnoremap <silent> z. <Cmd>call <SID>reveal('center', v:true)<CR>
onoremap <silent> z. <Cmd>call <SID>reveal('center', v:true)<CR>
nnoremap <silent> zz <Cmd>call <SID>reveal('center', v:false)<CR>
xnoremap <silent> zz <Cmd>call <SID>reveal('center', v:false)<CR>
onoremap <silent> zz <Cmd>call <SID>reveal('center', v:false)<CR>

nnoremap <silent> z- <Cmd>call <SID>reveal('bottom', v:true)<CR>
xnoremap <silent> z- <Cmd>call <SID>reveal('bottom', v:true)<CR>
onoremap <silent> z- <Cmd>call <SID>reveal('bottom', v:true)<CR>
nnoremap <silent> zb <Cmd>call <SID>reveal('bottom', v:false)<CR>
xnoremap <silent> zb <Cmd>call <SID>reveal('bottom', v:false)<CR>
onoremap <silent> zb <Cmd>call <SID>reveal('bottom', v:false)<CR>

function! s:move_cursor(to) abort
  " Native host commands don't register jumplist; record it explicitly.
  if reg_recording() !=# '' || reg_executing() !=# ''
    execute 'normal! ' . v:count1 . (a:to ==# 'top' ? 'H' : (a:to ==# 'bottom' ? 'L' : 'M'))
    return
  endif
  normal! m'
  if a:to ==# 'top' || a:to ==# 'bottom'
    call rpcnotify(g:monaco_neovim_wasm_chan, 'monaco_moveCursor', { 'to': a:to, 'value': v:count1 })
  else
    call rpcnotify(g:monaco_neovim_wasm_chan, 'monaco_moveCursor', { 'to': a:to })
  endif
endfunction

nnoremap <silent> H <Cmd>call <SID>move_cursor('top')<CR>
xnoremap <silent> H <Cmd>call <SID>move_cursor('top')<CR>
onoremap <silent> H <Cmd>call <SID>move_cursor('top')<CR>
nnoremap <silent> M <Cmd>call <SID>move_cursor('middle')<CR>
xnoremap <silent> M <Cmd>call <SID>move_cursor('middle')<CR>
onoremap <silent> M <Cmd>call <SID>move_cursor('middle')<CR>
nnoremap <silent> L <Cmd>call <SID>move_cursor('bottom')<CR>
xnoremap <silent> L <Cmd>call <SID>move_cursor('bottom')<CR>
onoremap <silent> L <Cmd>call <SID>move_cursor('bottom')<CR>

function! s:scroll(direction, by) abort
  if reg_recording() !=# '' || reg_executing() !=# ''
    if a:by ==# 'line'
      execute 'normal! ' . v:count1 . (a:direction ==# 'up' ? "\<C-y>" : "\<C-e>")
    elseif a:by ==# 'halfPage'
      execute 'normal! ' . v:count1 . (a:direction ==# 'up' ? "\<C-u>" : "\<C-d>")
    else
      execute 'normal! ' . v:count1 . (a:direction ==# 'up' ? "\<C-b>" : "\<C-f>")
    endif
    return
  endif
  let payload = { 'direction': a:direction, 'by': a:by, 'value': v:count1 }
  if a:by ==# 'line'
    let payload.moveCursor = v:false
  else
    let payload.moveCursor = v:true
    let payload.cursorBy = 'wrappedLine'
  endif
  call rpcnotify(g:monaco_neovim_wasm_chan, 'monaco_scroll', payload)
endfunction

nnoremap <silent> <C-e> <Cmd>call <SID>scroll('down', 'line')<CR>
xnoremap <silent> <C-e> <Cmd>call <SID>scroll('down', 'line')<CR>
onoremap <silent> <C-e> <Cmd>call <SID>scroll('down', 'line')<CR>
nnoremap <silent> <C-y> <Cmd>call <SID>scroll('up', 'line')<CR>
xnoremap <silent> <C-y> <Cmd>call <SID>scroll('up', 'line')<CR>
onoremap <silent> <C-y> <Cmd>call <SID>scroll('up', 'line')<CR>

nnoremap <silent> <C-d> <Cmd>call <SID>scroll('down', 'halfPage')<CR>
xnoremap <silent> <C-d> <Cmd>call <SID>scroll('down', 'halfPage')<CR>
onoremap <silent> <C-d> <Cmd>call <SID>scroll('down', 'halfPage')<CR>
nnoremap <silent> <C-u> <Cmd>call <SID>scroll('up', 'halfPage')<CR>
xnoremap <silent> <C-u> <Cmd>call <SID>scroll('up', 'halfPage')<CR>
onoremap <silent> <C-u> <Cmd>call <SID>scroll('up', 'halfPage')<CR>

nnoremap <silent> <C-f> <Cmd>call <SID>scroll('down', 'page')<CR>
xnoremap <silent> <C-f> <Cmd>call <SID>scroll('down', 'page')<CR>
onoremap <silent> <C-f> <Cmd>call <SID>scroll('down', 'page')<CR>
nnoremap <silent> <C-b> <Cmd>call <SID>scroll('up', 'page')<CR>
xnoremap <silent> <C-b> <Cmd>call <SID>scroll('up', 'page')<CR>
onoremap <silent> <C-b> <Cmd>call <SID>scroll('up', 'page')<CR>
