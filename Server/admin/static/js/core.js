/* OwnCord admin panel: shared core. The panel is classic scripts with no build
   step, loaded in the order index.html lists them: this core (icons, state,
   the API helper, permissions, formatters, toasts, dialogs, auth overlays,
   navigation, the content router and the ACTIONS dispatcher), one file per
   page group, and boot.js last. Classic scripts share one global scope, so a
   page file calls these helpers directly and the router reaches each page's
   render function by name at call time. */

/* ═══ Icons ═══ */
const I={
  dashboard:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
  users:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  channels:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>',
  settings:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
  backup:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  updates:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg>',
  audit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  logout:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  edit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  trash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  ban:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
  disconnect:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  refresh:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  download:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  voice:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>',
  megaphone:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  logs:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  lock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  plugins:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v6"/><path d="M18 3v6"/><path d="M4 9h16v4a8 8 0 0 1-16 0z"/><path d="M12 21v-4"/></svg>',
  upload:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
  shield:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  arrowUp:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
  arrowDown:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
  smile:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
};

/* ═══ State ═══ */
const PAGE_SIZE=50;
const state={section:'dashboard',token:localStorage.getItem('admin_token')||'',
  me:null,partialToken:'',
  usersPage:1,auditPage:1,auditSearch:'',auditActionFilter:'all',auditCache:[],settingsChanged:false,backupRunning:false,updateApplying:false,
  supportPreview:null,supportBusy:false,
  cachedStats:null,cachedUpdate:null,channelCache:{},roleList:[],pluginRuntime:'unknown',pluginBusy:false,
  logEntries:[],logLevels:{DEBUG:true,INFO:true,WARN:true,ERROR:true},
  logSearch:'',logAutoScroll:true,logPaused:false,logEventSource:null,logReconnectTimer:null,logConnectSeq:0,logMaxLines:2000};

/* ═══ API ═══ */
/* A 401 means the admin session is gone. Handle it here rather than letting
   every call site toast "invalid or expired session" forever while the panel
   stays on screen with no way back to the login form. */
function handleSessionExpired(){
  state.logConnectSeq++;
  if(state.logEventSource){state.logEventSource.close();state.logEventSource=null}
  if(state.logReconnectTimer){clearTimeout(state.logReconnectTimer);state.logReconnectTimer=null}
  state.supportPreview=null;state.supportBusy=false;state.token='';state.me=null;localStorage.removeItem('admin_token');
  const err=document.getElementById('loginErr');if(err)err.textContent='Your session expired — sign in again.';
  showOverlay('loginOverlay');
}

async function api(method,path,body,headers){
  const opts={method,headers:{'Authorization':'Bearer '+state.token,'Content-Type':'application/json',...headers}};
  if(body!==undefined)opts.body=JSON.stringify(body);
  const res=await fetch('/admin/api'+path,opts);
  if(res.status===401){handleSessionExpired();throw new Error('Your session expired — sign in again.')}
  if(res.status===204)return null;
  const data=await res.json();
  if(!res.ok)throw new Error(data.message||res.statusText);
  return data;
}

/* ═══ Permissions ═══ */
/* The panel perimeter admits any role holding one moderation bit, so what a
   principal may actually do varies. GET /admin/api/me reports the caller's
   role mask; tabs and row actions hide what it cannot use. Hiding is an
   affordance only — every route re-checks the bit server-side. */
const PERM={MANAGE_CHANNELS:0x20000,KICK_MEMBERS:0x40000,BAN_MEMBERS:0x80000,
  MUTE_MEMBERS:0x100000,MANAGE_ROLES:0x1000000,MANAGE_SERVER:0x2000000,
  VIEW_AUDIT_LOG:0x8000000,ADMINISTRATOR:0x40000000};
function can(bit){
  const p=(state.me&&state.me.permissions)||0;
  if((p&PERM.ADMINISTRATOR)!==0)return true;
  return (p&bit)===bit;
}
/* Owner-only routes (tokens, backups, updates) gate on role position, not on
   a bit, so the mask alone cannot answer this. */
function isOwner(){return !!(state.me&&state.me.is_owner)}

/* ═══ Utilities ═══ */
function esc(s){if(s===null||s===undefined)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fmtBytes(b){if(b<1024)return b+' B';if(b<1048576)return(b/1024).toFixed(1)+' KB';if(b<1073741824)return(b/1048576).toFixed(1)+' MB';return(b/1073741824).toFixed(2)+' GB'}
/* SQLite's datetime('now') writes "YYYY-MM-DD HH:MM:SS" — UTC with no zone
   marker — and new Date() reads that non-ISO form as LOCAL time, shifting the
   rendered clock by the viewer's offset. Add the marker the string is missing;
   a value that already carries one (or an offset) is passed through unchanged,
   so this is a no-op on the columns the server formats itself. */
function utcDate(s){const v=String(s);return new Date(/[Zz]|[+-]\d\d:?\d\d$/.test(v)?v:v.replace(' ','T')+'Z')}
/* U9: one local-time formatter for the SQLite naive-UTC strings (audit,
   dashboard activity, pending registrations). The UTC instant stays available
   as a tooltip; the visible text is the viewer's local time, matching the
   Tokens and Backups tables. */
function fmtLocal(s){if(!s)return'';const d=utcDate(s);if(isNaN(d.getTime()))return esc(String(s));return'<span title="'+esc(d.toISOString())+'">'+esc(d.toLocaleString())+'</span>'}
function actionBadge(a){if(!a)return'badge-muted';if(a.includes('ban')||a.includes('kick')||a.includes('delete'))return'badge-red';if(a.includes('create'))return'badge-green';if(a.includes('update'))return'badge-yellow';return'badge-accent'}
function actionColor(a){if(!a)return'var(--accent)';if(a.includes('ban')||a.includes('kick')||a.includes('delete'))return'var(--text-danger)';if(a.includes('create'))return'var(--text-positive)';if(a.includes('update'))return'var(--text-warning)';return'var(--accent)'}
/* Roles are createable now, so the four seeded ids are a fallback, not the set.
   Anything role-shaped prefers the live list (state.roleList, filled by the
   Roles section and by openEditUser) and only then the seeded map — otherwise a
   custom role renders as "Member" in its own colour. */
function roleFromCache(rid){return (state.roleList||[]).find(r=>r.id===rid)||null}
/* Nothing clears users.banned when a temporary ban lapses — expiry is decided
   lazily, by auth.IsEffectivelyBanned and by db.notBannedClause's
   `replace(ban_expires,' ','T') <= strftime(...)` arm. So a row keeps
   banned=1 with a past ban_expires for life while the account is fully active
   everywhere else, and this panel was the one surface still calling it
   banned. Apply the same rule here: banned, and either no expiry or an expiry
   still in the future. The replace() matches notBannedClause's normalisation
   of SQLite's space-separated form. */
function effectiveBan(u){
  if(!(u.Banned||u.banned))return false;
  const exp=u.ban_expires||u.BanExpires;
  if(!exp)return true;
  const t=utcDate(String(exp).replace(' ','T')).getTime();
  return isNaN(t)||t>Date.now();
}
function roleColor(rid){
  const r=roleFromCache(rid);
  if(r&&r.color)return r.color;
  return{1:'var(--role-owner)',2:'var(--role-admin)',3:'var(--role-mod)'}[rid]||'var(--role-member)';
}
/* Role colours are server-set, so an admin can pick a value that is
   unreadable as text. The client clamps every role colour through
   readableRoleColor() (B9 Q13); this is the same rule over the same four
   --bg-* surfaces: keep the colour only at 4.5:1 or better, otherwise fall
   back to --text-normal. Seeded var() tokens and the surfaces are read from
   the :root tokens, because a CSS var cannot be parsed as a colour here. */
function aoCssVar(value){
  const m=/^var\((--[\w-]+)\)$/.exec(String(value||'').trim());
  return m?getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim():value;
}
function aoParseColor(value){
  let v=(value||'').trim().replace(/^#/,'');
  if(/^[0-9a-f]{3}$/i.test(v))v=v.replace(/./g,'$&$&');
  if(!/^([0-9a-f]{6})$/i.test(v))return null;
  return [0,2,4].map(i=>parseInt(v.slice(i,i+2),16));
}
function aoLum(c){const s=c/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4)}
function aoContrast(a,b){const l=x=>0.2126*aoLum(x[0])+0.7152*aoLum(x[1])+0.0722*aoLum(x[2]);const x=l(a),y=l(b);return(Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)}
const aoRoleTextCache={};
function readableRoleColor(color){
  const raw=aoCssVar(color);
  if(aoRoleTextCache[raw]!==undefined)return aoRoleTextCache[raw];
  const rgb=aoParseColor(raw);
  const surfaces=['--bg-primary','--bg-secondary','--bg-tertiary','--bg-input'].map(n=>aoParseColor(aoCssVar('var('+n+')')));
  const out=(rgb&&surfaces.every(s=>s&&aoContrast(rgb,s)>=4.5))?raw:'var(--text-normal)';
  aoRoleTextCache[raw]=out;
  return out;
}
/* name is the server-supplied role_name where the caller has one (the users
   list ships it); it wins over any cache because it is always current. */
function roleName(rid,name){
  if(name)return name;
  const r=roleFromCache(rid);
  if(r)return r.name;
  return{1:'Owner',2:'Admin',3:'Moderator',4:'Member'}[rid]||'Member';
}

function showToast(msg,type='success'){
  const t=document.getElementById('toast');
  t.className='toast visible '+type;
  /* Errors persist until dismissed (U7): a message that vanishes after three
     seconds cannot be re-read or acted on. Success/info auto-dismiss. */
  t.innerHTML=(type==='success'?I.check:type==='error'?I.ban:I.check)+'<span>'+esc(msg)+'</span>'
    +(type==='error'?'<button class="toast-close" aria-label="Dismiss notification" data-action="dismissToast">&times;</button>':'');
  clearTimeout(window._tt);
  if(type!=='error')window._tt=setTimeout(()=>t.classList.remove('visible'),3000);
}
function dismissToast(){clearTimeout(window._tt);document.getElementById('toast').classList.remove('visible')}

/* U6: every .toggle is a role=switch button; this keeps its visual class and
   its aria-checked state in step in one place. */
function toggleSwitch(el){el.classList.toggle('on');el.setAttribute('aria-checked',el.classList.contains('on')?'true':'false')}

/* U5: the reused dialog moves focus in, traps Tab, and restores it on close.
   One modal exists at a time, so a module-level opener is enough. */
let modalOpener=null;
const MODAL_FOCUSABLE='a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
/* Writes dialog content and gives the reused wrapper its accessible name from
   the first heading, so role=dialog is never unnamed (U5). */
function setModalHTML(html){
  const o=document.getElementById('modal');
  const inner=document.getElementById('modalInner');
  inner.innerHTML=html;
  inner.querySelectorAll('h1,h2,h3').forEach((h,i)=>{h.id=h.id||('modalTitle'+(i||''))});
  const head=inner.querySelector('h1,h2,h3');
  if(head)o.setAttribute('aria-labelledby',head.id);else o.removeAttribute('aria-labelledby');
  /* Reset scroll so a second long dialog does not open past its header. */
  inner.scrollTop=0;
  if(o.classList.contains('visible')&&!o.contains(document.activeElement))focusModalStart(inner);
}
function focusModalStart(inner){
  const first=inner.querySelector(MODAL_FOCUSABLE);
  if(first instanceof HTMLElement)first.focus();
  else{inner.setAttribute('tabindex','-1');inner.focus()}
}
function openModal(html){
  state.retentionProposal=null;
  const o=document.getElementById('modal');
  const inner=document.getElementById('modalInner');
  if(!o.classList.contains('visible'))modalOpener=document.activeElement;
  setModalHTML(html);
  o.classList.add('visible');o.setAttribute('aria-hidden','false');
  /* A later openModal replaces the content; an earlier one's deferred focus
     must not steal it. */
  const seq=(openModal._seq=(openModal._seq||0)+1);
  setTimeout(()=>{
    if(seq!==openModal._seq)return;
    focusModalStart(inner);
  },0);
}
function closeModal(){
  state.retentionProposal=null;
  const o=document.getElementById('modal');
  o.classList.remove('visible');o.setAttribute('aria-hidden','true');
  openModal._seq=(openModal._seq||0)+1;
  if(modalOpener instanceof HTMLElement)modalOpener.focus();
  modalOpener=null;
}
/* Keep Tab inside the dialog while it is open. */
document.getElementById('modal').addEventListener('keydown',e=>{
  if(e.key!=='Tab')return;
  const inner=document.getElementById('modalInner');
  const focusables=Array.from(inner.querySelectorAll(MODAL_FOCUSABLE));
  if(!focusables.length)return;
  const first=focusables[0],last=focusables[focusables.length-1];
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}
  else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
});

/* ═══ Auth ═══ */
function hideAll(){['setupOverlay','setupSuccessOverlay','loginOverlay'].forEach(id=>document.getElementById(id).classList.remove('visible'));document.getElementById('adminShell').classList.add('hidden')}
function showOverlay(id){hideAll();if(id==='loginOverlay')resetLoginSteps();document.getElementById(id).classList.add('visible')}
/* Back to the username/password step, dropping any outstanding 2FA
   challenge. Deliberately leaves #loginErr alone: handleSessionExpired writes
   its message before calling showOverlay. */
function resetLoginSteps(){
  state.partialToken='';
  const t=document.getElementById('loginTotp');if(t)t.value='';
  const s1=document.getElementById('loginStep1');if(s1)s1.classList.remove('hidden');
  const s2=document.getElementById('loginTotpStep');if(s2)s2.classList.add('hidden');
}
function showApp(){hideAll();document.getElementById('adminShell').classList.remove('hidden')}

async function checkAuth(){
  try{const r=await fetch('/admin/api/setup/status');const d=await r.json();if(d.needs_setup){wizInit(d.defaults);showOverlay('setupOverlay');return}}catch(e){console.error('setup check:',e)}
  if(!state.token){showOverlay('loginOverlay');return}
  try{await enterApp()}catch(e){showOverlay('loginOverlay')}
}

/* Loads the caller's permissions before the first render — the nav is built
   from them, so rendering earlier would flash tabs the principal cannot open.
   Throws on an unusable session so callers fall back to the login overlay. */
/* A #section fragment deep-links the panel: the desktop client's "Audit Log"
   entry opens /admin#audit, so the operator lands on the log rather than on the
   dashboard with a tab still to find. Applied before the permission fallback
   below, so a fragment naming a section the principal may not open falls back
   to the dashboard exactly like a stale stored section does. */
function sectionFromHash(){
  const id=(location.hash||'').replace(/^#/,'');
  return NAV.some(n=>n.id===id)?id:'';
}

async function enterApp(){
  state.me=await api('GET','/me');
  const deepLink=sectionFromHash();
  if(deepLink)state.section=deepLink;
  if(!sectionAllowed(state.section))state.section='dashboard';
  showApp();renderNav();renderContent();
}

/* ═══ Nav ═══ */
/* `allowed` mirrors the server-side gate on each section's routes; omitted
   means perimeter-level (any principal the panel let in). */
const NAV=[
  {section:'Management'},
  {id:'dashboard',label:'Dashboard',icon:I.dashboard},
  {id:'users',label:'Users',icon:I.users},
  {id:'channels',label:'Channels',icon:I.channels,allowed:()=>can(PERM.MANAGE_CHANNELS)},
  {id:'roles',label:'Roles',icon:I.shield,allowed:()=>can(PERM.MANAGE_ROLES)},
  {id:'emoji',label:'Emoji',icon:I.smile,allowed:()=>can(PERM.MANAGE_SERVER)},
  {sep:true},
  {section:'Configuration'},
  {id:'audit',label:'Audit Log',icon:I.audit,allowed:()=>can(PERM.VIEW_AUDIT_LOG)},
  {id:'tokens',label:'API Tokens',icon:I.lock,allowed:isOwner},
  {id:'plugins',label:'Plugins',icon:I.plugins,allowed:()=>can(PERM.ADMINISTRATOR)},
  {id:'diagnostics',label:'Diagnostics',icon:I.shield,allowed:()=>can(PERM.ADMINISTRATOR)},
  {id:'logs',label:'Server Logs',icon:I.logs,allowed:()=>can(PERM.ADMINISTRATOR)},
  {id:'settings',label:'Settings',icon:I.settings,unsaved:()=>state.settingsChanged,allowed:()=>can(PERM.MANAGE_SERVER)},
  {id:'retention',label:'Retention',icon:I.trash,allowed:()=>can(PERM.MANAGE_SERVER)},
  {id:'backups',label:'Backups',icon:I.backup,allowed:isOwner},
  {id:'updates',label:'Updates',icon:I.updates,allowed:isOwner},
  {sep:true},
  {id:'logout',label:'Sign Out',icon:I.logout,danger:true},
];

/* True when the principal may open the section. Unknown ids are refused so a
   stale localStorage/section value can't route into a hidden page. */
function sectionAllowed(id){
  const n=NAV.find(x=>x.id===id);
  if(!n)return false;
  return !n.allowed||n.allowed();
}

/* Drops section labels with no visible item under them and separators that
   would end up leading, trailing, or doubled once entries are filtered out. */
function visibleNav(){
  const kept=NAV.filter(n=>n.section||n.sep||!n.allowed||n.allowed());
  const out=[];
  for(let i=0;i<kept.length;i++){
    const n=kept[i];
    if(n.section){
      const next=kept[i+1];
      if(!next||next.section||next.sep)continue;
    }
    if(n.sep){
      const prev=out[out.length-1];
      if(!prev||prev.sep)continue;
    }
    out.push(n);
  }
  while(out.length&&out[out.length-1].sep)out.pop();
  return out;
}

function renderNav(){
  document.getElementById('sidebarNav').innerHTML=visibleNav().map(n=>{
    if(n.section)return'<div class="sidebar-label">'+n.section+'</div>';
    if(n.sep)return'<div class="sidebar-sep"></div>';
    const active=state.section===n.id?'active':'';
    const cls=n.danger?'danger':'';
    const unsaved=n.unsaved&&n.unsaved()?'<span class="unsaved-dot"></span>':'';
    if(n.id==='logout')return'<button class="nav-item '+cls+'" data-action="doLogout">'+n.icon+'<span>'+n.label+'</span></button>';
    return'<button class="nav-item '+active+' '+cls+'" role="tab" data-action="navigateTo" data-args="'+actArgs(n.id)+'">'+unsaved+n.icon+'<span>'+n.label+'</span></button>';
  }).join('');
}

function navigateTo(id){
  if(!sectionAllowed(id)){showToast('You do not have permission to open that section','error');return}
  try{
    if(state.section==='logs'&&id!=='logs'){state.logConnectSeq++;if(state.logEventSource){state.logEventSource.close();state.logEventSource=null}if(state.logReconnectTimer){clearTimeout(state.logReconnectTimer);state.logReconnectTimer=null}}
    state.section=id;renderNav();renderContent();
  }catch(err){
    console.error('[Admin] Tab navigation failed for "'+id+'":', err);
    var c=document.getElementById('content');
    if(c)c.innerHTML='<div class="page-title">Error</div><p style="color:var(--text-danger)">Failed to navigate to '+esc(id)+': '+esc(err&&err.message||String(err))+'</p><button class="btn btn-accent" data-action="navigateTo" data-args="'+actArgs('dashboard')+'">Back to Dashboard</button>';
  }
}

function doLogout(){state.logConnectSeq++;if(state.logEventSource){state.logEventSource.close();state.logEventSource=null}if(state.logReconnectTimer){clearTimeout(state.logReconnectTimer);state.logReconnectTimer=null}state.supportPreview=null;state.supportBusy=false;state.token='';state.me=null;localStorage.removeItem('admin_token');showOverlay('loginOverlay')}

/* ═══ Content Router ═══ */
function renderContent(){
  const c=document.getElementById('content');if(!c)return;c.scrollTop=0;
  const r={dashboard:renderDashboard,users:renderUsers,channels:renderChannels,roles:renderRoles,emoji:renderEmoji,audit:renderAudit,tokens:renderTokens,plugins:renderPlugins,logs:renderLogs,diagnostics:renderDiagnostics,settings:renderSettings,retention:renderRetention,backups:renderBackups,updates:renderUpdates};
  c.innerHTML='<div class="page-title">Loading...</div>';
  const fn=r[state.section];
  if(typeof fn!=='function'){console.error('[Admin] No render function for section: '+state.section);c.innerHTML='<div class="page-title">Error</div><p style="color:var(--text-danger)">Unknown section: '+esc(state.section)+'</p><button class="btn btn-accent" data-action="navigateTo" data-args="'+actArgs('dashboard')+'">Back to Dashboard</button>';return}
  try{
    const result=fn();
    if(result instanceof Promise){
      const renderSection=state.section;
      result.then(function(html){if(state.section===renderSection)c.innerHTML=html}).catch(function(e){
        console.error('[Admin] Render error in "'+renderSection+'":', e);
        if(state.section===renderSection)c.innerHTML='<div class="page-title">Error</div><p style="color:var(--text-danger)">'+esc(e&&e.message||String(e))+'</p><button class="btn btn-accent" data-action="renderContent">Retry</button>';
      });
    }else{c.innerHTML=result}
  }catch(e){
    console.error('[Admin] Sync render error in "'+state.section+'":', e);
    c.innerHTML='<div class="page-title">Error</div><p style="color:var(--text-danger)">'+esc(e&&e.message||String(e))+'</p><button class="btn btn-accent" data-action="renderContent">Retry</button>';
  }
}

/* ═══ Actions ═══ */
/* The admin CSP is script-src 'self', so no markup carries an on*= handler.
   A control names its handler instead: data-action runs on click,
   data-input-action on input and data-change-action on change, with the
   arguments as a JSON array in data-args (build it with actArgs, which also
   HTML-escapes it for the attribute). Each script registers the handlers it
   defines in ACTIONS; a handler runs with `this` bound to the control, as an
   inline handler did. Only registered names can run, never any global. */
const ACTIONS=Object.create(null);
function actArgs(...args){return esc(JSON.stringify(args))}
function delegateActions(type,attr){
  document.addEventListener(type,e=>{
    const el=e.target instanceof Element?e.target.closest('['+attr+']'):null;
    if(!el)return;
    const fn=ACTIONS[el.getAttribute(attr)];
    if(typeof fn!=='function'){console.error('[Admin] No handler registered for '+attr+'="'+el.getAttribute(attr)+'"');return}
    fn.apply(el,el.dataset.args?JSON.parse(el.dataset.args):[]);
  });
}
delegateActions('click','data-action');
delegateActions('input','data-input-action');
delegateActions('change','data-change-action');
Object.assign(ACTIONS,{closeModal,renderContent,navigateTo,doLogout,dismissToast,
  closeModalAndRefresh(){closeModal();renderContent()},
  toggleSwitch(){toggleSwitch(this)}});
