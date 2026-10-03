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
  ((data&&data.settings)||[]).forEach(s=>{out[s.key]=s.env_locked?s.value:(s.override!=null?s.override:s.value)});
  return out;
}

function configRowValue(row){
  return row.env_locked?row.value:(row.override!=null?row.override:row.value);
}

function configControl(row){
  const value=configRowValue(row);
  const key=esc(row.key);
  const dis=row.env_locked?' disabled':'';
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
  const overridden=row.override!=null;
  const desc=row.env_locked?'Set by the environment':(overridden?'Overridden from the panel':'');
  const reset=overridden&&!row.env_locked
    ? '<button class="btn btn-ghost" data-action="resetConfigKey" data-args="'+actArgs(row.key)+'">Reset</button>':'';
  return'<div class="setting-row"><div class="setting-info"><div class="setting-name">'+esc(row.key)+'</div>'
    +(desc?'<div class="setting-desc">'+esc(desc)+'</div>':'')+'</div>'
    +'<div class="setting-ctrl">'+configControl(row)+reset+'</div></div>';
}

function configSectionCard(title,rows){
  return settingsCard(title.charAt(0).toUpperCase()+title.slice(1),rows.map(configRow).join(''));
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

async function saveServerConfig(){
  const btn=document.getElementById('saveConfigBtn');
  if(btn instanceof HTMLButtonElement){if(btn.disabled)return;btn.disabled=true}
  const body=configDiff();
  if(!Object.keys(body).length){setConfigChanged(false);showToast('Configuration saved');return}
  try{
    applyConfigResponse(await api('PATCH','/config/settings',body));
    showToast('Configuration saved — restart to apply');
  }catch(e){
    showToast(e.message,'error');
    if(btn instanceof HTMLButtonElement)btn.disabled=false;
  }
}

async function resetConfigKey(key){
  try{
    applyConfigResponse(await api('PATCH','/config/settings',{[key]:null}));
    showToast('Setting reset');
  }catch(e){showToast(e.message,'error')}
}

function discardConfig(){renderContent()}

async function restartForConfig(){
  if(!confirm('Restart the server now to apply the saved configuration?'))return;
  try{
    await api('POST','/restart');
    lockModal(true);
    setModalHTML(restartingHTML('Restarting','The server is restarting to apply the saved configuration.'));
    waitForRestart('restartWait');
  }catch(e){showToast(e.message,'error')}
}

Object.assign(ACTIONS,{
  markConfigChanged,saveServerConfig,resetConfigKey,restartForConfig,discardConfig,
  toggleConfigKey(){toggleSwitch(this);markConfigChanged()}});
