/* OwnCord admin panel: Settings, Message Retention, Backups and Updates. */

/* ═══ Settings ═══ */
/* The keys this page edits. Config-file values (upload limit, voice quality)
   are read-only facts from GET /config, and the owner-only backup policy
   lives on Backups & restore. */
const SETTINGS_KEYS=['server_name','motd','registration_mode','require_2fa'];
function settingNorm(k,v){return k==='require_2fa'?((v==='1'||v==='true')?'true':'false'):(v||'')}
function settingsFormValues(keys){
  const out={};
  keys.forEach(k=>{const el=document.getElementById('s-'+k);if(el)out[k]=el.classList.contains('toggle')?(el.classList.contains('on')?'true':'false'):el.value});
  return out;
}
/* Only what actually changed. The server's require_2fa enrollment
   precondition (service.validateRequire2FAUpdate) keys on the key's mere
   presence in the PATCH, not on whether its value moved — so resending it
   unchanged re-runs that precondition for a save that never touched it and
   can wedge the whole page once any TOTP-less user exists. */
function settingsDiff(values){
  const cur=state._settings||{};const body={};
  Object.keys(values).forEach(k=>{if(values[k]!==settingNorm(k,cur[k]))body[k]=values[k]});
  return body;
}
function settingsRow(key,name,desc,ctrl){
  return'<div class="setting-row"><div class="setting-info"><label class="setting-name" for="s-'+key+'">'+name+'</label>'+(desc?'<div class="setting-desc" id="s-'+key+'-desc">'+desc+'</div>':'')+'</div><div class="setting-ctrl">'+ctrl+'</div></div>';
}
function settingsCard(title,body){const id='sc-'+title.replace(/\W+/g,'-');return'<section class="section-card" aria-labelledby="'+id+'"><div class="section-card-header"><h3 id="'+id+'">'+esc(title)+'</h3></div><div class="section-card-body">'+body+'</div></section>'}
function voiceQualityLabel(q){return{low:'Low',medium:'Medium',high:'High'}[q]||q||'Unknown'}

async function renderSettings(){
  let settings,facts=null;
  try{settings=await api('GET','/settings')}catch(e){return'<div class="page-title">Settings</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  try{facts=await api('GET','/config')}catch(e){}
  state._settings={...settings};
  /* Unsaved edits survive leaving the page: the nav's unsaved dot promises
     they are still there to save. */
  const draft=state.settingsDraft||{};
  const v=k=>k in draft?draft[k]:(settings[k]||'');
  const on=settingNorm('require_2fa',v('require_2fa'))==='true';
  let html='<div class="page-title">Settings</div><div class="page-desc">How your server presents itself and who can join.'+(isOwner()?' The backup schedule is on <button class="link-btn" data-action="navigateTo" data-args="'+actArgs('backups')+'">Backups &amp; restore</button>.':'')+'</div>';
  html+=settingsCard('General',
    settingsRow('server_name','Server name','Shown in the client and at the top of this panel','<input class="form-input" id="s-server_name" value="'+esc(v('server_name'))+'" aria-describedby="s-server_name-desc" data-input-action="markSettingsChanged">')
    +settingsRow('motd','Message of the day','Shown to members when they connect','<input class="form-input" id="s-motd" value="'+esc(v('motd'))+'" aria-describedby="s-motd-desc" data-input-action="markSettingsChanged">'));
  html+=settingsCard('Access & registration',
    settingsRow('registration_mode','Registration','Closed: nobody can register. Invite: a valid invite code is required. Approval: new accounts wait in Members until you approve them. Open: anyone can register.','<select class="filter-select" id="s-registration_mode" aria-describedby="s-registration_mode-desc" data-change-action="markSettingsChanged">'+regModeOptions(v('registration_mode')||'invite')+'</select>'));
  html+=settingsCard('Security',
    '<div class="setting-row"><div class="setting-info"><div class="setting-name" id="s-require_2fa-name">Require two-factor authentication</div><div class="setting-desc" id="s-require_2fa-desc">Every member must turn on 2FA before they can use the server</div></div><div class="setting-ctrl"><button class="toggle '+(on?'on':'')+'" id="s-require_2fa" role="switch" aria-checked="'+on+'" aria-labelledby="s-require_2fa-name" aria-describedby="s-require_2fa-desc" data-action="toggleSetting"></button></div></div>');
  /* Facts, not inputs: these take effect from config.yaml at start-up, so
     an editable-looking field here would change nothing. */
  let factRows;
  if(facts)factRows=[['Max upload size',facts.upload_max_size_mb+' MB','upload.max_size_mb'],['Voice quality',voiceQualityLabel(facts.voice_quality),'voice.quality']]
    .map(([n,val,key])=>'<div class="fact-row"><dt>'+n+'</dt><dd><span class="fact-value">'+esc(val)+'</span><code class="fact-key">'+key+'</code></dd></div>').join('');
  html+=settingsCard('Set in config.yaml','<p class="setting-desc">These values come from the server\'s config file. Change them there and restart the server.</p>'
    +(facts?'<dl class="fact-list">'+factRows+'</dl>':'<p class="setting-desc" style="margin-top:8px">The running configuration could not be read.</p>'));
  html+='<div class="save-bar'+(state.settingsChanged?' dirty':'')+'" id="settingsSaveBar" role="region" aria-label="Save settings"><span class="save-bar-status" id="settingsSaveState" role="status">'+(state.settingsChanged?'Unsaved changes':'All changes saved')+'</span>'
    +'<button class="btn btn-ghost" id="discardSettingsBtn" data-action="discardSettings"'+(state.settingsChanged?'':' disabled')+'>Discard</button>'
    +'<button class="btn btn-accent" id="saveSettingsBtn" data-action="saveSettings"'+(state.settingsChanged?'':' disabled')+'>Save changes</button></div>';
  return html;
}

function setSettingsChanged(changed){
  if(state.settingsChanged!==changed){state.settingsChanged=changed;renderNav()}
  const s=document.getElementById('settingsSaveState');if(s)s.textContent=changed?'Unsaved changes':'All changes saved';
  const bar=document.getElementById('settingsSaveBar');if(bar)bar.classList.toggle('dirty',changed);
  ['saveSettingsBtn','discardSettingsBtn'].forEach(id=>{const b=document.getElementById(id);if(b)b.disabled=!changed});
}

function markSettingsChanged(){
  const diff=settingsDiff(settingsFormValues(SETTINGS_KEYS));
  state.settingsDraft=Object.keys(diff).length?diff:null;
  setSettingsChanged(!!state.settingsDraft);
}

function discardSettings(){state.settingsDraft=null;setSettingsChanged(false);renderContent()}

async function saveSettings(){
  const btn=document.getElementById('saveSettingsBtn');
  if(btn){if(btn.disabled)return;btn.disabled=true}
  const body=settingsDiff(settingsFormValues(SETTINGS_KEYS));
  if(!Object.keys(body).length){state.settingsDraft=null;setSettingsChanged(false);showToast('Settings saved');return}
  try{
    state._settings=await api('PATCH','/settings',body);
    if('server_name' in body&&state.me){state.me.server_name=body.server_name;renderTopbar()}
    state.settingsDraft=null;setSettingsChanged(false);showToast('Settings saved');
  }catch(e){
    showToast(e.message,'error');
    if(btn)btn.disabled=false;
  }
}

/* ═══ Message Retention (B4-11) ═══ */
/* Retention deletes message history continuously and irreversibly, so this
   page leads with GET /retention/preview: per channel with an effective
   window, how many messages the next sweep takes under the policy as it
   stands. The server-wide window is the retention_days setting; a channel may
   override it in either direction, and 0 on a channel keeps that channel
   forever even under a server window. DMs are never in scope — the server
   refuses a policy on one — so they are not listed. */
function retentionLabel(days){return days>0?days+' day'+(days===1?'':'s'):'Kept forever'}

async function renderRetention(){
  let policy,preview;
  try{policy=await api('GET','/retention');preview=await api('GET','/retention/preview')}
  catch(e){return'<div class="page-title">Message Retention</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  /* The channel list is MANAGE_CHANNELS while this page is MANAGE_SERVER, so
     a principal holding only the latter cannot read it. Degrade to the
     channels the policy and the preview already name rather than failing the
     whole page over an affordance. */
  let channels=null;
  try{channels=await api('GET','/channels')}catch(e){}
  const serverDays=(policy&&policy.server_days)||0;
  state.retentionRevision=policy&&policy.revision;
  state.retentionPolicyChannels=(policy&&policy.channels)||[];
  const overrides={};state.retentionPolicyChannels.forEach(c=>{overrides[c.channel_id]=c.days});
  const windows={};let totalDue=0;
  (preview||[]).forEach(w=>{windows[w.channel_id]=w;totalDue+=w.would_delete||0});
  const rows=[];const seen={};
  (channels||[]).forEach(ch=>{
    const id=ch.id||ch.ID;const type=ch.type||ch.Type||'text';
    if(type==='dm')return;
    seen[id]=true;rows.push({id:id,name:ch.name||ch.Name||('#'+id)});
  });
  Object.keys(overrides).concat(Object.keys(windows)).forEach(k=>{
    const id=parseInt(k,10);
    if(seen[id])return;
    seen[id]=true;
    rows.push({id:id,name:(windows[id]&&windows[id].channel_name)||('#'+id)});
  });
  rows.sort((a,b)=>String(a.name).localeCompare(String(b.name)));

  let html='<div class="page-title">Message Retention</div><div class="page-desc">Messages older than the window are deleted permanently on every maintenance sweep. Pinned messages are exempt, and direct messages are never in scope.</div>';

  html+='<div class="section-card"><div class="section-card-header"><h3>Server-wide window</h3></div><div class="section-card-body">';
  html+='<div class="setting-row"><div class="setting-info"><label class="setting-name" for="retentionDays">Keep messages for</label><div class="setting-desc">Applies to every channel without its own override. 0 keeps everything indefinitely, which is the default; otherwise between 1 and 3650 days.</div></div>';
  html+='<div class="setting-ctrl" style="display:flex;gap:8px;align-items:center"><input class="form-input" id="retentionDays" type="number" min="0" max="3650" style="width:110px" value="'+esc(serverDays)+'"><button class="btn btn-accent" data-action="openApplyRetention">Preview change</button></div></div>';
  html+='<div style="color:var(--text-muted);font-size:12px;margin-top:4px">Currently: <strong style="color:var(--text-normal)">'+esc(retentionLabel(serverDays))+'</strong></div>';
  html+='</div></div>';

  html+='<div class="section-card"><div class="section-card-header"><h3>Effect preview</h3><button class="btn btn-ghost" data-action="renderContent">'+I.refresh+' Refresh</button></div><div class="section-card-body">';
  if(!preview||!preview.length)html+='<div style="color:var(--text-muted);font-size:13px">No channel has a retention window, so the next sweep removes nothing.</div>';
  else if(totalDue===0)html+='<div style="color:var(--text-muted);font-size:13px">A window applies to '+preview.length+' channel'+(preview.length===1?'':'s')+', but nothing is past it yet — the next sweep removes nothing.</div>';
  else html+='<div style="color:var(--text-warning);font-size:13px">The next sweep permanently deletes <strong>'+totalDue.toLocaleString()+'</strong> message'+(totalDue===1?'':'s')+' across '+preview.length+' channel'+(preview.length===1?'':'s')+'. This cannot be undone.</div>';
  html+='</div></div>';

  html+='<div class="section-card"><div class="section-card-header"><h3>Channels</h3></div><div class="section-card-body no-pad"><table class="tbl"><thead><tr><th>Channel</th><th>Window</th><th>Source</th><th>Next sweep removes</th><th style="text-align:right">Actions</th></tr></thead><tbody>';
  if(!rows.length)html+='<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">No channels</td></tr>';
  rows.forEach(r=>{
    const w=windows[r.id];
    const has=Object.prototype.hasOwnProperty.call(overrides,r.id);
    const days=has?overrides[r.id]:serverDays;
    const due=w?(w.would_delete||0):0;
    html+='<tr><td><strong>'+esc(r.name)+'</strong></td>';
    html+='<td>'+esc(retentionLabel(days))+'</td>';
    html+='<td>'+(has?'<span class="badge badge-yellow">channel</span>':'<span class="badge badge-muted">server</span>')+'</td>';
    html+='<td'+(due?' style="color:var(--text-danger)"':' style="color:var(--text-muted)"')+'>'+due.toLocaleString()+'</td>';
    html+='<td><div class="act-group" style="justify-content:flex-end"><button class="btn btn-ghost" data-action="openChannelRetention" data-args="'+actArgs(r.id,r.name)+'">'+(has?'Edit override':'Override')+'</button>';
    if(has)html+='<button class="btn btn-ghost" data-action="clearChannelRetention" data-args="'+actArgs(r.id)+'">Use server policy</button>';
    html+='</div></td></tr>';
  });
  html+='</tbody></table></div></div>';
  return html;
}

/* Proposed previews are observations, never writes. Only the final explicit
   confirmation sends the signed proposal back through the existing routes. */
function readRetentionDays(id){
  const el=document.getElementById(id);
  const raw=el?el.value.trim():'';
  const days=Number(raw);
  if(!raw||!Number.isInteger(days)||days<0||days>3650){showToast('Window must be 0 (keep forever) or between 1 and 3650 days','error');return null}
  return days;
}

async function openApplyRetention(){
  const days=readRetentionDays('retentionDays');
  if(days===null)return;
  await previewRetentionChange({scope:'server',days:days});
}

function proposedRetentionLabel(change){
  if(change.scope==='server')return 'Server-wide window: '+retentionLabel(change.days);
  if(change.days===null)return 'Remove override for channel #'+change.channel_id+' and use the server policy (including removal of keep-forever protection).';
  return 'Channel #'+change.channel_id+': '+retentionLabel(change.days);
}

async function previewRetentionChange(change){
  openModal('<div class="modal-header"><h3>Preview retention change</h3></div><div class="modal-body" role="status">Calculating affected messages…</div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button></div>');
  const pending={change:change,revision:state.retentionRevision,preview:null};
  state.retentionProposal=pending;
  try{
    const preview=await api('POST','/retention/preview',{proposed:change,revision:pending.revision});
    if(state.retentionProposal!==pending)return;
    pending.preview=preview;
    let html='<div class="modal-header"><h3>Confirm retention change</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body">';
    html+='<p><strong>'+esc(proposedRetentionLabel(change))+'</strong></p>';
    html+='<p style="color:var(--text-warning);margin-top:12px">Under the proposed policy, <strong>'+Number(preview.would_delete).toLocaleString()+'</strong> messages are currently eligible for permanent deletion across '+Number(preview.affected_channels).toLocaleString()+' channels.</p>';
    html+='<p style="color:var(--text-danger);margin-top:8px">Deletion cannot be undone. The policy continues to apply on future maintenance sweeps.</p>';
    html+='<p style="margin-top:8px">Protected exclusions: '+Number(preview.protected_pinned).toLocaleString()+' pinned messages, '+Number(preview.protected_indefinite).toLocaleString()+' messages kept indefinitely, and '+Number(preview.protected_direct_messages).toLocaleString()+' direct messages. Counts are separate; pinned messages in indefinite channels are counted as indefinite.</p>';
    html+='<p style="color:var(--text-muted);margin-top:8px">Observed at '+esc(preview.observed_at)+'. Counts can change as messages arrive, age or are pinned. This preview expires after 15 minutes.</p>';
    html+='<table class="tbl" style="margin-top:12px"><thead><tr><th>Channel</th><th>Proposed window</th><th>Would delete</th><th>Protected</th></tr></thead><tbody>';
    (preview.channels||[]).forEach(ch=>{html+='<tr><td>'+esc(ch.channel_name)+'</td><td>'+esc(retentionLabel(ch.days))+' ('+esc(ch.source)+')</td><td>'+Number(ch.would_delete).toLocaleString()+'</td><td>'+Number(ch.protected_pinned+ch.protected_indefinite).toLocaleString()+'</td></tr>'});
    html+='</tbody></table></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button id="applyRetentionPreview" class="btn btn-danger" data-action="applyRetention">Apply window</button></div>';
    setModalHTML(html);
  }catch(e){
    if(state.retentionProposal!==pending)return;
    state.retentionProposal=null;
    setModalHTML('<div class="modal-header"><h3>Preview unavailable</h3></div><div class="modal-body" role="alert">'+esc(e.message)+'</div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModalAndRefresh">Reload policy</button></div>');
  }
}

async function applyRetention(){
  const pending=state.retentionProposal;
  if(!pending||!pending.preview||pending.applying)return;
  if(pending.change.scope==='server'&&readRetentionDays('retentionDays')!==pending.change.days){
    state.retentionProposal=null;closeModal();showToast('The window changed. Preview it again before applying.','error');return;
  }
  pending.applying=true;
  const button=document.getElementById('applyRetentionPreview');if(button)button.disabled=true;
  const change=pending.change;
  const headers={'X-Retention-Preview':pending.preview.token};
  try{
    if(change.scope==='server')await api('PATCH','/settings',{retention_days:String(change.days)},headers);
    else if(change.days===null)await api('DELETE','/channels/'+change.channel_id+'/retention',undefined,headers);
    else await api('PUT','/channels/'+change.channel_id+'/retention',{days:change.days},headers);
    if(state.retentionProposal!==pending)return;
    closeModal();showToast('Retention policy updated');renderContent();
  }catch(e){
    if(state.retentionProposal!==pending)return;
    state.retentionProposal=null;
    setModalHTML('<div class="modal-header"><h3>Retention change needs review</h3></div><div class="modal-body" role="alert">'+esc(e.message)+'</div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModalAndRefresh">Reload policy</button></div>');
  }
}

function openChannelRetention(id,name){
  const row=(state.retentionPolicyChannels||[]).find(c=>c.channel_id===id);
  const current=row?row.days:0;
  openModal('<div class="modal-header"><h3>Retention — #'+esc(name)+'</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'
    +'<div class="modal-body">'
    +'<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">An override replaces the server-wide window for this channel, in either direction. <strong style="color:var(--text-normal)">0 keeps this channel forever</strong>, even under a server window. <strong style="color:var(--text-danger)">Messages the window removes are deleted permanently.</strong></p>'
    +'<div class="form-group"><label class="form-label" for="chRetDays">Keep messages for (days)</label><input class="form-input" id="chRetDays" type="number" min="0" max="3650" value="'+esc(current)+'"></div>'
    +'</div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="saveChannelRetention" data-args="'+actArgs(id)+'">Preview override</button></div>');
}

async function saveChannelRetention(id){
  const days=readRetentionDays('chRetDays');
  if(days===null)return;
  await previewRetentionChange({scope:'channel',channel_id:id,days:days});
}

async function clearChannelRetention(id){
  await previewRetentionChange({scope:'channel',channel_id:id,days:null});
}

/* ═══ Restart wait ═══ */
/* Restoring a backup and applying an update both end in a self-restart.
   Poll the unauthenticated setup-status route until the old process has
   gone and a new one answers, then reload. A restart quicker than one poll
   never shows the gap, so an answer after 20 s counts as back too. */
function waitForRestart(statusId){
  const started=Date.now();let sawDown=false;
  const tick=async()=>{
    let up=false;
    try{up=(await fetch('/admin/api/setup/status',{cache:'no-store'})).ok}catch(e){}
    if(!up)sawDown=true;
    const elapsed=Date.now()-started;
    if(up&&(sawDown||elapsed>20000)){location.reload();return}
    if(elapsed>120000){
      const el=document.getElementById(statusId);
      if(el)el.innerHTML='The server has not come back after two minutes. Check it on the host, then <button class="link-btn" data-action="reloadPage">reload this page</button>.';
      return;
    }
    setTimeout(tick,2000);
  };
  setTimeout(tick,2000);
}
function restartingHTML(title,lead){
  return'<div class="modal-header"><h3>'+esc(title)+'</h3></div><div class="modal-body"><p>'+esc(lead)+'</p><p class="restart-wait" id="restartWait" role="status"><span class="spinner" aria-hidden="true"></span>Waiting for the server to come back. This page reloads by itself; you may need to sign in again.</p></div>';
}

/* ═══ Backups ═══ */
const BACKUP_KEYS=['backup_schedule','backup_retention'];
async function renderBackups(){
  let backups;
  try{backups=await api('GET','/backups')}catch(e){return'<div class="page-title">Backups &amp; restore</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  /* The schedule is owner-only policy in the settings table (BPR-072); this
     page is owner-only, so it is edited here rather than on Settings. */
  let policyErr='';
  try{state._settings=await api('GET','/settings')}catch(e){policyErr=e.message}
  const v=k=>(state._settings||{})[k]||'';
  let html='<div class="page-head"><div><div class="page-title">Backups &amp; restore</div><div class="page-desc">Copies of the server database. Restoring one replaces everything that happened after it was taken.</div></div>'
    +'<button class="btn btn-accent" data-action="createBackup"'+(state.backupRunning?' disabled':'')+'>'+(state.backupRunning?'<span class="spinner" aria-hidden="true"></span> Backing up…':I.download+' Create backup now')+'</button></div>';
  let sched;
  if(policyErr)sched='<p style="color:var(--text-danger)">'+esc(policyErr)+'</p>';
  else sched=settingsRow('backup_schedule','Automatic backups','A copy is taken on this schedule by the server\'s maintenance sweep','<select class="filter-select" id="s-backup_schedule" aria-describedby="s-backup_schedule-desc" data-change-action="markBackupPolicyChanged">'
      +[['off','Off'],['daily','Daily'],['weekly','Weekly']].map(([o,l])=>'<option value="'+o+'"'+(v('backup_schedule')===o?' selected':'')+'>'+l+'</option>').join('')+'</select>')
    +settingsRow('backup_retention','Keep backups for (days)','0 keeps every backup; otherwise 7 to 3650 days. Older backups are deleted.','<input class="form-input" id="s-backup_retention" type="number" min="0" max="3650" value="'+esc(v('backup_retention'))+'" aria-describedby="s-backup_retention-desc" data-input-action="markBackupPolicyChanged">')
    +'<div class="card-actions"><button class="btn btn-accent" id="saveBackupPolicyBtn" data-action="saveBackupPolicy" disabled>Save schedule</button></div>';
  html+=settingsCard('Schedule',sched);
  html+='<section class="section-card" aria-labelledby="sc-history"><div class="section-card-header"><h3 id="sc-history">Backup history</h3></div><div class="section-card-body no-pad"><table class="tbl"><thead><tr><th>File</th><th>Size</th><th>Created</th><th style="text-align:right">Actions</th></tr></thead><tbody>';
  if(!backups||!backups.length)html+='<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:24px">No backups yet</td></tr>';
  else backups.forEach(b=>{
    html+='<tr><td><code style="font-family:var(--font-mono);font-size:12px">'+esc(b.name)+'</code></td>';
    html+='<td>'+fmtBytes(b.size)+'</td><td>'+(b.date?esc(new Date(b.date).toLocaleString()):'')+'</td>';
    html+='<td><div class="act-group" style="justify-content:flex-end"><button class="btn btn-ghost" data-action="openRestoreModal" data-args="'+actArgs(b.name,b.date||'')+'">Restore</button><button class="act-btn danger" title="Delete '+esc(b.name)+'" aria-label="Delete '+esc(b.name)+'" data-action="openDeleteBackupModal" data-args="'+actArgs(b.name)+'">'+I.trash+'</button></div></td></tr>';
  });
  html+='</tbody></table></div></section>';
  return html;
}

function markBackupPolicyChanged(){
  const b=document.getElementById('saveBackupPolicyBtn');
  if(b)b.disabled=!Object.keys(settingsDiff(settingsFormValues(BACKUP_KEYS))).length;
}

async function saveBackupPolicy(){
  const btn=document.getElementById('saveBackupPolicyBtn');
  if(btn){if(btn.disabled)return;btn.disabled=true}
  const body=settingsDiff(settingsFormValues(BACKUP_KEYS));
  if(!Object.keys(body).length)return;
  try{state._settings=await api('PATCH','/settings',body);showToast('Backup schedule saved')}
  catch(e){showToast(e.message,'error');if(btn)btn.disabled=false}
}

async function createBackup(){
  state.backupRunning=true;renderContent();
  try{await api('POST','/backup');state.backupRunning=false;showToast('Backup created');renderContent()}catch(e){state.backupRunning=false;showToast(e.message,'error');renderContent()}
}

/* Restore overwrites the live database and restarts the server, so it asks
   for the backup's name typed out, like erasing an account does. */
function openRestoreModal(name,date){
  openModal('<div class="modal-header"><h3>Restore backup</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body">'
    +'<p>Replace the live database with <strong>'+esc(name)+'</strong>'+(date?', taken '+esc(new Date(date).toLocaleString()):'')+'.</p>'
    +'<ul class="modal-list"><li><strong style="color:var(--text-danger)">Everything since that backup is lost</strong>: messages, members, roles and settings.</li>'
    +'<li>A safety copy of the current database (<code>pre_restore_…</code>) is saved first and appears in this list.</li>'
    +'<li>The server restarts by itself. Everyone, including you, is disconnected and may need to sign in again.</li></ul>'
    +'<div class="form-group" style="margin-top:16px"><label class="form-label" for="restoreConfirm">Type <strong style="color:var(--text-normal);text-transform:none">'+esc(name)+'</strong> to confirm</label><input class="form-input" id="restoreConfirm" autocomplete="off" autocapitalize="off" spellcheck="false" data-input-action="checkRestoreConfirm" data-args="'+actArgs(name)+'"></div>'
    +'<p class="auth-error" id="restoreErr" role="alert"></p></div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" id="restoreConfirmBtn" data-action="confirmRestore" data-args="'+actArgs(name)+'" disabled>Restore and restart</button></div>');
}

function checkRestoreConfirm(name){
  const b=document.getElementById('restoreConfirmBtn');
  if(b)b.disabled=(document.getElementById('restoreConfirm')?.value||'').trim()!==name;
}

async function confirmRestore(name){
  if((document.getElementById('restoreConfirm')?.value||'').trim()!==name)return;
  const b=document.getElementById('restoreConfirmBtn');if(b)b.disabled=true;
  try{
    await api('POST','/backups/'+encodeURIComponent(name)+'/restore');
    setModalHTML(restartingHTML('Restoring backup','The database was restored from '+name+' and the server is restarting.'));
    waitForRestart('restartWait');
  }catch(e){
    /* Some failures still restart the server (its database is already
       closed); the message says so, and then waiting is the right thing. */
    if(/restarting/i.test(e.message)){setModalHTML(restartingHTML('Restore failed',e.message));waitForRestart('restartWait');return}
    const err=document.getElementById('restoreErr');if(err)err.textContent=e.message;
    if(b)b.disabled=false;
  }
}

/* Deleting a backup is irreversible — confirm it like every other destructive
   action here. It also used to report success without looking at the response,
   so a failed delete said "Backup deleted" and left the file in place. */
function openDeleteBackupModal(name){
  openModal('<div class="modal-header"><h3>Delete backup</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><p style="color:var(--text-muted)">Permanently delete <strong style="color:var(--text-normal)">'+esc(name)+'</strong>? This cannot be undone.</p></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="confirmDeleteBackup" data-args="'+actArgs(name)+'">Delete</button></div>');
}

async function confirmDeleteBackup(name){
  try{await api('DELETE','/backups/'+encodeURIComponent(name));closeModal();showToast('Backup deleted');renderContent()}catch(e){showToast(e.message,'error')}
}

/* ═══ Updates ═══ */
/* Only an https release page is linked; the URL comes from the release feed. */
function releaseNotesLink(info,text){
  const u=info&&info.release_url;
  return /^https:\/\//i.test(u||'')?'<a class="text-link" href="'+esc(u)+'" target="_blank" rel="noopener noreferrer">'+esc(text)+'<span class="sr-only"> (opens in a new tab)</span></a>':'';
}

async function renderUpdates(){
  // A failed check is not the same as "up to date" — saying so would be a lie
  // that hides a broken update path.
  let info,checkError='';
  try{info=await api('GET','/updates')}catch(e){checkError=e.message||'Update check failed'}
  state.updateInfo=info||null;
  let html='<div class="page-title">Updates</div><div class="page-desc">Server version management</div>';
  html+='<div class="update-grid">';
  html+='<div class="update-card"><div class="update-icon" style="background:rgba(92,195,137,.15);color:var(--text-positive)">'+I.check+'</div><div class="update-info"><div class="update-ver">'+(info?esc(info.current):'unknown')+'</div><div class="update-notes">Current version</div></div></div>';
  if(checkError)html+='<div class="update-card" style="border-color:var(--red)"><div class="update-icon" style="background:rgba(255,143,146,.15);color:var(--text-danger)">'+I.ban+'</div><div class="update-info"><div class="update-ver">Check failed</div><div class="update-notes">'+esc(checkError)+'</div></div></div>';
  else if(info&&info.update_available)html+='<div class="update-card" style="border-color:var(--accent)"><div class="update-icon" style="background:var(--accent-glow);color:var(--accent-text)">'+I.updates+'</div><div class="update-info"><div class="update-ver">'+esc(info.latest)+' <span class="badge badge-accent">New</span></div><div class="update-notes">Available. '+releaseNotesLink(info,'Release notes')+'</div></div></div>';
  else html+='<div class="update-card"><div class="update-icon" style="background:rgba(92,195,137,.15);color:var(--text-positive)">'+I.check+'</div><div class="update-info"><div class="update-ver">Up to date</div><div class="update-notes">You\'re running the latest version</div></div></div>';
  html+='</div>';
  if(info&&info.update_available&&info.can_apply===false){
    /* Container deployments: the binary is image content, so in-place apply is
       refused server-side (503 CONTAINER_DEPLOYMENT) — say so instead of
       offering a button that can only fail. */
    html+='<div class="update-card"><div class="update-info"><div class="update-notes">In-place update is unavailable in container deployments — upgrade by pulling the new image and recreating the container.</div></div></div>';
    html+='<div style="margin-top:16px"><button class="btn btn-ghost" data-action="renderContent">'+I.refresh+' Check again</button></div>';
  }else if(info&&info.update_available){
    html+='<div class="btn-row"><button class="btn btn-accent" data-action="applyUpdate"'+(state.updateApplying?' disabled':'')+'>'+(state.updateApplying?'<span class="spinner" aria-hidden="true"></span> Updating…':'Update to '+esc(info.latest)+'…')+'</button>';
    html+='<button class="btn btn-ghost" data-action="renderContent">'+I.refresh+' Check again</button></div>';
  }else{
    html+='<div style="margin-top:16px"><button class="btn btn-ghost" data-action="renderContent">'+I.refresh+' Check for updates</button></div>';
  }
  return html;
}

/* OP-11: an update migrates the database forward only, so the dialog leads
   with a backup (on by default), the release notes, and the latest backup. */
async function applyUpdate(){
  const info=state.updateInfo||{};
  const notes=releaseNotesLink(info,'Read the release notes for '+(info.latest||'this version'));
  openModal('<div class="modal-header"><h3>Update to '+esc(info.latest||'the latest version')+'</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body">'
    +'<p>The server downloads and verifies the release, replaces its binary and restarts. Everyone connected is disconnected for a moment.</p>'
    +'<div class="callout-warning"><strong>Database migrations only run forward.</strong> Once the new version starts, older versions cannot open the database, so the only way back is restoring a backup taken before the update.</div>'
    +(notes?'<p style="margin-top:12px">'+notes+' before you update.</p>':'')
    +'<p class="setting-desc" id="updateLastBackup" style="margin-top:12px">Checking for recent backups…</p>'
    +'<label class="check-row"><input type="checkbox" id="updateBackupFirst" checked data-change-action="syncUpdateConfirm"> Back up the database first (recommended)</label>'
    +'<p class="auth-error" id="updateErr" role="alert"></p></div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" id="updateConfirmBtn" data-action="confirmApplyUpdate">Back up and update</button></div>');
  let text;
  try{
    const list=await api('GET','/backups');
    const latest=(list||[]).filter(b=>b.date).sort((a,b)=>new Date(b.date)-new Date(a.date))[0];
    text=latest?'Latest backup: '+new Date(latest.date).toLocaleString()+' ('+latest.name+').':'There are no backups yet.';
  }catch(e){text='The backup list could not be read.'}
  const el=document.getElementById('updateLastBackup');if(el)el.textContent=text;
}

function syncUpdateConfirm(){
  const b=document.getElementById('updateConfirmBtn');
  if(b)b.textContent=document.getElementById('updateBackupFirst')?.checked?'Back up and update':'Update without a backup';
}

async function confirmApplyUpdate(){
  const btn=document.getElementById('updateConfirmBtn');
  if(btn){if(btn.disabled)return;btn.disabled=true}
  const err=document.getElementById('updateErr');if(err)err.textContent='';
  const fail=msg=>{if(err)err.textContent=msg;if(btn)btn.disabled=false};
  if(document.getElementById('updateBackupFirst')?.checked){
    if(btn)btn.textContent='Backing up…';
    try{await api('POST','/backup')}catch(e){syncUpdateConfirm();return fail('The backup failed, so nothing was updated: '+e.message)}
  }
  if(btn)btn.textContent='Updating…';
  state.updateApplying=true;
  try{
    await api('POST','/updates/apply');
    setModalHTML(restartingHTML('Updating to '+((state.updateInfo||{}).latest||'the latest version'),'The update was applied and the server is restarting.'));
    waitForRestart('restartWait');
  }catch(e){
    state.updateApplying=false;syncUpdateConfirm();fail(e.message);
  }
}

Object.assign(ACTIONS,{applyRetention,applyUpdate,checkRestoreConfirm,clearChannelRetention,confirmApplyUpdate,
  confirmDeleteBackup,confirmRestore,createBackup,discardSettings,markBackupPolicyChanged,markSettingsChanged,
  openApplyRetention,openChannelRetention,openDeleteBackupModal,openRestoreModal,saveBackupPolicy,saveChannelRetention,
  saveSettings,syncUpdateConfirm,
  reloadPage(){location.reload()},
  toggleSetting(){toggleSwitch(this);markSettingsChanged()}});
