/* OwnCord admin panel: Storage (what fills the disk, every upload with filters
   and bulk delete, and leftover files no message uses). MANAGE_SERVER, like
   the routes under /storage. */

state.storage={sort:'largest',q:'',kind:'',channel:0,uploader:0,uploaderName:'',older:0,cursors:[''],page:0,selected:{},rows:{}};
let storageListSeq=0;let storageSearchTimer=null;

const STORAGE_KINDS=[['','Any type'],['image','Images'],['video','Videos'],['audio','Audio'],['other','Other files']];
const STORAGE_AGES=[[0,'Any age'],[30,'Older than 1 month'],[90,'Older than 3 months'],[180,'Older than 6 months'],[365,'Older than 1 year']];
const STORAGE_KIND_LABEL={image:'Images',video:'Videos',audio:'Audio',other:'Other files'};
const STORAGE_STATE_LABEL={pending:'Not sent',deleted:'Message deleted',avatar:'Profile picture',banner:'Profile banner',group_icon:'Group icon'};

function storageQuery(){
  const s=state.storage;
  let q='?sort='+s.sort+'&limit='+PAGE_SIZE;
  if(s.q)q+='&q='+encodeURIComponent(s.q);
  if(s.kind)q+='&kind='+s.kind;
  if(s.channel)q+='&channel='+s.channel;
  if(s.uploader)q+='&uploader='+s.uploader;
  if(s.older)q+='&older_than_days='+s.older;
  const cur=s.cursors[s.page];
  if(cur)q+='&cursor='+encodeURIComponent(cur);
  return q;
}

/* One bar for the disk: uploads, the database, backups and free space, each a
   share of their sum. The legend carries every figure as text, so the bar is
   never the only way to read it. */
function storageBarHtml(sum){
  const parts=[['Uploads',sum.upload_bytes||0,'var(--accent)'],['Database',sum.database_bytes||0,'var(--accent-secondary)'],['Backups',sum.backup_bytes||0,'var(--text-positive)']];
  if(typeof sum.disk_free_bytes==='number')parts.push(['Free',sum.disk_free_bytes,'var(--text-warning)']);
  const total=parts.reduce((a,p)=>a+p[1],0)||1;
  return'<div class="storage-bar" aria-hidden="true">'+parts.map(p=>'<span style="width:'+(p[1]/total*100).toFixed(2)+'%;background:'+p[2]+'"></span>').join('')+'</div>'
    +'<div class="storage-legend">'+parts.map(p=>'<span><i style="background:'+p[2]+'"></i>'+p[0]+' '+fmtBytes(p[1])+'</span>').join('')+'</div>';
}

async function renderStorage(){
  let sum;
  try{sum=await api('GET','/storage/summary')}
  catch(e){return'<div class="page-title">Storage</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  let channels=[];
  try{const r=await api('GET','/retention/channels');if(Array.isArray(r))channels=r}catch(e){}
  const s=state.storage;
  const kinds=(sum.uploads||[]).map(k=>esc(STORAGE_KIND_LABEL[k.kind]||k.kind)+' '+fmtBytes(k.bytes)+' ('+k.count.toLocaleString()+')').join(' · ');
  const limit=sum.user_quota_bytes?'Each member may upload up to '+fmtBytes(sum.user_quota_bytes)+' unless you set their own limit on the Members page.':'Members have no upload limit unless you set one for them on the Members page.';
  let html='<div class="page-title">Storage</div><div class="page-desc">What uses space on this server. Delete files here to free space; a message that used a file loses it.</div>';
  html+='<section class="section-card"><div class="section-card-body">'+storageBarHtml(sum)
    +'<p class="storage-note">'+(sum.upload_count?sum.upload_count.toLocaleString()+' uploads: '+kinds:'No uploads yet.')+'</p><p class="storage-note">'+esc(limit)+'</p></div></section>';
  html+='<section class="section-card" id="storageLeftovers"><div class="section-card-body storage-leftovers">Checking for leftover files…</div></section>';
  html+='<div class="filter-bar" role="search">'
    +'<label class="sr-only" for="storageKind">File type</label><select class="filter-select" id="storageKind" data-change-action="filterStorage" data-args="'+actArgs('kind')+'">'+STORAGE_KINDS.map(([v,l])=>'<option value="'+v+'"'+(s.kind===v?' selected':'')+'>'+l+'</option>').join('')+'</select>'
    +'<label class="sr-only" for="storageChannel">Channel</label><select class="filter-select" id="storageChannel" data-change-action="filterStorage" data-args="'+actArgs('channel')+'"><option value="0">Any channel</option>'
    +channels.map(c=>'<option value="'+c.id+'"'+(s.channel===c.id?' selected':'')+'>#'+esc(c.name)+'</option>').join('')+'</select>'
    +'<label class="sr-only" for="storageOlder">Age</label><select class="filter-select" id="storageOlder" data-change-action="filterStorage" data-args="'+actArgs('older')+'">'+STORAGE_AGES.map(([v,l])=>'<option value="'+v+'"'+(s.older===v?' selected':'')+'>'+l+'</option>').join('')+'</select>'
    +'<label class="sr-only" for="storageSort">Sort</label><select class="filter-select" id="storageSort" data-change-action="filterStorage" data-args="'+actArgs('sort')+'"><option value="largest"'+(s.sort==='largest'?' selected':'')+'>Largest first</option><option value="newest"'+(s.sort==='newest'?' selected':'')+'>Newest first</option></select>'
    +'<label class="sr-only" for="storageSearch">Search file name</label><input class="filter-search" id="storageSearch" type="search" maxlength="100" autocomplete="off" spellcheck="false" placeholder="Search file name" value="'+esc(s.q)+'" data-input-action="searchStorage">'
    +'</div><div id="storageUploader"></div><div id="storageList"></div>';
  const seq=++storageListSeq;
  setTimeout(()=>{loadStorageLeftovers();refreshStorageList(seq)},0);
  return html;
}

async function loadStorageLeftovers(){
  const box=document.querySelector('#storageLeftovers .section-card-body');
  let scan;
  try{scan=await api('GET','/storage/leftovers')}catch(e){if(box)box.textContent=e.message;return}
  if(!box||state.section!=='storage')return;
  box.innerHTML=storageLeftoverHtml(scan);
}
function storageLeftoverHtml(scan){
  if(!scan||!scan.count)return'<span>No leftover files. Every file on disk belongs to an upload, emoji or sticker.</span>';
  return'<span><strong>'+scan.count.toLocaleString()+' leftover '+(scan.count===1?'file':'files')+'</strong> ('+fmtBytes(scan.bytes)+') that nothing uses any more, older than a day.</span>'
    +'<button class="btn btn-outline" data-action="cleanStorageLeftovers">Clean up</button>';
}
async function cleanStorageLeftovers(){
  if(!confirm('Delete the leftover files? Nothing on the server uses them.'))return;
  try{
    const r=await api('POST','/storage/leftovers');
    showToast('Removed '+r.removed+' leftover '+(r.removed===1?'file':'files'));
    const box=document.querySelector('#storageLeftovers .section-card-body');
    if(box)box.innerHTML=storageLeftoverHtml(r);
  }catch(e){showToast(e.message,'error')}
}

/* Only the table is replaced, so a search keeps focus in its box. A later
   request supersedes one still in flight, and its rows never land. */
async function refreshStorageList(seq){
  if(seq===undefined)seq=++storageListSeq;
  const s=state.storage;
  let page;
  try{page=await api('GET','/storage/files'+storageQuery())}
  catch(e){page={error:e.message}}
  const el=document.getElementById('storageList');
  if(seq!==storageListSeq||state.section!=='storage'||!el)return;
  const who=document.getElementById('storageUploader');
  if(who)who.innerHTML=s.uploader?'<div class="storage-chip">Uploaded by <strong>'+esc(s.uploaderName)+'</strong><button type="button" class="chip-remove" aria-label="Show every member\'s files" data-action="clearStorageUploader">&times;</button></div>':'';
  if(page.error){el.innerHTML='<p style="color:var(--text-danger)">'+esc(page.error)+'</p>';return}
  s.rows={};(page.items||[]).forEach(it=>{s.rows[it.attachment.id]=it});
  s.cursors[s.page+1]=page.next_cursor||'';
  el.innerHTML=storageTableHtml(page.items||[],!!page.next_cursor);
}

function storageChannelText(it){
  if(it.channel_type==='dm')return'Direct message';
  if(it.channel_name)return'#'+it.channel_name;
  return'—';
}
function storageTableHtml(items,hasMore){
  const s=state.storage;
  let html='<div class="section-card"><div class="section-card-body no-pad"><table class="tbl storage-tbl"><thead><tr><th scope="col" class="col-check"><span class="sr-only">Select</span></th><th scope="col">File</th><th scope="col">Size</th><th scope="col">Uploaded by</th><th scope="col" class="col-channel">Channel</th><th scope="col" class="col-date">Date</th></tr></thead><tbody>';
  if(!items.length)html+='<tr><td colspan="6" class="members-empty">No files match.</td></tr>';
  items.forEach(it=>{
    const a=it.attachment;const sel=!!s.selected[a.id];
    const note=STORAGE_STATE_LABEL[it.state];
    const box=it.removable
      ?'<input type="checkbox" aria-label="Select '+esc(a.filename)+'"'+(sel?' checked':'')+' data-change-action="toggleStorageFile" data-args="'+actArgs(a.id)+'">'
      :'<input type="checkbox" disabled aria-label="'+esc(a.filename)+' is in use" title="In use as a '+esc((note||'').toLowerCase())+'; change that first">';
    const who=it.uploader_id?'<button type="button" class="link-btn" data-action="filterStorageUploader" data-args="'+actArgs(it.uploader_id,it.uploader)+'">'+esc(it.uploader||('user #'+it.uploader_id))+'</button>':'<span class="member-sub">unknown</span>';
    html+='<tr'+(sel?' class="is-selected"':'')+'><td class="col-check">'+box+'</td><td class="storage-name"><span title="'+esc(a.mime)+'">'+esc(a.filename)+'</span>'+(note?' <span class="badge '+(it.removable?'badge-muted':'badge-yellow')+'">'+esc(note)+'</span>':'')+'</td>'
      +'<td class="mono">'+fmtBytes(a.size)+'</td><td>'+who+'</td><td class="col-channel">'+esc(storageChannelText(it))+'</td><td class="col-date">'+fmtLocal(it.uploaded_at)+'</td></tr>';
  });
  html+='</tbody></table></div></div>';
  const ids=Object.keys(s.selected);const bytes=ids.reduce((n,id)=>n+s.selected[id],0);
  html+='<div class="storage-foot"><span class="storage-note" role="status">'+(ids.length?ids.length+' selected · '+fmtBytes(bytes):'Tick files to delete them, up to 100 at a time.')+'</span>'
    +'<span class="act-group"><button class="btn btn-ghost" data-action="clearStorageSelection"'+(ids.length?'':' disabled')+'>Clear</button><button class="btn btn-danger" data-action="confirmStorageDelete"'+(ids.length?'':' disabled')+'>Delete '+(ids.length||'')+' '+(ids.length===1?'file':'files')+'</button></span></div>';
  html+='<div class="pagination"><div class="pagination-info">Page '+(s.page+1)+'</div><div class="pagination-btns">'
    +'<button class="page-btn" '+(s.page<=0?'disabled':'')+' data-action="turnStoragePage" data-args="[-1]" aria-label="Previous page">&lt;</button>'
    +'<button class="page-btn active" aria-current="page">'+(s.page+1)+'</button>'
    +'<button class="page-btn" '+(hasMore?'':'disabled')+' data-action="turnStoragePage" data-args="[1]" aria-label="Next page">&gt;</button></div></div>';
  return html;
}

function resetStoragePaging(){state.storage.cursors=[''];state.storage.page=0}
function filterStorage(key){
  const s=state.storage;
  if(key==='sort')s.sort=this.value==='newest'?'newest':'largest';
  else if(key==='kind')s.kind=this.value;
  else s[key]=parseInt(this.value,10)||0;
  resetStoragePaging();refreshStorageList();
}
function searchStorage(){
  state.storage.q=this.value.trim();resetStoragePaging();
  clearTimeout(storageSearchTimer);storageSearchTimer=setTimeout(()=>refreshStorageList(),250);
}
function filterStorageUploader(id,name){state.storage.uploader=id;state.storage.uploaderName=name||('user #'+id);resetStoragePaging();refreshStorageList()}
function clearStorageUploader(){state.storage.uploader=0;state.storage.uploaderName='';resetStoragePaging();refreshStorageList()}
function turnStoragePage(delta){
  const s=state.storage;const next=s.page+delta;
  if(next<0||(delta>0&&!s.cursors[next]))return;
  s.page=next;refreshStorageList();
}
/* The selection survives paging and filters, so files from several pages can
   go in one delete; the server takes 100 at a time. */
function toggleStorageFile(id){
  const s=state.storage;const it=s.rows[id];
  if(this.checked){
    if(Object.keys(s.selected).length>=100){this.checked=false;showToast('Select at most 100 files at a time','error');return}
    s.selected[id]=it?it.attachment.size:0;
  }else delete s.selected[id];
  this.closest('tr')?.classList.toggle('is-selected',this.checked);
  const ids=Object.keys(s.selected);const bytes=ids.reduce((n,k)=>n+s.selected[k],0);
  const foot=document.querySelector('.storage-foot');
  if(foot){
    foot.querySelector('.storage-note').textContent=ids.length?ids.length+' selected · '+fmtBytes(bytes):'Tick files to delete them, up to 100 at a time.';
    foot.querySelectorAll('button').forEach(b=>{b.disabled=!ids.length});
    foot.querySelector('.btn-danger').textContent='Delete '+(ids.length||'')+' '+(ids.length===1?'file':'files');
  }
}
function clearStorageSelection(){state.storage.selected={};refreshStorageList()}

function confirmStorageDelete(){
  const ids=Object.keys(state.storage.selected);if(!ids.length)return;
  const bytes=ids.reduce((n,k)=>n+state.storage.selected[k],0);
  openModal('<div class="modal-header"><h3>Delete '+ids.length+' '+(ids.length===1?'file':'files')+'</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'
    +'<div class="modal-body"><p style="color:var(--text-muted)">This frees about <strong style="color:var(--text-normal)">'+fmtBytes(bytes)+'</strong>. Messages that used these files lose them, and a message left with no text and no files is deleted.</p>'
    +'<p style="color:var(--text-muted);margin-top:10px"><strong style="color:var(--text-danger)">This cannot be undone.</strong> Each delete is written to the audit log.</p></div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="deleteStorageFiles">Delete</button></div>');
}
async function deleteStorageFiles(){
  const ids=Object.keys(state.storage.selected);
  const btn=this instanceof HTMLButtonElement?this:null;if(btn)btn.disabled=true;
  try{
    const r=await api('POST','/storage/files/delete',{ids});
    closeModal();
    const done=r.deleted.length+r.already_gone.length;
    const parts=['Deleted '+done+' '+(done===1?'file':'files')+' ('+fmtBytes(r.freed_bytes)+')'];
    if(r.in_use.length)parts.push(r.in_use.length+' in use, kept');
    if(r.failed.length)parts.push(r.failed.length+' failed');
    if(r.files_kept)parts.push(r.files_kept+' stayed on disk and show up as leftover files');
    showToast(parts.join('; '),r.failed.length||r.files_kept?'error':'success');
    r.deleted.concat(r.already_gone).forEach(id=>{delete state.storage.selected[id]});
    renderContent();
  }catch(e){if(btn)btn.disabled=false;showToast(e.message,'error')}
}

Object.assign(ACTIONS,{cleanStorageLeftovers,filterStorage,searchStorage,filterStorageUploader,clearStorageUploader,turnStoragePage,
  toggleStorageFile,clearStorageSelection,confirmStorageDelete,deleteStorageFiles});
