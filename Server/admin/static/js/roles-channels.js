/* OwnCord admin panel: Channels, the channel permission overrides and access
   explanation, Roles, and Emoji. */

/* ═══ Channels ═══ */
async function renderChannels(){
  let channels;
  try{channels=await api('GET','/channels')}catch(e){return'<div class="page-title">Channels</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  const chIcon=t=>t==='voice'?I.voice:t==='announcement'?I.megaphone:I.channels;
  /* Categories are free text — a channel of any type may live under any one of
     them. Collect the ones already in use so the create/edit forms can offer
     them as a datalist instead of hardcoding names nobody has to use. */
  const catSet={};
  let html='<div class="page-title">Channels</div><div class="page-desc">'+channels.length+' channels</div>';
  html+='<div class="filter-bar"><button class="btn btn-accent" data-action="openChannelModal" data-args="'+actArgs(null)+'">'+I.plus+' Create Channel</button></div>';
  html+='<div class="section-card"><div class="section-card-body no-pad"><table class="tbl"><thead><tr><th>Channel</th><th>Type</th><th>Category</th><th>Archived</th><th style="text-align:right">Actions</th></tr></thead><tbody>';
  if(!channels.length)html+='<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">No channels</td></tr>';
  channels.forEach(ch=>{
    const id=ch.id||ch.ID;const name=ch.name||ch.Name||'';const type=ch.type||ch.Type||'text';
    const cat=ch.category||ch.Category||'';const archived=ch.archived||ch.Archived||false;
    html+='<tr><td><div style="display:flex;align-items:center;gap:8px"><span style="color:var(--text-muted)">'+chIcon(type)+'</span><strong>'+esc(name)+'</strong></div></td>';
    html+='<td><span class="badge '+(type==='voice'?'badge-yellow':type==='announcement'?'badge-accent':'badge-muted')+'">'+esc(type)+'</span></td>';
    html+='<td style="font-size:12px;color:var(--text-muted)">'+esc(cat)+'</td>';
    html+='<td>'+(archived?'<span class="badge badge-muted">Yes</span>':'<span class="badge badge-green">No</span>')+'</td>';
    const lockBtn=type==='dm'?'':'<button class="act-btn" title="Access (private channel)" aria-label="Access (private channel)" data-action="openChannelPermsModal" data-args="'+actArgs(id,name)+'">'+I.lock+'</button>';
    state.channelCache[id]=ch;
    if(cat)catSet[cat]=true;
    html+='<td><div class="act-group" style="justify-content:flex-end"><button class="act-btn" title="Edit" aria-label="Edit" data-action="openChannelEditModal" data-args="'+actArgs(id)+'">'+I.edit+'</button>'+lockBtn+'<button class="act-btn danger" title="Delete" aria-label="Delete" data-action="openDeleteChannel" data-args="'+actArgs(id,name)+'">'+I.trash+'</button></div></td></tr>';
  });
  html+='</tbody></table></div></div>';
  state.channelCategories=Object.keys(catSet).sort();
  return html;
}

/* <datalist> of the categories currently in use. Purely a suggestion list —
   typing a brand-new name is the supported way to create a category. */
function categoryDatalist(listId){
  const cats=state.channelCategories||[];
  let html='<datalist id="'+listId+'">';
  cats.forEach(c=>{html+='<option value="'+esc(c)+'"></option>'});
  return html+'</datalist>';
}

function openChannelModal(){
  openModal('<div class="modal-header"><h3>Create Channel</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><div class="form-group"><label class="form-label" for="chName">Name <span class="req">*</span></label><input class="form-input" id="chName" placeholder="general"></div><div class="form-group"><label class="form-label" for="chType">Type</label><select class="form-input" id="chType" style="appearance:auto"><option value="text">Text</option><option value="voice">Voice</option><option value="announcement">Announcement</option></select></div><div class="form-group"><label class="form-label" for="chCat">Category</label><input class="form-input" id="chCat" list="chCatList" placeholder="Text Channels" autocomplete="off">'+categoryDatalist('chCatList')+'<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Any name works, for voice and text channels alike. Leave blank for no category.</div></div><div class="form-group"><label class="form-label" for="chTopic">Topic</label><input class="form-input" id="chTopic"></div><div class="form-group"><label class="form-label" for="chPos">Position</label><input class="form-input" id="chPos" type="number" value="0" min="0"></div></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-accent" data-action="createChannel">Create</button></div>');
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
  openModal('<div class="modal-header"><h3>Edit Channel</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'
    +'<div class="modal-body">'
    +'<div class="form-group"><label class="form-label" for="chEditName">Name</label><input class="form-input" id="chEditName" value="'+esc(name)+'"></div>'
    +'<div class="form-group"><label class="form-label" for="chEditTopic">Topic</label><input class="form-input" id="chEditTopic" value="'+esc(topic)+'"></div>'
    +'<div class="form-group"><label class="form-label" for="chEditCat">Category</label><input class="form-input" id="chEditCat" list="chEditCatList" value="'+esc(cat)+'" autocomplete="off">'+categoryDatalist('chEditCatList')+'<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Move the channel to another category, or blank it to leave it uncategorized.</div></div>'
    +'<div class="form-group"><label class="form-label" for="chEditSlow">Slow mode (seconds, 0 = off)</label><input class="form-input" id="chEditSlow" type="number" min="0" value="'+esc(slow)+'"></div>'
    +'<div class="form-group"><label class="form-label" for="chEditPos">Position</label><input class="form-input" id="chEditPos" type="number" min="0" value="'+esc(pos)+'"></div>'
    +voiceRows
    +'<div class="setting-row"><div class="setting-info"><div class="setting-name" id="chEditArchived-name">Archived</div><div class="setting-desc">Hide the channel without deleting its messages</div></div><div class="setting-ctrl"><button class="toggle '+(archived?'on':'')+'" id="chEditArchived" role="switch" aria-checked="'+(archived?'true':'false')+'" aria-labelledby="chEditArchived-name" data-action="toggleSwitch"></button></div></div>'
    +'<div class="setting-row"><div class="setting-info"><div class="setting-name" id="chEditNsfw-name">Age-restricted (NSFW)</div><div class="setting-desc">Clients show a one-time warning and mark the channel. The server does not filter or restrict anything.</div></div><div class="setting-ctrl"><button class="toggle '+(nsfw?'on':'')+'" id="chEditNsfw" role="switch" aria-checked="'+(nsfw?'true':'false')+'" aria-labelledby="chEditNsfw-name" data-action="toggleSwitch"></button></div></div>'
    +'</div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-accent" data-action="saveChannelEdit" data-args="'+actArgs(id)+'">Save</button></div>');
}

async function saveChannelEdit(id){
  const name=document.getElementById('chEditName').value.trim();
  if(!name){showToast('Name is required','error');return}
  const body={
    name,
    topic:document.getElementById('chEditTopic').value.trim(),
    category:document.getElementById('chEditCat').value.trim(),
    slow_mode:parseInt(document.getElementById('chEditSlow').value,10)||0,
    position:parseInt(document.getElementById('chEditPos').value,10)||0,
    archived:document.getElementById('chEditArchived').classList.contains('on'),
    nsfw:document.getElementById('chEditNsfw').classList.contains('on'),
  };
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

function openDeleteChannel(id,name){
  openModal('<div class="modal-header"><h3>Delete Channel</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><p style="color:var(--text-muted)">Permanently delete <strong style="color:var(--text-normal)">#'+esc(name)+'</strong> and all its messages?</p></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="confirmDeleteChannel" data-args="'+actArgs(id)+'">Delete</button></div>');
}

async function confirmDeleteChannel(id){
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
  let data,users;
  try{
    data=await api('GET','/channels/'+id+'/permissions');
    users=await api('GET','/users?limit=500&offset=0');
  }catch(e){showToast(e.message,'error');return}
  state.permChannel={id:id,name:name,roles:data.roles||[],users:data.users||[],allUsers:users||[]};
  renderChannelPermsModal();
}

function renderChannelPermsModal(){
  const pc=state.permChannel;if(!pc)return;
  let quick='';
  pc.roles.forEach(role=>{
    const isAdmin=(role.permissions&ADMIN_BIT)!==0;
    const canAccess=isAdmin||((role.deny&0x2)===0);
    quick+='<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--bg-active)">'
      +'<span style="color:'+readableRoleColor(roleColor(role.role_id))+';font-weight:600">'+esc(role.role_name)+'</span>'
      +(isAdmin
        ?'<span style="font-size:12px;color:var(--text-muted)">always has access</span>'
        :'<label style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text-muted);cursor:pointer"><input type="checkbox" id="permRole'+role.role_id+'" '+(canAccess?'checked':'')+'> Can access</label>')
      +'</div>';
  });

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

  openModal('<div class="modal-header"><h3>Channel Permissions — #'+esc(pc.name)+'</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'
    +'<div class="modal-body">'
    +'<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">Uncheck a role to hide this channel from it (private channel). Changes apply to connected users immediately; users already in the voice channel are not disconnected.</p>'
    +quick
    +'<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--bg-active)">'
    +'<div class="form-group"><label class="form-label" for="permTarget">Override matrix</label>'
    +'<select class="form-input" id="permTarget" style="appearance:auto" data-change-action="renderPermMatrix">'+opts+'</select></div>'
    +'<p style="color:var(--text-muted);font-size:12px;margin:0 0 10px">Resolution order: base role permissions → role override → member override. A member deny beats a role allow; Administrator bypasses everything.</p>'
    +'<div id="permMatrix"></div>'
    +'<div id="permPreview"></div>'
    +'</div>'
    +'<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--bg-active)">'
    +'<div class="form-group"><label class="form-label" for="explainUser">Explain access</label>'
    +'<div style="display:flex;gap:8px;flex-wrap:wrap"><select class="form-input" id="explainUser" style="appearance:auto;flex:1;min-width:0">'+memberOpts+'</select>'
    +'<select class="form-input" id="explainAction" aria-label="Action to explain" style="appearance:auto;flex:1;min-width:0">'+actionOpts+'</select>'
    +'<button class="btn btn-ghost" data-action="explainAccess">Explain</button></div></div>'
    +'<div id="permExplain"></div>'
    +'</div></div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-ghost" data-action="previewPermChange">Preview matrix change</button><button class="btn btn-accent" data-action="saveChannelPerms">Save</button></div>');
  renderPermMatrix();
}

/* Reads the current masks for the selected target and paints one tri-state row
   per bit. A member with no override row starts all-inherit. */
function renderPermMatrix(){
  const pc=state.permChannel;if(!pc)return;
  const box=document.getElementById('permMatrix');if(!box)return;
  const pv=document.getElementById('permPreview');if(pv)pv.innerHTML='';
  const sel=document.getElementById('permTarget');
  const val=sel?sel.value:'';
  if(!val){box.innerHTML='<p style="color:var(--text-muted);font-size:12px">Pick a role or member above to edit its per-channel bits.</p>';return}
  const kind=val.charAt(0),tid=parseInt(val.slice(2),10);
  let allow=0,deny=0,adminNote='';
  if(kind==='r'){
    const role=pc.roles.find(r=>r.role_id===tid);
    if(role){allow=role.allow;deny=role.deny;if((role.permissions&ADMIN_BIT)!==0)adminNote='This role holds Administrator — every override below is bypassed.'}
  }else{
    const o=pc.users.find(u=>u.user_id===tid);
    if(o){allow=o.allow;deny=o.deny}
  }
  let html='';
  if(adminNote)html+='<p style="color:var(--text-warning);font-size:12px;margin:0 0 8px">'+esc(adminNote)+'</p>';
  html+='<table class="tbl"><thead><tr><th>Permission</th><th style="text-align:center">Allow</th><th style="text-align:center">Inherit</th><th style="text-align:center">Deny</th></tr></thead><tbody>';
  OVERRIDE_BITS.forEach(b=>{
    const bit=b[0],label=b[1],st=overrideStateOf(allow,deny,bit);
    html+='<tr><td>'+esc(label)+'</td>';
    ['allow','inherit','deny'].forEach(k=>{
      html+='<td style="text-align:center"><input type="radio" name="ovr'+bit+'" data-ovrbit="'+bit+'" value="'+k+'"'+(st===k?' checked':'')+'></td>';
    });
    html+='</tr>';
  });
  html+='</tbody></table>';
  html+='<div style="margin-top:10px"><button class="btn btn-ghost" data-action="clearPermOverride">Clear override</button></div>';
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
  return '/channels/'+pc.id+(kind==='r'?'/permissions/':'/user-permissions/')+tid;
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
   reference an operator reads next to this grid, and every one of the 19
   defined bits must appear in exactly one group or it becomes ungrantable
   here. */
const PERM_GROUPS=[
  {title:'General',bits:[
    [0x20000,'Manage Channels','Create, edit and delete channels and their overrides'],
    [0x1000000,'Manage Roles','Create, edit, delete and assign roles below your own'],
    [0x4000000,'Manage Invites','Create and revoke invite codes'],
    [0x2000000,'Manage Server','Read and change server settings'],
    [0x8000000,'View Audit Log','Read the action history'],
    [0x400000,'Moderate Members','warn and time out members, work the report queue'],
    [0x40000000,'Administrator','Bypasses every permission check'],
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
    [0x100000,'Mute Members','Server mute, deafen, move and disconnect in voice'],
  ]},
];

/* My own position, from GET /me — the hierarchy boundary every row respects. */
function myPosition(){return (state.me&&state.me.role_position)||0}
/* True when the signed-in principal may manage this role at all. */
function canManageRole(role){return role.position<myPosition()}
/* True when this bit may be granted: ADMINISTRATOR grants anything, otherwise
   only bits the caller's own role holds. */
function canGrantBit(bit){
  const p=(state.me&&state.me.permissions)||0;
  if((p&PERM.ADMINISTRATOR)!==0)return true;
  return (p&bit)===bit;
}

async function renderRoles(){
  let roles;
  try{roles=await api('GET','/roles')}catch(e){return'<div class="page-title">Roles</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  state.roleList=roles||[];
  let html='<div class="page-title">Roles</div><div class="page-desc">'+state.roleList.length+' roles, highest rank first. You can only manage roles below your own.</div>';
  html+='<div class="filter-bar"><button class="btn btn-accent" data-action="openRoleModal" data-args="'+actArgs(null)+'">'+I.plus+' Create Role</button></div>';
  html+='<div class="section-card"><div class="section-card-body no-pad"><table class="tbl"><thead><tr><th>Role</th><th>Members</th><th>Position</th><th style="text-align:right">Actions</th></tr></thead><tbody>';
  if(!state.roleList.length)html+='<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:24px">No roles</td></tr>';
  /* Only the manageable slice can be reordered — the reorder endpoint takes
     exactly the roles below the caller, so the arrows move within that slice. */
  const movable=state.roleList.filter(canManageRole);
  state.roleList.forEach(role=>{
    const mine=canManageRole(role);
    const mIdx=movable.findIndex(r=>r.id===role.id);
    const swatch='<span class="role-swatch" style="background:'+(role.color?esc(role.color):'var(--text-muted)')+'"></span>';
    html+='<tr><td><div style="display:flex;align-items:center;gap:8px">'+swatch+'<strong style="color:'+(role.color?readableRoleColor(role.color):'var(--text-normal)')+'">'+esc(role.name)+'</strong>';
    if(role.is_default)html+='<span class="badge badge-muted">default</span>';
    if(!mine)html+='<span class="badge badge-muted">above you</span>';
    html+='</div></td>';
    html+='<td style="color:var(--text-muted)">'+(role.member_count||0)+'</td>';
    html+='<td style="font-size:12px;color:var(--text-muted)">'+role.position+'</td>';
    html+='<td><div class="act-group" style="justify-content:flex-end">';
    if(mine){
      const upDisabled=mIdx<=0?'disabled style="opacity:.3"':'';
      const downDisabled=(mIdx<0||mIdx>=movable.length-1)?'disabled style="opacity:.3"':'';
      html+='<button class="act-btn" title="Move up" aria-label="Move up" '+upDisabled+' data-action="moveRole" data-args="'+actArgs(role.id,-1)+'">'+I.arrowUp+'</button>';
      html+='<button class="act-btn" title="Move down" aria-label="Move down" '+downDisabled+' data-action="moveRole" data-args="'+actArgs(role.id,1)+'">'+I.arrowDown+'</button>';
      html+='<button class="act-btn" title="Edit" aria-label="Edit" data-action="openRoleModal" data-args="'+actArgs(role.id)+'">'+I.edit+'</button>';
      if(role.is_default)html+='<button class="act-btn" title="The default role cannot be deleted" aria-label="The default role cannot be deleted" disabled style="opacity:.3">'+I.trash+'</button>';
      else html+='<button class="act-btn danger" title="Delete" aria-label="Delete" data-action="openDeleteRole" data-args="'+actArgs(role.id)+'">'+I.trash+'</button>';
    }else{
      html+='<span style="font-size:12px;color:var(--text-muted)">read-only</span>';
    }
    html+='</div></td></tr>';
  });
  html+='</tbody></table></div></div>';
  return html;
}

/* Swap a role with its neighbour and send the whole manageable order. The
   endpoint normalizes positions, so the client never computes them. */
async function moveRole(id,delta){
  const movable=state.roleList.filter(canManageRole);
  const i=movable.findIndex(r=>r.id===id);
  const j=i+delta;
  if(i<0||j<0||j>=movable.length)return;
  const ids=movable.map(r=>r.id);
  ids[i]=movable[j].id;ids[j]=movable[i].id;
  try{await api('PATCH','/roles/reorder',{role_ids:ids});showToast('Roles reordered');renderContent()}
  catch(e){showToast(e.message,'error')}
}

/* Shared create/edit modal. id === null creates. */
function openRoleModal(id){
  const role=id===null?null:state.roleList.find(r=>r.id===id);
  if(id!==null&&!role){showToast('Role not found','error');return}
  const name=role?role.name:'';
  const color=(role&&role.color)?role.color:'';
  const perms=role?role.permissions:0;
  /* A new role defaults to the highest free slot below the caller — the same
     walk-down CreateRole does for an omitted position, shown so the number is
     never a surprise. Prefilling myPosition()-1 unconditionally handed the
     server a slot the previous new role already holds, and CreateRole refuses
     an explicitly requested position that is taken, so every role after the
     first was rejected on its own default. */
  let position;
  if(role)position=role.position;
  else{
    const taken={};(state.roleList||[]).forEach(r=>{taken[r.position]=true});
    position=Math.max(0,myPosition()-1);
    while(position>0&&taken[position])position--;
  }

  let grid='';
  PERM_GROUPS.forEach(g=>{
    grid+='<div class="perm-group"><div class="perm-group-title">'+esc(g.title)+'</div><div class="perm-grid">';
    g.bits.forEach(b=>{
      const bit=b[0],label=b[1],desc=b[2];
      const granted=(perms&bit)===bit;
      /* A bit the caller does not hold can only be left as it is: checked and
         locked when the role already has it (removing is a de-escalation the
         server allows, but the panel keeps the rule to one sentence), unchecked
         and locked otherwise. */
      const locked=!canGrantBit(bit);
      const title=locked?'Your own role does not have this permission':desc;
      grid+='<label class="perm-item'+(locked?' locked':'')+'" title="'+esc(title)+'">'
        +'<input type="checkbox" data-permbit="'+bit+'" '+(granted?'checked':'')+' '+(locked?'disabled':'')+'>'
        +'<span>'+esc(label)+'</span></label>';
    });
    grid+='</div></div>';
  });

  openModal('<div class="modal-header"><h3>'+(role?'Edit Role':'Create Role')+'</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'
    +'<div class="modal-body">'
    +'<div class="form-group"><label class="form-label" for="roleName">Name <span class="req">*</span></label><input class="form-input" id="roleName" maxlength="32" value="'+esc(name)+'" placeholder="Moderator"></div>'
    +'<div class="form-group"><label class="form-label" for="roleColor">Color</label><div style="display:flex;align-items:center;gap:10px">'
      +'<input type="color" id="roleColor" value="'+esc(color||'#00c8ff')+'" style="width:44px;height:34px;padding:2px;background:var(--bg-input);border:1px solid var(--border-control);border-radius:var(--radius-sm)">'
      +'<label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-muted)"><input type="checkbox" id="roleNoColor" '+(color?'':'checked')+'> No color</label>'
    +'</div></div>'
    +'<div class="form-group"><label class="form-label" for="rolePos">Position (must be below your own rank of '+myPosition()+')</label><input class="form-input" id="rolePos" type="number" min="0" max="'+Math.max(0,myPosition()-1)+'" value="'+position+'"></div>'
    +'<div class="form-group"><label class="form-label">Permissions</label>'+grid+'</div>'
    +'</div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-accent" data-action="saveRole" data-args="'+actArgs(role?role.id:null)+'">'+(role?'Save':'Create')+'</button></div>');
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
  const noColor=document.getElementById('roleNoColor').checked;
  const body={
    name:name,
    color:noColor?'':document.getElementById('roleColor').value,
    permissions:collectRolePerms(),
    position:parseInt(document.getElementById('rolePos').value,10)||0,
  };
  try{
    if(id===null)await api('POST','/roles',body);
    else await api('PATCH','/roles/'+id,body);
    closeModal();showToast(id===null?'Role created':'Role updated');renderContent();
  }catch(e){showToast(e.message,'error')}
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
    +'<p style="color:var(--text-muted);font-size:12px;margin-top:8px">Its channel permission overrides are removed too. This cannot be undone.</p></div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="confirmDeleteRole" data-args="'+actArgs(id)+'">Delete</button></div>');
}

async function confirmDeleteRole(id){
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

  html+='<div class="section-card"><div class="section-card-header"><h3>Installed ('+list.length+')</h3><button class="btn btn-ghost" data-action="renderContent">'+I.refresh+' Refresh</button></div><div class="section-card-body no-pad">';
  html+='<table class="tbl"><thead><tr><th style="width:60px">Preview</th><th>Shortcode</th><th style="text-align:right">Actions</th></tr></thead><tbody>';
  if(!list.length)html+='<tr><td colspan="3" style="text-align:center;color:var(--text-muted);padding:24px">No custom emoji yet</td></tr>';
  else list.forEach(function(e){
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

Object.assign(ACTIONS,{clearPermOverride,confirmDeleteChannel,confirmDeleteEmoji,confirmDeleteRole,createChannel,
  deleteEmoji,explainAccess,moveRole,openChannelEditModal,openChannelModal,openChannelPermsModal,openDeleteChannel,
  openDeleteRole,openRoleModal,previewPermChange,renderPermMatrix,saveChannelEdit,saveChannelPerms,saveRole,uploadEmoji});
