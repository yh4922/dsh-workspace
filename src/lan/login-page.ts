/*
 * @Description: 局域网访问 —— 登录页（自包含 HTML，不依赖宿主任何资源）
 * @Author: YangHeng
 * @Date: 2026-10-30 18:00:00
 * @FilePath: /dsh-workspace/src/lan/login-page.ts
 */
import { LAN_PROXY_PREFIX } from '../wire/lan.js'

const TEXT = {
  zh: {
    title: 'DSH 远程访问',
    subtitle: '请输入访问密码',
    placeholder: '访问密码',
    submit: '登录',
    wrong: '密码错误，还可尝试 {n} 次',
    locked: '尝试次数过多，请 {m} 分钟后再试',
    unset: '尚未设置访问密码，请在电脑端「远程访问」中设置',
    failed: '登录失败，请重试',
    hint: '密码可在电脑端 DSH「远程工作区 → 远程访问」中查看'
  },
  en: {
    title: 'DSH Remote Access',
    subtitle: 'Enter the access password',
    placeholder: 'Access password',
    submit: 'Sign in',
    wrong: 'Wrong password, {n} attempts left',
    locked: 'Too many attempts, try again in {m} min',
    unset: 'No access password yet. Set one in “Remote Access” on the computer.',
    failed: 'Sign-in failed, please retry',
    hint: 'Find the password in DSH on the computer: Remote Workspace → Remote Access'
  }
}

export type LoginLang = keyof typeof TEXT

/** 按 Accept-Language 选语言：首选中文就用中文，其余一律英文。 */
export function pickLang(acceptLanguage: string | undefined): LoginLang {
  const first = (acceptLanguage ?? '').split(',')[0]?.trim().toLowerCase() ?? ''
  return first.startsWith('zh') ? 'zh' : 'en'
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

export function loginPage(lang: LoginLang): string {
  const t = TEXT[lang]
  // 文案以 JSON 注入脚本；</ 转义防止提前闭合 script。
  const dict = JSON.stringify(t).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>${esc(t.title)}</title>
<style>
:root{--bg:#f5f6f8;--card:#fff;--fg:#1f2329;--muted:#8a8f99;--line:#e3e5e8;--accent:#3b6cf6;--err:#d64545}
@media (prefers-color-scheme:dark){:root{--bg:#141518;--card:#1e2024;--fg:#e8e9eb;--muted:#8d929c;--line:#30333a;--accent:#5a86ff;--err:#ff6b6b}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
main{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:360px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px 24px}
.logo{width:44px;height:44px;border-radius:12px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;margin-bottom:16px}
h1{font-size:20px;margin:0 0 4px}
p{margin:0 0 20px;color:var(--muted);font-size:14px}
input{width:100%;height:46px;border:1px solid var(--line);border-radius:10px;padding:0 14px;font-size:17px;background:transparent;color:inherit;outline:none;letter-spacing:.08em}
input:focus{border-color:var(--accent)}
button{width:100%;height:46px;margin-top:14px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:16px;font-weight:600}
button:disabled{opacity:.6}
.err{min-height:20px;margin-top:10px;color:var(--err);font-size:13px}
.hint{margin-top:18px;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<main>
<form class="card" id="f" autocomplete="off">
<div class="logo">DSH</div>
<h1>${esc(t.title)}</h1>
<p>${esc(t.subtitle)}</p>
<input id="pw" type="password" inputmode="text" autocomplete="current-password" placeholder="${esc(t.placeholder)}" autofocus required>
<button id="go" type="submit">${esc(t.submit)}</button>
<div class="err" id="err" role="alert"></div>
<div class="hint">${esc(t.hint)}</div>
</form>
</main>
<script>
(function(){
var T=${dict};
var f=document.getElementById('f'),pw=document.getElementById('pw'),go=document.getElementById('go'),err=document.getElementById('err');
function next(){var n=new URLSearchParams(location.search).get('next')||'/';return n.charAt(0)==='/'&&n.charAt(1)!=='/'&&n.charAt(1)!=='\\\\'?n:'/';}
f.addEventListener('submit',function(e){
e.preventDefault();go.disabled=true;err.textContent='';
fetch('${LAN_PROXY_PREFIX}/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:pw.value}),credentials:'same-origin'})
.then(function(r){return r.json()}).then(function(d){
if(d.ok){location.replace(next());return}
go.disabled=false;pw.select();
if(d.reason==='locked')err.textContent=T.locked.replace('{m}',Math.max(1,Math.ceil((d.retryAfterMs||0)/60000)));
else if(d.reason==='wrong')err.textContent=T.wrong.replace('{n}',d.remaining);
else if(d.reason==='unset')err.textContent=T.unset;
else err.textContent=T.failed;
}).catch(function(){go.disabled=false;err.textContent=T.failed});
});
})();
</script>
</body>
</html>`
}
