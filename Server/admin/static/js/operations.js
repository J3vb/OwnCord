/* OwnCord admin panel: Diagnostics, the Dashboard and its attention panel,
   Audit Log, Server Logs, API Tokens and Plugins. */

/* Support bundles remain local until the administrator chooses to share the
   downloaded file. The server freezes the preview; confirmation sends its ID
   and hash, and cannot regenerate different content under an old preview. */
function renderDiagnostics(){
  let html='<div class="page-title">Diagnostics</div><div class="page-desc">Create a support bundle to investigate server problems.</div>';
  html+='<div class="section-card"><div class="section-card-body"><p>Includes versions, selected settings, database counts, server health metrics and a recent event timeline. Client media connectivity is not tested. Message contents, credentials, addresses and raw logs are excluded. Nothing is uploaded.</p><button class="btn btn-accent" style="margin-top:16px" data-action="previewSupportBundle" '+(state.supportBusy?'disabled':'')+'>'+(state.supportBusy?'Preparing…':'Create support bundle preview')+'</button></div></div>';
  const p=state.supportPreview;if(!p)return html;
  html+='<div class="section-card" id="support-preview"><div class="section-card-header"><h3>Review before download</h3></div><div class="section-card-body"><p>Archive size: <strong>'+p.byte_size+' bytes</strong> ('+fmtBytes(p.byte_size)+'). Preview expires '+esc(utcDate(p.expires_at).toLocaleTimeString())+'.</p><p style="overflow-wrap:anywhere">SHA-256: <code>'+esc(p.sha256)+'</code></p><table class="tbl"><thead><tr><th>Item</th><th>Bytes</th><th>SHA-256</th></tr></thead><tbody>';
  p.items.forEach(item=>{html+='<tr><td>'+esc(item.name)+'</td><td>'+item.byte_size+'</td><td style="overflow-wrap:anywhere;max-width:280px"><code>'+esc(item.sha256)+'</code></td></tr>'});
  html+='</tbody></table><h4 style="margin-top:16px">Redaction report</h4>';
  p.redactions.forEach(rule=>{html+='<p><strong>'+esc(rule.item)+': '+esc(rule.rule)+'</strong><br>'+esc(rule.omitted)+'</p>'});
  html+='<p>Review the downloaded file before sharing it with someone helping you.</p><button class="btn btn-ghost" data-action="discardSupportBundle" '+(state.supportBusy?'disabled':'')+'>Discard preview</button> <button class="btn btn-accent" id="support-confirm" data-action="downloadSupportBundle" '+(state.supportBusy?'disabled':'')+'>Confirm download</button></div></div>';
  return html;
}
function discardSupportBundle(){state.supportPreview=null;if(state.section==='diagnostics')renderContent()}
async function previewSupportBundle(){
  if(state.supportBusy)return;
  const token=state.token;state.supportBusy=true;state.supportPreview=null;renderContent();
  try{
    const res=await fetch('/admin/api/support-bundles/preview',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});
    if(state.token!==token)return;
    if(res.status===401){handleSessionExpired();return}
    const data=await res.json();if(state.token!==token)return;
    if(!res.ok)throw new Error(data.message||'Could not prepare diagnostics');
    state.supportPreview=data;
  }catch(e){if(state.token===token)showToast(e.message,'error')}
  finally{if(state.token===token){state.supportBusy=false;if(state.section==='diagnostics')renderContent()}}
}
async function downloadSupportBundle(){
  const p=state.supportPreview;if(!p||state.supportBusy)return;
  const token=state.token;state.supportBusy=true;renderContent();
  try{
    const res=await fetch('/admin/api/support-bundles/download',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({preview_id:p.preview_id,sha256:p.sha256})});
    if(state.token!==token)return;
    if(res.status===401){handleSessionExpired();return}
    if(!res.ok){const data=await res.json();throw new Error(data.message||'Could not download diagnostics')}
    const blob=await res.blob();if(state.token!==token)return;
    const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download='owncord-support.zip';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    showToast('Support bundle downloaded');
  }catch(e){if(state.token===token)showToast(e.message,'error')}
  finally{if(state.token===token){state.supportPreview=null;state.supportBusy=false;if(state.section==='diagnostics')renderContent()}}
}

/* ═══ Attention (RI-07) ═══ */
/* The server samples disk space, writer wait, reconnects, delivery pressure,
   the newest backup and every maintenance job once a minute, and keeps one
   deduplicated warning per signal with hysteresis; this only renders what
   GET /attention reports. Unknown is a measurement the server could not take
   and is never drawn as healthy. */
const ATTN_STATUS={ok:['badge-green','Healthy'],warning:['badge-yellow','Warning'],critical:['badge-red','Critical'],unknown:['badge-muted','Unknown']};
function attnBadge(s){const b=ATTN_STATUS[s]||ATTN_STATUS.unknown;return'<span class="badge '+b[0]+'">'+b[1]+'</span>'}
function attnTime(iso){if(!iso)return'';const d=new Date(iso);return isNaN(d.getTime())?'':d.toLocaleString()}
function renderAttention(rep){
  const warnings=(rep&&rep.warnings)||[],signals=(rep&&rep.signals)||[];
  const active=warnings.filter(w=>!w.recovered_at);
  let html='<div class="section-card" id="attentionPanel"><div class="section-card-header"><h3>Attention'+(active.length?' ('+active.length+')':'')+'</h3><button class="btn btn-ghost" data-action="renderContent">Refresh</button></div><div class="section-card-body">';
  if(!rep||!rep.evaluated_at)html+='<p class="attn-pending" style="color:var(--text-muted)">The server has not evaluated its health yet.</p>';
  else{
    html+='<div class="activity-time">Evaluated '+esc(attnTime(rep.evaluated_at))+'</div>';
    if(!active.length)html+='<p class="attn-none" style="margin-top:8px">No active warnings.</p>';
  }
  warnings.forEach(w=>{
    const rec=!!w.recovered_at;
    html+='<div class="activity-item attn-warning" data-id="'+esc(w.id)+'"><div>'+(rec?'<span class="badge badge-green">Recovered</span>':attnBadge(w.severity))+'</div><div>'
      +'<div class="activity-text"><strong>'+esc(w.title)+'</strong>'+(w.detail?' — '+esc(w.detail):'')+'</div>'
      +'<div class="activity-text attn-action">'+esc(w.action)+'</div>'
      +'<div class="activity-time">First seen '+esc(attnTime(w.first_observed))+' · last seen '+esc(attnTime(w.last_observed))
      +(w.occurrences>1?' · '+w.occurrences+' occurrences':'')+(rec?' · recovered '+esc(attnTime(w.recovered_at)):'')+'</div></div></div>';
  });
  html+='</div>';
  if(signals.length){
    html+='<div class="section-card-body no-pad"><table class="tbl"><thead><tr><th>Signal</th><th>Status</th><th>Measured</th><th>Detail</th></tr></thead><tbody>';
    signals.forEach(g=>{html+='<tr data-signal="'+esc(g.id)+'"><td>'+esc(g.label)+'</td><td>'+attnBadge(g.status)+'</td><td>'+esc(g.value||'—')+'</td><td>'+esc([g.threshold,g.detail].filter(Boolean).join(' · '))+'</td></tr>'});
    html+='</tbody></table></div>';
  }
  return html+'</div>';
}

/* ═══ Dashboard ═══ */
async function renderDashboard(){
  try{state.cachedStats=await api('GET','/stats')}catch(e){return'<div class="page-title">Dashboard</div><p style="color:var(--text-danger)">Failed to load stats: '+esc(e.message)+'</p>'}
  /* Update checks are owner-only; skip the call for everyone else instead of
     spending a guaranteed 403 on every dashboard load. */
  if(isOwner()){try{state.cachedUpdate=await api('GET','/updates')}catch(e){/* the banner is optional; the Updates page reports the failure */}}
  const s=state.cachedStats;const u=state.cachedUpdate;
  let html='<div class="page-title">Dashboard</div><div class="page-desc">Server overview and statistics</div>';
  if(u&&u.update_available)html+='<div class="update-card" style="border-color:var(--accent);margin-bottom:20px"><div class="update-icon" style="background:var(--accent-glow);color:var(--accent)">'+I.updates+'</div><div class="update-info"><div class="update-ver">Update Available: '+esc(u.latest)+'</div><div class="update-notes">Current: '+esc(u.current)+' &mdash; <button class="btn btn-accent" style="margin-left:8px" data-action="navigateTo" data-args="'+actArgs('updates')+'">View Update</button></div></div></div>';
  /* Attention is server health detail: ADMINISTRATOR, like the route. */
  if(can(PERM.ADMINISTRATOR)){
    try{html+=renderAttention(await api('GET','/attention'))}
    catch(e){html+='<div class="section-card" id="attentionPanel"><div class="section-card-header"><h3>Attention</h3></div><div class="section-card-body"><p style="color:var(--text-danger)">Could not load attention state: '+esc(e.message)+'</p></div></div>'}
  }
  html+='<div class="stat-grid">';
  html+='<div class="stat-card"><div class="stat-card-header"><span class="stat-card-label">Total Users</span><div class="stat-card-icon" style="background:rgba(92,195,137,.15);color:var(--text-positive)">'+I.users+'</div></div><div class="stat-card-value">'+(s.user_count||0)+'</div><div class="stat-card-sub">registered</div></div>';
  html+='<div class="stat-card"><div class="stat-card-header"><span class="stat-card-label">Messages</span><div class="stat-card-icon" style="background:var(--accent-glow);color:var(--accent)">'+I.megaphone+'</div></div><div class="stat-card-value">'+(s.message_count||0).toLocaleString()+'</div><div class="stat-card-sub">total</div></div>';
  html+='<div class="stat-card"><div class="stat-card-header"><span class="stat-card-label">Channels</span><div class="stat-card-icon" style="background:rgba(242,184,75,.15);color:var(--text-warning)">'+I.channels+'</div></div><div class="stat-card-value">'+(s.channel_count||0)+'</div><div class="stat-card-sub">active</div></div>';
  html+='<div class="stat-card"><div class="stat-card-header"><span class="stat-card-label">Database</span><div class="stat-card-icon" style="background:var(--accent-glow);color:var(--accent)">'+I.backup+'</div></div><div class="stat-card-value">'+fmtBytes(s.db_size_bytes||0)+'</div><div class="stat-card-sub">SQLite</div></div>';
  html+='</div>';
  // The certificate users compare out of band before accepting the client's
  // trust prompt (BPR-051). Shown only when the server serves a statically
  // loaded certificate (not with TLS off or ACME before its first handshake).
  if(s.certificate_fingerprint){
    html+='<div class="section-card"><div class="section-card-header"><h3>Certificate Fingerprint</h3></div><div class="section-card-body"><p style="font-size:13px;color:var(--text-muted);margin:0 0 8px">Users compare this against the prompt their client shows before they accept the connection. Publish it out of band — another platform, a call. A mismatch is the one warning that means an interception attempt.</p><code style="display:block;word-break:break-all;font-size:13px">'+esc(s.certificate_fingerprint)+'</code></div></div>';
  }
  // Recent audit — VIEW_AUDIT_LOG only.
  if(can(PERM.VIEW_AUDIT_LOG))try{
    const entries=await api('GET','/audit-log?limit=5&offset=0');
    if(entries&&entries.length){
      html+='<div class="section-card"><div class="section-card-header"><h3>Recent Activity</h3><button class="btn btn-ghost" data-action="navigateTo" data-args="'+actArgs('audit')+'">View All</button></div><div class="section-card-body">';
      entries.forEach(a=>{html+='<div class="activity-item"><div class="activity-icon" style="background:'+actionColor(a.action)+'22;color:'+actionColor(a.action)+'">'+I.audit+'</div><div><div class="activity-text"><strong>'+esc(a.actor_name||a.actor_id)+'</strong> '+esc(a.action)+' <strong>'+esc(a.target_type)+(a.target_id?' #'+a.target_id:'')+'</strong></div><div class="activity-time">'+fmtLocal(a.created_at)+(a.detail?' — '+esc(a.detail):'')+'</div></div></div>'});
      html+='</div></div>';
    }
  }catch(e){}
  return html;
}

/* ═══ Audit Log ═══ */
async function renderAudit(){
  const offset=(state.auditPage-1)*PAGE_SIZE;
  // Over-fetched like the Users page, so the ">" button never offers an
  // empty page at an exact multiple of PAGE_SIZE. The cache keeps the sliced
  // page so the "N entries on this page" label stays accurate.
  let entries;
  try{entries=await api('GET','/audit-log?limit='+(PAGE_SIZE+1)+'&offset='+offset)}catch(e){return'<div class="page-title">Audit Log</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  const hasMore=!!entries&&entries.length>PAGE_SIZE;
  state.auditCache=(entries||[]).slice(0,PAGE_SIZE);

  // Collect unique action types for the filter dropdown.
  // The options come from the fetched page but the filter is global, so a
  // filtered action that does not occur on this page would leave no option
  // `selected`: the control would read "All Actions" with the filter still
  // applied, and picking "All Actions" would fire no change event because the
  // element's value already was "all". Keeping the active filter in the set
  // makes the control and the state impossible to diverge.
  const actionTypes=[...new Set(state.auditCache.map(e=>e.action).filter(Boolean).concat(state.auditActionFilter!=='all'?[state.auditActionFilter]:[]))].sort();

  // Client-side filter on fetched page.
  const filtered=auditFiltered();

  let html='<div class="page-title">Audit Log</div><div class="page-desc">Action history — '+state.auditCache.length+' entries on this page</div>';

  // Filter bar
  html+='<div class="filter-bar">';
  html+='<input class="filter-search" aria-label="Search audit log" placeholder="Search audit log..." value="'+esc(state.auditSearch)+'" data-input-action="setAuditSearch">';
  html+='<select class="filter-select" aria-label="Filter by action" data-change-action="setAuditActionFilter">';
  html+='<option value="all" '+(state.auditActionFilter==='all'?'selected':'')+'>All Actions</option>';
  actionTypes.forEach(t=>{html+='<option value="'+esc(t)+'" '+(state.auditActionFilter===t?'selected':'')+'>'+esc(t)+'</option>'});
  html+='</select>';
  html+='<button class="btn btn-ghost" data-action="copyAuditLog" title="Copy filtered entries">Copy All</button>';
  html+='<button class="btn btn-ghost" data-action="exportAuditCSV" title="Export as CSV">Export CSV</button>';
  html+='</div>';

  // Table
  html+='<div class="section-card"><div class="section-card-body no-pad"><table class="tbl"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Detail</th></tr></thead><tbody id="auditTbody">';
  if(!filtered.length)html+='<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">No matching entries</td></tr>';
  else filtered.forEach(e=>{html+=renderAuditRow(e)});
  html+='</tbody></table></div></div>';

  // Pagination
  html+='<div class="pagination"><div class="pagination-info">Page '+state.auditPage+(state.auditSearch||state.auditActionFilter!=='all'?' ('+filtered.length+' of '+state.auditCache.length+' shown)':'')+'</div><div class="pagination-btns">';
  html+='<button class="page-btn" '+(state.auditPage<=1?'disabled':'')+' data-action="turnAuditPage" data-args="[-1]">&lt;</button>';
  html+='<button class="page-btn active">'+state.auditPage+'</button>';
  html+='<button class="page-btn" '+(hasMore?'':'disabled')+' data-action="turnAuditPage" data-args="[1]">&gt;</button>';
  html+='</div></div>';
  return html;
}

// Audit-filter predicate: action dropdown plus the free-text search, applied to
// the fetched page. Shared by renderAudit, refilterAudit, copyAuditLog and
// exportAuditCSV so the four stay in step.
function auditFiltered(){
  return state.auditCache.filter(e=>{
    if(state.auditActionFilter!=='all'&&e.action!==state.auditActionFilter)return false;
    if(state.auditSearch){const s=state.auditSearch.toLowerCase();
      if(!(e.actor_name||String(e.actor_id)||'').toLowerCase().includes(s)&&!(e.action||'').toLowerCase().includes(s)&&!(e.target_type||'').toLowerCase().includes(s)&&!(e.detail||'').toLowerCase().includes(s))return false}
    return true;
  });
}

function renderAuditRow(e){
  return'<tr><td style="font-size:12px;color:var(--text-muted);white-space:nowrap">'+fmtLocal(e.created_at)+'</td>'
    +'<td><strong>'+esc(e.actor_name||e.actor_id)+'</strong></td>'
    +'<td><span class="badge '+actionBadge(e.action)+'">'+esc(e.action)+'</span></td>'
    +'<td>'+esc(e.target_type)+(e.target_id?' #'+e.target_id:'')+'</td>'
    +'<td style="font-size:12px;color:var(--text-muted)">'+esc(e.detail)+'</td></tr>';
}

function refilterAudit(){
  const tbody=document.getElementById('auditTbody');if(!tbody)return;
  const filtered=auditFiltered();
  if(!filtered.length)tbody.innerHTML='<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">No matching entries</td></tr>';
  else tbody.innerHTML=filtered.map(renderAuditRow).join('');
}

function copyAuditLog(){
  const filtered=auditFiltered();
  const lines=filtered.map(e=>(e.created_at||'')+'\t'+(e.actor_name||e.actor_id)+'\t'+(e.action||'')+'\t'+(e.target_type||'')+(e.target_id?' #'+e.target_id:'')+'\t'+(e.detail||''));
  navigator.clipboard.writeText(lines.join('\n')).then(()=>showToast('Copied '+lines.length+' entries','info')).catch(()=>showToast('Copy failed','error'));
}

function exportAuditCSV(){
  const filtered=auditFiltered();
  const csvQ=v=>'"'+String(v||'').replace(/"/g,'""')+'"';
  let csv='Time,Actor,Action,Target,Detail\n';
  filtered.forEach(e=>{csv+=csvQ(e.created_at)+','+csvQ(e.actor_name||e.actor_id)+','+csvQ(e.action)+','+csvQ((e.target_type||'')+(e.target_id?' #'+e.target_id:''))+','+csvQ(e.detail)+'\n'});
  const blob=new Blob([csv],{type:'text/csv'});const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='audit_log_'+new Date().toISOString().slice(0,10)+'.csv';a.click();
  URL.revokeObjectURL(url);showToast('Exported '+filtered.length+' entries','info');
}

/* ═══ Server Logs ═══ */
function renderLogs(){
  const lvlBtn=(l)=>{const on=state.logLevels[l];return'<button class="level-toggle '+(on?'active-'+l.toLowerCase():'')+'" data-action="toggleLogLevel" data-args="'+actArgs(l)+'">'+l+'</button>'};
  let html='<div class="page-title">Server Logs</div><div class="page-desc">Real-time structured log stream</div>';
  html+='<div class="log-toolbar">';
  html+=lvlBtn('DEBUG')+lvlBtn('INFO')+lvlBtn('WARN')+lvlBtn('ERROR');
  html+='<input class="filter-search" aria-label="Filter logs" placeholder="Filter logs..." style="flex:1;min-width:150px" value="'+esc(state.logSearch)+'" data-input-action="setLogSearch">';
  html+='<button class="btn btn-ghost" data-action="toggleLogAutoScroll" id="autoScrollBtn" title="Auto-scroll">'+(state.logAutoScroll?'⬇ Auto':'⏸ Manual')+'</button>';
  html+='<button class="btn btn-ghost" data-action="toggleLogPause" id="pauseBtn">'+(state.logPaused?'▶ Resume':'⏸ Pause')+'</button>';
  html+='<button class="btn btn-ghost" data-action="copyAllLogs" title="Copy visible logs">Copy All</button>';
  html+='<button class="btn btn-ghost" data-action="clearLogs" title="Clear log view">Clear</button>';
  html+='</div>';
  html+='<div class="log-output" id="logOutput"></div>';
  html+='<div class="log-status"><span class="'+(state.logPaused?'dot-off':'dot-live')+'" id="logDot"></span><span id="logStatusText">'+(state.logPaused?'Paused':'Connecting...')+'</span><span style="margin-left:auto" id="logCount">'+state.logEntries.length+' entries</span></div>';
  setTimeout(()=>{renderLogLines();if(!state.logPaused)connectLogStream()},0);
  return html;
}

function toggleLogLevel(l){state.logLevels[l]=!state.logLevels[l];const btns=document.querySelectorAll('.level-toggle');btns.forEach(b=>{if(b.textContent===l){b.className='level-toggle '+(state.logLevels[l]?'active-'+l.toLowerCase():'')}});renderLogLines()}

function toggleLogAutoScroll(){state.logAutoScroll=!state.logAutoScroll;const btn=document.getElementById('autoScrollBtn');if(btn)btn.textContent=state.logAutoScroll?'⬇ Auto':'⏸ Manual'}

function toggleLogPause(){
  state.logPaused=!state.logPaused;
  const btn=document.getElementById('pauseBtn');if(btn)btn.textContent=state.logPaused?'▶ Resume':'⏸ Pause';
  const dot=document.getElementById('logDot');if(dot)dot.className=state.logPaused?'dot-off':'dot-live';
  const txt=document.getElementById('logStatusText');
  if(state.logPaused){state.logConnectSeq++;if(state.logEventSource){state.logEventSource.close();state.logEventSource=null}if(state.logReconnectTimer){clearTimeout(state.logReconnectTimer);state.logReconnectTimer=null}if(txt)txt.textContent='Paused'}
  else{connectLogStream()}
}

function scheduleLogReconnect(){
  if(state.logPaused||state.section!=='logs'||state.logReconnectTimer)return;
  state.logReconnectTimer=setTimeout(function(){state.logReconnectTimer=null;connectLogStream()},1500);
}

async function connectLogStream(){
  if(state.logReconnectTimer){clearTimeout(state.logReconnectTimer);state.logReconnectTimer=null}
  if(state.logEventSource){state.logEventSource.close();state.logEventSource=null}
  if(state.logPaused||state.section!=='logs')return;
  const connectSeq=++state.logConnectSeq;
  let ticket;
  try{const res=await api('POST','/logs/ticket');ticket=res.ticket}catch(err){const t=document.getElementById('logStatusText');const d=document.getElementById('logDot');const msg=(err&&err.message)||'';if(/authorization|invalid or expired session|session has expired|missing or invalid|administrator permission required/i.test(msg)){state.logPaused=true;state.logConnectSeq++;if(state.logReconnectTimer){clearTimeout(state.logReconnectTimer);state.logReconnectTimer=null}if(state.logEventSource){state.logEventSource.close();state.logEventSource=null}state.token='';localStorage.removeItem('admin_token');if(t)t.textContent='Session expired';if(d)d.className='dot-off';showOverlay('loginOverlay');return}if(t)t.textContent='Reconnect failed';if(d)d.className='dot-off';scheduleLogReconnect();return}
  if(connectSeq!==state.logConnectSeq||state.logPaused||state.section!=='logs')return;
  /* The server replays its whole ring-buffer backfill to every new
     subscriber with no event ids, so a (re)connect must replace the buffered
     view, not append to it — otherwise a reconnect (tab re-entry, an SSE
     error) duplicates every backfilled line still held from the last
     connection. The replay is always a superset of anything already held
     (ring capacity == state.logMaxLines), so nothing is lost by clearing.

     Clear only once the REPLACEMENT stream is actually live, not here: a
     failed connect retries every 1.5s, and clearing up front blanked the
     operator's log view on every retry and kept it blank for as long as the
     server stayed unreachable. Either sign of life will do — onopen, or a
     first delivered line if no open event fires — and the flag makes it
     happen exactly once per connection. */
  let bufferReplaced=false;
  const replaceBufferOnce=function(){
    if(bufferReplaced)return;
    bufferReplaced=true;
    state.logEntries=[];renderLogLines();
    const c0=document.getElementById('logCount');if(c0)c0.textContent='0 entries';
  };
  const es=new EventSource('/admin/api/logs/stream?ticket='+encodeURIComponent(ticket));
  state.logEventSource=es;
  es.onopen=function(){replaceBufferOnce();const t=document.getElementById('logStatusText');if(t)t.textContent='Connected'};
  es.onmessage=function(e){
    try{const entry=JSON.parse(e.data);replaceBufferOnce();state.logEntries.push(entry);
      while(state.logEntries.length>state.logMaxLines)state.logEntries.shift();
      appendLogLine(entry);
      const c=document.getElementById('logCount');if(c)c.textContent=state.logEntries.length+' entries';
    }catch(err){}
  };
  es.onerror=function(){if(state.logEventSource===es){state.logEventSource.close();state.logEventSource=null}const t=document.getElementById('logStatusText');if(t)t.textContent='Reconnecting...';const d=document.getElementById('logDot');if(d)d.className='dot-off';scheduleLogReconnect()};
}

function matchesLogFilter(entry){
  if(!state.logLevels[entry.level])return false;
  if(state.logSearch){const s=state.logSearch.toLowerCase();if(!(entry.msg||'').toLowerCase().includes(s)&&!(entry.source||'').toLowerCase().includes(s)&&!(entry.attrs||'').toLowerCase().includes(s))return false}
  return true;
}

function appendLogLine(entry){
  if(!matchesLogFilter(entry))return;
  const out=document.getElementById('logOutput');if(!out)return;
  const div=document.createElement('div');
  div.className='log-line l-'+entry.level.toLowerCase();
  const ts=entry.ts?entry.ts.substring(11,23):'';
  div.innerHTML='<span class="log-ts">'+esc(ts)+'</span><span class="log-lvl">'+esc(entry.level)+'</span><span class="log-src">['+esc(entry.source||'server')+']</span>'+esc(entry.msg)+(entry.attrs&&entry.attrs!=='{}'?' <span style="color:var(--text-muted)">'+esc(entry.attrs)+'</span>':'');
  out.appendChild(div);
  // Trim DOM to max lines
  while(out.children.length>state.logMaxLines)out.removeChild(out.firstChild);
  if(state.logAutoScroll)out.scrollTop=out.scrollHeight;
}

function renderLogLines(){
  const out=document.getElementById('logOutput');if(!out)return;
  out.innerHTML='';
  state.logEntries.forEach(e=>{if(matchesLogFilter(e))appendLogLine(e)});
}

function copyAllLogs(){
  const out=document.getElementById('logOutput');if(!out)return;
  const lines=[];state.logEntries.forEach(e=>{if(matchesLogFilter(e))lines.push((e.ts||'')+' '+e.level+' ['+( e.source||'server')+'] '+e.msg+(e.attrs&&e.attrs!=='{}'?' '+e.attrs:''))});
  navigator.clipboard.writeText(lines.join('\n')).then(()=>showToast('Copied '+lines.length+' log lines','info')).catch(()=>showToast('Copy failed','error'));
}

function clearLogs(){state.logEntries=[];const out=document.getElementById('logOutput');if(out)out.innerHTML='';const c=document.getElementById('logCount');if(c)c.textContent='0 entries';showToast('Log view cleared','info')}

/* ═══ API Tokens ═══ */
function tokenStatus(t){
  if(t.revoked_at)return'<span class="badge badge-red">Revoked</span>';
  if(t.expires_at&&utcDate(t.expires_at)<new Date())return'<span class="badge badge-yellow">Expired</span>';
  return'<span class="badge badge-green">Active</span>';
}
async function renderTokens(){
  let tokens;
  try{tokens=await api('GET','/tokens')}catch(e){return'<div class="page-title">API Tokens</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  let html='<div class="page-title">API Tokens</div><div class="page-desc">Long-lived bearer tokens for bots, CI, and the introspection MCP tool. A token authenticates as its bound user. Owner only.</div>';
  html+='<div style="margin-bottom:16px"><button class="btn btn-accent" data-action="openCreateTokenModal">'+I.plus+' Create Token</button></div>';
  html+='<div class="section-card"><div class="section-card-header"><h3>Tokens</h3></div><div class="section-card-body no-pad"><table class="tbl"><thead><tr><th>Label</th><th>User</th><th>Created</th><th>Last Used</th><th>Expires</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>';
  if(!tokens||!tokens.length)html+='<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px">No API tokens</td></tr>';
  else tokens.forEach(t=>{
    const revoked=!!t.revoked_at;
    html+='<tr><td>'+esc(t.label||'—')+'</td><td>'+esc(t.username)+'</td>';
    html+='<td>'+(t.created_at?utcDate(t.created_at).toLocaleString():'')+'</td>';
    html+='<td>'+(t.last_used?utcDate(t.last_used).toLocaleString():'<span style="color:var(--text-muted)">never</span>')+'</td>';
    html+='<td>'+(t.expires_at?utcDate(t.expires_at).toLocaleString():'<span style="color:var(--text-muted)">never</span>')+'</td>';
    html+='<td>'+tokenStatus(t)+'</td>';
    html+='<td><div class="act-group" style="justify-content:flex-end">'+(revoked?'':'<button class="act-btn danger" title="Revoke" aria-label="Revoke" data-action="confirmRevokeToken" data-args="'+actArgs(t.id,t.label)+'">'+I.trash+'</button>')+'</div></td></tr>';
  });
  html+='</tbody></table></div></div>';
  return html;
}

function openCreateTokenModal(){
  openModal('<div class="modal-header"><h3>Create API Token</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'+
    '<div class="modal-body"><div class="form-group"><label class="form-label" for="tokLabel">Label</label><input id="tokLabel" class="form-input" placeholder="ci-bot" autofocus></div>'+
    '<div class="form-group"><label class="form-label" for="tokUser">User <span style="color:var(--text-muted)">(optional)</span></label><input id="tokUser" class="form-input" placeholder="owner (default)"></div>'+
    '<div class="form-group"><label class="form-label" for="tokExpires">Expires in hours <span style="color:var(--text-muted)">(0 = never)</span></label><input id="tokExpires" class="form-input" type="number" min="0" value="0"></div></div>'+
    '<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-accent" data-action="createToken">Create</button></div>');
}

async function createToken(){
  const label=document.getElementById('tokLabel').value.trim();
  const user=document.getElementById('tokUser').value.trim();
  const expires=parseInt(document.getElementById('tokExpires').value,10)||0;
  if(!label){showToast('Label is required','error');return}
  try{
    const d=await api('POST','/tokens',{label,username:user,expires_hours:expires});
    showTokenOnceModal(d);
  }catch(e){showToast(e.message,'error')}
}

// The raw token is shown exactly once here — it is never recoverable afterward.
function showTokenOnceModal(d){
  openModal('<div class="modal-header"><h3>Token Created</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModalAndRefresh">&times;</button></div>'+
    '<div class="modal-body"><p style="color:var(--text-muted)">Store this token now — it is shown only once and cannot be recovered. Bound to <strong style="color:var(--text-normal)">'+esc(d.user)+'</strong>.</p>'+
    '<div style="display:flex;gap:8px;margin-top:12px"><code style="flex:1;font-family:var(--font-mono);font-size:12px;background:var(--bg-active);padding:10px;border-radius:var(--radius-sm);word-break:break-all">'+esc(d.token)+'</code>'+
    '<button class="btn btn-ghost" data-action="copyToken" data-args="'+actArgs(d.token)+'">Copy</button></div></div>'+
    '<div class="modal-footer"><button class="btn btn-accent" data-action="closeModalAndRefresh">Done</button></div>');
}
function copyToken(t){navigator.clipboard.writeText(t).then(()=>showToast('Copied!','info')).catch(()=>showToast('Copy failed — select the token and copy it manually','error'))}

function confirmRevokeToken(id,label){
  openModal('<div class="modal-header"><h3>Revoke Token</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><p style="color:var(--text-muted)">Revoke <strong style="color:var(--text-normal)">'+esc(label||('#'+id))+'</strong>? Any client using it will immediately lose access. This cannot be undone.</p></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="revokeToken" data-args="'+actArgs(id)+'">Revoke</button></div>');
}
async function revokeToken(id){
  try{await api('DELETE','/tokens/'+id);closeModal();showToast('Token revoked');renderContent()}catch(e){showToast(e.message,'error')}
}

/* ═══ Plugins ═══ */
/* The plugin lifecycle API lives under /api/v1/admin/plugins (same admin auth
   and IP gate, different prefix), so it needs its own fetch helper rather than
   api(). Errors come back as plain text from http.Error, not JSON. */
async function pluginApi(method,path,opts){
  const init={method,headers:{'Authorization':'Bearer '+state.token}};
  if(opts&&opts.body!==undefined)init.body=opts.body;
  const res=await fetch('/api/v1/admin/plugins'+path,init);
  if(res.status===401){handleSessionExpired();throw new Error('Your session expired — sign in again.')}
  if(res.status===204)return{data:null,res};
  const text=await res.text();
  let data=null;
  if(text){try{data=JSON.parse(text)}catch(e){data=null}}
  if(!res.ok){
    const msg=(data&&(data.message||data.error))||text.trim()||res.statusText;
    throw new Error(msg);
  }
  return{data,res};
}

function pluginManifestSummary(row){
  const raw=row.manifest_json||row.ManifestJSON||'';
  if(!raw)return'';
  try{
    const m=JSON.parse(raw);
    const bits=[];
    if(m.description)bits.push(m.description);
    if(Array.isArray(m.permissions)&&m.permissions.length)bits.push('permissions: '+m.permissions.join(', '));
    return bits.join(' — ');
  }catch(e){return''}
}

async function renderPlugins(){
  let rows;
  try{
    const out=await pluginApi('GET','/');
    rows=out.data||[];
    state.pluginRuntime=out.res.headers.get('X-Plugin-Runtime')||'unknown';
  }catch(e){
    return'<div class="page-title">Plugins</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p><button class="btn btn-accent" data-action="renderContent">Retry</button>';
  }

  const disabled=state.pluginRuntime==='disabled';
  let html='<div class="page-title">Plugins</div><div class="page-desc">Install and manage server plugins</div>';

  if(disabled){
    html+='<div class="section-card" style="border-color:var(--yellow)"><div class="section-card-body"><strong style="color:var(--text-warning)">Plugin runtime is disabled on this server.</strong><div style="color:var(--text-muted);font-size:13px;margin-top:4px">Installed plugins are listed below but cannot be installed, enabled, or removed until the runtime is turned on in the server configuration.</div></div></div>';
  }else{
    html+='<div class="section-card"><div class="section-card-header"><h3>Install Plugin</h3></div><div class="section-card-body">';
    html+='<div style="color:var(--text-muted);font-size:13px;margin-bottom:10px">Upload a plugin package (.zip, max 16 MB) containing a plugin.json manifest at its root.</div>';
    html+='<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
    html+='<input type="file" id="pluginFile" aria-label="Plugin package (.zip)" accept=".zip,application/zip" class="form-input" style="max-width:320px;padding:8px" data-change-action="pluginFileChosen">';
    html+='<button class="btn btn-accent" id="pluginInstallBtn" disabled data-action="installPlugin">'+I.upload+' Install</button>';
    html+='</div></div></div>';
  }

  html+='<div class="section-card"><div class="section-card-header"><h3>Installed</h3><button class="btn btn-ghost" data-action="renderContent">'+I.refresh+' Refresh</button></div><div class="section-card-body no-pad">';
  html+='<table class="tbl"><thead><tr><th>Plugin</th><th>Version</th><th>Status</th><th>Installed</th><th style="text-align:right">Actions</th></tr></thead><tbody>';
  if(!rows.length){
    const empty=disabled?'No plugins installed — and the runtime is off':'No plugins installed yet';
    html+='<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">'+empty+'</td></tr>';
  }else rows.forEach(row=>{
    const id=row.id!==undefined?row.id:row.ID;
    const name=row.name||row.Name||'';
    const version=row.version||row.Version||'';
    const enabled=row.enabled!==undefined?row.enabled:row.Enabled;
    const installed=row.installed_at||row.InstalledAt||'';
    const summary=pluginManifestSummary(row);
    html+='<tr><td><div><strong>'+esc(name)+'</strong>'+(summary?'<div style="font-size:12px;color:var(--text-muted);margin-top:2px">'+esc(summary)+'</div>':'')+'</div></td>';
    html+='<td style="font-family:var(--font-mono);font-size:12px">'+esc(version||'—')+'</td>';
    html+='<td>'+(enabled?'<span class="badge badge-green">Enabled</span>':'<span class="badge badge-muted">Disabled</span>')+'</td>';
    html+='<td style="font-size:12px;color:var(--text-muted)">'+(installed?new Date(installed).toLocaleString():'')+'</td>';
    html+='<td><div class="act-group" style="justify-content:flex-end">';
    if(disabled){
      html+='<span style="font-size:12px;color:var(--text-muted)">runtime off</span>';
    }else{
      html+='<button class="btn btn-ghost" data-action="setPluginEnabled" data-args="'+actArgs(id,!enabled)+'">'+(enabled?'Disable':'Enable')+'</button>';
      html+='<button class="act-btn danger" title="Uninstall" aria-label="Uninstall" data-action="openUninstallPlugin" data-args="'+actArgs(id,name)+'">'+I.trash+'</button>';
    }
    html+='</div></td></tr>';
  });
  html+='</tbody></table></div></div>';
  return html;
}

async function installPlugin(){
  const input=document.getElementById('pluginFile');
  const btn=document.getElementById('pluginInstallBtn');
  const file=input&&input.files&&input.files[0];
  if(!file){showToast('Choose a .zip package first','error');return}
  if(state.pluginBusy)return;
  state.pluginBusy=true;
  if(btn){btn.disabled=true;btn.textContent='Installing...'}
  const fd=new FormData();
  fd.append('plugin',file);
  try{
    // No explicit Content-Type: the browser must set the multipart boundary.
    const out=await pluginApi('POST','/install',{body:fd});
    const name=(out.data&&out.data.name)||file.name;
    showToast('Installed '+name);
    state.pluginBusy=false;
    renderContent();
  }catch(e){
    state.pluginBusy=false;
    showToast(e.message,'error');
    if(btn){btn.disabled=false;btn.textContent='Install'}
  }
}

async function setPluginEnabled(id,enable){
  if(state.pluginBusy)return;
  state.pluginBusy=true;
  try{
    await pluginApi('POST','/'+id+'/'+(enable?'enable':'disable'));
    showToast(enable?'Plugin enabled':'Plugin disabled');
  }catch(e){showToast(e.message,'error')}
  state.pluginBusy=false;
  renderContent();
}

function openUninstallPlugin(id,name){
  openModal('<div class="modal-header"><h3>Uninstall Plugin</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><p style="color:var(--text-muted)">Remove <strong style="color:var(--text-normal)">'+esc(name)+'</strong> and its files from the server? Any data it stored is discarded. This cannot be undone.</p></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="uninstallPlugin" data-args="'+actArgs(id)+'">Uninstall</button></div>');
}

async function uninstallPlugin(id){
  if(state.pluginBusy)return;
  state.pluginBusy=true;
  try{
    await pluginApi('DELETE','/'+id);
    closeModal();
    showToast('Plugin uninstalled');
  }catch(e){showToast(e.message,'error')}
  state.pluginBusy=false;
  renderContent();
}

Object.assign(ACTIONS,{clearLogs,confirmRevokeToken,copyAllLogs,copyAuditLog,copyToken,createToken,
  discardSupportBundle,downloadSupportBundle,exportAuditCSV,installPlugin,openCreateTokenModal,openUninstallPlugin,
  previewSupportBundle,revokeToken,setPluginEnabled,toggleLogAutoScroll,toggleLogLevel,toggleLogPause,uninstallPlugin,
  turnAuditPage(delta){state.auditPage+=delta;renderContent()},
  setAuditSearch(){state.auditSearch=this.value;refilterAudit()},
  setAuditActionFilter(){state.auditActionFilter=this.value;refilterAudit()},
  setLogSearch(){state.logSearch=this.value;renderLogLines()},
  pluginFileChosen(){document.getElementById('pluginInstallBtn').disabled=!this.files.length}});
