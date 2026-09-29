/* OwnCord admin panel: Invites (create, copy, revoke, and trace who redeemed
   each code). Invites live on the ordinary member API (/api/v1/invites,
   MANAGE_INVITES) rather than under /admin/api, exactly as custom emoji do; the
   panel's session token authenticates there unchanged. The redemption history
   is the O1 fix: before it, invites.redeemed_by was never written, so a leaked
   code could not be traced to the account that spent it. */

async function inviteApi(method,path,opts){
  const init={method,headers:{'Authorization':'Bearer '+state.token}};
  if(opts&&opts.body!==undefined){init.headers['Content-Type']='application/json';init.body=JSON.stringify(opts.body)}
  const res=await fetch('/api/v1/invites'+path,init);
  if(res.status===401){handleSessionExpired();throw new Error('Your session expired — sign in again.')}
  if(res.status===204)return null;
  const text=await res.text();
  let data=null;
  if(text){try{data=JSON.parse(text)}catch(e){data=null}}
  if(!res.ok)throw new Error((data&&(data.message||data.error))||text.trim()||res.statusText);
  return data;
}

/* An invite is usable unless it is revoked or past its expiry. The server
   enforces the same rule; this only decides what to render. */
function inviteUsable(inv){
  if(inv.revoked)return false;
  if(!inv.expires_at)return true;
  const t=utcDate(String(inv.expires_at).replace(' ','T')).getTime();
  return isNaN(t)||t>Date.now();
}
function inviteStatus(inv){
  if(inv.revoked)return'<span class="badge badge-red">Revoked</span>';
  if(!inviteUsable(inv))return'<span class="badge badge-muted">Expired</span>';
  if(inv.max_uses!==null&&inv.max_uses!==undefined&&inv.uses>=inv.max_uses)return'<span class="badge badge-muted">Exhausted</span>';
  return'<span class="badge badge-green">Active</span>';
}
function inviteUses(inv){
  const max=(inv.max_uses===null||inv.max_uses===undefined)?null:inv.max_uses;
  return max===null?inv.uses+' uses':inv.uses+' / '+max+' uses';
}

async function renderInvites(){
  let list;
  try{list=await inviteApi('GET','/')}catch(e){return'<div class="page-title">Invites</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  if(!Array.isArray(list))list=[];

  let html='<div class="page-title">Invites</div><div class="page-desc">Create codes people use to join this server, and see who redeemed each one</div>';

  html+='<div class="section-card"><div class="section-card-header"><h3>Create invite</h3></div><div class="section-card-body">';
  html+='<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">';
  html+='<div class="form-group" style="margin:0"><label class="form-label" for="inviteMaxUses">Max uses</label><input class="form-input" id="inviteMaxUses" type="number" min="0" max="1000" value="0" style="max-width:120px" aria-describedby="inviteMaxUsesHint"></div>';
  html+='<div class="form-group" style="margin:0"><label class="form-label" for="inviteExpiry">Expires in (hours)</label><input class="form-input" id="inviteExpiry" type="number" min="0" max="720" value="24" style="max-width:140px" aria-describedby="inviteExpiryHint"></div>';
  html+='<button class="btn btn-accent" data-action="createInvite">'+I.plus+' Create invite</button>';
  html+='</div>';
  html+='<p class="wiz-hint" id="inviteMaxUsesHint">0 means unlimited uses.</p>';
  html+='<p class="wiz-hint" id="inviteExpiryHint">0 means never expires. Maximum 720 hours (30 days).</p>';
  html+='</div></div>';

  html+='<div class="section-card"><div class="section-card-header"><h3>Invites ('+list.length+')</h3><button class="btn btn-ghost" data-action="renderContent">'+I.refresh+' Refresh</button></div><div class="section-card-body no-pad">';
  html+='<table class="tbl"><thead><tr><th scope="col">Code</th><th scope="col">Uses</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col" class="col-actions"><span class="sr-only">Actions</span></th></tr></thead><tbody>';
  if(!list.length)html+='<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">No invites yet</td></tr>';
  else list.forEach(function(inv){
    html+='<tr><td><div class="code-copy"><code>'+esc(inv.code)+'</code><button type="button" class="btn btn-ghost" data-action="copyInvite" data-args="'+actArgs(inv.code)+'" aria-label="Copy invite code">Copy</button></div></td>';
    html+='<td>'+esc(inviteUses(inv))+'</td>';
    html+='<td>'+inviteStatus(inv)+'</td>';
    html+='<td>'+fmtLocal(inv.created_at)+'</td>';
    html+='<td class="col-actions"><div class="act-group">';
    html+='<button class="btn btn-outline" data-action="openInviteRedemptions" data-args="'+actArgs(inv.code)+'">Redeemed by<span class="sr-only"> for invite '+esc(inv.code)+'</span></button>';
    if(inviteUsable(inv))html+='<button class="btn btn-outline member-btn danger" data-action="revokeInvite" data-args="'+actArgs(inv.code)+'">Revoke<span class="sr-only"> invite '+esc(inv.code)+'</span></button>';
    html+='</div></td></tr>';
  });
  return html+'</tbody></table></div></div>';
}

async function createInvite(){
  const maxUsesEl=/** @type {HTMLInputElement|null} */(document.getElementById('inviteMaxUses'));
  const expiryEl=/** @type {HTMLInputElement|null} */(document.getElementById('inviteExpiry'));
  const maxUses=parseInt(maxUsesEl?.value,10)||0;
  const expiry=parseInt(expiryEl?.value,10);
  if(maxUses<0){showToast('Max uses cannot be negative','error');return}
  if(!Number.isNaN(expiry)&&expiry<0){showToast('Expiry cannot be negative','error');return}
  try{
    const inv=await inviteApi('POST','/',{max_uses:maxUses,expires_in_hours:Number.isNaN(expiry)?0:expiry});
    showToast('Invite created');
    await renderContent();
    copyInviteText(inv&&inv.code);
  }catch(e){showToast(e.message,'error')}
}

/* Copying is best-effort: clipboard access can be refused (insecure origin, no
   permission), so a failure says so rather than silently doing nothing. */
async function copyInvite(code){
  await copyInviteText(code);
}
async function copyInviteText(code){
  if(!code)return;
  try{await navigator.clipboard.writeText(code);showToast('Invite code copied')}
  catch(e){showToast('Couldn\u2019t copy the invite code — copy it manually','error')}
}

function revokeInvite(code){
  openModal('<div class="modal-header"><h3>Revoke invite</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'
    +'<div class="modal-body"><p style="color:var(--text-muted)">Revoke <code>'+esc(code)+'</code>? Anyone who has not redeemed it yet will no longer be able to.</p></div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="confirmRevokeInvite" data-args="'+actArgs(code)+'">Revoke</button></div>');
}
async function confirmRevokeInvite(code){
  try{await inviteApi('DELETE','/'+code);closeModal();showToast('Invite revoked');renderContent()}
  catch(e){showToast(e.message,'error')}
}

/* The redemption history: who spent a code and when. An erased redeemer keeps
   its row with no link, so it reads as "Account erased" rather than blank. */
async function openInviteRedemptions(code){
  let reds;
  try{reds=await inviteApi('GET','/'+code+'/redemptions')}catch(e){showToast(e.message,'error');return}
  if(!Array.isArray(reds))reds=[];
  let rows='';
  if(!reds.length)rows='<tr><td colspan="2" style="text-align:center;color:var(--text-muted);padding:20px">This invite has not been redeemed yet.</td></tr>';
  else reds.forEach(function(red){
    const who=red.user_id?esc(red.username||('user #'+red.user_id)):'<span style="color:var(--text-muted)">Account erased</span>';
    rows+='<tr><td>'+who+'</td><td>'+fmtLocal(red.redeemed_at)+'</td></tr>';
  });
  openModal('<div class="modal-header"><h3>Redemptions for '+esc(code)+'</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'
    +'<div class="modal-body"><p style="color:var(--text-muted);margin-bottom:12px">Each row is one account that redeemed this code. An erased account keeps its row so the count and time survive, but its name is gone.</p>'
    +'<div class="section-card" style="margin:0"><div class="section-card-body no-pad"><table class="tbl"><thead><tr><th scope="col">Redeemed by</th><th scope="col">When</th></tr></thead><tbody>'+rows+'</tbody></table></div></div></div>'
    +'<div class="modal-footer"><button class="btn btn-primary" data-action="closeModal">Close</button></div>');
}

Object.assign(ACTIONS,{createInvite,revokeInvite,confirmRevokeInvite,copyInvite,openInviteRedemptions});
