// Os comandos disparados pelos botões (open, osascript...) não herdam ELECTRON_RUN_AS_NODE nem DECK_*: um app Electron aberto por um botão herdaria a variável e fecharia na hora.
process.env.ELECTRON_RUN_AS_NODE = '1'; process.env.DECK_PARENT_PID = '123'; process.env.DECK_ALGO = 'x'; process.env.MINHA_VARIAVEL = 'ok';
const { runCmd, cleanEnv } = await import('../src/actions.ts');
let fails = 0; const check = (ok: boolean, what: string) => { console.log(`  ${ok ? '✓' : '✗'} ${what}`); if (!ok) fails++; };
const e = cleanEnv();
check(!('ELECTRON_RUN_AS_NODE' in e) && !('DECK_PARENT_PID' in e) && !('DECK_ALGO' in e), 'cleanEnv remove ELECTRON_RUN_AS_NODE e DECK_*');
check(e.MINHA_VARIAVEL === 'ok' && !!(e.PATH ?? e.Path), 'o resto do ambiente é mantido');
const [rc, out] = await runCmd([process.execPath, '-e', 'for (const [k, v] of Object.entries(process.env)) console.log(k + "=" + v)']);   // imprime o ambiente que o filho recebeu (portável: não depende de /usr/bin/env)
check(rc === 0 && !/ELECTRON_RUN_AS_NODE|DECK_PARENT_PID/.test(out) && /MINHA_VARIAVEL=ok/.test(out), 'um comando executado de verdade não recebe as variáveis do servidor');
console.log(`\n${'='.repeat(60)}\n3 verificações, ${fails} falha(s)`); process.exit(fails ? 1 : 0);
