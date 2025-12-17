if !exists('g:monaco_neovim_wasm_chan')
  finish
endif

function! s:notify_cursor_move(payload) abort
  call rpcnotify(g:monaco_neovim_wasm_chan, 'monaco_cursorMove', a:payload)
endfunction

function! s:in_macro() abort
  return reg_recording() !=# '' || reg_executing() !=# ''
endfunction

function! s:native(keys) abort
  execute 'normal! ' . a:keys
endfunction

function! s:to_first_char_of_screen_line() abort
  if s:in_macro()
    call s:native('g0')
    return
  endif
  call s:notify_cursor_move({ 'to': 'wrappedLineFirstNonWhitespaceCharacter' })
endfunction

function! s:to_last_char_of_screen_line() abort
  if s:in_macro()
    call s:native('g$')
    return
  endif
  call s:notify_cursor_move({ 'to': 'wrappedLineLastNonWhitespaceCharacter' })
endfunction

nnoremap <silent> g0 <Cmd>call <SID>to_first_char_of_screen_line()<CR>
xnoremap <silent> g0 <Cmd>call <SID>to_first_char_of_screen_line()<CR>
onoremap <silent> g0 <Cmd>call <SID>to_first_char_of_screen_line()<CR>
nnoremap <silent> g<Home> <Cmd>call <SID>to_first_char_of_screen_line()<CR>
xnoremap <silent> g<Home> <Cmd>call <SID>to_first_char_of_screen_line()<CR>
onoremap <silent> g<Home> <Cmd>call <SID>to_first_char_of_screen_line()<CR>
nnoremap <silent> g^ <Cmd>call <SID>to_first_char_of_screen_line()<CR>
xnoremap <silent> g^ <Cmd>call <SID>to_first_char_of_screen_line()<CR>
onoremap <silent> g^ <Cmd>call <SID>to_first_char_of_screen_line()<CR>
nnoremap <silent> g$ <Cmd>call <SID>to_last_char_of_screen_line()<CR>
xnoremap <silent> g$ <Cmd>call <SID>to_last_char_of_screen_line()<CR>
onoremap <silent> g$ <Cmd>call <SID>to_last_char_of_screen_line()<CR>
nnoremap <silent> g<End> <Cmd>call <SID>to_last_char_of_screen_line()<CR>
xnoremap <silent> g<End> <Cmd>call <SID>to_last_char_of_screen_line()<CR>
onoremap <silent> g<End> <Cmd>call <SID>to_last_char_of_screen_line()<CR>

" Note: Using these in macros can be problematic.
function! s:up_down(to) abort
  if s:in_macro()
    execute 'normal! ' . v:count1 . (a:to ==# 'up' ? 'gk' : 'gj')
    return
  endif
  call s:notify_cursor_move({ 'to': a:to, 'by': 'wrappedLine', 'value': v:count1 })
endfunction

nnoremap <silent> gk <Cmd>call <SID>up_down('up')<CR>
xnoremap <silent> gk <Cmd>call <SID>up_down('up')<CR>
onoremap <silent> gk <Cmd>call <SID>up_down('up')<CR>
nnoremap <silent> gj <Cmd>call <SID>up_down('down')<CR>
xnoremap <silent> gj <Cmd>call <SID>up_down('down')<CR>
onoremap <silent> gj <Cmd>call <SID>up_down('down')<CR>
