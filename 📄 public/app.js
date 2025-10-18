const BASE_URL = window.APP_CONFIG.BASE_URL; // cùng origin
const $ = (s) => document.querySelector(s);

const AUTH_KEY = 'cskh_web_auth';
const STATE_KEY = 'cskh_web_state';
const LOGS_KEY = 'cskh_web_logs';

const now = () => Date.now();
const emptyState = () => ({ status:'offline', startedAt:null, breakStartedAt:null, accBreakMs:0 });
const statusLabel = (s) => s==='working' ? 'Working' : (s==='break' ? 'On Break' : 'Offline');
const startOfDay = (ts) => { const d=new Date(ts); d.setHours(0,0,0,0); return d.getTime(); };

function getAuth(){ try{return JSON.parse(localStorage.getItem(AUTH_KEY)||'null');}catch{return null;} }
function setAuth(a){ localStorage.setItem(AUTH_KEY, JSON.stringify(a)); }
function clearAuth(){ localStorage.removeItem(AUTH_KEY); }

function getState(){ try{return JSON.parse(localStorage.getItem(STATE_KEY)||'null')||emptyState();}catch{return emptyState();} }
function setState(s){ localStorage.setItem(STATE_KEY, JSON.stringify(s)); }
function pushLog(e){
  const logs = JSON.parse(localStorage.getItem(LOGS_KEY)||'[]'); logs.push(e);
  localStorage.setItem(LOGS_KEY, JSON.stringify(logs));
}

async function api(path, method='GET', body){
  const auth = getAuth();
  const headers = { 'Content-Type':'application/json' };
  if (auth?.token) headers['Authorization'] = 'Bearer ' + auth.token;
  const r = await fetch(BASE_URL + path, { method, headers, body: body?JSON.stringify(body):undefined });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

// UI helpers
function showLoggedIn(on){
  $('#authCard').style.display = on ? 'none' : 'block';
  $('#appCard').style.display = on ? 'block' : 'none';
}

async function loadPublic(){
  try{
    const data = await (await fetch(BASE_URL + '/public/online')).json();
    const list = $('#publicList'); list.innerHTML='';
    (data.online||[]).forEach(u=>{
      const div = document.createElement('div');
      div.className='item';
      div.innerHTML = `<div><b>${u.display_name||''}</b><div class="muted">${u.status}</div></div>
                       <div class="muted">${u.started_at?new Date(u.started_at).toLocaleString():''}</div>`;
      list.appendChild(div);
    });
  }catch(e){}
}

async function refresh(){
  await loadPublic();
  const auth = getAuth();
  showLoggedIn(!!auth?.token);
  if(!auth?.token) return;
  $('#displayNameTxt').textContent = auth.profile?.display_name || 'Agent';
  $('#roleTxt').textContent = auth.profile?.role || 'agent';
  $('#emailTxt').textContent = auth.profile?.email || '';
  const s = getState(); $('#status').textContent = statusLabel(s.status);

  try{
    const t = await api('/attendance/today','GET');
    $('#todayHours').textContent = String(Math.floor((t.workMs||0)/3600000));
  }catch(e){}
}

// auth handlers
$('#loginBtn').onclick = async ()=>{
  $('#authMsg').textContent='';
  const email = $('#email').value.trim();
  const password = $('#password').value.trim();
  try{
    const r = await fetch(BASE_URL + '/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, password }) });
    if(!r.ok){ $('#authMsg').textContent = await r.text(); return; }
    const data = await r.json(); setAuth(data); await refresh();
  }catch(e){ $('#authMsg').textContent = 'Đăng nhập thất bại'; }
};
$('#signupBtn').onclick = async ()=>{
  $('#authMsg').textContent='';
  const email = $('#email').value.trim();
  const password = $('#password').value.trim();
  const display_name = $('#displayName').value.trim();
  if(password.length<6){ $('#authMsg').textContent='Mật khẩu tối thiểu 6 ký tự'; return; }
  try{
    const r = await fetch(BASE_URL + '/auth/signup', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, password, display_name }) });
    $('#authMsg').textContent = r.ok ? 'Đăng ký thành công! Hãy đăng nhập.' : await r.text();
  }catch(e){ $('#authMsg').textContent='Đăng ký thất bại'; }
};
$('#logoutBtn').onclick = ()=>{ clearAuth(); setState(emptyState()); refresh(); };

// actions
$('#checkInBtn').onclick = async ()=>{
  const s = getState(); if(s.status!=='offline') return;
  const startedAt = now();
  setState({ status:'working', startedAt, breakStartedAt:null, accBreakMs:0 });
  try{ await api('/attendance/check-in','POST',{ startedAt }); }catch(e){}
  refresh();
};
$('#breakBtn').onclick = async ()=>{
  const s = getState();
  if(s.status==='working'){
    s.status='break'; s.breakStartedAt=now(); setState(s);
    try{ await api('/attendance/break/start','POST',{ at:s.breakStartedAt }); }catch(e){}
  }else if(s.status==='break'){
    const n=now(); if(s.breakStartedAt) s.accBreakMs += (n - s.breakStartedAt);
    setState({ ...s, status:'working', breakStartedAt:null });
    try{ await api('/attendance/break/end','POST',{ at:n }); }catch(e){}
  }
  refresh();
};
$('#checkOutBtn').onclick = async ()=>{
  const s = getState(); if(s.status==='offline' || !s.startedAt) return;
  const end = now();
  let acc = s.accBreakMs; if(s.status==='break' && s.breakStartedAt) acc += (end - s.breakStartedAt);
  const elapsed=end - s.startedAt; const workMs=Math.max(0, elapsed - acc);
  pushLog({ dateStart: startOfDay(s.startedAt), startedAt: s.startedAt, endedAt:end, workMs, breakMs:acc });
  setState(emptyState());
  try{ await api('/attendance/check-out','POST',{ endedAt:end }); }catch(e){}
  refresh();
};

// heartbeat 30s
async function heartbeat(){
  try{
    const auth = getAuth(); if(!auth?.token) return;
    const s = getState();
    await api('/presence/beat','POST',{ status:s.status, startedAt:s.startedAt||null });
  }catch(e){}
}
setInterval(heartbeat, 30000);

setInterval(refresh, 15000);
refresh();
