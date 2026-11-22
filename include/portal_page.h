// Página do portal de Wi-Fi (servida pela placa em http://192.168.4.1/). Mostra a lista de redes encontradas: tocar numa e digitar a senha. Não há campo de nome da rede.
#pragma once
#include <pgmspace.h>
static const char PORTAL_PAGE[] PROGMEM = R"HTML(<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Stream Deck ESP</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}
body{margin:0;font:16px system-ui,-apple-system,sans-serif;background:#16171b;color:#eceef2;padding:16px;max-width:520px;margin:auto}
h1{font-size:20px;margin:6px 0 4px}p.d{color:#9a9aa6;font-size:14px;margin:0 0 14px;line-height:1.4}
.net{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:#22242a;border:2px solid transparent;color:inherit;border-radius:10px;padding:13px 12px;margin:0 0 8px;font:inherit}
.net.on{border-color:#19d9c8;background:#1b2f31}.net b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.bars{color:#19d9c8;font-size:13px;letter-spacing:1px}.lock{font-size:13px;opacity:.85}
label{display:block;font-size:13px;color:#9a9aa6;margin:14px 0 6px}
input{width:100%;padding:12px;border-radius:10px;border:1px solid #3a3d46;background:#0f1013;color:#eceef2;font-size:16px}
button.go,button.sec{padding:12px 16px;border:0;border-radius:10px;font:inherit;font-weight:600;margin:14px 8px 0 0}
button.go{background:#19d9c8;color:#06201d}button.sec{background:#2c2f37;color:#eceef2}button:disabled{opacity:.5}
.msg{margin-top:12px;min-height:1.3em;font-size:15px}.ok{color:#4cd387}.err{color:#ff7b7b}.dim{color:#9a9aa6}
</style></head><body>
<h1>Conectar a placa ao Wi-Fi</h1>
<p class="d">Escolha a sua rede na lista e digite a senha. A placa guarda a rede e volta a se conectar sozinha.</p>
<div id="list"></div>
<button class="sec" id="bscan">Atualizar lista</button>
<div id="pw" hidden><label for="pass">Senha da rede <b id="sel"></b></label><input type="password" id="pass" autocomplete="off" autocapitalize="off" spellcheck="false">
<button class="go" id="bgo">Conectar</button></div>
<div class="msg" id="msg"></div>
<script>
const $=id=>document.getElementById(id);let nets=[],sel=-1,poll=null;
const esc=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const msg=(t,c)=>{$('msg').className='msg '+(c||'dim');$('msg').textContent=t};
function draw(){
  $('list').innerHTML=nets.length?nets.map((n,i)=>'<button class="net'+(i===sel?' on':'')+'" data-i="'+i+'"><b>'+esc(n.s)+'</b><span class="bars">'+'▂▄▆█'.slice(0,n.q)+'</span><span class="lock">'+(n.o?'':'🔒')+'</span></button>').join(''):'<p class="d">Nenhuma rede encontrada. Aproxime a placa do roteador e toque em Atualizar lista.</p>';
  document.querySelectorAll('.net').forEach(b=>b.onclick=()=>{sel=+b.dataset.i;const n=nets[sel];$('sel').textContent=n.s;$('pw').hidden=false;$('pass').value='';$('pass').style.display=n.o?'none':'';draw();if(!n.o)$('pass').focus()});
}
async function scan(fresh){
  $('bscan').disabled=true;msg('Buscando redes...');
  try{const r=await fetch('/api/scan'+(fresh?'?fresh=1':''));nets=(await r.json()).map(n=>({s:n.s,q:n.r>-55?4:n.r>-65?3:n.r>-75?2:1,o:!!n.o}));sel=-1;$('pw').hidden=true;draw();msg(nets.length+' rede(s) encontrada(s)')}
  catch(e){msg('Falha ao buscar redes. Tente de novo.','err')}
  $('bscan').disabled=false;
}
$('bscan').onclick=()=>scan(true);
$('bgo').onclick=async()=>{
  if(sel<0)return;const n=nets[sel],p=$('pass').value;
  if(!n.o&&p.length<8){msg('A senha do Wi-Fi tem pelo menos 8 caracteres.','err');return}
  $('bgo').disabled=true;msg('Enviando...');
  try{const r=await fetch('/api/wifi',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ssid:n.s,pass:n.o?'':p})});
    if(!(await r.json()).ok)throw 0;msg('Conectando a "'+n.s+'"... (se esta página parar de responder, veja o resultado na tela da placa)');clearInterval(poll);poll=setInterval(status,1500)}
  catch(e){msg('A placa recusou os dados. Confira o nome e a senha.','err')}
  $('bgo').disabled=false;
};
async function status(){
  try{const s=await (await fetch('/api/status')).json();
    if(s.state==='ok'){clearInterval(poll);msg('Pronto! A placa conectou. Pode fechar esta página e voltar ao seu Wi-Fi normal.','ok')}
    else if(s.state==='fail'){clearInterval(poll);msg('Nao conectou: confira a senha e tente de novo.','err')}}
  catch(e){}
}
scan(false);
</script></body></html>)HTML";
