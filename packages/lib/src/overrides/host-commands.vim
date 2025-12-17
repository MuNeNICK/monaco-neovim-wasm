if !exists('g:monaco_neovim_wasm_chan')
  finish
endif

function! s:notify(action, payload) abort
  let obj = a:payload
  let obj.action = a:action
  call rpcnotify(g:monaco_neovim_wasm_chan, 'monaco_host_command', obj)
endfunction

function! s:edit(file, bang) abort
  call s:notify('edit', { 'path': a:file, 'bang': a:bang ==# '!' })
endfunction

function! s:write(file, bang) abort
  call s:notify('write', { 'path': a:file, 'bang': a:bang ==# '!' })
endfunction

function! s:quit(bang) abort
  call s:notify('quit', { 'bang': a:bang ==# '!' })
endfunction

function! s:wq(bang) abort
  call s:notify('wq', { 'bang': a:bang ==# '!' })
endfunction

command! -complete=file -bang -nargs=? MonacoEdit call <SID>edit(<q-args>, <q-bang>)
command! -complete=file -bang -nargs=? MonacoWrite call <SID>write(<q-args>, <q-bang>)
command! -bang -nargs=0 MonacoQuit call <SID>quit(<q-bang>)
command! -bang -nargs=0 MonacoWq call <SID>wq(<q-bang>)

function! s:abbr(cmd, target) abort
  if getcmdtype() !=# ':'
    return a:cmd
  endif
  let l = getcmdline()
  " Only expand at the start of the command line (possibly after spaces).
  if l !~# '^\s*' . a:cmd . '\>'
    return a:cmd
  endif
  return substitute(l, '^\s*' . a:cmd . '\>', a:target, '')
endfunction

cnoreabbrev <expr> e <SID>abbr('e', 'MonacoEdit')
cnoreabbrev <expr> edit <SID>abbr('edit', 'MonacoEdit')
cnoreabbrev <expr> w <SID>abbr('w', 'MonacoWrite')
cnoreabbrev <expr> write <SID>abbr('write', 'MonacoWrite')
cnoreabbrev <expr> q <SID>abbr('q', 'MonacoQuit')
cnoreabbrev <expr> quit <SID>abbr('quit', 'MonacoQuit')
cnoreabbrev <expr> wq <SID>abbr('wq', 'MonacoWq')
cnoreabbrev <expr> x <SID>abbr('x', 'MonacoWq')
