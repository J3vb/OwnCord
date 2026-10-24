/* Custom stickers (WP 8.8): upload, preview, rename and delete.
   Like emoji, stickers live on the ordinary member API (/api/v1/stickers) and
   MANAGE_SERVER is enforced by the route itself; the panel's session token
   authenticates there unchanged. The checks below mirror the server's limits
   so an obvious mistake is caught before the upload, and every server message
   (409 name taken, 413 too large, the 60-sticker limit) is shown as sent. */

const STICKER_MAX_BYTES=512*1024;
const STICKER_MAX_COUNT=60;
const STICKER_NAME_RE=/^[A-Za-z0-9 _-]{2,30}$/;
const STICKER_TYPES=['image/png','image/gif','image/webp'];

/* The first problem with a name, an emoji or a file, or '' when there is none. */
function stickerNameProblem(name){
  return STICKER_NAME_RE.test(name)?'':'Name must be 2-30 characters of letters, digits, space, underscore or hyphen';
}
function stickerEmojiProblem(emoji){
  return emoji.length>64?'Related emoji is too long':'';
}
function stickerFileProblem(file){
  if(!file)return'Choose an image first';
  if(STICKER_TYPES.indexOf(file.type)<0)return'Sticker must be a PNG, GIF or WebP image';
  if(file.size>STICKER_MAX_BYTES)return'Sticker must be at most 512 KB';
  return'';
}

async function stickerApi(method,path,opts){
  const init={method,headers:{'Authorization':'Bearer '+state.token}};
  if(opts&&opts.json!==undefined){init.body=JSON.stringify(opts.json);init.headers['Content-Type']='application/json'}
  if(opts&&opts.body!==undefined)init.body=opts.body;
  const res=await fetch('/api/v1/stickers'+path,init);
  if(res.status===401){handleSessionExpired();throw new Error('Your session expired — sign in again.')}
  if(res.status===204)return null;
  const text=await res.text();
  let data=null;
  if(text){try{data=JSON.parse(text)}catch(e){data=null}}
  if(!res.ok){
    /* 413 comes from the body-size guard and carries no JSON message. */
    const fallback=res.status===413?'Sticker is too large (512 KB at most)':res.statusText;
    throw new Error((data&&(data.message||data.error))||text.trim()||fallback);
  }
  return data;
}

/* The image route needs the Authorization header, which <img src> cannot send,
   so each preview is fetched with the token and swapped in as a blob: URL. */
async function loadStickerThumbnails(){
  const imgs=document.querySelectorAll('img[data-sticker-url]');
  for(const img of imgs){
    if(!(img instanceof HTMLImageElement))continue;
    try{
      const res=await fetch(img.getAttribute('data-sticker-url')||'',{headers:{'Authorization':'Bearer '+state.token}});
      if(!res.ok)continue;
      const blob=await res.blob();
      const url=URL.createObjectURL(blob);
      img.addEventListener('load',()=>URL.revokeObjectURL(url),{once:true});
      img.src=url;
    }catch(e){/* a preview that will not load is not worth an error toast */}
  }
}

async function renderStickers(){
  let list;
  try{list=await stickerApi('GET','/')}catch(e){return'<div class="page-title">Stickers</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  if(!Array.isArray(list))list=[];

  let html='<div class="page-title">Stickers</div><div class="page-desc">Server-wide custom stickers that members send from the composer</div>';
  html+='<div class="section-card"><div class="section-card-header"><h3>Upload</h3></div><div class="section-card-body">';
  html+='<div style="color:var(--text-muted);font-size:13px;margin-bottom:10px">PNG, GIF or WebP (animated is fine). Up to 512 KB and 320&times;320 pixels. Names are 2-30 characters. Up to '+STICKER_MAX_COUNT+' stickers ('+list.length+' used). The related emoji is optional and only helps search.</div>';
  html+='<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">';
  html+='<input type="text" id="stickerName" aria-label="Sticker name" class="form-input" style="max-width:200px" placeholder="name" maxlength="30">';
  html+='<input type="text" id="stickerEmoji" aria-label="Related emoji (optional)" class="form-input" style="max-width:160px" placeholder="related emoji" maxlength="64">';
  html+='<input type="file" id="stickerFile" aria-label="Sticker image file" accept="image/png,image/gif,image/webp" class="form-input" style="max-width:320px;padding:8px">';
  html+='<button class="btn btn-accent" data-action="uploadSticker">'+I.upload+' Upload</button>';
  html+='</div></div></div>';

  if(!list.length)return html+'<section class="section-card" aria-labelledby="sticker-installed-h"><div class="section-card-header"><h3 id="sticker-installed-h">Installed</h3></div><div class="empty-line">'+I.smile+'<span>No stickers yet. Upload one above.</span></div></section>';
  html+='<div class="section-card"><div class="section-card-header"><h3>Installed ('+list.length+')</h3><button class="btn btn-ghost" data-action="renderContent">'+I.refresh+' Refresh</button></div><div class="section-card-body no-pad">';
  html+='<table class="tbl"><thead><tr><th style="width:80px">Preview</th><th>Name</th><th>Related emoji</th><th style="text-align:right">Actions</th></tr></thead><tbody>';
  list.forEach(function(s){
    html+='<tr><td><img alt="'+esc(s.name)+'" data-sticker-url="'+esc(s.url)+'" style="width:56px;height:56px;object-fit:contain"></td>';
    html+='<td>'+esc(s.name)+'</td><td>'+esc(s.emoji||'')+'</td>';
    html+='<td><div class="act-group" style="justify-content:flex-end">';
    html+='<button class="act-btn" title="Rename" aria-label="Rename" data-action="openRenameSticker" data-args="'+actArgs(s.id,s.name,s.emoji||'')+'">'+I.edit+'</button>';
    html+='<button class="act-btn danger" title="Delete" aria-label="Delete" data-action="confirmDeleteSticker" data-args="'+actArgs(s.id,s.name)+'">'+I.trash+'</button>';
    html+='</div></td></tr>';
  });
  html+='</tbody></table></div></div>';
  setTimeout(loadStickerThumbnails,0);
  return html;
}

async function uploadSticker(){
  const nameInput=document.getElementById('stickerName');
  const emojiInput=document.getElementById('stickerEmoji');
  const fileInput=document.getElementById('stickerFile');
  const name=(nameInput instanceof HTMLInputElement?nameInput.value:'').trim();
  const emoji=(emojiInput instanceof HTMLInputElement?emojiInput.value:'').trim();
  const file=fileInput instanceof HTMLInputElement&&fileInput.files?fileInput.files[0]:null;
  const problem=stickerNameProblem(name)||stickerEmojiProblem(emoji)||stickerFileProblem(file);
  if(problem){showToast(problem,'error');return}
  const fd=new FormData();
  fd.append('name',name);
  if(emoji)fd.append('emoji',emoji);
  fd.append('file',file);
  try{
    /* No explicit Content-Type: the browser must set the multipart boundary. */
    await stickerApi('POST','/',{body:fd});
    showToast('Added sticker '+name);
    renderContent();
  }catch(e){showToast(e.message,'error')}
}

function openRenameSticker(id,name,emoji){
  openModal('<div class="modal-header"><h3>Edit Sticker</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body">'
    +'<label class="form-label" for="stickerRenameName">Name</label><input type="text" id="stickerRenameName" class="form-input" maxlength="30" value="'+esc(name)+'">'
    +'<label class="form-label" for="stickerRenameEmoji" style="margin-top:12px">Related emoji (optional)</label><input type="text" id="stickerRenameEmoji" class="form-input" maxlength="64" value="'+esc(emoji)+'">'
    +'</div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-accent" data-action="saveSticker" data-args="'+actArgs(id)+'">Save</button></div>');
}

async function saveSticker(id){
  const nameInput=document.getElementById('stickerRenameName');
  const emojiInput=document.getElementById('stickerRenameEmoji');
  const name=(nameInput instanceof HTMLInputElement?nameInput.value:'').trim();
  const emoji=(emojiInput instanceof HTMLInputElement?emojiInput.value:'').trim();
  const problem=stickerNameProblem(name)||stickerEmojiProblem(emoji);
  if(problem){showToast(problem,'error');return}
  try{
    await stickerApi('PATCH','/'+id,{json:{name,emoji}});
    closeModal();
    showToast('Sticker updated');
    renderContent();
  }catch(e){showToast(e.message,'error')}
}

function confirmDeleteSticker(id,name){
  openModal('<div class="modal-header"><h3>Delete Sticker</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><p style="color:var(--text-muted)">Delete <strong style="color:var(--text-normal)">'+esc(name)+'</strong>? Messages that already use it will show &ldquo;Deleted sticker&rdquo; instead. This cannot be undone.</p></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="deleteSticker" data-args="'+actArgs(id)+'">Delete</button></div>');
}

async function deleteSticker(id){
  try{
    await stickerApi('DELETE','/'+id);
    closeModal();
    showToast('Sticker deleted');
    renderContent();
  }catch(e){showToast(e.message,'error')}
}

Object.assign(ACTIONS,{confirmDeleteSticker,deleteSticker,openRenameSticker,saveSticker,uploadSticker});
