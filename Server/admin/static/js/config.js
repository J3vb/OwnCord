/* OwnCord admin panel: Server configuration — the config.yaml settings the
   owner may override from the panel. Saves go to an overrides file beside the
   database and take effect at the next restart, so the page offers Restart now
   once a change is pending. The server sends one row per editable key and
   never includes secrets or the other excluded keys. */

/* The page's save/discard bar and nav unsaved marker share core's
   state.configChanged, exactly like the Settings page's settingsChanged. */
function setConfigChanged(changed){
  if(state.configChanged!==changed){state.configChanged=changed;renderNav()}
  const s=document.getElementById('configSaveState');if(s)s.textContent=changed?'Unsaved changes':'All changes saved';
  const bar=document.getElementById('configSaveBar');if(bar)bar.classList.toggle('dirty',changed);
  ['saveConfigBtn','discardConfigBtn'].forEach(id=>{const b=document.getElementById(id);if(b instanceof HTMLButtonElement)b.disabled=!changed});
}

/* The initial, typed value of every row: the saved override when there is one,
   otherwise the running value. The diff compares typed values against this, so
   "1" and 1 are the same and a list is compared element by element. */
function configInitialValues(data){
  const out={};
  ((data&&data.settings)||[]).forEach(s=>{out[s.key]=s.type==='secret'?'':(s.env_locked?s.value:(s.override!=null?s.override:s.value))});
  return out;
}

function configRowValue(row){
  return row.env_locked?row.value:(row.override!=null?row.override:row.value);
}

function configControl(row){
  const value=configRowValue(row);
  const key=esc(row.key);
  const dis=row.env_locked?' disabled':'';
  if(row.type==='secret'){
    /* Write-only: the server never sends the value, so the field starts empty
       and a save sends it only when one is typed. */
    return'<input class="form-input" type="password" autocomplete="new-password" data-config-key="'+key+'" value="" data-input-action="markConfigChanged"'+dis+'>';
  }
  if(row.type==='bool'){
    const on=!!value;
    return'<button class="toggle'+(on?' on':'')+'" role="switch" aria-checked="'+on+'" data-config-key="'+key+'" data-action="toggleConfigKey"'+dis+'></button>';
  }
  if(row.type==='list'){
    const v=Array.isArray(value)?value.join(', '):String(value==null?'':value);
    return'<input class="form-input" data-config-key="'+key+'" value="'+esc(v)+'" data-input-action="markConfigChanged"'+dis+'>';
  }
  if(row.options&&row.options.length){
    const options=row.options.includes(value)?row.options:[value].concat(row.options);
    return'<select class="filter-select" data-config-key="'+key+'" data-change-action="markConfigChanged"'+dis+'>'
      +options.map(o=>'<option value="'+esc(o)+'"'+(o===value?' selected':'')+'>'+esc(o)+'</option>').join('')+'</select>';
  }
  const type=row.type==='int'||row.type==='float'?'number':'text';
  return'<input class="form-input" type="'+type+'" data-config-key="'+key+'" value="'+esc(value==null?'':value)+'" data-input-action="markConfigChanged"'+dis+'>';
}

function configRow(row){
  if(row.type==='secret')return configSecretRow(row);
  const overridden=row.override!=null;
  const desc=row.env_locked?'Set by the environment':(overridden?'Overridden from the panel':'');
  const reset=overridden&&!row.env_locked
    ? '<button class="btn btn-ghost" data-action="resetConfigKey" data-args="'+actArgs(row.key)+'">Reset</button>':'';
  return'<div class="setting-row"><div class="setting-info"><div class="setting-name">'+esc(row.key)+'</div>'
    +(desc?'<div class="setting-desc">'+esc(desc)+'</div>':'')+'</div>'
    +'<div class="setting-ctrl">'+configControl(row)+reset+'</div></div>';
}

/* A secret row renders a configured/not-set badge and a Clear button; the
   value itself is never sent by the server. */
function configSecretRow(row){
  const set=!!(row.configured||row.override_set);
  const badge=set?'<span class="badge badge-success">Configured</span>':'<span class="badge">Not set</span>';
  const desc=row.env_locked?'Set by the environment':(row.override_set?'Overridden from the panel':'');
  const clear=set&&!row.env_locked
    ? '<button class="btn btn-ghost" data-action="clearConfigSecret" data-args="'+actArgs(row.key)+'">Clear</button>':'';
  return'<div class="setting-row"><div class="setting-info"><div class="setting-name">'+esc(row.key)+' '+badge+'</div>'
    +(desc?'<div class="setting-desc">'+esc(desc)+'</div>':'')+'</div>'
    +'<div class="setting-ctrl">'+configControl(row)+clear+'</div></div>';
}

/* server.data_dir stays read-only: the overrides file, TOTP, erasure and VAPID
   keys all live inside it, so a move needs a shell copy anyway. It carries no
   data-config-key, so it is never part of the diff. */
function configReadonlyDataDir(){
  return'<div class="setting-row"><div class="setting-info"><div class="setting-name">server.data_dir <span class="badge">Read-only</span></div>'
    +'<div class="setting-desc">The overrides file and the TOTP, erasure and VAPID keys live here. Change it in config.yaml or OWNCORD_SERVER_DATA_DIR and restart; see the server configuration docs.</div></div>'
    +'<div class="setting-ctrl"></div></div>';
}

/* The upload-type lists already have live rows on the Settings page; a second
   panel value would be a third source, so link there instead. */
function configUploadsLink(){
  return'<div class="setting-row"><div class="setting-info"><div class="setting-name">Allowed / blocked file types</div>'
    +'<div class="setting-desc">These are edited live on the Settings page.</div></div>'
    +'<div class="setting-ctrl"><button class="btn btn-ghost" data-action="navigateTo" data-args="'+actArgs('settings')+'">Open Settings</button></div></div>';
}

function configSectionCard(name,rows){
  let body=rows.map(configRow).join('');
  if(name==='server')body+=configReadonlyDataDir();
  if(name==='upload')body+=configUploadsLink();
  return settingsCard(name.charAt(0).toUpperCase()+name.slice(1),body);
}

/* One card per key prefix, in the order the keys arrive (EditableKeys order). */
function configPageHTML(data){
  const settings=(data&&data.settings)||[];
  let html='<div class="page-title">Server configuration</div>'
    +'<div class="page-desc">Settings normally written in <code>config.yaml</code>. Changes apply after a server restart. The server name is on the <button class="link-btn" data-action="navigateTo" data-args="'+actArgs('settings')+'">Settings</button> page.</div>';
  if(data&&data.restart_pending){
    html+='<div class="card-note" role="status">Saved changes are waiting to apply. '
      +'<button class="btn btn-accent" data-action="restartForConfig">Restart now</button></div>';
  }
  const names=[];
  const byName={};
  settings.forEach(s=>{
    const name=String(s.key).split('.')[0];
    if(!(name in byName)){byName[name]=[];names.push(name)}
    byName[name].push(s);
  });
  names.forEach(name=>{html+=configSectionCard(name,byName[name])});
  html+='<div class="save-bar" id="configSaveBar" role="region" aria-label="Save configuration">'
    +'<span class="save-bar-status" id="configSaveState" role="status">All changes saved</span>'
    +'<button class="btn btn-ghost" id="discardConfigBtn" data-action="discardConfig" disabled>Discard</button>'
    +'<button class="btn btn-accent" id="saveConfigBtn" data-action="saveServerConfig" disabled>Save changes</button></div>';
  return html;
}

/* The typed current value of one row's control, so a number compares as a
   number and a comma-separated list compares as an array. */
function configTypedValue(row,el){
  if(row.type==='bool')return el.classList.contains('on');
  if(row.type==='int'||row.type==='float'){const raw=String(el.value).trim();return raw===''?null:Number(raw)}
  if(row.type==='list')return String(el.value).split(',').map(s=>s.trim()).filter(Boolean);
  return el.value;
}

function configEqual(a,b){
  if(Array.isArray(a)||Array.isArray(b)){
    return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>x===b[i]);
  }
  return a===b;
}

/* Only the changed keys, with typed values. An env-locked row is disabled and
   never sent: the server refuses it anyway. */
function configDiff(){
  const data=state._configData||{};
  const initial=state._configInitial||{};
  const body={};
  (data.settings||[]).forEach(row=>{
    if(row.env_locked)return;
    const el=document.querySelector('[data-config-key="'+row.key+'"]');
    if(!el)return;
    const typed=configTypedValue(row,el);
    if(!configEqual(typed,initial[row.key]))body[row.key]=typed;
  });
  return body;
}

function markConfigChanged(){setConfigChanged(true)}

function applyConfigResponse(data){
  state._configData=data;
  state._configInitial=configInitialValues(data);
  setConfigChanged(false);
  const content=document.getElementById('content');
  if(content)content.innerHTML=configPageHTML(data);
}

async function renderServerConfig(){
  let data;
  try{data=await api('GET','/config/settings')}
  catch(e){return'<div class="page-title">Server configuration</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  state._configData=data;
  state._configInitial=configInitialValues(data);
  setConfigChanged(false);
  return configPageHTML(data);
}

function configNeedsConfirmation(key){
  const data=state._configData||{};
  const row=(data.settings||[]).find(s=>s.key===key);
  return !!(row&&row.requires_confirmation);
}

async function sendConfigPatch(body,headers){
  try{
    applyConfigResponse(await api('PATCH','/config/settings',body,headers));
    showToast('Configuration saved — restart to apply');
  }catch(e){
    showToast(e.message,'error');
    const btn=document.getElementById('saveConfigBtn');
    if(btn instanceof HTMLButtonElement)btn.disabled=false;
  }
}

async function saveServerConfig(){
  const btn=document.getElementById('saveConfigBtn');
  if(btn instanceof HTMLButtonElement){if(btn.disabled)return;btn.disabled=true}
  const body=configDiff();
  if(!Object.keys(body).length){setConfigChanged(false);showToast('Configuration saved');return}
  const confirmKeys=Object.keys(body).filter(configNeedsConfirmation);
  if(confirmKeys.length){
    state._configPending=body;
    openConfigConfirmModal(confirmKeys);
    return;
  }
  await sendConfigPatch(body,{});
}

/* One-line risk text per lock-out-capable key, shown before the typed
   confirmation. The server enforces the guards regardless of the wording. */
const CONFIG_RISKS={
  'server.port':'the server will listen on a new port; the panel moves with it',
  'tls.mode':'the panel scheme can change and the old URL may stop answering',
  'tls.domain':'the TLS identity changes',
  'tls.cert_file':'the TLS certificate changes',
  'tls.key_file':'the TLS key changes',
  'tls.acme_cache_dir':'the ACME certificate cache moves',
  'server.admin_allowed_cidrs':'a wrong list locks you out of the panel',
  'server.trusted_proxies':'a wrong list lets clients forge their address',
  'server.restart_mode':'the wrong mode can leave nothing to restart the server',
  'database.path':'the server opens a different database',
  'upload.storage_dir':'attachments move; an empty target makes them 404',
  'backup.dir':'backups move to a different directory',
  'plugins.directory':'plugins load from a different directory',
  'voice.livekit_binary':'the server executes this binary'
};
function configRiskText(key){return CONFIG_RISKS[key]||'a change that can lock you out or move server data'}

function openConfigConfirmModal(keys){
  const risks=keys.map(k=>'<li><code>'+esc(k)+'</code> — '+esc(configRiskText(k))+'</li>').join('');
  openModal('<div class="modal-header"><h3>Confirm configuration change</h3></div>'
    +'<div class="modal-body"><p>These changes can lock you out of the panel or move the data the server runs on. If one goes wrong, stop the server, edit <code>&lt;data_dir&gt;/config-overrides.json</code> on the host and delete the key, then start it again.</p>'
    +'<ul>'+risks+'</ul>'
    +typedConfirmField('CONFIRM')+'</div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button>'
    +'<button class="btn btn-danger" id="typedConfirmBtn" disabled data-action="confirmServerConfig">Save changes</button></div>');
}

async function confirmServerConfig(){
  if(!typedConfirmed('CONFIRM'))return;
  const body=state._configPending;
  if(!body)return;
  state._configPending=null;
  const keys=Object.keys(body).filter(configNeedsConfirmation);
  await sendConfigPatch(body,{'X-OwnCord-Confirm':keys.join(',')});
}

async function clearConfigSecret(key){
  try{
    applyConfigResponse(await api('PATCH','/config/settings',{[key]:''}));
    showToast('Secret cleared');
  }catch(e){showToast(e.message,'error')}
}

async function resetConfigKey(key){
  try{
    applyConfigResponse(await api('PATCH','/config/settings',{[key]:null}));
    showToast('Setting reset');
  }catch(e){showToast(e.message,'error')}
}

function discardConfig(){state._configPending=null;renderContent()}

/* A port or scheme change moves the panel: the old origin will not answer the
   reload poll, so show the new address instead of waitForRestart. */
function configMovedAddress(){
  const data=state._configData||{};
  let moved=false,port=null,mode=null;
  (data.settings||[]).forEach(s=>{
    if(s.override==null||s.override===s.value)return;
    if(s.key==='server.port'){moved=true;port=s.override}
    if(s.key==='tls.mode'){moved=true;mode=s.override}
  });
  if(!moved)return'';
  const row=k=>(data.settings||[]).find(s=>s.key===k)||{};
  const p=port!=null?port:row('server.port').value;
  const m=mode!=null?mode:row('tls.mode').value;
  return (m==='off'?'http':'https')+'://'+location.hostname+':'+p+'/admin';
}

function configNewAddressHTML(addr){
  return'<div class="modal-header"><h3>Restarting</h3></div><div class="modal-body"><p>The server is restarting to apply the saved configuration. This page cannot follow a port or scheme change, so open the panel at:</p>'
    +'<p><a href="'+esc(addr)+'">'+esc(addr)+'</a></p></div>';
}

async function restartForConfig(){
  if(!confirm('Restart the server now to apply the saved configuration?'))return;
  const addr=configMovedAddress();
  try{
    await api('POST','/restart');
    lockModal(true);
    if(addr)setModalHTML(configNewAddressHTML(addr));
    else{setModalHTML(restartingHTML('Restarting','The server is restarting to apply the saved configuration.'));waitForRestart('restartWait')}
  }catch(e){showToast(e.message,'error')}
}

Object.assign(ACTIONS,{
  markConfigChanged,saveServerConfig,resetConfigKey,restartForConfig,discardConfig,
  confirmServerConfig,clearConfigSecret,
  toggleConfigKey(){toggleSwitch(this);markConfigChanged()}});
