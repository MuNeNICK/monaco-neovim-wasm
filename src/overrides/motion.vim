if !exists('g:monaco_neovim_wasm_chan')
  finish
endif

function! s:notify_cursor_move(payload) abort
  call rpcnotify(g:monaco_neovim_wasm_chan, 'monaco_cursorMove', a:payload)
endfunction

function! s:to_first_char_of_screen_line() abort
  call s:notify_cursor_move({ 'to': 'wrappedLineFirstNonWhitespaceCharacter' })
endfunction

function! s:to_last_char_of_screen_line() abort
  call s:notify_cursor_move({ 'to': 'wrappedLineLastNonWhitespaceCharacter' })
endfunction

nnoremap <silent> g0 <Cmd>call <SID>to_first_char_of_screen_line()<CR>
nnoremap <silent> g<Home> <Cmd>call <SID>to_first_char_of_screen_line()<CR>
nnoremap <silent> g^ <Cmd>call <SID>to_first_char_of_screen_line()<CR>
nnoremap <silent> g$ <Cmd>call <SID>to_last_char_of_screen_line()<CR>
nnoremap <silent> g<End> <Cmd>call <SID>to_last_char_of_screen_line()<CR>

" Note: Using these in macros can be problematic (same as vscode-neovim).
nnoremap <silent> gk <Cmd>call <SID>notify_cursor_move({ 'to': 'up', 'by': 'wrappedLine', 'value': v:count1 })<CR>
nnoremap <silent> gj <Cmd>call <SID>notify_cursor_move({ 'to': 'down', 'by': 'wrappedLine', 'value': v:count1 })<CR>
