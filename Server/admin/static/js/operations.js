/* OwnCord admin panel: Diagnostics, the Dashboard and its attention panel,
   Audit Log, Server Logs, API Tokens and Plugins. */

/* Icons these pages need that the shared set (core.js I) lacks. The log
   toolbar used Unicode glyphs before, and "⏸" renders as a missing-glyph box
   in Linux Chromium. */
const OPS_ICON={
  pause:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>',
  play:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="6 3 20 12 6 21 6 3"/></svg>',
  copy:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
};

/* Support bundles remain local until the administrator chooses to share the
   downloaded file. The server freezes the preview; confirmation sends its ID
   and hash, and cannot regenerate different content under an old preview. */
/* What a bundle carries and what it never does, shown before the operator
   asks for one. The server's redaction rules are the authority; this is the
   summary of them. */
const SUPPORT_INCLUDED=['Versions and selected settings','Database counts','Server health metrics','A recent event timeline'];
const SUPPORT_EXCLUDED=['Message contents','Credentials and tokens','Addresses','Raw logs'];
function renderDiagnostics(){
  const busy=state.supportBusy?' disabled':'';
  const list=items=>'<ul class="support-list">'+items.map(i=>'<li>'+esc(i)+'</li>').join('')+'</ul>';
  let html='<div class="page-title">Diagnostics</div><div class="page-desc">Create a support bundle to investigate server problems. Nothing is uploaded: you review the archive, download it and decide who sees it.</div>';
  html+='<div class="section-card"><div class="section-card-header"><h3>Support bundle</h3></div><div class="section-card-body">'
    +'<div class="support-scope"><div><h4>Included</h4>'+list(SUPPORT_INCLUDED)+'</div><div><h4>Never included</h4>'+list(SUPPORT_EXCLUDED)+'</div></div>'
    +'<p class="support-note">Client media connectivity is not tested.</p>'
    +'<button class="btn btn-accent" data-action="previewSupportBundle"'+busy+'>'+(state.supportBusy?'Preparing…':'Create support bundle preview')+'</button></div></div>';
  const p=state.supportPreview;if(!p)return html;
  html+='<div class="section-card" id="support-preview"><div class="section-card-header"><h3>Review before download</h3></div><div class="section-card-body">'
    +'<dl class="facts"><dt>Archive size</dt><dd><strong>'+p.byte_size+' bytes</strong> ('+fmtBytes(p.byte_size)+')</dd>'
    +'<dt>SHA-256</dt><dd><code class="hash">'+esc(p.sha256)+'</code></dd>'
    +'<dt>Preview expires</dt><dd>'+fmtLocal(p.expires_at)+'</dd></dl></div>'
    +'<div class="section-card-body no-pad"><table class="tbl"><thead><tr><th>Item</th><th class="num">Bytes</th><th>SHA-256</th></tr></thead><tbody>';
  p.items.forEach(item=>{html+='<tr><td><code>'+esc(item.name)+'</code></td><td class="num">'+item.byte_size+'</td><td><code class="hash">'+esc(item.sha256)+'</code></td></tr>'});
  html+='</tbody></table></div><div class="section-card-body"><h4 class="support-heading">Redaction report</h4><ul class="redaction-list">';
  p.redactions.forEach(rule=>{html+='<li><div class="redaction-rule"><code>'+esc(rule.item)+'</code><span>'+esc(rule.rule)+'</span></div><p>'+esc(rule.omitted)+'</p></li>'});
  html+='</ul><p class="support-note">Review the downloaded file before sharing it with someone helping you.</p>'
    +'<div class="support-actions"><button class="btn btn-ghost" data-action="discardSupportBundle"'+busy+'>Discard preview</button><button class="btn btn-accent" id="support-confirm" data-action="downloadSupportBundle"'+busy+'>Confirm download</button></div></div></div>';
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
   and is never drawn or counted as healthy.
   The dashboard answers "is anything wrong?" first: one headline, a card per
   active warning, and every signal in a disclosure that starts open only when
   a warning is active or a signal is a warning or critical; unknown alone
   shows as a grey "not measured" chip. The disclosures never touch the
   #section hash. */
const ATTN_STATUS={ok:['badge-green','Healthy'],warning:['badge-yellow','Warning'],critical:['badge-red','Critical'],unknown:['badge-muted','Unknown']};
function attnBadge(s){const b=ATTN_STATUS[s]||ATTN_STATUS.unknown;return'<span class="badge '+b[0]+'">'+b[1]+'</span>'}
const ATTN_TIME=new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'});
function attnWord(s){return(ATTN_STATUS[s]||ATTN_STATUS.unknown)[1]}
function plural(n,one,many){return n+' '+(n===1?one:many)}
function disclosure(summary,body,open,cls){return'<details class="disclose'+(cls?' '+cls:'')+'"'+(open?' open':'')+'><summary>'+I.chevronRight+summary+'</summary>'+body+'</details>'}
/* Counts per status; anything the server did not name as ok, warning or
   critical is unknown. */
function attnCounts(signals){
  const c={ok:0,warning:0,critical:0,unknown:0};
  signals.forEach(g=>{c[ATTN_STATUS[g.status]?g.status:'unknown']++});
  return c;
}
function attnWorst(c){return c.critical?'critical':c.warning?'warning':c.unknown?'unknown':'ok'}
function attnWarningCard(w){
  const rec=!!w.recovered_at;
  return'<div class="attn-card attn-warning '+(rec?'ok':w.severity==='critical'?'crit':'warn')+'" data-id="'+esc(w.id)+'">'+statusIcon(rec?'ok':w.severity)+'<div class="attn-body">'
    +'<h4>'+(rec?'<span class="badge badge-green">Recovered</span>':attnBadge(w.severity))+' <strong>'+esc(w.title)+'</strong></h4>'
    +(w.action?'<p class="attn-next"><b>What to do:</b> <span class="attn-action">'+esc(w.action)+'</span></p>':'')
    +'<div class="attn-meta"><span>First seen '+fmtLocal(w.first_observed)+' · last seen '+fmtLocal(w.last_observed)
    +(w.occurrences>1?' · '+w.occurrences+' occurrences':'')+(rec?' · recovered '+fmtLocal(w.recovered_at):'')+'</span>'
    +(w.detail?disclosure('Technical detail','<div class="attn-tech">'+esc(w.detail)+'</div>'):'')+'</div></div></div>';
}
/* One signal's plain value; the threshold and learning-period text stay in
   the tooltip, and a non-healthy signal also shows its detail. */
function attnSignalText(g){
  const val=g.value||g.detail||'';
  const more=g.status!=='ok'&&g.value&&g.detail?g.detail:'';
  return{val,more,title:[g.value,g.threshold,g.detail].filter(Boolean).join(' · ')};
}
function renderChecks(signals,counts,active){
  const jobs=signals.filter(g=>String(g.id).startsWith('job:')),services=signals.filter(g=>!String(g.id).startsWith('job:'));
  const sum=[plural(signals.length,'check','checks')];
  if(counts.critical)sum.push(counts.critical+' critical');
  if(counts.warning)sum.push(plural(counts.warning,'warning','warnings'));
  if(counts.unknown)sum.push(counts.unknown+' not measured');
  let body='<div class="check-group">';
  if(services.length){
    body+='<div class="check-group-title">Services</div><div class="check-grid">';
    services.forEach(g=>{const t=attnSignalText(g);
      body+='<div class="check-tile" data-signal="'+esc(g.id)+'" title="'+esc(t.title)+'">'+statusIcon(g.status)+'<div><div class="lbl">'+esc(g.label)+'<span class="sr-only"> — <span class="st-word">'+attnWord(g.status)+'</span></span></div>'
        +(t.val?'<div class="val">'+esc(t.val)+'</div>':'')+(t.more?'<div class="val">'+esc(t.more)+'</div>':'')+'</div></div>'});
    body+='</div>';
  }
  if(jobs.length){
    const jc=attnCounts(jobs);
    const jobState=jc.critical+jc.warning?plural(jc.critical+jc.warning,'job is failing','jobs are failing')
      :jc.unknown===jobs.length?'None has run yet':jc.unknown?(jc.ok+' ran on schedule · '+jc.unknown+' not run yet'):'All ran on schedule';
    let list='<ul class="job-list">';
    jobs.forEach(g=>{const t=attnSignalText(g);
      list+='<li data-signal="'+esc(g.id)+'" title="'+esc(t.title)+'">'+statusIcon(g.status)+'<span>'+esc(String(g.label).replace(/^Maintenance: /,''))+'<span class="sr-only"> — <span class="st-word">'+attnWord(g.status)+'</span></span>'
        +(g.status==='warning'||g.status==='critical'?'<span class="val"> · '+esc(t.val)+'</span>':'')+'</span></li>'});
    body+='<div class="check-group-title">Background maintenance</div>'
      +disclosure(statusIcon(attnWorst(jc))+'<span class="lbl">'+plural(jobs.length,'maintenance job','maintenance jobs')+'</span><span class="val">'+jobState+'</span>',list+'</ul>',jc.critical+jc.warning>0,'check-jobs');
  }
  body+='</div>';
  return'<details class="section-card checks disclose" id="healthChecks"'+(counts.critical+counts.warning||active.length?' open':'')+'><summary class="section-card-header">'+I.chevronRight+'<h3>All health checks</h3><span class="checks-sum">'+sum.join(' · ')+'</span></summary>'+body+'</details>';
}
/* The headline, the active and recently recovered warnings (#attentionPanel),
   and the all-checks disclosure, returned apart so the dashboard can put the
   stat cards between them. */
function renderAttention(rep){
  const warnings=(rep&&rep.warnings)||[],signals=(rep&&rep.signals)||[];
  const active=warnings.filter(w=>!w.recovered_at),recovered=warnings.filter(w=>w.recovered_at);
  const counts=attnCounts(signals);
  let tone,title,cls;
  if(!rep||!rep.evaluated_at){tone='unknown';cls='attn-pending';title='Waiting for the first health check'}
  else if(active.length){tone=active.some(w=>w.severity==='critical')?'critical':'warning';cls='attn-problems';title=active.length===1?'1 problem needs your attention':active.length+' problems need your attention'}
  else{tone='ok';cls='attn-none';title='Everything is running normally'}
  const sub=rep&&rep.evaluated_at?'Checked '+fmtLocal(rep.evaluated_at,ATTN_TIME)+' · the server checks every minute':'The server checks its health once a minute after it starts.';
  const chips=[['critical','critical','critical'],['warning','warning','warnings'],['ok','healthy','healthy'],['unknown','not measured','not measured']]
    .filter(k=>counts[k[0]]).map(k=>'<span class="count-chip">'+statusIcon(k[0])+plural(counts[k[0]],k[1],k[2])+'</span>').join('');
  let head='<section id="attentionPanel" aria-labelledby="attnTitle"><div class="health-hero '+({ok:'ok',warning:'warn',critical:'crit',unknown:'pending'})[tone]+'">'
    +'<div class="health-hero-icon">'+statusIcon(tone)+'</div><div class="health-hero-text"><h2 class="health-hero-title '+cls+'" id="attnTitle">'+title+'</h2><div class="health-hero-sub">'+sub+'</div></div>'
    +'<div class="health-hero-counts">'+(chips?'<span class="sr-only">Health checks: </span>'+chips:'')+'<button class="btn btn-ghost" data-action="renderContent">'+I.refresh+'Refresh</button></div></div>';
  active.forEach(w=>{head+=attnWarningCard(w)});
  if(recovered.length)head+=disclosure('Recently recovered ('+recovered.length+')',recovered.map(attnWarningCard).join(''),false,'attn-recovered');
  head+='</section>';
  return{head,checks:signals.length?renderChecks(signals,counts,active):''};
}

/* ═══ Dashboard ═══ */
async function renderDashboard(){
  try{state.cachedStats=await api('GET','/stats')}catch(e){return'<div class="page-title">Dashboard</div><p style="color:var(--text-danger)">Failed to load stats: '+esc(e.message)+'</p>'}
  /* Update checks are owner-only; skip the call for everyone else instead of
     spending a guaranteed 403 on every dashboard load. */
  if(isOwner()){try{state.cachedUpdate=await api('GET','/updates')}catch(e){/* the strip is optional; the Updates page reports the failure */}}
  const s=state.cachedStats;const u=state.cachedUpdate;
  let html='<div class="page-title">Dashboard</div><div class="page-desc">How your server is doing right now</div>';
  /* Attention is server health detail: ADMINISTRATOR, like the route. */
  let checks='';
  if(can(PERM.ADMINISTRATOR)){
    try{const a=renderAttention(await api('GET','/attention'));html+=a.head;checks=a.checks}
    catch(e){html+='<section id="attentionPanel" class="section-card"><div class="section-card-body"><p style="color:var(--text-danger)">Could not load attention state: '+esc(e.message)+'</p><button class="btn btn-ghost" data-action="renderContent">Retry</button></div></section>'}
  }
  if(u&&u.update_available)html+='<div class="update-strip">'+I.updates+'<span><strong>'+esc(u.latest)+' is available.</strong> <span class="muted">You are running '+esc(String(u.current||'').replace(/^v(?=\D)/,''))+'.</span></span><button class="btn btn-outline" data-action="navigateTo" data-args="'+actArgs('updates')+'">View update</button></div>';
  const stat=(label,value)=>'<div class="stat-card"><div class="stat-card-label">'+label+'</div><div class="stat-card-value">'+value+'</div></div>';
  html+='<div class="stat-grid compact">'+stat('Members',s.user_count||0)+stat('Messages',(s.message_count||0).toLocaleString())+stat('Channels',s.channel_count||0)+stat('Database',fmtBytes(s.db_size_bytes||0))+'</div>';
  html+=checks;
  // The certificate users compare out of band before accepting the client's
  // trust prompt (BPR-051). Shown only when the server serves a statically
  // loaded certificate (not with TLS off or ACME before its first handshake).
  // Rarely needed, so it waits behind a disclosure.
  if(s.certificate_fingerprint){
    html+='<details class="section-card disclose" id="certFingerprintCard"><summary class="section-card-header">'+I.chevronRight+'<h3>Certificate fingerprint</h3><span class="checks-sum">Show</span></summary><div class="section-card-body"><p class="card-note">Users compare this against the prompt their client shows before they accept the connection. Publish it out of band — another platform, a call. A mismatch is the one warning that means an interception attempt.</p><code class="hash">'+esc(s.certificate_fingerprint)+'</code></div></details>';
  }
  // Recent audit — VIEW_AUDIT_LOG only.
  if(can(PERM.VIEW_AUDIT_LOG))try{
    const entries=await api('GET','/audit-log?limit=5&offset=0&hide_signins=1');
    if(entries&&entries.length){
      html+='<div class="section-card"><div class="section-card-header"><h3>Recent activity</h3><button class="btn btn-ghost" data-action="navigateTo" data-args="'+actArgs('audit')+'">View all</button></div><div class="section-card-body">';
      entries.forEach(a=>{html+='<div class="act-line" data-audit-action="'+esc(a.action)+'" title="'+esc(a.action+(a.detail?' — '+a.detail:''))+'">'+auditMark(a.action)+'<span class="act-what">'+auditSentence(a)+'</span><span class="act-when">'+fmtLocal(a.created_at,auditDay(a.created_at)==='Today'?AUDIT_TIME:undefined)+'</span></div>'});
      html+='</div></div>';
    }
  }catch(e){}
  return html;
}

/* ═══ Audit Log ═══ */
/* Search (q) and the action filter run on the server, so they cover the whole
   log, not just the fetched page. Typing refetches after a short pause and
   replaces only #auditResults, so the search box keeps its focus and caret;
   auditSeq drops a response a newer request has already superseded. The
   action options are every action in the whole log, which the first page's
   X-Audit-Actions header names. */
let auditSeq=0,auditSearchTimer=null,auditActions=[];
/* Sign-in and connection rows stay hidden (on the server, so paging and
   search still cover the whole log) until the Sign-ins chip is on, or the
   action filter asks for one of them by name. */
function auditQuery(search,action){
  const q=search.trim();
  const hide=!state.auditShowSignins&&!SIGNIN_ACTIONS.includes(action);
  return(q?'&q='+encodeURIComponent(q):'')+(action!=='all'?'&action='+encodeURIComponent(action):'')+(hide?'&hide_signins=1':'');
}
/* state.auditSearch and state.auditActionFilter mirror the controls; page is
   committed to state.auditPage only once its rows arrive. */
async function loadAuditPage(page){
  const seq=++auditSeq;
  const offset=(page-1)*PAGE_SIZE;
  // Over-fetched like the Users page, so the ">" button never offers an
  // empty page at an exact multiple of PAGE_SIZE.
  const{data:entries,res}=await apiRes('GET','/audit-log?limit='+(PAGE_SIZE+1)+'&offset='+offset+auditQuery(state.auditSearch,state.auditActionFilter));
  if(seq!==auditSeq)return false;
  const actions=res.headers.get('X-Audit-Actions');
  if(actions){try{const a=JSON.parse(actions);if(Array.isArray(a))auditActions=a.filter(x=>typeof x==='string')}catch(e){}}
  state.auditPage=page;
  const hasMore=!!entries&&entries.length>PAGE_SIZE;
  state.auditHasMore=hasMore;
  state.auditCache=(entries||[]).slice(0,PAGE_SIZE);
  return true;
}

/* A filter option names the action itself, not the sentence verb, so two
   actions that share a verb ("created") stay apart: "Channel create". */
function auditActionName(a){const s=String(a).replace(/_/g,' ');return s.charAt(0).toUpperCase()+s.slice(1)}
function auditOptionsHtml(){
  // The filter is global, so a filtered action that the fetched rows do not
  // contain would leave no option `selected`: the control would read "All
  // Actions" with the filter still applied, and picking "All Actions" would
  // fire no change event because the element's value already was "all".
  // Keeping the active filter in the set makes the control and the state
  // impossible to diverge.
  const actionTypes=[...new Set(auditActions.concat(state.auditActionFilter!=='all'?[state.auditActionFilter]:[]))].sort();
  let html='<option value="all" '+(state.auditActionFilter==='all'?'selected':'')+'>All Actions</option>';
  actionTypes.forEach(t=>{html+='<option value="'+esc(t)+'" '+(state.auditActionFilter===t?'selected':'')+'>'+esc(auditActionName(t))+'</option>'});
  return html;
}

async function renderAudit(){
  try{await loadAuditPage(state.auditPage)}catch(e){return'<div class="page-title">Audit log</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p><button class="btn btn-accent" data-action="renderContent">Retry</button>'}

  let html='<div class="page-title">Audit log</div><div class="page-desc">Every administrative action, newest first. Search and the filters cover the whole log; sign-ins and connections stay hidden until you turn on Sign-ins.</div>';
  html+='<div class="filter-bar audit-filters">';
  html+='<input type="search" class="filter-search" aria-label="Search audit log" placeholder="Search action codes, names and details…" maxlength="100" value="'+esc(state.auditSearch)+'" data-input-action="setAuditSearch">';
  html+='<select class="filter-select" id="auditAction" aria-label="Filter by action" data-change-action="setAuditActionFilter">'+auditOptionsHtml()+'</select>';
  html+='<button class="chip-toggle" id="auditSignins" aria-pressed="'+state.auditShowSignins+'" data-action="toggleAuditSignins" title="Show sign-in and connection events">'+(state.auditShowSignins?I.check:'')+'Sign-ins</button>';
  html+='<button class="btn btn-ghost" data-action="copyAuditLog" title="Copy the entries on this page">'+OPS_ICON.copy+'Copy page</button>';
  html+='<button class="btn btn-ghost" data-action="exportAuditCSV" title="Export the entries on this page as CSV">'+I.download+'Export CSV</button>';
  html+='</div>';
  return html+'<div id="auditResults">'+auditResultsHtml()+'</div>';
}

function auditResultsHtml(){
  const rows=state.auditCache,filtered=!!(state.auditSearch.trim()||state.auditActionFilter!=='all');
  let html='<div class="section-card"><div class="section-card-body no-pad"><table class="tbl audit-tbl"><thead><tr><th>Time</th><th>What happened</th><th>Detail</th></tr></thead><tbody id="auditTbody">';
  if(!rows.length)html+='<tr><td colspan="3" class="tbl-empty">'+(filtered?'No entries match this search':'No audit entries yet')+(state.auditShowSignins?'':' <span class="muted">(sign-ins hidden)</span>')+'</td></tr>';
  else{
    let day='';
    rows.forEach(e=>{
      const d=auditDay(e.created_at);
      if(d!==day){day=d;html+='<tr class="audit-day"><th colspan="3" scope="colgroup">'+esc(d)+'</th></tr>'}
      html+=renderAuditRow(e);
    });
  }
  html+='</tbody></table></div></div>';
  // The count is a status message, so a screen reader hears how many entries
  // a search found without leaving the search box.
  html+='<div class="pagination"><div class="pagination-info" role="status">Page '+state.auditPage+' · '+rows.length+(filtered?' matching':'')+' entr'+(rows.length===1?'y':'ies')+'</div><div class="pagination-btns">';
  html+='<button class="page-btn" aria-label="Previous page" '+(state.auditPage<=1?'disabled':'')+' data-action="turnAuditPage" data-args="[-1]">&lt;</button>';
  html+='<span class="page-btn active" aria-current="page">'+state.auditPage+'</span>';
  html+='<button class="page-btn" aria-label="Next page" '+(state.auditHasMore?'':'disabled')+' data-action="turnAuditPage" data-args="[1]">&gt;</button>';
  return html+'</div></div>';
}

/* Rows are grouped under their local day; each row shows the time alone. */
const AUDIT_TIME=new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'});
const AUDIT_DAY=new Intl.DateTimeFormat(undefined,{weekday:'long',day:'numeric',month:'long',year:'numeric'});
function auditDay(s){
  const d=utcDate(s);if(!s||isNaN(d.getTime()))return'Unknown date';
  const day=x=>new Date(x.getFullYear(),x.getMonth(),x.getDate()).getTime();
  const diff=Math.round((day(new Date())-day(d))/86400000);
  return diff===0?'Today':diff===1?'Yesterday':AUDIT_DAY.format(d);
}
/* The coloured mark keeps actionBadge's classes (delete/ban red, create
   green, update yellow); the words carry the meaning. */
function auditMark(a){return'<span class="audit-mark '+actionBadge(a)+'" aria-hidden="true"></span>'}
function renderAuditRow(e){
  return'<tr class="audit-row" data-audit-action="'+esc(e.action)+'" title="'+esc(e.action)+'"><td class="audit-time">'+fmtLocal(e.created_at,AUDIT_TIME)+'</td>'
    +'<td class="audit-what"><div>'+auditMark(e.action)+'<span>'+auditSentence(e)+'</span></div></td>'
    +'<td class="audit-detail">'+esc(e.detail)+'</td></tr>';
}

/* Fetch a page for the current search and filter, replacing only the
   results. A failure replaces them with the error and a Retry, so no rows for
   another query stay on screen or in Copy page and Export CSV. Focus on a
   pager button stays on the same button. */
async function reloadAudit(page){
  const load=loadAuditPage(page),seq=auditSeq;
  let err=null;
  try{await load}catch(e){err=e}
  const box=document.getElementById('auditResults');
  if(seq!==auditSeq||!box||state.section!=='audit')return;
  const focused=box.contains(document.activeElement)?document.activeElement.getAttribute('data-args'):null;
  if(err){
    state.auditCache=[];
    box.innerHTML='<p role="alert" style="color:var(--text-danger)">'+esc(err.message)+'</p><button class="btn btn-accent" data-action="reloadAudit" data-args="'+actArgs(page)+'">Retry</button>';
    if(focused!==null)box.querySelector('button').focus();
    return;
  }
  box.innerHTML=auditResultsHtml();
  const select=document.getElementById('auditAction');if(select)select.innerHTML=auditOptionsHtml();
  if(focused===null)return;
  const again=box.querySelector('button.page-btn[data-args="'+focused+'"]:not([disabled])');
  (again||box.querySelector('button.page-btn:not([disabled])')||document.querySelector('.filter-search')).focus();
}

function copyAuditLog(){
  const lines=state.auditCache.map(e=>[e.created_at||'',e.actor_name||e.actor_id,e.action||'',(e.target_type||'')+(e.target_id?' #'+e.target_id:''),e.detail||''].map(formulaGuard).join('\t'));
  navigator.clipboard.writeText(lines.join('\n')).then(()=>showToast('Copied '+lines.length+' entries','info')).catch(()=>showToast('Copy failed','error'));
}

/* A leading =, +, -, @, tab or CR is prefixed with ' so spreadsheet apps
   read the cell as text, not a formula. Both the Copy page clipboard rows
   and the CSV export wrap their cells with this. */
function formulaGuard(v){
  const s=String(v??'');
  return /^[=+\-@\t\r]/.test(s)?"'"+s:s;
}

/* Quotes one formula-guarded CSV cell. */
function csvQ(v){
  return '"'+formulaGuard(v).replace(/"/g,'""')+'"';
}

function exportAuditCSV(){
  const rows=state.auditCache;
  let csv='Time,Actor,Action,Target,Detail\n';
  rows.forEach(e=>{csv+=csvQ(e.created_at)+','+csvQ(e.actor_name||e.actor_id)+','+csvQ(e.action)+','+csvQ((e.target_type||'')+(e.target_id?' #'+e.target_id:''))+','+csvQ(e.detail)+'\n'});
  const blob=new Blob([csv],{type:'text/csv'});const url=URL.createObjectURL(blob);
  const a=document.createElement('a');a.href=url;a.download='audit_log_'+new Date().toISOString().slice(0,10)+'.csv';a.click();
  URL.revokeObjectURL(url);showToast('Exported '+rows.length+' entries','info');
}

/* ═══ Server Logs ═══ */
/* Log times are the viewer's local clock to the millisecond; the tooltip
   keeps the UTC instant (fmtLocal). */
const LOG_TIME=new Intl.DateTimeFormat(undefined,{hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hourCycle:'h23'});
function pauseLabel(){return state.logPaused?OPS_ICON.play+'Resume':OPS_ICON.pause+'Pause'}

function renderLogs(){
  /* Each level chip is a toggle button: aria-pressed carries its state, and
     the filled or hollow dot shows it without relying on colour. */
  const lvlBtn=(l)=>'<button class="level-toggle lvl-'+l.toLowerCase()+'" aria-pressed="'+!!state.logLevels[l]+'" data-level="'+l+'" data-action="toggleLogLevel" data-args="'+actArgs(l)+'">'+l+'</button>';
  let html='<div class="page-title">Server logs</div><div class="page-desc">What the server is doing right now, newest at the bottom. Open the details on a line for everything it logged.</div>';
  html+='<div class="log-toolbar"><div class="log-conn"><span class="'+(state.logPaused?'dot-off':'dot-live')+'" id="logDot" aria-hidden="true"></span><span id="logStatusText" role="status">'+(state.logPaused?'Paused':'Connecting...')+'</span></div>';
  html+='<div class="level-group" role="group" aria-label="Show levels">'+lvlBtn('DEBUG')+lvlBtn('INFO')+lvlBtn('WARN')+lvlBtn('ERROR')+'</div>';
  html+='<input type="search" class="filter-search log-filter" aria-label="Filter logs" placeholder="Filter logs…" value="'+esc(state.logSearch)+'" data-input-action="setLogSearch">';
  html+='<div class="log-actions">';
  html+='<button class="btn btn-ghost" data-action="toggleLogAutoScroll" id="autoScrollBtn" aria-pressed="'+state.logAutoScroll+'" title="Keep the newest line in view">'+I.arrowDown+'Auto-scroll</button>';
  html+='<button class="btn btn-ghost" data-action="toggleLogPause" id="pauseBtn">'+pauseLabel()+'</button>';
  html+='<button class="btn btn-ghost" data-action="copyAllLogs" title="Copy the lines the filters show">'+OPS_ICON.copy+'Copy</button>';
  html+='<button class="btn btn-ghost" data-action="clearLogs" title="Clear the lines on screen">'+I.trash+'Clear</button>';
  html+='</div></div>';
  // A focusable region, so the log scrolls from the keyboard. Not role=log:
  // that is a live region, and a streaming log would talk over everything.
  html+='<div class="log-output" id="logOutput" role="region" aria-label="Log lines" tabindex="0"></div>';
  html+='<div class="log-status"><span style="margin-left:auto" id="logCount">'+state.logEntries.length+' entries</span></div>';
  setTimeout(()=>{renderLogLines();if(!state.logPaused)connectLogStream()},0);
  return html;
}

function toggleLogLevel(l){state.logLevels[l]=!state.logLevels[l];document.querySelectorAll('.level-toggle[data-level="'+l+'"]').forEach(b=>b.setAttribute('aria-pressed',String(state.logLevels[l])));renderLogLines()}

function toggleLogAutoScroll(){state.logAutoScroll=!state.logAutoScroll;const btn=document.getElementById('autoScrollBtn');if(btn)btn.setAttribute('aria-pressed',String(state.logAutoScroll))}

function toggleLogPause(){
  state.logPaused=!state.logPaused;
  const btn=document.getElementById('pauseBtn');if(btn)btn.innerHTML=pauseLabel();
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

/* A line's attrs as chips instead of raw JSON: an http request reads
   "GET /path · 200 · 3 ms" with the status coloured by class (the number is
   always there) and nothing more, anything else as key=value. The full attrs stay one click
   away, and search, Copy and the filters keep using the raw text. */
const LOG_CHIP_MAX=60;
function logAttrs(raw){
  if(!raw||raw==='{}')return null;
  try{const o=JSON.parse(raw);return o&&typeof o==='object'&&!Array.isArray(o)?o:null}catch(e){return null}
}
function logChipsHtml(entry){
  const a=logAttrs(entry.attrs);
  if(!a){return entry.attrs&&entry.attrs!=='{}'?' <span class="log-raw">'+esc(entry.attrs)+'</span>':''}
  const rest=Object.assign({},a);let html='';
  if(entry.msg==='http request'&&a.method&&a.path){
    const st=Number(a.status)||0;
    html+='<span class="log-chip log-req">'+esc(a.method)+' '+esc(a.path)+'</span>';
    if(st)html+='<span class="log-chip log-status-'+(st>=500?'5xx':st>=400?'4xx':'ok')+'">'+st+'</span>';
    if(a.duration_ms!==undefined)html+='<span class="log-chip">'+esc(a.duration_ms)+' ms</span>';
    /* Bytes, client address and request id wait in the details. */
    Object.keys(rest).forEach(k=>{delete rest[k]});
  }
  let cut=false;
  Object.keys(rest).forEach(k=>{
    let v=rest[k];v=typeof v==='string'?v:JSON.stringify(v);
    if(v.length>LOG_CHIP_MAX){v=v.slice(0,LOG_CHIP_MAX)+'…';cut=true}
    html+='<span class="log-chip"><span class="log-key">'+esc(k)+'=</span>'+esc(v)+'</span>';
  });
  const detail='<details class="log-more"><summary>'+(cut?'full details':'details')+'</summary><pre>'+esc(JSON.stringify(a,null,2))+'</pre></details>';
  return' <span class="log-chips">'+html+'</span>'+detail;
}

function appendLogLine(entry){
  if(!matchesLogFilter(entry))return;
  const out=document.getElementById('logOutput');if(!out)return;
  const div=document.createElement('div');
  div.className='log-line l-'+entry.level.toLowerCase();
  div.innerHTML='<span class="log-ts">'+fmtLocal(entry.ts,LOG_TIME)+'</span><span class="log-lvl">'+esc(entry.level)+'</span><span class="log-src">['+esc(entry.source||'server')+']</span>'+esc(entry.msg)+logChipsHtml(entry);
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
    html+='<td>'+fmtLocal(t.created_at)+'</td>';
    html+='<td>'+(t.last_used?fmtLocal(t.last_used):'<span style="color:var(--text-muted)">never</span>')+'</td>';
    html+='<td>'+(t.expires_at?fmtLocal(t.expires_at):'<span style="color:var(--text-muted)">never</span>')+'</td>';
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
    '<div class="code-copy"><code>'+esc(d.token)+'</code><button class="btn btn-ghost" data-action="copyToken" data-args="'+actArgs(d.token)+'">Copy</button></div></div>'+
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
    html+='<td style="font-size:12px;color:var(--text-muted)">'+fmtLocal(installed)+'</td>';
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
  discardSupportBundle,downloadSupportBundle,exportAuditCSV,reloadAudit,installPlugin,openCreateTokenModal,openUninstallPlugin,
  previewSupportBundle,revokeToken,setPluginEnabled,toggleLogAutoScroll,toggleLogLevel,toggleLogPause,uninstallPlugin,
  turnAuditPage(delta){reloadAudit(Math.max(1,state.auditPage+delta))},
  setAuditSearch(){
    state.auditSearch=this.value;clearTimeout(auditSearchTimer);
    auditSearchTimer=setTimeout(()=>reloadAudit(1),300);
  },
  setAuditActionFilter(){clearTimeout(auditSearchTimer);state.auditActionFilter=this.value;reloadAudit(1)},
  toggleAuditSignins(){
    clearTimeout(auditSearchTimer);state.auditShowSignins=!state.auditShowSignins;
    const chip=document.getElementById('auditSignins');
    if(chip){chip.setAttribute('aria-pressed',String(state.auditShowSignins));chip.innerHTML=(state.auditShowSignins?I.check:'')+'Sign-ins'}
    reloadAudit(1);
  },
  setLogSearch(){state.logSearch=this.value;renderLogLines()},
  pluginFileChosen(){document.getElementById('pluginInstallBtn').disabled=!this.files.length}});
