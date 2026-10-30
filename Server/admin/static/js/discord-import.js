/* OwnCord admin panel: the "Import from Discord" card on the Channels page. */

/* One import runs at a time, server-wide, so the card keeps one job. Every
   piece of text that came from the server or the chosen file is set with
   textContent, never written into markup. */
const IMPORT_POLL_MS=2000;
const importUI={job:null,retentionDays:0,maxBytes:0,busy:false,notice:'',pollTimer:null,token:'',cancelling:false};

function importEl(tag,cls,text){
  const e=document.createElement(tag);
  if(cls)e.className=cls;
  if(text!==undefined&&text!==null)e.textContent=text;
  return e;
}
function importCount(n,word){return n+' '+word+(n===1?'':'s')}

/* The sentence for a finished job: what went in and what was left out, or why
   it stopped. */
function importResultText(job){
  if(!job)return'';
  if(job.status==='done'){
    let t='Imported '+importCount(job.imported,'message')+'.';
    if(job.skipped>0)t+=' Skipped '+importCount(job.skipped,'message')+' it could not take.';
    if(job.skipped_attachments>0)t+=' Skipped '+importCount(job.skipped_attachments,'attachment')+' (not in the export, a blocked type or too large).';
    return t;
  }
  if(job.status==='cancelled')return'The import was cancelled and nothing was kept.';
  if(job.status==='failed')return'The import failed and nothing was kept'+(job.error?': '+job.error:'.');
  return'';
}

/* The sentence for a failure that carried no JSON message. */
function importHttpError(status){
  if(status===413)return'The file is larger than this server or a reverse proxy in front of it allows.';
  return'The import could not be started (the server answered '+status+').';
}

function importRunning(){return !!(importUI.job&&importUI.job.status==='running')}

/* Redraws the card from importUI. Safe to call whenever the card is on the
   page and a no-op when it is not. */
function paintImportCard(){
  const card=document.getElementById('discordImportCard');
  if(!card)return;
  card.replaceChildren();
  const head=importEl('div','section-card-header');
  head.appendChild(importEl('h3','','Import from Discord'));
  card.appendChild(head);
  const body=importEl('div','section-card-body');
  card.appendChild(body);

  const help=importEl('p','support-note');
  help.textContent='Bring a Discord channel’s history in as a new text channel. In DiscordChatExporter choose the JSON format and turn on “Download media”, then zip the .json file together with its _Files folder. A .json file on its own imports the text only.';
  body.appendChild(help);
  if(importUI.retentionDays>0){
    const warn=importEl('div','callout-warning','Message retention is on: messages older than '+importCount(importUI.retentionDays,'day')+' are deleted automatically, imported ones included. History older than that disappears with the next retention sweep.');
    warn.setAttribute('role','note');
    body.appendChild(warn);
  }

  if(importRunning())paintImportProgress(body);
  else paintImportForm(body);

  if(importUI.notice){
    const n=importEl('div','callout-warning',importUI.notice);
    n.setAttribute('role','alert');
    body.appendChild(n);
  }
  if(!importRunning()&&importUI.job){
    const r=importEl('p','support-note','Last import ('+importUI.job.source_name+'): '+importResultText(importUI.job));
    r.id='discordImportResult';
    body.appendChild(r);
  }
}

function paintImportProgress(body){
  const job=importUI.job;
  const bar=importEl('progress','import-bar');
  bar.setAttribute('aria-label','Import progress');
  body.appendChild(bar);
  const line=importEl('p','support-note',importUI.cancelling
    ?'Cancelling…'
    :'Importing '+job.source_name+': '+importCount(job.imported,'message')+' so far…');
  line.id='discordImportProgress';
  line.setAttribute('role','status');
  body.appendChild(line);
  const cancel=importEl('button','btn btn-outline','Cancel import');
  cancel.setAttribute('data-action','cancelDiscordImport');
  cancel.disabled=importUI.cancelling;
  body.appendChild(cancel);
}

function paintImportForm(body){
  const file=importEl('div','form-group');
  const fl=importEl('label','form-label','Export file (.json or .zip)');
  fl.htmlFor='discordImportFile';
  const input=importEl('input','form-input');
  input.type='file';input.id='discordImportFile';input.accept='.json,.zip';
  input.disabled=importUI.busy;
  file.append(fl,input);
  if(importUI.maxBytes>0)file.appendChild(importEl('div','setting-desc','Up to '+fmtBytes(importUI.maxBytes)+' (upload.import_max_mb).'));
  body.appendChild(file);

  const cat=importEl('div','form-group');
  const cl=importEl('label','form-label','Category');
  cl.htmlFor='discordImportCategory';
  const sel=importEl('select','form-input');
  sel.id='discordImportCategory';sel.style.appearance='auto';sel.disabled=importUI.busy;
  const none=importEl('option','','No category');
  none.value='0';
  sel.appendChild(none);
  (state.categoryList||[]).forEach(c=>{
    const o=importEl('option','',c.name);
    o.value=String(c.id);
    sel.appendChild(o);
  });
  cat.append(cl,sel);
  body.appendChild(cat);

  const go=importEl('button','btn btn-accent',importUI.busy?'Uploading…':'Import');
  go.id='discordImportGo';
  go.setAttribute('data-action','startDiscordImport');
  go.disabled=importUI.busy;
  body.appendChild(go);
}

/* Loads the newest job and the form facts, then keeps polling while it runs,
   so a reopened panel finds an import in progress. */
async function initDiscordImport(){
  const token=state.token;
  importUI.token=token;importUI.notice='';
  try{
    const r=await api('GET','/discord-imports/latest');
    if(state.token!==token)return;
    importUI.job=r.job;importUI.retentionDays=r.retention_days||0;importUI.maxBytes=r.max_upload_bytes||0;
  }catch(e){
    if(state.token!==token)return;
    importUI.notice=e.status===503?'Import from Discord is not available on this server.':e.message;
  }
  paintImportCard();
  if(importRunning())scheduleImportPoll();
}

function scheduleImportPoll(){
  if(importUI.pollTimer)clearTimeout(importUI.pollTimer);
  importUI.pollTimer=setTimeout(pollDiscordImport,IMPORT_POLL_MS);
}

/* One status read. The chain ends when the job ends, the card leaves the page
   or the session changes. */
async function pollDiscordImport(){
  importUI.pollTimer=null;
  const token=state.token;
  if(!document.getElementById('discordImportCard')||!importRunning()||token!==importUI.token)return;
  try{
    const job=await api('GET','/discord-imports/'+importUI.job.id);
    if(state.token!==token)return;
    importUI.job=job;
    if(job.status!=='running'){
      importUI.cancelling=false;
      showToast(importResultText(job),job.status==='failed'?'error':'success');
      if(job.status==='done'&&state.section==='channels'){renderContent();return}
    }
  }catch(e){
    if(state.token!==token)return;
    importUI.notice=e.message;
  }
  paintImportCard();
  if(importRunning())scheduleImportPoll();
}

async function startDiscordImport(){
  const input=/** @type {HTMLInputElement|null} */(document.getElementById('discordImportFile'));
  const file=input&&input.files&&input.files[0];
  importUI.notice='';
  if(!file){importUI.notice='Choose the export file first.';paintImportCard();return}
  if(!/\.(json|zip)$/i.test(file.name)){importUI.notice='The export must be a .json or .zip file.';paintImportCard();return}
  const sel=/** @type {HTMLSelectElement|null} */(document.getElementById('discordImportCategory'));
  const categoryId=sel?sel.value:'0';
  const token=state.token;
  importUI.busy=true;paintImportCard();
  try{
    const res=await fetch('/admin/api/discord-imports/upload?filename='+encodeURIComponent(file.name)+'&category_id='+encodeURIComponent(categoryId),
      {method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream'},body:file});
    if(state.token!==token)return;
    if(res.status===401){handleSessionExpired();return}
    /* A proxy in front of the server answers with a page, not JSON. */
    const isJson=/json/i.test((res.headers&&res.headers.get('content-type'))||'');
    const data=isJson?await res.json():{};
    if(state.token!==token)return;
    if(!res.ok)throw new Error(data.message||importHttpError(res.status));
    importUI.job={id:data.id,status:'running',source_name:file.name,imported:0,skipped:0,skipped_attachments:0,error:null};
    importUI.cancelling=false;importUI.token=token;
    scheduleImportPoll();
  }catch(e){
    if(state.token===token)importUI.notice=e.message;
  }finally{
    if(state.token===token){importUI.busy=false;paintImportCard()}
  }
}

async function cancelDiscordImport(){
  if(!importRunning()||importUI.cancelling)return;
  const token=state.token;
  importUI.cancelling=true;importUI.notice='';paintImportCard();
  try{await api('POST','/discord-imports/'+importUI.job.id+'/cancel')}
  catch(e){
    if(state.token!==token)return;
    importUI.cancelling=false;importUI.notice=e.message;paintImportCard();
  }
}

Object.assign(ACTIONS,{startDiscordImport,cancelDiscordImport});
