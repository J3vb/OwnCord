/* OwnCord admin panel: Channels, the channel permission overrides and access
   explanation, Roles, and Emoji. */

/* ═══ Channels ═══ */
/* The page header: title and summary on the left, the page's primary action
   on the right (it wraps under the title on a narrow window). */
function rcHead(title,desc,action){
  return '<div class="rc-head"><div><h1 class="page-title">'+title+'</h1><div class="page-desc">'+desc+'</div></div>'+action+'</div>';
}

async function renderChannels(){
  let channels;
  try{channels=await api('GET','/channels')}catch(e){return'<div class="page-title">Channels</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  /* Every category, empty ones too: a category with no channel has no header
     row below but still carries a permission template. */
  let cats=[];
  try{cats=await api('GET','/channels/categories')}catch(e){cats=[]}
  state.categoryList=Array.isArray(cats)?cats:[];
  const chIcon=t=>t==='voice'?I.voice:t==='announcement'?I.megaphone:I.channels;
  /* Categories are free text — a channel of any type may live under any one of
     them. Collect the ones already in use so the create/edit forms can offer
     them as a datalist instead of hardcoding names nobody has to use. */
  const catSet=new Set();
  let html=rcHead('Channels',channels.length+' channel'+(channels.length===1?'':'s')+', grouped by category as members see them.',
    '<button class="btn btn-accent" data-action="openChannelModal" data-args="'+actArgs(null)+'">'+I.plus+' Create Channel</button>');
  /* Grouped under their category like the client sidebar: an uncategorised
     voice channel sits under Voice, and groups come in the order their first
     channel does. The type is the row's icon (named for screen readers), and
     Archived shows only on a channel that is. */
  const groups=new Map();
  const catIds=new Map();
  channels.forEach(ch=>{
    const cat=ch.category||ch.Category||((ch.type||ch.Type)==='voice'?'Voice':'');
    if(!groups.has(cat))groups.set(cat,[]);
    groups.get(cat).push(ch);
    if(ch.category_id)catIds.set(cat,ch.category_id);
  });
  if(state.categoryList.length){
    /* The permission template of a category, edited in the same matrix a
       channel uses. Saving writes the same rows to every channel that is
       synced with the category. */
    html+='<div class="section-card"><div class="section-card-body"><div class="form-group" style="margin-bottom:0"><label class="form-label" for="catPermPick">Category permissions</label>'
      +'<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><select class="form-input" id="catPermPick" style="appearance:auto;max-width:280px">'
      +state.categoryList.map(c=>'<option value="'+esc(c.id)+'">'+esc(c.name)+'</option>').join('')
      +'</select><button class="btn btn-outline" data-action="openCategoryPermsPicker">Edit permissions</button></div>'
      +'<div style="font-size:11px;color:var(--text-muted);margin-top:4px">A category\'s permissions are a template. Channels marked &ldquo;Synced with category&rdquo; follow it; editing a channel\'s own permissions stops that.</div></div></div></div>';
  }
  html+='<div class="section-card"><div class="section-card-body no-pad"><table class="tbl ch-tbl"><thead><tr><th>Channel</th><th style="text-align:right">Actions</th></tr></thead>';
  if(!channels.length)html+='<tbody><tr><td colspan="2" class="tbl-empty">No channels yet. Create one to get started.</td></tr></tbody>';
  groups.forEach((chs,cat)=>{
    html+='<tbody>';
    if(groups.size>1||cat){
      const cid=catIds.get(cat);
      html+='<tr class="ch-cat"><th colspan="2" scope="rowgroup">'+esc(cat||'No category')
        +(cid?' <button class="act-btn" title="Category permissions" aria-label="Permissions for category '+esc(cat)+'" data-action="openCategoryPermsModal" data-args="'+actArgs(cid,cat)+'">'+I.lock+'</button>':'')+'</th></tr>';
    }
    chs.forEach(ch=>{
      const id=ch.id||ch.ID;const name=ch.name||ch.Name||'';const type=ch.type||ch.Type||'text';
      const archived=ch.archived||ch.Archived||false;
      html+='<tr data-channel="'+esc(id)+'"><td><div class="ch-name"><span class="ch-type" title="'+esc(CH_TYPE_NAME[type]||type)+'">'+chIcon(type)+'<span class="sr-only">'+esc(CH_TYPE_NAME[type]||type)+'</span></span><strong>'+esc(name)+'</strong>'
        +(archived?'<span class="badge badge-muted">Archived</span>':'')+(ch.afk?'<span class="badge badge-accent">AFK</span>':'')
        +(ch.permissions_synced?'<span class="badge badge-green">Synced with category</span>':'')
        +(ch.category_id&&!ch.permissions_synced?'<button class="btn btn-ghost btn-sm" aria-label="Sync #'+esc(name)+' with its category" data-action="syncChannelPerms" data-args="'+actArgs(id,name)+'">Sync now</button>':'')+'</div></td>';
      const lockBtn=type==='dm'?'':'<button class="act-btn" title="Who can see this" aria-label="Who can see #'+esc(name)+'" data-action="openChannelPermsModal" data-args="'+actArgs(id,name)+'">'+I.lock+'</button>';
      state.channelCache[id]=ch;
      if(ch.category||ch.Category)catSet.add(ch.category||ch.Category);
      html+='<td><div class="act-group" style="justify-content:flex-end"><button class="act-btn" title="Edit" aria-label="Edit #'+esc(name)+'" data-action="openChannelEditModal" data-args="'+actArgs(id)+'">'+I.edit+'</button>'+lockBtn+'<button class="act-btn danger" title="Delete" aria-label="Delete #'+esc(name)+'" data-action="openDeleteChannel" data-args="'+actArgs(id,name)+'">'+I.trash+'</button></div></td></tr>';
    });
    html+='</tbody>';
  });
  html+='</table></div></div>';
  state.channelCategories=[...catSet].sort();
  return html;
}
/* A channel type in words, beside its icon. */
const CH_TYPE_NAME={text:'Text channel',voice:'Voice channel',announcement:'Announcement channel',forum:'Forum channel',dm:'Direct message'};

/* <datalist> of the categories currently in use. Purely a suggestion list —
   typing a brand-new name is the supported way to create a category. */
function categoryDatalist(listId){
  const cats=state.channelCategories||[];
  let html='<datalist id="'+listId+'">';
  cats.forEach(c=>{html+='<option value="'+esc(c)+'"></option>'});
  return html+'</datalist>';
}

function openChannelModal(){
  openModal('<div class="modal-header"><h3>Create Channel</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><div class="form-group"><label class="form-label" for="chName">Name <span class="req">*</span></label><input class="form-input" id="chName" placeholder="general"></div><div class="form-group"><label class="form-label" for="chType">Type</label><select class="form-input" id="chType" style="appearance:auto" data-change-action="onChannelTypeChange"><option value="text">Text</option><option value="voice">Voice</option><option value="announcement">Announcement</option><option value="forum">Forum</option></select></div><div class="form-group"><label class="form-label" for="chCat">Category</label><input class="form-input" id="chCat" list="chCatList" placeholder="Text Channels" autocomplete="off">'+categoryDatalist('chCatList')+'<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Any name works, for voice and text channels alike. Leave blank for no category.</div></div><div class="form-group"><label class="form-label" for="chTopic">Topic</label><input class="form-input" id="chTopic"><div id="chTopicHint" style="font-size:11px;color:var(--text-muted);margin-top:4px" hidden>For a forum the topic is its guidelines, shown above the posts. Tags are set after creating it, with Edit.</div></div><div class="form-group"><label class="form-label" for="chPos">Position</label><input class="form-input" id="chPos" type="number" value="0" min="0"></div></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-accent" data-action="createChannel">Create</button></div>');
}

/* A forum's topic is its guidelines, and its tags come after it exists. */
function onChannelTypeChange(){
  const hint=document.getElementById('chTopicHint');
  if(hint)hint.hidden=fsInput(document,'#chType').value!=='forum';
}

async function createChannel(){
  const body={name:document.getElementById('chName').value.trim(),type:document.getElementById('chType').value,category:document.getElementById('chCat').value.trim(),topic:document.getElementById('chTopic').value.trim(),position:parseInt(document.getElementById('chPos').value)||0};
  if(!body.name){showToast('Name is required','error');return}
  try{await api('POST','/channels',body);closeModal();showToast('Channel created');renderContent()}catch(e){showToast(e.message,'error')}
}

/* PATCH /channels/{id} accepts name, topic, category, slow_mode, position,
   archived, nsfw and the two voice capacity limits — the modal used to offer
   only the name, so the Archived column in the table was read-only state with
   no control behind it.

   NSFW is a flag and nothing more: the server stores, broadcasts and audits it
   but applies no content behaviour to a flagged channel. Clients decide what to
   do with it (the desktop client shows a per-session age gate).

   The voice limits are only rendered for a voice channel. They are stored on
   any type, but on a text channel they are values nothing will ever read, and
   offering them there would imply an enforcement that does not exist. */
function openChannelEditModal(id){
  const ch=state.channelCache[id]||{};
  const name=ch.name||ch.Name||'';
  const topic=ch.topic||ch.Topic||'';
  const cat=ch.category||ch.Category||'';
  const slow=ch.slow_mode||ch.SlowMode||0;
  const pos=ch.position||ch.Position||0;
  const archived=ch.archived||ch.Archived||false;
  const nsfw=ch.nsfw||ch.NSFW||false;
  const type=ch.type||ch.Type||'text';
  const maxUsers=ch.voice_max_users||ch.VoiceMaxUsers||0;
  const maxVideo=ch.voice_max_video||ch.VoiceMaxVideo||0;
  const voiceRows=type!=='voice'?'':
     '<div class="form-group"><label class="form-label" for="chEditMaxUsers">User limit (0 = unlimited)</label><input class="form-input" id="chEditMaxUsers" type="number" min="0" max="99" value="'+esc(maxUsers)+'"></div>'
    +'<div class="form-group"><label class="form-label" for="chEditMaxVideo">Video limit (0 = unlimited)</label><input class="form-input" id="chEditMaxVideo" type="number" min="0" max="99" value="'+esc(maxVideo)+'"></div>';
  const forumRows=type==='forum'?forumSettingsHtml(id,ch.forum||ch.Forum):'';
  openModal('<div class="modal-header"><h3>Edit Channel</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'
    +'<div class="modal-body">'
    +'<div class="form-group"><label class="form-label" for="chEditName">Name</label><input class="form-input" id="chEditName" value="'+esc(name)+'"></div>'
    +'<div class="form-group"><label class="form-label" for="chEditTopic">Topic</label><input class="form-input" id="chEditTopic" value="'+esc(topic)+'"></div>'
    +'<div class="form-group"><label class="form-label" for="chEditCat">Category</label><input class="form-input" id="chEditCat" list="chEditCatList" value="'+esc(cat)+'" data-orig="'+esc(cat.trim())+'" autocomplete="off">'+categoryDatalist('chEditCatList')+'<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Move the channel to another category, or blank it to leave it uncategorized.</div></div>'
    +'<div class="form-group"><label class="form-label" for="chEditSlow">Slow mode (seconds, 0 = off)</label><input class="form-input" id="chEditSlow" type="number" min="0" value="'+esc(slow)+'"></div>'
    +'<div class="form-group"><label class="form-label" for="chEditPos">Position</label><input class="form-input" id="chEditPos" type="number" min="0" value="'+esc(pos)+'"></div>'
    +voiceRows
    +'<div class="setting-row"><div class="setting-info"><div class="setting-name" id="chEditArchived-name">Archived</div><div class="setting-desc">Hide the channel without deleting its messages</div></div><div class="setting-ctrl"><button class="toggle '+(archived?'on':'')+'" id="chEditArchived" role="switch" aria-checked="'+(archived?'true':'false')+'" aria-labelledby="chEditArchived-name" data-action="toggleSwitch"></button></div></div>'
    +'<div class="setting-row"><div class="setting-info"><div class="setting-name" id="chEditNsfw-name">Age-restricted (NSFW)</div><div class="setting-desc">Clients show a one-time warning and mark the channel. The server does not filter or restrict anything.</div></div><div class="setting-ctrl"><button class="toggle '+(nsfw?'on':'')+'" id="chEditNsfw" role="switch" aria-checked="'+(nsfw?'true':'false')+'" aria-labelledby="chEditNsfw-name" data-action="toggleSwitch"></button></div></div>'
    +forumRows
    +'</div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-accent" data-action="saveChannelEdit" data-args="'+actArgs(id)+'">Save</button></div>');
}

async function saveChannelEdit(id){
  const name=document.getElementById('chEditName').value.trim();
  if(!name){showToast('Name is required','error');return}
  const body={
    name,
    topic:document.getElementById('chEditTopic').value.trim(),
    slow_mode:parseInt(document.getElementById('chEditSlow').value,10)||0,
    position:parseInt(document.getElementById('chEditPos').value,10)||0,
    archived:document.getElementById('chEditArchived').classList.contains('on'),
    nsfw:document.getElementById('chEditNsfw').classList.contains('on'),
  };
  /* Send category only when the input differs from what the modal opened
     with. The row's name can be stale (a category renamed since the list
     loaded), and echoing it back would recreate the old name. */
  const catEl=document.getElementById('chEditCat');
  const catNow=catEl.value.trim();
  if(catNow!==(catEl.dataset.orig||'')){body.category=catNow}
  /* Only present for a voice channel. Omitting them entirely (rather than
     sending 0) is what keeps a text-channel edit from clobbering limits a
     channel might carry from an earlier life as a voice channel — the handler
     starts from the stored values for every field the body leaves out. */
  const maxUsersEl=document.getElementById('chEditMaxUsers');
  const maxVideoEl=document.getElementById('chEditMaxVideo');
  if(maxUsersEl){body.voice_max_users=parseInt(maxUsersEl.value,10)||0}
  if(maxVideoEl){body.voice_max_video=parseInt(maxVideoEl.value,10)||0}
  try{await api('PATCH','/channels/'+id,body);closeModal();showToast('Channel updated');renderContent()}catch(e){showToast(e.message,'error')}
}

/* ═══ Forum settings (WP 6.9d) ═══ */
/* PUT /channels/{id}/forum replaces the forum's whole settings: a tag sent with
   its id is renamed in place (posts keep it), one without an id is created, and
   a tag the list leaves out is deleted with its links to posts. The list order
   is the display order. The section sits in the Edit Channel dialog and saves on
   its own button; the limits below mirror Server/service/forum_settings.go. */
const FORUM_MAX_TAGS=20,FORUM_MAX_TAG_NAME=20,FORUM_MAX_TAG_EMOJI=34;
const FORUM_ARCHIVE=[[60,'1 hour'],[1440,'24 hours'],[4320,'3 days'],[10080,'1 week']];
function forumRuneLen(v){return Array.from(v).length}
/* The settings as one comparable string: what the dialog opened on, and what
   the server holds when Save is pressed. */
function forumKey(f){
  const tags=((f&&f.tags)||[]).slice().sort((a,b)=>(a.position||0)-(b.position||0)).map(t=>[t.id,t.name,t.emoji||'']);
  return JSON.stringify([tags,!!(f&&f.require_tag),(f&&f.default_auto_archive_minutes)||4320]);
}
function forumTagRowHtml(t,i,n){
  const label=t.name.trim()||'this tag';
  return '<div class="fs-row" data-tag-id="'+esc(t.id||0)+'">'
    +'<input class="form-input fs-emoji" aria-label="Tag '+(i+1)+' emoji" placeholder="Emoji" autocomplete="off" value="'+esc(t.emoji||'')+'">'
    +'<input class="form-input fs-name" aria-label="Tag '+(i+1)+' name" placeholder="Name" autocomplete="off" value="'+esc(t.name)+'">'
    +'<button class="act-btn" type="button" title="Move up" aria-label="Move '+esc(label)+' up"'+(i===0?' disabled':'')+' data-focus="fsup-'+i+'" data-action="forumTagMove" data-args="'+actArgs(i,-1)+'">'+I.arrowUp+'</button>'
    +'<button class="act-btn" type="button" title="Move down" aria-label="Move '+esc(label)+' down"'+(i===n-1?' disabled':'')+' data-focus="fsdown-'+i+'" data-action="forumTagMove" data-args="'+actArgs(i,1)+'">'+I.arrowDown+'</button>'
    +'<button class="act-btn danger" type="button" title="Remove" aria-label="Remove '+esc(label)+'" data-action="forumTagRemove" data-args="'+actArgs(i)+'">'+I.trash+'</button></div>';
}
function forumTagsHtml(rows){
  const body=rows.length?rows.map((t,i)=>forumTagRowHtml(t,i,rows.length)).join(''):'<div class="fs-hint">No tags yet.</div>';
  return body+'<div class="fs-foot"><button class="btn btn-outline btn-sm" type="button" data-action="forumTagAdd"'+(rows.length>=FORUM_MAX_TAGS?' disabled':'')+'>'+I.plus+' Add tag</button><span class="fs-hint">'+rows.length+'/'+FORUM_MAX_TAGS+' tags</span></div>';
}
function forumSettingsHtml(id,forum){
  const f=forum||{tags:[],require_tag:false,default_auto_archive_minutes:4320};
  state.forumEdit={id,key:forumKey(f)};
  const rows=(f.tags||[]).slice().sort((a,b)=>(a.position||0)-(b.position||0)).map(t=>({id:t.id,name:t.name,emoji:t.emoji||''}));
  const opts=FORUM_ARCHIVE.map(o=>'<option value="'+o[0]+'"'+(o[0]===f.default_auto_archive_minutes?' selected':'')+'>'+o[1]+'</option>').join('');
  return '<div class="fs-section" id="forumSettings"><div class="fs-title">Forum settings</div>'
    +'<div class="form-group"><label class="form-label" id="fsTags-label">Tags</label><div id="fsTags" role="group" aria-labelledby="fsTags-label">'+forumTagsHtml(rows)+'</div>'
    +'<div class="fs-hint">Members pick up to 5 per post. Renaming a tag keeps it on its posts; removing one takes it off them.</div></div>'
    +'<div class="setting-row"><div class="setting-info"><div class="setting-name" id="fsRequire-name">Require a tag on new posts</div><div class="setting-desc">A post cannot be created without at least one tag.</div></div><div class="setting-ctrl"><button class="toggle '+(f.require_tag?'on':'')+'" id="fsRequire" role="switch" aria-checked="'+(f.require_tag?'true':'false')+'" aria-labelledby="fsRequire-name" data-action="toggleSwitch"></button></div></div>'
    +'<div class="form-group"><label class="form-label" for="fsArchive">Default auto-archive</label><select class="form-input" id="fsArchive" style="appearance:auto">'+opts+'</select><div class="fs-hint">How long a new post may sit idle before it is archived.</div></div>'
    +'<div class="fs-hint">Forum settings save on their own button; the fields above save with Save.</div>'
    +'<div class="fs-actions"><button class="btn btn-outline" type="button" id="fsSave" data-action="saveForumSettings" data-args="'+actArgs(id)+'">Save forum settings</button></div></div>';
}
/** @param {ParentNode} root @param {string} sel @returns {HTMLInputElement} */
function fsInput(root,sel){return /** @type {HTMLInputElement} */(root.querySelector(sel))}
function readForumRows(){
  return [...document.querySelectorAll('#fsTags div.fs-row')].map(r=>({
    id:parseInt(r instanceof HTMLElement&&r.dataset.tagId||'0',10)||0,
    name:fsInput(r,'.fs-name').value,
    emoji:fsInput(r,'.fs-emoji').value}));
}
function paintForumRows(rows,focus){
  document.getElementById('fsTags').innerHTML=forumTagsHtml(rows);
  markModalDirty();
  const el=focus&&document.querySelector('#fsTags button[data-focus="'+focus+'"]:not(:disabled)')||(focus==='new'&&[...document.querySelectorAll('#fsTags input.fs-name')].pop());
  if(el instanceof HTMLElement)el.focus();
}
function forumTagAdd(){
  const rows=readForumRows();
  if(rows.length>=FORUM_MAX_TAGS)return;
  rows.push({id:0,name:'',emoji:''});
  paintForumRows(rows,'new');
}
function forumTagRemove(i){
  const rows=readForumRows();
  rows.splice(i,1);
  paintForumRows(rows,'');
  const next=document.querySelector('#fsTags input.fs-name')||document.querySelector('#fsTags button[data-action="forumTagAdd"]');
  if(next instanceof HTMLElement)next.focus();
}
function forumTagMove(i,delta){
  const rows=readForumRows();
  const j=i+delta;
  if(j<0||j>=rows.length)return;
  [rows[i],rows[j]]=[rows[j],rows[i]];
  paintForumRows(rows,(delta<0?'fsup-':'fsdown-')+j);
}
/* What the server would refuse, said before the round trip. */
function forumProblem(rows){
  const seen=new Set();
  for(const t of rows){
    const n=t.name.trim();
    if(!n||forumRuneLen(n)>FORUM_MAX_TAG_NAME)return'Every tag needs a name of 1 to '+FORUM_MAX_TAG_NAME+' characters';
    if(seen.has(n.toLowerCase()))return'Tag names must be different';
    seen.add(n.toLowerCase());
    const e=t.emoji.trim();
    if(e&&(forumRuneLen(e)>FORUM_MAX_TAG_EMOJI||/[\u0000-\u001f\u007f]/.test(e)))return'A tag\'s emoji must be a single emoji';
  }
  return rows.length>FORUM_MAX_TAGS?'A forum holds at most '+FORUM_MAX_TAGS+' tags':'';
}
async function saveForumSettings(id){
  const rows=readForumRows();
  const problem=forumProblem(rows);
  if(problem){showToast(problem,'error');return}
  const body={
    tags:rows.map(t=>{const e=t.emoji.trim();const o={name:t.name.trim()};if(t.id)o.id=t.id;if(e)o.emoji=e;return o}),
    require_tag:document.getElementById('fsRequire').classList.contains('on'),
    default_auto_archive_minutes:parseInt(fsInput(document,'#fsArchive').value,10)};
  const btn=/** @type {HTMLButtonElement|null} */(document.getElementById('fsSave'));
  if(btn)btn.disabled=true;
  try{
    /* The write replaces the whole list, so a tag another admin added since this
       dialog opened would be deleted by it. Refuse instead, and say so. */
    const fresh=(await api('GET','/channels')).find(c=>(c.id||c.ID)===id);
    const opened=state.forumEdit&&state.forumEdit.id===id?state.forumEdit.key:null;
    if(fresh&&opened!==null&&forumKey(fresh.forum)!==opened){
      state.channelCache[id]=fresh;
      closeModal();
      showToast('Another admin changed this forum while you were editing. Reopen it to see their changes.','error');
      renderContent();
      return;
    }
    await api('PUT','/channels/'+id+'/forum',body);
    closeModal();showToast('Forum settings saved');renderContent();
  }catch(e){showToast(e.message,'error');if(btn)btn.disabled=false}
}

/* Deleting a channel or a role cannot be undone, so it asks for the name to be
   typed first, the way Erase account does: Delete stays disabled until the
   field matches, and the confirm handler re-checks it. */
function typedConfirmField(name){
  return '<div class="form-group rc-confirm"><label class="form-label" for="typedConfirm">Type <strong>'+esc(name)+'</strong> to confirm</label>'
    +'<input class="form-input" id="typedConfirm" autocomplete="off" autocapitalize="off" spellcheck="false" data-input-action="syncTypedConfirm" data-args="'+actArgs(name)+'"></div>';
}
function typedConfirmed(name){return (document.getElementById('typedConfirm')?.value||'').trim()===name}
function syncTypedConfirm(name){
  const b=document.getElementById('typedConfirmBtn');
  if(b)b.disabled=!typedConfirmed(name);
}

function openDeleteChannel(id,name){
  openModal('<div class="modal-header"><h3>Delete Channel</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'
    +'<div class="modal-body"><p style="color:var(--text-muted)">Permanently delete <strong style="color:var(--text-normal)">#'+esc(name)+'</strong> and all its messages? <strong style="color:var(--text-danger)">This cannot be undone.</strong></p>'
    +typedConfirmField(name)+'</div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" id="typedConfirmBtn" disabled data-action="confirmDeleteChannel" data-args="'+actArgs(id,name)+'">Delete channel</button></div>');
}

async function confirmDeleteChannel(id,name){
  if(!typedConfirmed(name)){showToast('Type the channel name exactly to confirm','error');return}
  try{await api('DELETE','/channels/'+id);closeModal();showToast('Channel deleted');renderContent()}catch(e){showToast(e.message,'error')}
}

/* ═══ Channel permissions (override matrix) ═══ */
/* Two editors over the same two endpoints, because they answer two different
   questions. The quick "Can access" list is the 90% case — hide this channel
   from a role — and still writes exactly the mask it always did. The matrix
   below it is the honest one: pick a role OR a single member, then set each
   relevant bit to allow / inherit / deny, which is what the API has always
   accepted and what the resolution order (base -> role override -> user
   override) actually resolves. */
const DENY_PRIVATE=0x202; /* READ_MESSAGES | CONNECT_VOICE */
const ADMIN_BIT=0x40000000;

/* The bits worth overriding PER CHANNEL. Server-wide bits (Manage Roles, Ban
   Members, …) are deliberately absent: they answer to the server, not to one
   channel, so offering them here would write masks nothing ever reads. */
const OVERRIDE_BITS=[
  [0x2,'Read Messages'],
  [0x1,'Send Messages'],
  [0x20,'Attach Files'],
  [0x40,'Add Reactions'],
  [0x10000,'Manage Messages'],
  [0x200000,'Mention @everyone'],
  [0x200,'Connect'],
  [0x400,'Speak'],
  [0x800,'Video'],
  [0x1000,'Share Screen'],
];

/* Tri-state per bit: 'allow' sets the bit in the allow mask, 'deny' sets it in
   the deny mask, 'inherit' sets it in neither. An override row whose two masks
   are both zero is deleted rather than stored — an all-inherit row is the same
   thing as no row, and keeping it would leave phantom entries in the listing. */
function overrideStateOf(allow,deny,bit){
  if((allow&bit)===bit)return 'allow';
  if((deny&bit)===bit)return 'deny';
  return 'inherit';
}

async function openChannelPermsModal(id,name){
  let data,users,roles;
  try{
    /* The role list is only for colours: GET /channels/{id}/permissions
       carries names but not colours, and the seeded fallback would paint a
       custom-coloured role in a colour it does not have. */
    [data,users,roles]=await Promise.all([
      api('GET','/channels/'+id+'/permissions'),
      api('GET','/users?limit=500&offset=0'),
      api('GET','/roles').catch(()=>null),
    ]);
  }catch(e){showToast(e.message,'error');return}
  if(Array.isArray(roles))state.roleList=roles;
  state.permChannel={id:id,name:name,roles:data.roles||[],users:data.users||[],allUsers:users||[],tab:'access',synced:!!data.permissions_synced,categoryId:(state.channelCache[id]||{}).category_id||0};
  renderChannelPermsModal();
}

/* Channel access is a drawer with three tabs instead of one stacked dialog:
   Access (hide the channel from a role), Overrides (the tri-state matrix and
   its preview) and Explain (why one member can or cannot do something). All
   three panels stay in the DOM and a tab only shows its own, so switching tabs
   keeps unsaved edits; Save applies the Access and Overrides edits together,
   exactly as the single dialog did. */
const CHANNEL_TABS=[['access','Access'],['overrides','Overrides'],['explain','Explain']];

function renderChannelPermsModal(){
  const pc=state.permChannel;if(!pc)return;
  const tab=pc.tab||'access';
  let quick='<ul class="access-list">';
  pc.roles.forEach(role=>{
    const isAdmin=(role.permissions&ADMIN_BIT)!==0;
    const canAccess=isAdmin||((role.deny&0x2)===0);
    const nameId='permRoleName'+role.role_id;
    quick+='<li class="access-row">'
      +'<span id="'+nameId+'" class="access-role" style="color:'+readableRoleColor(roleColor(role.role_id))+'">'+esc(role.role_name)+'</span>'
      +(isAdmin
        ?'<span class="access-note">Administrator, always has access</span>'
        :'<label class="access-toggle"><input type="checkbox" id="permRole'+role.role_id+'" aria-describedby="'+nameId+'" '+(canAccess?'checked':'')+'> Can access</label>')
      +'</li>';
  });
  quick+='</ul>';

  let opts='<option value="">— pick a role or member —</option><optgroup label="Roles">';
  pc.roles.forEach(r=>{opts+='<option value="r:'+r.role_id+'">'+esc(r.role_name)+'</option>'});
  opts+='</optgroup><optgroup label="Members">';
  /* The member list is paginated, so a member who already has an override could
     fall outside the page and become uneditable. Union the two lists — the
     override rows carry the username the picker needs. */
  const picked=[];const seen={};
  pc.users.forEach(o=>{seen[o.user_id]=true;picked.push({id:o.user_id,username:o.username,has:true})});
  pc.allUsers.forEach(u=>{if(!seen[u.id])picked.push({id:u.id,username:u.username,has:false})});
  picked.sort((a,b)=>String(a.username).localeCompare(String(b.username)));
  picked.forEach(u=>{
    opts+='<option value="u:'+u.id+'">'+esc(u.username)+(u.has?' (override)':'')+'</option>';
  });
  opts+='</optgroup>';
  let memberOpts='<option value="">— pick a member —</option>';
  picked.forEach(u=>{memberOpts+='<option value="'+u.id+'">'+esc(u.username)+'</option>'});
  let actionOpts='';
  ACCESS_ACTIONS.forEach(a=>{actionOpts+='<option value="'+a[0]+'">'+esc(a[1])+'</option>'});

  const tabs='<div class="drawer-tabs" role="tablist" aria-label="Channel access">'+CHANNEL_TABS.map(t=>{
    const on=t[0]===tab;
    return '<button class="drawer-tab" role="tab" id="chTab-'+t[0]+'" aria-controls="chPanel-'+t[0]+'" aria-selected="'+on+'" tabindex="'+(on?'0':'-1')+'" data-tab="'+t[0]+'" data-action="selectChannelTab" data-args="'+actArgs(t[0])+'">'+t[1]+'</button>';
  }).join('')+'</div>';
  const panel=(id,body)=>'<div class="drawer-panel" role="tabpanel" id="chPanel-'+id+'" aria-labelledby="chTab-'+id+'"'+(id===tab?'':' hidden')+'>'+body+'</div>';

  openModal('<div class="drawer">'
    +'<div class="modal-header"><h3>Access — #'+esc(pc.name)+'</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'
    +tabs
    +'<div class="modal-body drawer-body">'
    +panel('access',
      (pc.synced?'<p class="drawer-intro" id="chSyncedNote"><span class="badge badge-green">Synced with category</span> This channel follows its category\'s permissions. Saving a change here stops that until you sync it again.</p>':'')
      +'<p class="drawer-intro">Uncheck a role to hide this channel from it (a private channel). Changes apply to connected users immediately; users already in the voice channel are not disconnected.</p>'
      +quick)
    +panel('overrides',
      '<p class="drawer-intro">Set single permissions for one role or member in this channel. Resolution order: base role permissions → role override → member override. A member deny beats a role allow; Administrator bypasses everything.</p>'
      +'<div class="form-group"><label class="form-label" for="permTarget">Role or member</label>'
      +'<select class="form-input" id="permTarget" style="appearance:auto" data-change-action="onPermTargetChange">'+opts+'</select></div>'
      +'<div id="permMatrix"></div>'
      +'<div id="permPreview"></div>')
    +panel('explain',
      '<p class="drawer-intro">Ask the server why a member can or cannot do something here, layer by layer. Nothing is changed.</p>'
      +'<div class="form-group"><label class="form-label" for="explainUser">Member</label>'
      +'<select class="form-input" id="explainUser" style="appearance:auto">'+memberOpts+'</select></div>'
      +'<div class="form-group"><label class="form-label" for="explainAction">Action</label>'
      +'<select class="form-input" id="explainAction" style="appearance:auto">'+actionOpts+'</select></div>'
      +'<button class="btn btn-ghost" data-action="explainAccess">Explain</button>'
      +'<div id="permExplain"></div>')
    +'</div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-accent" data-action="saveChannelPerms">Save changes</button></div>'
    +'</div>');
  renderPermMatrix();
}

/* Shows one tab's panel. The panels are not re-rendered, so edits survive. */
function selectChannelTab(id){
  if(state.permChannel)state.permChannel.tab=id;
  document.querySelectorAll('#modalInner [role="tab"][data-tab]').forEach(t=>{
    const on=t.getAttribute('data-tab')===id;
    t.setAttribute('aria-selected',on?'true':'false');
    t.tabIndex=on?0:-1;
    const p=document.getElementById(t.getAttribute('aria-controls'));
    if(p)p.hidden=!on;
  });
}
/* Arrow keys, Home and End move between the tabs (the ARIA tabs pattern with
   automatic activation); Tab leaves the tab list for the open panel. */
document.addEventListener('keydown',e=>{
  const tab=e.target instanceof Element?e.target.closest('#modalInner [role="tab"][data-tab]'):null;
  if(!tab)return;
  const tabs=[...tab.parentElement.querySelectorAll('[role="tab"][data-tab]')];
  let i=tabs.indexOf(tab);
  if(e.key==='ArrowRight')i=(i+1)%tabs.length;
  else if(e.key==='ArrowLeft')i=(i-1+tabs.length)%tabs.length;
  else if(e.key==='Home')i=0;
  else if(e.key==='End')i=tabs.length-1;
  else return;
  e.preventDefault();
  selectChannelTab(tabs[i].getAttribute('data-tab'));
  tabs[i].focus();
});

/* Reads the current masks for the selected target and paints one tri-state row
   per bit. A member with no override row starts all-inherit. */
function renderPermMatrix(){
  const pc=state.permChannel;if(!pc)return;
  const box=document.getElementById('permMatrix');if(!box)return;
  const pv=document.getElementById('permPreview');if(pv)pv.innerHTML='';
  const sel=document.getElementById('permTarget');
  const val=sel?sel.value:'';
  /* The radios read from the snapshot, so remember which target they belong
     to; onPermTargetChange compares the live radios against that target's
     snapshot to tell whether a switch would discard edits. */
  if(sel)sel.dataset.painted=val;
  if(!val){box.innerHTML='<p class="drawer-intro">Pick a role or member above to edit its per-channel permissions.</p>';return}
  const {allow,deny}=snapshotOverrideMasks(val);
  let adminNote='';
  if(val.charAt(0)==='r'){
    const role=pc.roles.find(r=>r.role_id===parseInt(val.slice(2),10));
    if(role&&(role.permissions&ADMIN_BIT)!==0)adminNote='This role holds Administrator — every override below is bypassed.';
  }
  let html='';
  if(adminNote)html+='<p style="color:var(--text-warning);font-size:12px;margin:0 0 8px">'+esc(adminNote)+'</p>';
  html+='<table class="tbl"><thead><tr><th scope="col">Permission</th><th scope="col" style="text-align:center">Allow</th><th scope="col" style="text-align:center">Inherit</th><th scope="col" style="text-align:center">Deny</th></tr></thead><tbody>';
  OVERRIDE_BITS.forEach(b=>{
    const bit=b[0],label=b[1],st=overrideStateOf(allow,deny,bit);
    html+='<tr><th scope="row" class="ovr-label">'+esc(label)+'</th>';
    ['allow','inherit','deny'].forEach(k=>{
      html+='<td style="text-align:center"><input type="radio" name="ovr'+bit+'" data-ovrbit="'+bit+'" value="'+k+'" aria-label="'+esc(label)+': '+k+'"'+(st===k?' checked':'')+'></td>';
    });
    html+='</tr>';
  });
  html+='</tbody></table>';
  html+='<div class="drawer-actions">'+(pc.kind==='category'?'':'<button class="btn btn-ghost" data-action="previewPermChange">Preview change</button>')+'<button class="btn btn-outline" data-action="clearPermOverride">Clear override</button></div>';
  box.innerHTML=html;
}

/* Collects the tri-state rows back into the two masks the API takes. */
function collectOverrideMasks(){
  let allow=0,deny=0;
  document.querySelectorAll('#permMatrix input[data-ovrbit]:checked').forEach(el=>{
    const bit=parseInt(el.getAttribute('data-ovrbit'),10);
    if(el.value==='allow')allow|=bit;
    else if(el.value==='deny')deny|=bit;
  });
  return {allow:allow,deny:deny};
}

function permTargetPath(){
  const pc=state.permChannel;
  const sel=document.getElementById('permTarget');
  const val=sel?sel.value:'';
  if(!pc||!val)return null;
  const kind=val.charAt(0),tid=parseInt(val.slice(2),10);
  /* A category edits its template; the same rows are then written to every
     synced channel by the server. */
  const base=pc.kind==='category'?'/channels/categories/':'/channels/';
  return base+pc.id+(kind==='r'?'/permissions/':'/user-permissions/')+tid;
}

/* The masks a target carried in the snapshot — what renderPermMatrix painted
   its radios from. */
function snapshotOverrideMasks(val){
  const pc=state.permChannel;
  if(!pc||!val)return {allow:0,deny:0};
  const kind=val.charAt(0),tid=parseInt(val.slice(2),10);
  if(kind==='r'){const r=pc.roles.find(r=>r.role_id===tid);return r?{allow:r.allow,deny:r.deny}:{allow:0,deny:0}}
  const o=pc.users.find(u=>u.user_id===tid);return o?{allow:o.allow,deny:o.deny}:{allow:0,deny:0};
}
/* True when the matrix's live radios differ from the target they were painted
   for — i.e. an override edit that switching the target would discard. */
function permMatrixHasEdits(){
  const sel=document.getElementById('permTarget');
  const painted=sel&&sel.dataset.painted;
  if(!painted)return false;
  const now=collectOverrideMasks(),was=snapshotOverrideMasks(painted);
  return now.allow!==was.allow||now.deny!==was.deny;
}
/* True when an Access-tab checkbox differs from the snapshot, so a discarded
   matrix edit does not clear dirt that belongs to another tab. */
function accessTabHasEdits(){
  const pc=state.permChannel;if(!pc)return false;
  return (pc.roles||[]).some(role=>{
    if((role.permissions&ADMIN_BIT)!==0)return false;
    const box=document.getElementById('permRole'+role.role_id);
    if(!(box instanceof HTMLInputElement))return false;
    return box.checked!==((role.deny&0x2)===0);
  });
}
/* Switching the target repaints the matrix from the snapshot. Ask first when
   the current target holds an edit; declining keeps the select on the target
   the edits belong to. */
function onPermTargetChange(){
  const sel=this;
  if(permMatrixHasEdits()&&!confirmDiscardModal()){sel.value=sel.dataset.painted||'';return}
  renderPermMatrix();
  /* The repaint discarded the previous target's edits; keep the flag honest
     for a beforeunload or a later dismiss. */
  state.modalDirty=accessTabHasEdits();
}

/* ═══ Category permission templates ═══ */
function openCategoryPermsPicker(){
  const sel=document.getElementById('catPermPick');
  if(!(sel instanceof HTMLSelectElement)||!sel.value)return;
  const id=parseInt(sel.value,10);
  const c=(state.categoryList||[]).find(x=>x.id===id);
  openCategoryPermsModal(id,c?c.name:'');
}

/* The same override matrix a channel uses, over the category's template. */
async function openCategoryPermsModal(id,name){
  let data,users,roles;
  try{
    [data,users,roles]=await Promise.all([
      api('GET','/channels/categories/'+id+'/permissions'),
      api('GET','/users?limit=500&offset=0'),
      api('GET','/roles').catch(()=>null),
    ]);
  }catch(e){showToast(e.message,'error');return}
  if(Array.isArray(roles))state.roleList=roles;
  const synced=Object.values(state.channelCache||{}).filter(c=>c.category_id===id&&c.permissions_synced).length;
  state.permChannel={kind:'category',id:id,name:name,roles:data.roles||[],users:data.users||[],allUsers:users||[],tab:'overrides',syncedCount:synced};
  renderCategoryPermsModal();
}

function renderCategoryPermsModal(){
  const pc=state.permChannel;if(!pc||pc.kind!=='category')return;
  let opts='<option value="">— pick a role or member —</option><optgroup label="Roles">';
  pc.roles.forEach(r=>{opts+='<option value="r:'+r.role_id+'">'+esc(r.role_name)+'</option>'});
  opts+='</optgroup><optgroup label="Members">';
  const picked=[];const seen={};
  pc.users.forEach(o=>{seen[o.user_id]=true;picked.push({id:o.user_id,username:o.username,has:true})});
  pc.allUsers.forEach(u=>{if(!seen[u.id])picked.push({id:u.id,username:u.username,has:false})});
  picked.sort((a,b)=>String(a.username).localeCompare(String(b.username)));
  picked.forEach(u=>{opts+='<option value="u:'+u.id+'">'+esc(u.username)+(u.has?' (override)':'')+'</option>'});
  opts+='</optgroup>';
  openModal('<div class="drawer">'
    +'<div class="modal-header"><h3>Category permissions — '+esc(pc.name)+'</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'
    +'<div class="modal-body drawer-body">'
    +'<p class="drawer-intro">These permissions are a template. Saving writes the same override to the '+pc.syncedCount+' channel'+(pc.syncedCount===1?'':'s')+' synced with this category; channels that are not synced keep their own. You can only set a permission your own role holds, and the same applies to every synced channel it replaces.</p>'
    +'<div class="form-group"><label class="form-label" for="permTarget">Role or member</label>'
    +'<select class="form-input" id="permTarget" style="appearance:auto" data-change-action="onPermTargetChange">'+opts+'</select></div>'
    +'<div id="permMatrix"></div>'
    +'</div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-accent" data-action="saveCategoryPerms">Save changes</button></div>'
    +'</div>');
  renderPermMatrix();
}

async function saveCategoryPerms(){
  const pc=state.permChannel;if(!pc||pc.kind!=='category')return;
  const path=permTargetPath();
  if(!path){showToast('Pick a role or member first','error');return}
  const masks=collectOverrideMasks();
  try{
    /* An all-inherit row is the same as no row, so it is a delete. */
    if(masks.allow===0&&masks.deny===0)await api('DELETE',path);
    else await api('PUT',path,masks);
    closeModal();showToast('Category permissions updated');renderContent();
  }catch(e){showToast(e.message,'error')}
}

/* Re-sync one channel to its category's template. */
async function syncChannelPerms(id,name){
  try{
    await api('POST','/channels/'+id+'/permissions/sync');
    showToast('#'+name+' is synced with its category');renderContent();
  }catch(e){showToast(e.message,'error')}
}

/* ═══ Access explanation and change preview (RI-06) ═══ */
/* Both ask the server, which runs the canonical authorization predicates over
   the member's live state — this panel never decides access itself, and
   neither request acts as the member. Both reads are audited. */
const ACCESS_ACTIONS=[
  ['view_channel','View channel'],
  ['read_content','Read content'],
  ['send_message','Send messages'],
  ['add_reaction','Add reactions'],
  ['join_voice','Join voice'],
  ['moderate_voice','Moderate voice'],
  ['move_voice','Move voice'],
];
function accessActionLabel(a){const f=ACCESS_ACTIONS.find(x=>x[0]===a);return f?f[1]:a}
function accessVerdict(ok){return ok?'<span style="color:var(--text-positive)">Allowed</span>':'<span style="color:var(--text-danger)">Denied</span>'}
function layerLabel(v){return v==='allow'?'allow':v==='deny'?'deny':'—'}

async function explainAccess(){
  const pc=state.permChannel;if(!pc)return;
  const box=document.getElementById('permExplain');
  const uid=(document.getElementById('explainUser')||{}).value;
  const action=(document.getElementById('explainAction')||{}).value;
  if(!uid){showToast('Pick a member first','error');return}
  let r;
  try{
    r=await api('GET','/channels/'+pc.id+'/access/explain?user_id='+encodeURIComponent(uid)+'&action='+encodeURIComponent(action));
  }catch(e){showToast(e.message,'error');return}
  const rs=r.restrictions||{};
  const facts=['Role: '+esc(r.role_name||'none')];
  if(rs.banned)facts.push('<span style="color:var(--text-danger)">banned</span>');
  if(rs.registration_status&&rs.registration_status!=='active')facts.push('registration '+esc(rs.registration_status));
  if(rs.timed_out)facts.push('<span style="color:var(--text-warning)">timed out</span>');
  if(rs.channel_nsfw)facts.push('NSFW '+(rs.nsfw_acknowledged?'acknowledged':'not acknowledged'));
  if(rs.channel_archived)facts.push('channel archived');
  let html='<p style="font-size:12px;color:var(--text-muted);margin:8px 0">'+esc(r.username)+' · '+facts.join(' · ')+'</p>';
  (r.decisions||[]).forEach(d=>{
    html+='<div style="margin:8px 0"><div style="font-size:13px"><b>'+esc(accessActionLabel(d.action))+'</b>: '+accessVerdict(d.allowed)
      +(d.reason?' <span style="color:var(--text-muted)">— '+esc(d.reason)+'</span>':'')
      +(d.administrator_bypass?' <span style="color:var(--text-muted)">(Administrator bypasses overrides)</span>':'')+'</div>';
    if((d.bits||[]).length){
      html+='<table class="tbl"><thead><tr><th>Bit</th><th>Base role</th><th>Role override</th><th>Member override</th><th>Effective</th></tr></thead><tbody>';
      d.bits.forEach(b=>{
        html+='<tr><td>'+esc(b.bit)+'</td><td>'+(b.base?'yes':'no')+'</td><td>'+layerLabel(b.role_override)+'</td><td>'+layerLabel(b.user_override)+'</td><td>'+(b.effective?'yes':'no')+'</td></tr>';
      });
      html+='</tbody></table>';
    }
    html+='</div>';
  });
  if(box)box.innerHTML=html;
}

/* Previews the override matrix's current radios for its selected target —
   before Save, against the same rules Save's result will be judged by. */
async function previewPermChange(){
  const pc=state.permChannel;if(!pc)return;
  const box=document.getElementById('permPreview');
  const sel=document.getElementById('permTarget');
  const val=sel?sel.value:'';
  if(!val){showToast('Pick a role or member in the override matrix first','error');return}
  const kind=val.charAt(0),tid=parseInt(val.slice(2),10);
  const masks=collectOverrideMasks();
  const body={allow:masks.allow,deny:masks.deny};
  body[kind==='r'?'role_id':'user_id']=tid;
  let r;
  try{r=await api('POST','/channels/'+pc.id+'/access/preview',body)}
  catch(e){showToast(e.message,'error');return}
  const members=r.members||[];
  let html='<p style="font-size:12px;color:var(--text-muted);margin:10px 0 6px">'
    +(members.length?members.length+' of '+r.evaluated+' member(s) would change:':'No member\'s access would change ('+r.evaluated+' evaluated).')+'</p>';
  if(members.length){
    html+='<table class="tbl"><thead><tr><th>Member</th><th>Action</th><th>Now</th><th>After save</th></tr></thead><tbody>';
    members.forEach(m=>{(m.changes||[]).forEach(c=>{
      html+='<tr><td>'+esc(m.username)+'</td><td>'+esc(accessActionLabel(c.action))+'</td><td>'+accessVerdict(c.before)+'</td><td>'+accessVerdict(c.after)
        +(c.after_reason?' <span style="color:var(--text-muted);font-size:12px">— '+esc(c.after_reason)+'</span>':'')+'</td></tr>';
    })});
    html+='</tbody></table>';
  }
  if(box)box.innerHTML=html;
}

async function clearPermOverride(){
  const path=permTargetPath();
  if(!path){showToast('Pick a role or member first','error');return}
  /* Clearing closes the drawer, so any other unsaved edit in it would go with
     it — ask first, the same way the dismissals do. */
  if(!confirmDiscardModal())return;
  try{
    await api('DELETE',path);
    closeModal();showToast('Override cleared');renderContent();
  }catch(e){showToast(e.message,'error')}
}

async function saveChannelPerms(){
  const pc=state.permChannel;if(!pc)return;
  try{
    /* Quick toggles first: same masks this panel has always written. Track
       which roles this loop actually wrote — the override matrix below reads
       its radios from the pre-save snapshot, so if its target is one of
       these roles that snapshot is already stale and must not be trusted. */
    const touchedRoles=new Set();
    for(const role of pc.roles){
      if((role.permissions&ADMIN_BIT)!==0)continue;
      const box=document.getElementById('permRole'+role.role_id);
      if(!box)continue;
      const wasHidden=(role.deny&0x2)!==0;
      if(!box.checked){if(!wasHidden){await api('PUT','/channels/'+pc.id+'/permissions/'+role.role_id,{allow:0,deny:DENY_PRIVATE});touchedRoles.add(role.role_id)}}
      else if(wasHidden){await api('DELETE','/channels/'+pc.id+'/permissions/'+role.role_id);touchedRoles.add(role.role_id)}
    }
    /* Then the matrix, if a target is selected — unless the quick-toggle loop
       above just wrote that exact role's override row. Its radios reflect
       state from before that write, so collecting them now would silently
       undo the toggle (e.g. write back an all-inherit row that DELETEs what
       was just PUT). An all-inherit row is itself a delete: storing (0,0)
       would leave a row that resolves to nothing. */
    const sel=document.getElementById('permTarget');
    const targetVal=sel?sel.value:'';
    const targetIsTouchedRole=targetVal.charAt(0)==='r'&&touchedRoles.has(parseInt(targetVal.slice(2),10));
    if(!targetIsTouchedRole){
      const path=permTargetPath();
      if(path){
        const masks=collectOverrideMasks();
        if(masks.allow===0&&masks.deny===0)await api('DELETE',path);
        else await api('PUT',path,masks);
      }
    }
    closeModal();showToast('Channel permissions updated');renderContent();
  }catch(e){showToast(e.message,'error')}
}

/* ═══ Roles ═══ */
/* Roles are real CRUD now, not four seeded rows. Everything here is gated on
   MANAGE_ROLES, and the server additionally enforces the hierarchy: you may
   only touch roles strictly BELOW your own position, and may never grant a bit
   your own role lacks. The UI mirrors both rules so a doomed request is not
   offered — but the server is the authority, and a 403 surfaces as a toast. */

/* Permission checkboxes, grouped exactly as docs/schema.md's "Permission
   groups" section groups the bitfield. Keep the two in step: the doc is the
   reference an operator reads next to this grid, and every one of the 30
   defined bits must appear in exactly one group or it becomes ungrantable
   here. */
const PERM_GROUPS=[
  {title:'General',bits:[
    [0x20000,'Manage Channels','Create, edit and delete channels and their overrides'],
    [0x1000000,'Manage Roles','Create, edit, delete and assign roles below your own'],
    [0x4000000,'Manage Invites','Create and revoke invite codes'],
    [0x2000000,'Manage Server','Read and change server settings, retention and the AFK channel, and approve registrations. Restoring backups, updates, tokens and server configuration are separate permissions under Owner powers'],
    [0x8000000,'View Audit Log','Read the action history'],
    [0x400000,'Moderate Members','Warn and time out members, work the report queue'],
    [0x800000,'Manage Nicknames','Change or reset another member\'s nickname'],
    [0x4000,'Manage Backups','Create, list and download database backups. A backup holds every message and password hash (only the owner can grant)'],
    [0x40000000,'Administrator','Bypasses every permission check and channel override, never the rank rule: it cannot touch a role at or above its own'],
  ]},
  {title:'Text',bits:[
    [0x2,'Read Messages','View messages in text channels'],
    [0x1,'Send Messages','Post messages in text channels'],
    [0x20,'Attach Files','Upload file attachments'],
    [0x40,'Add Reactions','React to messages with emoji'],
    [0x200000,'Mention @everyone','Give @everyone/@here real mention semantics'],
    [0x10000,'Manage Messages','Delete others’ messages, pin and purge'],
  ]},
  {title:'Voice',bits:[
    [0x200,'Connect','Join voice channels'],
    [0x400,'Speak','Transmit audio in voice channels'],
    [0x800,'Video','Enable the camera in voice channels'],
    [0x1000,'Share Screen','Share the screen in voice channels'],
  ]},
  {title:'Moderation',bits:[
    [0x40000,'Kick Members','Force-logout a lower-ranked member'],
    [0x80000,'Ban Members','Ban and unban lower-ranked members'],
    [0x100000,'Mute Members','Server mute, deafen and disconnect, and move lower-ranked members'],
    [0x2000,'Move Members','Move anyone between voice channels, whatever their rank (only the owner can grant)'],
  ]},
  /* The owner-type permissions (WP 8.4d): actions that were the owner's alone.
     The first five are owner-tier: an Administrator does not hold them without
     the bit, and only the owner can grant them. The last two an Administrator
     already has; the owner or an Administrator can grant them. */
  {title:'Owner powers',bits:[
    [0x8000,'Restore Backups','Restore or delete a backup and download the full archive. A restore replaces everything since the backup (about as powerful as being the owner; only the owner can grant)'],
    [0x4,'Manage Server Configuration','Read and change the server configuration file and restart the server (about as powerful as being the owner; only the owner can grant)'],
    [0x8,'Manage Updates','Check for and install server updates (about as powerful as being the owner; only the owner can grant)'],
    [0x10,'Manage API Tokens','Create, list and revoke their own API tokens (about as powerful as being the owner; only the owner can grant)'],
    [0x80,'Issue Recovery Credentials','Give a locked-out member who ranks below them a one-time recovery credential (about as powerful as being the owner; only the owner can grant)'],
    [0x100,'View Diagnostics','Open the server logs, change the log level, build support bundles and read the attention panel (only the owner or an Administrator can grant)'],
    [0x10000000,'Erase Accounts','Permanently erase the account of a member who ranks below them (only the owner or an Administrator can grant)'],
  ]},
];

/* My own position, from GET /me — the hierarchy boundary every row respects. */
function myPosition(){return (state.me&&state.me.role_position)||0}
/* True when the signed-in principal may manage this role at all. */
function canManageRole(role){return role.position<myPosition()}
/* Move Members can be given or taken away only by the owner or an
   Administrator, whatever other role permissions the viewer holds (the server
   refuses anyone else, so the box is shown greyed rather than left to fail). */
const OWNER_GRANT_ONLY_TITLE='Only the owner or an Administrator can change this';
/* The bits only the owner or an Administrator may add or remove: one mask,
   mirroring permissions.OwnerGrantOnly, so a new such bit is one more term. */
const OWNER_GRANT_ONLY_MASK=PERM.MOVE_MEMBERS|PERM.MANAGE_BACKUPS|PERM.RESTORE_BACKUPS|PERM.MANAGE_CONFIG|PERM.MANAGE_UPDATES|PERM.MANAGE_TOKENS|PERM.ISSUE_RECOVERY|PERM.VIEW_DIAGNOSTICS|PERM.ERASE_ACCOUNTS;
function isOwnerGrantOnlyBit(bit){return (bit&OWNER_GRANT_ONLY_MASK)!==0}
function canChangeOwnerGrantOnly(){return isOwner()||can(PERM.ADMINISTRATOR)}
/* The owner-tier subset (WP 8.4d), mirroring permissions.OwnerOnlyGrant: these
   boxes only the owner can change, an Administrator included, because the
   owner tier ignores ADMINISTRATOR and an Administrator could otherwise give
   the bit to themself. */
const OWNER_ONLY_GRANT_TITLE='Only the owner can change this';
const OWNER_ONLY_GRANT_MASK=PERM.RESTORE_BACKUPS|PERM.MANAGE_CONFIG|PERM.MANAGE_UPDATES|PERM.MANAGE_TOKENS|PERM.ISSUE_RECOVERY;
function isOwnerOnlyGrantBit(bit){return (bit&OWNER_ONLY_GRANT_MASK)!==0}
function grantLockTitle(bit){return isOwnerOnlyGrantBit(bit)?OWNER_ONLY_GRANT_TITLE:OWNER_GRANT_ONLY_TITLE}
/* True when this bit may be granted: ADMINISTRATOR grants anything, otherwise
   only bits the caller's own role holds. */
function canGrantBit(bit){
  if(isOwnerOnlyGrantBit(bit))return isOwner();
  if(isOwnerGrantOnlyBit(bit))return canChangeOwnerGrantOnly();
  const p=(state.me&&state.me.permissions)||0;
  if((p&PERM.ADMINISTRATOR)!==0)return true;
  return (p&bit)===bit;
}

/* Role presets: a starting point for the role editor. Each one REPLACES the
   ticked permission boxes with the member basics plus the bits of its job; the
   name, colour and rank are left alone and every box stays editable. A bit the
   viewer cannot grant stays as it is and is named in a note. */
const ROLE_PRESET_BASE=0x1|0x2|0x20|0x40|0x200|0x400|0x800|0x1000;
const ROLE_PRESETS=[
  {id:'super',label:'Super admin',bits:PERM.ADMINISTRATOR},
  {id:'manager',label:'Server manager',bits:PERM.MANAGE_SERVER|PERM.MANAGE_CHANNELS|PERM.MANAGE_INVITES|PERM.VIEW_AUDIT_LOG},
  {id:'moderator',label:'Moderator',bits:0x10000|PERM.KICK_MEMBERS|PERM.BAN_MEMBERS|PERM.MUTE_MEMBERS|0x400000|PERM.MANAGE_NICKNAMES|PERM.VIEW_AUDIT_LOG},
  {id:'voice',label:'Voice moderator',bits:PERM.MUTE_MEMBERS|PERM.MOVE_MEMBERS},
];
function permLabel(bit){
  for(const g of PERM_GROUPS){const b=g.bits.find(x=>x[0]===bit);if(b)return b[1]}
  return'';
}
function applyRolePreset(id){
  const preset=ROLE_PRESETS.find(p=>p.id===id);
  if(!preset)return;
  const want=ROLE_PRESET_BASE|preset.bits;
  const skipped=[],kept=[];
  /** @type {NodeListOf<HTMLInputElement>} */(document.querySelectorAll('#modalInner input[data-permbit]')).forEach(box=>{
    const bit=parseInt(box.getAttribute('data-permbit'),10);
    if(!canGrantBit(bit)){
      const why=isOwnerGrantOnlyBit(bit)?'only the owner can ':'your own role cannot ';
      if((want&bit)===bit&&!box.checked)skipped.push(permLabel(bit)+' ('+(isOwnerGrantOnlyBit(bit)?'only the owner can grant':'your own role does not have it')+')');
      else if((want&bit)!==bit&&box.checked)kept.push(permLabel(bit)+' ('+why+'change it)');
      return;
    }
    box.checked=(want&bit)===bit;
  });
  const note=document.getElementById('rolePresetNote');
  if(note)note.textContent='Applied the '+preset.label+' preset; adjust any box before saving.'+(skipped.length?' Not applied: '+skipped.join(', ')+'.':'')+(kept.length?' Kept: '+kept.join(', ')+'.':'');
}

/* How many of the grid's permissions a mask grants, for the ladder's summary. */
function rolePermCount(mask){
  return PERM_GROUPS.reduce((n,g)=>n+g.bits.filter(b=>(mask&b[0])===b[0]).length,0);
}
const PERM_TOTAL=PERM_GROUPS.reduce((n,g)=>n+g.bits.length,0);

/* The Roles page is a rank ladder: highest rank first, each rung showing its
   position, members and how much it grants, with a line marking the caller's
   own rank — everything below that line is what they may manage. */
async function renderRoles(){
  let roles;
  try{roles=await api('GET','/roles')}catch(e){return'<h1 class="page-title">Roles &amp; permissions</h1><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  state.roleList=roles||[];
  let html=rcHead('Roles &amp; permissions',state.roleList.length+' role'+(state.roleList.length===1?'':'s')+', highest rank first. A higher rank manages every role below it, so place new roles with care.',
    '<button class="btn btn-accent" data-action="openRoleModal" data-args="'+actArgs(null)+'">'+I.plus+' Create Role</button>');
  if(!state.roleList.length)return html+'<div class="section-card"><div class="section-card-body" style="color:var(--text-muted)">No roles</div></div>';
  /* Only the manageable slice can be reordered — the reorder endpoint takes
     exactly the roles below the caller, so the arrows move within that slice. */
  const movable=state.roleList.filter(canManageRole);
  html+='<ol class="rank-ladder" aria-label="Roles by rank, highest first">';
  let divided=false;
  state.roleList.forEach((role,i)=>{
    const mine=canManageRole(role);
    if(mine&&!divided&&i>0)html+='<li class="rank-divider" aria-hidden="true">Your rank · '+myPosition()+' — you manage the roles below</li>';
    if(mine)divided=true;
    const mIdx=movable.findIndex(r=>r.id===role.id);
    const name=esc(role.name);
    const count=role.member_count||0;
    const admin=(role.permissions&PERM.ADMINISTRATOR)!==0;
    const perms=admin?'Administrator: every permission':rolePermCount(role.permissions)+' of '+PERM_TOTAL+' permissions';
    html+='<li class="rank-rung'+(mine?'':' is-above')+'">';
    html+='<span class="rank-pos"><span class="sr-only">Position </span>'+role.position+'</span>';
    html+='<span class="role-swatch" style="background:'+(role.color?esc(role.color):'var(--text-muted)')+'" aria-hidden="true"></span>';
    html+='<div class="rank-main"><div class="rank-name"><strong style="color:'+(role.color?readableRoleColor(role.color):'var(--text-normal)')+'">'+name+'</strong>';
    if(role.is_default)html+='<span class="badge badge-muted">default</span>';
    if(role.position===myPosition())html+='<span class="badge badge-accent">your role</span>';
    else if(!mine)html+='<span class="badge badge-muted">above you</span>';
    html+='</div><div class="rank-meta">'+count+' member'+(count===1?'':'s')+' · '+perms+'</div></div>';
    html+='<div class="act-group rank-actions">';
    if(mine){
      const upDisabled=mIdx<=0?' disabled':'';
      const downDisabled=(mIdx<0||mIdx>=movable.length-1)?' disabled':'';
      html+='<button class="act-btn" title="Move up" aria-label="Move '+name+' up"'+upDisabled+' data-focus="up-'+role.id+'" data-action="moveRole" data-args="'+actArgs(role.id,-1)+'">'+I.arrowUp+'</button>';
      html+='<button class="act-btn" title="Move down" aria-label="Move '+name+' down"'+downDisabled+' data-focus="down-'+role.id+'" data-action="moveRole" data-args="'+actArgs(role.id,1)+'">'+I.arrowDown+'</button>';
      html+='<button class="act-btn" title="Edit" aria-label="Edit '+name+'" data-action="openRoleModal" data-args="'+actArgs(role.id)+'">'+I.edit+'</button>';
      if(role.is_default)html+='<button class="act-btn" title="The default role cannot be deleted" aria-label="The default role cannot be deleted" disabled>'+I.trash+'</button>';
      else html+='<button class="act-btn danger" title="Delete" aria-label="Delete '+name+'" data-action="openDeleteRole" data-args="'+actArgs(role.id)+'">'+I.trash+'</button>';
    }else{
      html+='<span class="rank-readonly">read-only</span>';
    }
    html+='</div></li>';
  });
  html+='</ol>';
  return html;
}

/* Swap a role with its neighbour and send the whole manageable order. The
   endpoint normalizes positions, so the client never computes them. The
   ladder is redrawn in place and focus returns to the arrow just used (or its
   twin, once the role reaches an end), so a keyboard user can keep moving it. */
async function moveRole(id,delta){
  const movable=state.roleList.filter(canManageRole);
  const i=movable.findIndex(r=>r.id===id);
  const j=i+delta;
  if(i<0||j<0||j>=movable.length)return;
  const ids=movable.map(r=>r.id);
  ids[i]=movable[j].id;ids[j]=movable[i].id;
  try{await api('PATCH','/roles/reorder',{role_ids:ids});showToast('Roles reordered')}
  catch(e){showToast(e.message,'error');return}
  if(state.section!=='roles')return;
  let html;
  try{html=await renderRoles()}catch(e){renderContent();return}
  const c=document.getElementById('content');
  if(!c||state.section!=='roles')return;
  c.innerHTML=html;
  const dir=delta<0?'up':'down',other=delta<0?'down':'up';
  const btn=[c.querySelector('[data-focus="'+dir+'-'+id+'"]'),c.querySelector('[data-focus="'+other+'-'+id+'"]')].find(b=>b&&!b.disabled);
  if(btn)btn.focus();
}

/* Where a role at `pos` lands on the ladder. The role being edited is left
   out, so it neither collides with nor outranks itself. The default role is
   not listed as outranked: every other role sits above it by design. */
function rolePlacement(pos,editId){
  const others=(state.roleList||[]).filter(r=>r.id!==editId);
  return {
    clash:others.find(r=>r.position===pos)||null,
    outranks:others.filter(r=>r.position<pos&&!r.is_default).sort((a,b)=>b.position-a.position),
    above:others.filter(r=>r.position>pos).sort((a,b)=>a.position-b.position)[0]||null,
    below:others.filter(r=>r.position<pos).sort((a,b)=>b.position-a.position)[0]||null,
  };
}
/* The lowest free slot above the default role — where a new everyday role
   usually belongs. null when nothing between it and the caller is free. */
function slotAboveDefault(editId){
  const roles=(state.roleList||[]).filter(r=>r.id!==editId);
  const def=roles.find(r=>r.is_default);
  const taken={};roles.forEach(r=>{taken[r.position]=true});
  let pos=def?def.position+1:1;
  while(pos<myPosition()&&taken[pos])pos++;
  return pos<myPosition()?pos:null;
}
function listNames(roles){
  const n=roles.map(r=>esc(r.name));
  return n.length<2?n.join(''):n.slice(0,-1).join(', ')+' and '+n[n.length-1];
}
/* Plain text naming why the position is doomed, or '' when it is usable. */
function rolePositionError(pos,editId){
  if(isNaN(pos)||pos<0)return 'Enter a position of 0 or more.';
  if(pos>=myPosition())return 'Must be below your own rank of '+myPosition()+'.';
  const p=rolePlacement(pos,editId);
  if(p.clash)return 'Position '+pos+' is already used by '+p.clash.name+'. Pick a free number.';
  return '';
}
/* The live line under the position field: where the role sits, and a warning
   (U13) when it would outrank roles such as Admin or Moderator — a new role
   defaults to the highest free slot below the caller, which for the owner is
   above every seeded role. An edit warns only about roles the new position
   newly outranks, and offers no one-click move. */
function renderRolePlacement(){
  const el=document.getElementById('rolePlacement');
  const input=document.getElementById('rolePos');
  if(!el||!input)return;
  const pos=parseInt(input.value,10);
  const editId=state.roleEditId;
  const err=rolePositionError(pos,editId);
  if(err){el.className='rank-placement is-error';el.textContent=err;return}
  const p=rolePlacement(pos,editId);
  const editing=editId!==null;
  if(editing){
    const was=(state.roleList||[]).find(r=>r.id===editId);
    p.outranks=was?p.outranks.filter(r=>r.position>was.position):[];
  }
  const between=p.above&&p.below?'Sits between '+esc(p.above.name)+' ('+p.above.position+') and '+esc(p.below.name)+' ('+p.below.position+').'
    :p.above?'Sits below every other role, under '+esc(p.above.name)+' ('+p.above.position+').'
    :p.below?'Sits above every other role, over '+esc(p.below.name)+' ('+p.below.position+').':'';
  if(!p.outranks.length){el.className='rank-placement';el.innerHTML=between;return}
  const slot=slotAboveDefault(editId);
  const def=(state.roleList||[]).find(r=>r.is_default);
  el.className='rank-placement is-warn';
  el.innerHTML='<strong>This role will outrank '+listNames(p.outranks)+'.</strong> '
    +'With Manage Roles or a moderation permission, its members could act on theirs. '+between
    +(!editing&&slot!==null&&slot!==pos&&def?'<div><button type="button" class="btn btn-outline" data-action="placeRoleAboveDefault" data-args="'+actArgs(slot)+'">Place just above '+esc(def.name)+' ('+slot+')</button></div>':'');
}
function placeRoleAboveDefault(slot){
  const input=document.getElementById('rolePos');if(!input)return;
  input.value=String(slot);
  markModalDirty();
  renderRolePlacement();
  input.focus();
}

/* Shared create/edit modal. id === null creates. */
function openRoleModal(id){
  const role=id===null?null:state.roleList.find(r=>r.id===id);
  if(id!==null&&!role){showToast('Role not found','error');return}
  state.roleEditId=role?role.id:null;
  /* The mask as loaded into this editor; saveRole sends it back so the server
     can refuse an edit made from a copy that has since moved (WP 5.1b). */
  state.roleEditLoadedPerms=role?role.permissions:null;
  const name=role?role.name:'';
  const color=(role&&role.color)?role.color:'';
  const perms=role?role.permissions:0;
  /* A new role defaults to the highest free slot below the caller — the same
     walk-down CreateRole does for an omitted position, shown so the number is
     never a surprise. Prefilling myPosition()-1 unconditionally handed the
     server a slot the previous new role already holds, and CreateRole refuses
     an explicitly requested position that is taken, so every role after the
     first was rejected on its own default. The placement line under the field
     warns when that default outranks existing roles. */
  let position;
  if(role)position=role.position;
  else{
    const taken={};(state.roleList||[]).forEach(r=>{taken[r.position]=true});
    position=Math.max(0,myPosition()-1);
    while(position>0&&taken[position])position--;
  }

  /* Each permission shows its description under its name (U14), not in a
     tooltip only a mouse can reach; the checkbox is named by the name and
     described by the description. */
  let grid='';
  PERM_GROUPS.forEach(g=>{
    grid+='<fieldset class="perm-group"><legend class="perm-group-title">'+esc(g.title)+'</legend><div class="perm-grid">';
    g.bits.forEach(b=>{
      const bit=b[0],label=b[1],desc=b[2];
      const granted=(perms&bit)===bit;
      /* A bit the caller does not hold can only be left as it is: checked and
         locked when the role already has it (removing is a de-escalation the
         server allows, but the panel keeps the rule to one sentence), unchecked
         and locked otherwise. */
      const locked=!canGrantBit(bit);
      const ownerOnly=isOwnerGrantOnlyBit(bit);
      const lockNote=ownerOnly?grantLockTitle(bit)+'.':'Locked: your own role does not have this permission.';
      grid+='<label class="perm-item'+(locked?' locked':'')+'">'
        +'<input type="checkbox" data-permbit="'+bit+'" aria-labelledby="permName'+bit+'" aria-describedby="permDesc'+bit+'" '+(granted?'checked':'')+' '+(locked?'disabled':'')+(locked&&ownerOnly?' title="'+esc(grantLockTitle(bit))+'"':'')+'>'
        +'<span class="perm-text"><span class="perm-name" id="permName'+bit+'">'+esc(label)+'</span>'
        +'<span class="perm-desc" id="permDesc'+bit+'">'+esc(desc)+(locked?'<span class="perm-lock"> '+esc(lockNote)+'</span>':'')
        +(ownerOnly&&role&&role.is_default?'<span class="perm-hint" id="permHint'+bit+'">Giving this to the default role means only '+(isOwnerOnlyGrantBit(bit)?'the owner':'the owner or an Administrator')+' can change members\' roles.</span>':'')+'</span></span></label>';
    });
    grid+='</div></fieldset>';
  });

  openModal('<div class="modal-header"><h3>'+(role?'Edit Role':'Create Role')+'</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'
    +'<div class="modal-body role-form">'
    +'<div class="form-group"><label class="form-label" for="roleName">Name <span class="req">*</span></label><input class="form-input" id="roleName" maxlength="32" value="'+esc(name)+'" placeholder="Moderator"></div>'
    +'<div class="form-group"><label class="form-label" for="roleColor">Color</label><div style="display:flex;align-items:center;gap:10px">'
      +'<input type="color" id="roleColor" value="'+esc(color||'#00c8ff')+'" style="width:44px;height:34px;padding:2px;background:var(--bg-input);border:1px solid var(--border-control);border-radius:var(--radius-sm)">'
      +'<label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted)"><input type="checkbox" id="roleNoColor" '+(color?'':'checked')+'> No color</label>'
    +'</div></div>'
    +'<div class="form-group"><label class="form-label" for="rolePos">Rank position</label>'
      +'<input class="form-input" id="rolePos" type="number" min="0" max="'+Math.max(0,myPosition()-1)+'" value="'+position+'" aria-describedby="rolePosHint rolePlacement" data-input-action="renderRolePlacement">'
      +'<div class="rc-hint" id="rolePosHint">Higher numbers rank higher. It must be below your own rank of '+myPosition()+'.</div>'
      +'<div id="rolePlacement" class="rank-placement" aria-live="polite"></div></div>'
    +'<div class="form-group"><div class="form-label">Display</div>'
      +'<label class="perm-item" for="roleHoist"><input type="checkbox" id="roleHoist" '+(role&&role.hoist?'checked':'')+'><span class="perm-text"><span class="perm-name">Show members separately</span><span class="perm-desc">List members with this as their top role in their own group in the member list.</span></span></label>'
      +'<label class="perm-item" for="roleMentionable"><input type="checkbox" id="roleMentionable" '+(role&&role.mentionable?'checked':'')+'><span class="perm-text"><span class="perm-name">Allow anyone to @mention this role</span><span class="perm-desc">Without it, only members who can mention everyone can ping this role.</span></span></label></div>'
    +'<div class="form-group"><div class="form-label">Permissions</div>'
      +'<div class="role-presets" role="group" aria-label="Role presets">'+ROLE_PRESETS.map(p=>'<button type="button" class="btn btn-ghost btn-sm" data-action="applyRolePreset" data-args="'+actArgs(p.id)+'">'+esc(p.label)+'</button>').join(' ')+'</div>'
      +'<div class="rc-hint" id="rolePresetNote" aria-live="polite">A preset replaces the boxes below; you can still change them.</div>'
      +grid
      +'<div class="rc-hint">Owner powers start with nobody: the owner grants each one by hand.</div></div>'
    +'</div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-accent" data-action="saveRole" data-args="'+actArgs(role?role.id:null)+'">'+(role?'Save':'Create')+'</button></div>');
  renderRolePlacement();
}

/* Collect the checked bits. Disabled boxes still report their state, so a bit
   the caller cannot grant is preserved rather than silently stripped. */
function collectRolePerms(){
  let mask=0;
  document.querySelectorAll('#modalInner input[data-permbit]').forEach(box=>{
    if(box.checked)mask|=parseInt(box.getAttribute('data-permbit'),10);
  });
  return mask;
}

async function saveRole(id){
  const name=document.getElementById('roleName').value.trim();
  if(!name){showToast('Name is required','error');return}
  const position=parseInt(document.getElementById('rolePos').value,10);
  const posErr=rolePositionError(position,id);
  if(posErr){showToast(posErr,'error');return}
  const noColor=document.getElementById('roleNoColor').checked;
  const body={
    name:name,
    color:noColor?'':document.getElementById('roleColor').value,
    permissions:collectRolePerms(),
    position:position,
    hoist:/** @type {HTMLInputElement} */(document.getElementById('roleHoist')).checked,
    mentionable:/** @type {HTMLInputElement} */(document.getElementById('roleMentionable')).checked,
  };
  try{
    if(id===null)await api('POST','/roles',body);
    else await api('PATCH','/roles/'+id,Object.assign({expected_permissions:state.roleEditLoadedPerms},body));
    closeModal();showToast(id===null?'Role created':'Role updated');renderContent();
  }catch(e){
    if(e.status===409&&e.code==='ROLE_CONFLICT'){await reloadRoleAfterConflict(id);return}
    showToast(e.message,'error');
  }
}

/* Another admin changed this role's permissions after the editor loaded it, so
   the save was refused and nothing was written. Reload the list and reopen the
   editor on the latest copy; the edit is not carried over, so it is applied
   again on purpose rather than on top of a mask the admin has not seen. */
async function reloadRoleAfterConflict(id){
  try{
    state.roleList=(await api('GET','/roles'))||[];
    if(state.roleList.some(r=>r.id===id))openRoleModal(id);
    else{closeModal();renderContent()}
  }catch(e){
    closeModal();renderContent();
    showToast('Someone else changed this role and it could not be reloaded. Refresh the page and apply your change again.','error');
    return;
  }
  showToast('Someone else changed this role. The latest version is loaded; apply your change again.','error');
}

function openDeleteRole(id){
  const role=state.roleList.find(r=>r.id===id);
  if(!role){showToast('Role not found','error');return}
  const fallback=state.roleList.find(r=>r.is_default);
  const fallbackName=fallback?fallback.name:'the default role';
  const count=role.member_count||0;
  const members=count===0
    ?'No members hold this role.'
    :'<strong style="color:var(--text-normal)">'+count+' member'+(count===1?'':'s')+'</strong> will be moved to <strong style="color:var(--text-normal)">'+esc(fallbackName)+'</strong>.';
  openModal('<div class="modal-header"><h3>Delete Role</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'
    +'<div class="modal-body"><p style="color:var(--text-muted)">Delete <strong style="color:'+(role.color?readableRoleColor(role.color):'var(--text-normal)')+'">'+esc(role.name)+'</strong>?</p>'
    +'<p style="color:var(--text-muted);margin-top:8px">'+members+'</p>'
    +'<p style="color:var(--text-muted);font-size:12px;margin-top:8px">Its channel permission overrides are removed too. <strong style="color:var(--text-danger)">This cannot be undone.</strong></p>'
    +typedConfirmField(role.name)+'</div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" id="typedConfirmBtn" disabled data-action="confirmDeleteRole" data-args="'+actArgs(id)+'">Delete role</button></div>');
}

async function confirmDeleteRole(id){
  const role=state.roleList.find(r=>r.id===id);
  if(!role||!typedConfirmed(role.name)){showToast('Type the role name exactly to confirm','error');return}
  try{await api('DELETE','/roles/'+id);closeModal();showToast('Role deleted');renderContent()}
  catch(e){showToast(e.message,'error')}
}

/* ═══ Emoji ═══ */
/* Custom emoji live on the ordinary member API (/api/v1/emoji) rather than
   under /admin/api: the desktop client reads the same list, and MANAGE_SERVER
   is enforced by the route itself. The panel's session token authenticates
   there unchanged, so this needs its own fetch helper — like pluginApi. */
async function emojiApi(method,path,opts){
  const init={method,headers:{'Authorization':'Bearer '+state.token}};
  if(opts&&opts.body!==undefined)init.body=opts.body;
  const res=await fetch('/api/v1/emoji'+path,init);
  if(res.status===401){handleSessionExpired();throw new Error('Your session expired — sign in again.')}
  if(res.status===204)return null;
  const text=await res.text();
  let data=null;
  if(text){try{data=JSON.parse(text)}catch(e){data=null}}
  if(!res.ok)throw new Error((data&&(data.message||data.error))||text.trim()||res.statusText);
  return data;
}

/* The image route needs the Authorization header, which <img src> cannot send.
   Each thumbnail is therefore fetched with the token and swapped in as a blob:
   URL once the section has been written into the DOM. */
async function loadEmojiThumbnails(){
  const imgs=document.querySelectorAll('img[data-emoji-url]');
  for(const img of imgs){
    try{
      const res=await fetch(img.getAttribute('data-emoji-url'),{headers:{'Authorization':'Bearer '+state.token}});
      if(!res.ok)continue;
      const blob=await res.blob();
      img.src=URL.createObjectURL(blob);
      img.addEventListener('load',()=>URL.revokeObjectURL(img.src),{once:true});
    }catch(e){/* a thumbnail that will not load is not worth an error toast */}
  }
}

async function renderEmoji(){
  let list;
  try{list=await emojiApi('GET','/')}catch(e){return'<div class="page-title">Emoji</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  if(!Array.isArray(list))list=[];

  let html='<div class="page-title">Emoji</div><div class="page-desc">Server-wide custom emoji, usable as <span style="font-family:var(--font-mono)">:shortcode:</span> in messages and reactions</div>';
  html+='<div class="section-card"><div class="section-card-header"><h3>Upload</h3></div><div class="section-card-body">';
  html+='<div style="color:var(--text-muted);font-size:13px;margin-bottom:10px">PNG, JPEG, GIF or WebP. Up to 512 KB and 128&times;128 pixels. Shortcodes are 2-32 characters of a-z, 0-9 or underscore.</div>';
  html+='<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
  html+='<input type="text" id="emojiShortcode" aria-label="Emoji shortcode" class="form-input" style="max-width:200px" placeholder="shortcode" maxlength="32">';
  html+='<input type="file" id="emojiFile" aria-label="Emoji image file" accept="image/png,image/jpeg,image/gif,image/webp" class="form-input" style="max-width:320px;padding:8px">';
  html+='<button class="btn btn-accent" data-action="uploadEmoji">'+I.upload+' Upload</button>';
  html+='</div></div></div>';

  /* Nothing installed: one line instead of an empty table. */
  if(!list.length)return html+'<section class="section-card" aria-labelledby="emoji-installed-h"><div class="section-card-header"><h3 id="emoji-installed-h">Installed</h3></div><div class="empty-line">'+I.smile+'<span>No custom emoji yet. Upload one above.</span></div></section>';
  html+='<div class="section-card"><div class="section-card-header"><h3>Installed ('+list.length+')</h3><button class="btn btn-ghost" data-action="renderContent">'+I.refresh+' Refresh</button></div><div class="section-card-body no-pad">';
  html+='<table class="tbl"><thead><tr><th style="width:60px">Preview</th><th>Shortcode</th><th style="text-align:right">Actions</th></tr></thead><tbody>';
  list.forEach(function(e){
    html+='<tr><td><img alt="'+esc(e.shortcode)+'" data-emoji-url="'+esc(e.url)+'" style="width:32px;height:32px;object-fit:contain"></td>';
    html+='<td style="font-family:var(--font-mono)">:'+esc(e.shortcode)+':</td>';
    html+='<td><div class="act-group" style="justify-content:flex-end"><button class="act-btn danger" title="Delete" aria-label="Delete" data-action="confirmDeleteEmoji" data-args="'+actArgs(e.id,e.shortcode)+'">'+I.trash+'</button></div></td></tr>';
  });
  html+='</tbody></table></div></div>';
  setTimeout(loadEmojiThumbnails,0);
  return html;
}

async function uploadEmoji(){
  const codeInput=document.getElementById('emojiShortcode');
  const fileInput=document.getElementById('emojiFile');
  const shortcode=(codeInput&&codeInput.value||'').trim();
  const file=fileInput&&fileInput.files&&fileInput.files[0];
  if(!shortcode){showToast('Enter a shortcode first','error');return}
  if(!file){showToast('Choose an image first','error');return}
  const fd=new FormData();
  fd.append('shortcode',shortcode);
  fd.append('file',file);
  try{
    /* No explicit Content-Type: the browser must set the multipart boundary. */
    await emojiApi('POST','/',{body:fd});
    showToast('Added :'+shortcode.toLowerCase()+':');
    renderContent();
  }catch(e){showToast(e.message,'error')}
}

function confirmDeleteEmoji(id,shortcode){
  openModal('<div class="modal-header"><h3>Delete Emoji</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><p style="color:var(--text-muted)">Delete <strong style="color:var(--text-normal)">:'+esc(shortcode)+':</strong>? Messages and reactions that use it will show the plain text instead. This cannot be undone.</p></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="deleteEmoji" data-args="'+actArgs(id)+'">Delete</button></div>');
}

async function deleteEmoji(id){
  try{
    await emojiApi('DELETE','/'+id);
    closeModal();
    showToast('Emoji deleted');
    renderContent();
  }catch(e){showToast(e.message,'error')}
}

Object.assign(ACTIONS,{forumTagAdd,forumTagMove,forumTagRemove,onChannelTypeChange,saveForumSettings,openCategoryPermsModal,openCategoryPermsPicker,saveCategoryPerms,syncChannelPerms,clearPermOverride,confirmDeleteChannel,confirmDeleteEmoji,confirmDeleteRole,createChannel,
  deleteEmoji,explainAccess,moveRole,onPermTargetChange,openChannelEditModal,openChannelModal,openChannelPermsModal,openDeleteChannel,
  applyRolePreset,openDeleteRole,openRoleModal,placeRoleAboveDefault,previewPermChange,renderRolePlacement,
  saveChannelEdit,saveChannelPerms,saveRole,selectChannelTab,syncTypedConfirm,uploadEmoji});
