/* OwnCord admin panel: Settings, Message Retention, Backups and Updates. */

/* ═══ Settings ═══ */
async function renderSettings(){
  let settings;
  try{settings=await api('GET','/settings')}catch(e){return'<div class="page-title">Settings</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  state._settings={...settings};
  const v=k=>settings[k]||'';
  const isOn=k=>v(k)==='1'||v(k)==='true';
  let html='<div class="page-title">Server Settings</div><div class="page-desc">Configure your OwnCord server</div>';
  html+='<div class="section-card"><div class="section-card-header"><h3>General</h3></div><div class="section-card-body">';
  html+='<div class="setting-row"><div class="setting-info"><label class="setting-name" for="s-server_name">Server Name</label></div><div class="setting-ctrl"><input class="form-input" id="s-server_name" value="'+esc(v('server_name'))+'" style="width:240px" data-input-action="markSettingsChanged"></div></div>';
  html+='<div class="setting-row"><div class="setting-info"><label class="setting-name" for="s-server_icon">Server Icon URL</label><div class="setting-desc">Not used by the server or client yet &mdash; stored for a future release</div></div><div class="setting-ctrl"><input class="form-input" id="s-server_icon" value="'+esc(v('server_icon'))+'" style="width:240px" disabled title="Not implemented yet"></div></div>';
  html+='<div class="setting-row"><div class="setting-info"><label class="setting-name" for="s-motd">Message of the Day</label><div class="setting-desc">Shown to users when they connect</div></div><div class="setting-ctrl"><input class="form-input" id="s-motd" value="'+esc(v('motd'))+'" style="width:300px" data-input-action="markSettingsChanged"></div></div>';
  html+='</div></div>';
  html+='<div class="section-card"><div class="section-card-header"><h3>Limits</h3></div><div class="section-card-body">';
  html+='<div class="setting-row"><div class="setting-info"><label class="setting-name" for="s-max_upload_bytes">Max Upload Size (bytes)</label><div class="setting-desc">Controlled by upload.max_size_mb in config.yaml (requires restart) &mdash; this display value has no effect</div></div><div class="setting-ctrl"><input class="form-input" id="s-max_upload_bytes" value="'+esc(v('max_upload_bytes'))+'" style="width:160px" type="number" disabled title="Set upload.max_size_mb in config.yaml and restart"></div></div>';
  html+='<div class="setting-row"><div class="setting-info"><label class="setting-name" for="s-voice_quality">Voice Quality</label><div class="setting-desc">Controlled by voice.quality in config.yaml (requires restart) &mdash; this display value has no effect</div></div><div class="setting-ctrl"><select class="filter-select" id="s-voice_quality" disabled title="Set voice.quality in config.yaml and restart"><option value="low" '+(v('voice_quality')==='low'?'selected':'')+'>Low</option><option value="medium" '+(v('voice_quality')==='medium'?'selected':'')+'>Medium</option><option value="high" '+(v('voice_quality')==='high'?'selected':'')+'>High</option></select></div></div>';
  html+='</div></div>';
  html+='<div class="section-card"><div class="section-card-header"><h3>Security</h3></div><div class="section-card-body">';
  html+='<div class="setting-row"><div class="setting-info"><div class="setting-name" id="s-require_2fa-name">Require 2FA</div><div class="setting-desc">Require all users to enable two-factor authentication</div></div><div class="setting-ctrl"><button class="toggle '+(isOn('require_2fa')?'on':'')+'" id="s-require_2fa" role="switch" aria-checked="'+(isOn('require_2fa')?'true':'false')+'" aria-labelledby="s-require_2fa-name" data-action="toggleSetting"></button></div></div>';
  html+='<div class="setting-row"><div class="setting-info"><label class="setting-name" for="s-registration_mode">Registration</label><div class="setting-desc">Closed: nobody can register. Invite: a valid invite code is required. Approval: new accounts wait in Users until you approve them. Open: anyone can register.</div></div><div class="setting-ctrl"><select class="filter-select" id="s-registration_mode" data-change-action="markSettingsChanged">'+regModeOptions(v('registration_mode')||'invite')+'</select></div></div>';
  html+='</div></div>';
  const owner=isOwner();
  html+='<div class="section-card"><div class="section-card-header"><h3>Backup</h3></div><div class="section-card-body">';
  html+='<div class="setting-row"><div class="setting-info"><label class="setting-name" for="s-backup_schedule">Schedule</label><div class="setting-desc">'+(owner?'':'Owner only. ')+'The backup policy is owner-only (BPR-072).</div></div><div class="setting-ctrl"><select class="filter-select" id="s-backup_schedule" '+(owner?'':'disabled title="Owner role required"')+' data-change-action="markSettingsChanged"><option value="off" '+(v('backup_schedule')==='off'?'selected':'')+'>Off</option><option value="daily" '+(v('backup_schedule')==='daily'?'selected':'')+'>Daily</option><option value="weekly" '+(v('backup_schedule')==='weekly'?'selected':'')+'>Weekly</option></select></div></div>';
  html+='<div class="setting-row"><div class="setting-info"><label class="setting-name" for="s-backup_retention">Retention (days)</label><div class="setting-desc">'+(owner?'0 keeps backups forever.':'Owner only. 0 keeps backups forever.')+'</div></div><div class="setting-ctrl"><input class="form-input" id="s-backup_retention" value="'+esc(v('backup_retention'))+'" style="width:100px" type="number" '+(owner?'':'disabled title="Owner role required"')+' data-input-action="markSettingsChanged"></div></div>';
  html+='</div></div>';
  html+='<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px"><button class="btn btn-accent" id="saveSettingsBtn" '+(state.settingsChanged?'':'disabled')+' data-action="saveSettings">Save Changes</button></div>';
  return html;
}

function markSettingsChanged(){state.settingsChanged=true;renderNav();const btn=document.getElementById('saveSettingsBtn');if(btn)btn.disabled=false}

async function saveSettings(){
  const body={};
  ['server_name','server_icon','motd','max_upload_bytes','voice_quality','backup_schedule','backup_retention','registration_mode'].forEach(k=>{const el=document.getElementById('s-'+k);if(el)body[k]=el.value});
  ['require_2fa'].forEach(k=>{const el=document.getElementById('s-'+k);if(el)body[k]=el.classList.contains('on')?'true':'false'});
  /* Send only what actually changed. The server's require_2fa enrollment
     precondition (service.validateRequire2FAUpdate) keys on the key's mere
     presence in the PATCH, not on whether its value moved — so resending it
     unchanged re-runs that precondition for a save that never touched it and
     can wedge the whole page once any TOTP-less user exists. */
  const cur=state._settings||{};
  Object.keys(body).forEach(k=>{
    const curNorm=(k==='require_2fa')?((cur[k]==='1'||cur[k]==='true')?'true':'false'):(cur[k]||'');
    if(body[k]===curNorm)delete body[k];
  });
  const btn=document.getElementById('saveSettingsBtn');
  if(btn){if(btn.disabled)return;btn.disabled=true}
  if(!Object.keys(body).length){
    state.settingsChanged=false;renderNav();showToast('Settings saved');
    return;
  }
  try{
    await api('PATCH','/settings',body);
    state.settingsChanged=false;renderNav();showToast('Settings saved');
    // Leave the button disabled: there are no unsaved changes any more.
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

/* ═══ Backups ═══ */
async function renderBackups(){
  let backups;
  try{backups=await api('GET','/backups')}catch(e){return'<div class="page-title">Backups</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  let html='<div class="page-title">Backups</div><div class="page-desc">Database backup and restore</div>';
  html+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px"><div class="section-card"><div class="section-card-header"><h3>Manual Backup</h3></div><div class="section-card-body" style="text-align:center;padding:32px"><button class="btn btn-accent" style="font-size:15px;padding:12px 32px" data-action="createBackup" '+(state.backupRunning?'disabled':'')+'>'+(state.backupRunning?'<div class="spinner"></div> Running...':I.download+' Create Backup Now')+'</button></div></div>';
  html+='<div class="section-card"><div class="section-card-header"><h3>Schedule</h3></div><div class="section-card-body"><p style="color:var(--text-muted);font-size:13px">Configure backup schedule in Settings.</p><button class="btn btn-ghost" style="margin-top:8px" data-action="navigateTo" data-args="'+actArgs('settings')+'">Go to Settings</button></div></div></div>';
  html+='<div class="section-card"><div class="section-card-header"><h3>Backup History</h3></div><div class="section-card-body no-pad"><table class="tbl"><thead><tr><th>Filename</th><th>Size</th><th>Date</th><th style="text-align:right">Actions</th></tr></thead><tbody>';
  if(!backups||!backups.length)html+='<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:24px">No backups found</td></tr>';
  else backups.forEach(b=>{
    html+='<tr><td><code style="font-family:var(--font-mono);font-size:12px">'+esc(b.name)+'</code></td>';
    html+='<td>'+fmtBytes(b.size)+'</td><td>'+(b.date?new Date(b.date).toLocaleString():'')+'</td>';
    html+='<td><div class="act-group" style="justify-content:flex-end"><button class="btn btn-ghost" data-action="openRestoreModal" data-args="'+actArgs(b.name)+'">Restore</button><button class="act-btn danger" title="Delete" aria-label="Delete" data-action="openDeleteBackupModal" data-args="'+actArgs(b.name)+'">'+I.trash+'</button></div></td></tr>';
  });
  html+='</tbody></table></div></div>';
  return html;
}

async function createBackup(){
  state.backupRunning=true;renderContent();
  try{await api('POST','/backup');state.backupRunning=false;showToast('Backup created');renderContent()}catch(e){state.backupRunning=false;showToast(e.message,'error');renderContent()}
}

function openRestoreModal(name){
  openModal('<div class="modal-header"><h3>Restore Backup</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><p style="color:var(--text-muted)">Overwrite the current database with <strong style="color:var(--text-normal)">'+esc(name)+'</strong>? A pre-restore backup will be created. Server restart recommended after restore.</p></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="confirmRestore" data-args="'+actArgs(name)+'">Restore</button></div>');
}

async function confirmRestore(name){
  try{await api('POST','/backups/'+encodeURIComponent(name)+'/restore');closeModal();showToast('Database restored. Restart recommended.','info');renderContent()}catch(e){showToast(e.message,'error')}
}

/* Deleting a backup is irreversible — confirm it like every other destructive
   action here. It also used to report success without looking at the response,
   so a failed delete said "Backup deleted" and left the file in place. */
function openDeleteBackupModal(name){
  openModal('<div class="modal-header"><h3>Delete Backup</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><p style="color:var(--text-muted)">Permanently delete <strong style="color:var(--text-normal)">'+esc(name)+'</strong>? This cannot be undone.</p></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="confirmDeleteBackup" data-args="'+actArgs(name)+'">Delete</button></div>');
}

async function confirmDeleteBackup(name){
  try{await api('DELETE','/backups/'+encodeURIComponent(name));closeModal();showToast('Backup deleted');renderContent()}catch(e){showToast(e.message,'error')}
}

/* ═══ Updates ═══ */
async function renderUpdates(){
  // A failed check is not the same as "up to date" — saying so would be a lie
  // that hides a broken update path.
  let info,checkError='';
  try{info=await api('GET','/updates')}catch(e){checkError=e.message||'Update check failed'}
  let html='<div class="page-title">Updates</div><div class="page-desc">Server version management</div>';
  html+='<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">';
  html+='<div class="update-card"><div class="update-icon" style="background:rgba(92,195,137,.15);color:var(--text-positive)">'+I.check+'</div><div class="update-info"><div class="update-ver">'+(info?esc(info.current):'unknown')+'</div><div class="update-notes">Current version</div></div></div>';
  if(checkError)html+='<div class="update-card" style="border-color:var(--red)"><div class="update-icon" style="background:rgba(255,143,146,.15);color:var(--text-danger)">'+I.ban+'</div><div class="update-info"><div class="update-ver">Check failed</div><div class="update-notes">'+esc(checkError)+'</div></div></div>';
  else if(info&&info.update_available)html+='<div class="update-card" style="border-color:var(--accent)"><div class="update-icon" style="background:var(--accent-glow);color:var(--accent)">'+I.updates+'</div><div class="update-info"><div class="update-ver">'+esc(info.latest)+' <span class="badge badge-accent">New</span></div><div class="update-notes">Available for download</div></div></div>';
  else html+='<div class="update-card"><div class="update-icon" style="background:rgba(92,195,137,.15);color:var(--text-positive)">'+I.check+'</div><div class="update-info"><div class="update-ver">Up to date</div><div class="update-notes">You\'re running the latest version</div></div></div>';
  html+='</div>';
  if(info&&info.update_available&&info.can_apply===false){
    /* Container deployments: the binary is image content, so in-place apply is
       refused server-side (503 CONTAINER_DEPLOYMENT) — say so instead of
       offering a button that can only fail. */
    html+='<div class="update-card"><div class="update-info"><div class="update-notes">In-place update is unavailable in container deployments — upgrade by pulling the new image and recreating the container.</div></div></div>';
    html+='<div style="margin-top:16px"><button class="btn btn-ghost" data-action="renderContent">'+I.refresh+' Check Again</button></div>';
  }else if(info&&info.update_available){
    html+='<div style="display:flex;gap:8px"><button class="btn btn-danger" data-action="applyUpdate" '+(state.updateApplying?'disabled':'')+'>'+(state.updateApplying?'<div class="spinner"></div> Applying...':'Apply Update & Restart')+'</button>';
    html+='<button class="btn btn-ghost" data-action="renderContent">'+I.refresh+' Check Again</button></div>';
  }else{
    html+='<div style="margin-top:16px"><button class="btn btn-ghost" data-action="renderContent">'+I.refresh+' Check for Updates</button></div>';
  }
  return html;
}

async function applyUpdate(){
  openModal('<div class="modal-header"><h3>Apply Update</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><p style="color:var(--text-muted)">This will restart the server. All connected users will be briefly disconnected. Continue?</p></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="confirmApplyUpdate">Update & Restart</button></div>');
}

async function confirmApplyUpdate(){
  closeModal();state.updateApplying=true;renderContent();
  try{
    const r=await fetch('/admin/api/updates/apply',{method:'POST',headers:{'Authorization':'Bearer '+state.token}});
    if(r.ok){showToast('Update applied! Server restarting...','info');setTimeout(()=>location.reload(),10000);return}
    let msg='Update failed';
    try{const e=await r.json();msg=e.message||msg}catch(parseErr){}
    showToast(msg,'error');
  }catch(e){showToast(e.message,'error')}
  // Failure path only: re-render so the button leaves its "Applying..." state
  // instead of staying disabled until the next navigation.
  state.updateApplying=false;renderContent();
}

Object.assign(ACTIONS,{applyRetention,applyUpdate,clearChannelRetention,confirmApplyUpdate,confirmDeleteBackup,
  confirmRestore,createBackup,markSettingsChanged,openApplyRetention,openChannelRetention,openDeleteBackupModal,
  openRestoreModal,saveChannelRetention,saveSettings,
  toggleSetting(){toggleSwitch(this);markSettingsChanged()}});
