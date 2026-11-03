/* OwnCord admin panel: the System health page. Four cards (connections,
   database, voice, process) from GET /system/health, refreshed every 5
   seconds while the page is on screen. Warnings are the attention panel's:
   each card lists the attention signals that belong to it and links to the
   Dashboard, so there is one warning system. LiveKit's own CPU, memory and
   traffic figures are on the Dashboard's LiveKit card.

   Polling follows the Dashboard health row: each render starts a new
   generation (sysHealth.seq); a poll checks it still owns the page (same
   generation, still on this page, same session) before it fetches and again
   before it paints or schedules the next one, so a late answer after leaving
   the page or signing out is dropped and its loop ends. */
const SYS_HEALTH_POLL_MS=5000,SYS_HEALTH_FIRST_WAIT_MS=3000;
const sysHealth={seq:0,timer:null,data:null,error:'',token:''};
const SYS_DASH='–';

/* Which attention signals each card shows, by signal id. */
const SYS_SIGNALS={
  hub:id=>id==='reconnects'||id==='delivery',
  database:id=>id==='db_writer_wait'||id==='backup'||id==='disk',
  voice:id=>id==='voice',
  process:id=>id==='last_exit'||id==='last_restore'||id.startsWith('job:'),
};

function sysHealthOwns(seq,token){return seq===sysHealth.seq&&state.section==='health'&&state.token===token}

async function renderSystemHealth(){
  if(sysHealth.timer){clearTimeout(sysHealth.timer);sysHealth.timer=null}
  const seq=++sysHealth.seq,token=state.token;
  if(sysHealth.token!==token){sysHealth.data=null;sysHealth.error='';sysHealth.token=token}
  let waited;
  const first=loadSystemHealth(seq,token).then(ok=>{if(ok&&sysHealthOwns(seq,token))paintSystemHealth()});
  await Promise.race([first,new Promise(r=>{waited=setTimeout(r,SYS_HEALTH_FIRST_WAIT_MS)})]);
  clearTimeout(waited);
  if(sysHealthOwns(seq,token))sysHealth.timer=setTimeout(()=>pollSystemHealth(seq,token),SYS_HEALTH_POLL_MS);
  return'<div class="page-title">System health</div><div class="page-desc">Connections, database, voice and the server process right now. Refreshes every 5 seconds.</div>'
    +'<div class="sys-health-actions"><button class="btn btn-ghost" data-action="copySystemHealth">Copy for support</button></div>'
    +'<div id="sysHealthBody">'+systemHealthBody(sysHealth.data,sysHealth.error)+'</div>';
}
async function pollSystemHealth(seq,token){
  sysHealth.timer=null;
  if(!sysHealthOwns(seq,token))return;
  if(document.visibilityState!=='hidden'){
    const ok=await loadSystemHealth(seq,token);
    if(!sysHealthOwns(seq,token)||!ok)return;
    paintSystemHealth();
  }
  if(sysHealthOwns(seq,token))sysHealth.timer=setTimeout(()=>pollSystemHealth(seq,token),SYS_HEALTH_POLL_MS);
}
/* False stops the poll: a refusal (the permission was removed) or the session
   ended. A failed read keeps the last figures, notes the failure and polls on. */
async function loadSystemHealth(seq,token){
  try{
    const data=await api('GET','/system/health');
    if(sysHealthOwns(seq,token)){sysHealth.data=data;sysHealth.error=''}
    return true;
  }catch(e){
    if(e&&(e.status===403||e.status===401))return false;
    if(sysHealthOwns(seq,token))sysHealth.error=(e&&e.message)||'request failed';
    return state.token===token;
  }
}
function paintSystemHealth(){
  const el=document.getElementById('sysHealthBody');
  if(el)el.innerHTML=systemHealthBody(sysHealth.data,sysHealth.error);
}

/* The same health snapshot the support bundle carries as health.json. */
function copySystemHealth(){
  const d=sysHealth.data;
  if(!d||!d.snapshot){showToast('Nothing to copy yet','error');return}
  const text=JSON.stringify({captured_at:d.captured_at,health:d.snapshot,database:d.database,build:d.process&&d.process.build},null,2);
  try{navigator.clipboard.writeText(text).then(()=>showToast('Copied','info')).catch(()=>showToast('Copy failed','error'))}
  catch(e){showToast('Copy failed','error')}
}

function sysNum(v){return typeof v==='number'?v.toLocaleString():SYS_DASH}
function sysMs(v){return typeof v==='number'?(v<10?v.toFixed(1):Math.round(v).toLocaleString())+' ms':SYS_DASH}
function sysLatency(s){return s&&typeof s.count==='number'&&s.count>0?sysMs(s.p50)+' / '+sysMs(s.p95):SYS_DASH}
function sysYesNo(v,yes,no){return typeof v==='boolean'?(v?yes:no):SYS_DASH}
function sysUptime(s){
  if(typeof s!=='number')return SYS_DASH;
  const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  return d?d+'d '+h+'h':h?h+'h '+m+'m':m+'m';
}
function sysFacts(rows){
  return'<dl class="facts">'+rows.map(r=>'<dt>'+r[0]+'</dt><dd>'+r[1]+'</dd>').join('')+'</dl>';
}
const SYS_BADGE={ok:['badge-green','OK'],warning:['badge-yellow','Warning'],critical:['badge-red','Critical'],unknown:['badge-muted','Unknown']};
function sysSignals(signals,pick){
  const mine=(signals||[]).filter(s=>s&&typeof s.id==='string'&&pick(s.id));
  if(!mine.length)return'';
  const rows=mine.map(s=>{
    const b=SYS_BADGE[s.status]||SYS_BADGE.unknown;
    return'<li><span class="badge '+b[0]+'">'+b[1]+'</span> '+esc(s.label)+(s.value?' <span class="muted">'+esc(s.value)+'</span>':'')+'</li>';
  }).join('');
  const raised=mine.some(s=>s.status==='warning'||s.status==='critical');
  return'<ul class="sys-signals">'+rows+'</ul>'
    +(raised?'<button class="btn btn-ghost btn-sm" data-action="navigateTo" data-args="'+actArgs('dashboard')+'">Open warnings on the Dashboard</button>':'');
}
function sysCard(id,title,body){
  return'<section class="section-card" id="'+id+'" aria-labelledby="'+id+'Title"><div class="section-card-header"><h3 id="'+id+'Title">'+title+'</h3></div><div class="section-card-body">'+body+'</div></section>';
}

function systemHealthBody(d,error){
  if(!d)return error?'<p style="color:var(--text-danger)">Could not load system health: '+esc(error)+'</p>':'<p class="muted">Loading…</p>';
  const s=d.snapshot||{},hub=d.hub||{},db=d.database||{},proc=d.process||{},build=proc.build||{},sig=d.signals||[];
  const stale=error?'<p class="muted sys-stale">Last refresh failed ('+esc(error)+'). Showing figures from '+fmtLocal(d.captured_at)+'.</p>':'';

  const conns=typeof hub.connections==='number'?sysNum(hub.connections)+(hub.max_connections?' of '+sysNum(hub.max_connections):' (no limit)'):SYS_DASH;
  const hubCard=sysCard('sysHub','Connections',sysFacts([
    ['Users online',sysNum(s.connected_users)],
    ['Connections',conns],
    ['In voice',sysNum(s.voice_sessions)],
    ['Message delivery',sysYesNo(s.dispatch_alive,'Running','<span class="badge badge-red">Stopped</span>')],
    ['Broadcast time (typical / slow)',sysLatency(s.ws_broadcast_ms)],
    ['Delivery lag (typical / slow)',sysLatency(s.ws_dispatch_lag_ms)],
    ['Message send ack (typical / slow)',sysLatency(s.chat_send_ack_ms)],
    ['Broadcast queue',sysNum(s.hub_broadcast_queue_depth)],
    ['Longest sequence lock',sysMs(s.hub_seqmu_max_hold_ms)],
    ['Dropped broadcasts',sysNum(s.broadcast_drops)],
    ['Shed topic updates',sysNum(s.topic_sheds_total)],
    ['Slow clients disconnected',sysNum(s.queue_disconnects)],
    ['Refused connections',sysNum(s.ws_connection_rejects)],
    ['Reconnects (buffer / database / full)',[s.reconnect_buffer,s.reconnect_database,s.reconnect_full].map(sysNum).join(' / ')],
  ])+sysSignals(sig,SYS_SIGNALS.hub));

  let dbBody;
  const st=db.stats;
  if(db.status==='ok'&&st){
    dbBody=sysFacts([
      ['Database file',fmtBytes(st.file_bytes)],
      ['Write-ahead log',fmtBytes(st.wal_bytes)],
      ['Schema',st.schema_version?'<code>'+esc(String(st.schema_version).replace(/\.sql$/,''))+'</code>':SYS_DASH],
      ['Readers in use',sysNum(st.readers_in_use)+' of '+sysNum(st.readers_max)+' <span class="muted">('+sysNum(st.readers_open)+' open)</span>'],
      ['Waits for a reader',sysNum(st.reader_wait_count)+' <span class="muted">('+sysMs(st.reader_wait_ms)+' total)</span>'],
      ['Waits for the writer',sysNum(st.writer_wait_count)+' <span class="muted">('+sysMs(st.writer_wait_ms)+' total)</span>'],
    ]);
  }else if(db.status==='timeout'){
    dbBody='<p><span class="badge badge-yellow">Could not read</span> The database did not answer within 2 seconds. It may be busy with a long write.</p>';
  }else if(db.status==='not_measured'){
    dbBody='<p class="muted">Not measured on this server.</p>';
  }else{
    dbBody='<p><span class="badge badge-red">Could not read</span> Check Server logs for database errors.</p>';
  }
  dbBody+=sysSignals(sig,SYS_SIGNALS.database)
    +(can(PERM.MANAGE_BACKUPS)||ownerOrHolds(PERM.RESTORE_BACKUPS)?'<button class="btn btn-ghost btn-sm" data-action="navigateTo" data-args="'+actArgs('backups')+'">Backups</button>':'');
  const dbCard=sysCard('sysDatabase','Database',dbBody);

  const lk=d.livekit||{};
  let voiceBody;
  if(lk.managed){
    const lkState=s.livekit_gave_up?'<span class="badge badge-red">Stopped restarting</span>':s.livekit_healthy?'<span class="badge badge-green">Running</span>':'<span class="badge badge-yellow">Not running</span>';
    voiceBody=sysFacts([['LiveKit','Run by OwnCord'],['State',lkState],['Restarts',sysNum(s.livekit_restarts)]]);
  }else{
    voiceBody='<p class="muted">LiveKit runs on its own. Its CPU, memory and traffic are on the Dashboard\'s LiveKit card.</p>';
  }
  const voiceSignals=sysSignals(sig,SYS_SIGNALS.voice);
  voiceBody+=voiceSignals
    +(lk.managed||voiceSignals.includes('data-action')?'':'<button class="btn btn-ghost btn-sm" data-action="navigateTo" data-args="'+actArgs('dashboard')+'">Dashboard</button>');
  const voiceCard=sysCard('sysVoice','Voice',voiceBody);

  const rev=typeof build.revision==='string'?'<code>'+esc(build.revision.slice(0,12))+'</code>'+(build.modified?' <span class="muted">(modified)</span>':''):SYS_DASH;
  const procCard=sysCard('sysProcess','Server process',sysFacts([
    ['Version',build.version?esc(build.version):SYS_DASH],
    ['Uptime',sysUptime(proc.uptime_seconds)],
    ['Goroutines',sysNum(s.goroutines)],
    ['Heap in use',typeof s.heap_alloc_bytes==='number'?fmtBytes(s.heap_alloc_bytes):SYS_DASH],
    ['Garbage collections',sysNum(s.gc_cycles)],
    ['Go',build.go?esc(build.go):SYS_DASH],
    ['Platform',build.os?esc(build.os+'/'+build.arch):SYS_DASH],
    ['Build',rev],
  ])+sysSignals(sig,SYS_SIGNALS.process));

  return stale+'<div class="sys-health-grid">'+hubCard+dbCard+voiceCard+procCard+'</div>';
}

Object.assign(ACTIONS,{copySystemHealth});
