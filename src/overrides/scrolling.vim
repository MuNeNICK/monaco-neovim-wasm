if !exists('g:monaco_neovim_wasm_chan')
  finish
endif

function! s:reveal(direction, resetCursor) abort
  call rpcnotify(g:monaco_neovim_wasm_chan, 'monaco_reveal', { 'direction': a:direction, 'resetCursor': a:resetCursor })
endfunction

nnoremap <silent> z<CR> <Cmd>call <SID>reveal('top', v:true)<CR>
xnoremap <silent> z<CR> <Cmd>call <SID>reveal('top', v:true)<CR>
nnoremap <silent> zt <Cmd>call <SID>reveal('top', v:false)<CR>
xnoremap <silent> zt <Cmd>call <SID>reveal('top', v:false)<CR>

nnoremap <silent> z. <Cmd>call <SID>reveal('center', v:true)<CR>
xnoremap <silent> z. <Cmd>call <SID>reveal('center', v:true)<CR>
nnoremap <silent> zz <Cmd>call <SID>reveal('center', v:false)<CR>
xnoremap <silent> zz <Cmd>call <SID>reveal('center', v:false)<CR>

nnoremap <silent> z- <Cmd>call <SID>reveal('bottom', v:true)<CR>
xnoremap <silent> z- <Cmd>call <SID>reveal('bottom', v:true)<CR>
nnoremap <silent> zb <Cmd>call <SID>reveal('bottom', v:false)<CR>
xnoremap <silent> zb <Cmd>call <SID>reveal('bottom', v:false)<CR>

function! s:move_cursor(to) abort
  " Native host commands don't register jumplist; match vscode-neovim behavior.
  normal! m'
  call rpcnotify(g:monaco_neovim_wasm_chan, 'monaco_moveCursor', { 'to': a:to })
endfunction

nnoremap <silent> H <Cmd>call <SID>move_cursor('top')<CR>
xnoremap <silent> H <Cmd>call <SID>move_cursor('top')<CR>
nnoremap <silent> M <Cmd>call <SID>move_cursor('middle')<CR>
xnoremap <silent> M <Cmd>call <SID>move_cursor('middle')<CR>
nnoremap <silent> L <Cmd>call <SID>move_cursor('bottom')<CR>
xnoremap <silent> L <Cmd>call <SID>move_cursor('bottom')<CR>
