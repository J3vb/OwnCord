/* OwnCord admin panel: Users (members, pending registrations, bans, recovery
   credentials and erasure). */

/* ═══ Users ═══ */

/* Registration modes (B4-1): the four values the server accepts. */
const REG_MODES=[['closed','Closed'],['invite','Invite-only'],['approval','Approval'],['open','Open']];
function regModeLabel(m){const f=REG_MODES.find(x=>x[0]===m);return f?f[1]:'Invite-only'}
function regModeOptions(cur){return REG_MODES.map(([v,l])=>'<option value="'+v+'"'+(cur===v?' selected':'')+'>'+l+'</option>').join('')}
async function decideRegistration(id,action){
  try{await api('POST','/registrations/'+id+'/'+action);showToast(action==='approve'?'Registration approved':'Registration denied');renderContent()}
  catch(e){showToast(e.message,'error')}
}
async function renderUsers(){
  const offset=(state.usersPage-1)*PAGE_SIZE;
  /* Fetch one row past the page: a page of exactly PAGE_SIZE rows is
     otherwise indistinguishable from "a full page and nothing after it", and
     the ">" button offered a phantom empty page at every exact multiple.
     Same shape as MessageService.GetMessages (limit+1, hasMore from the
     overflow); limit=51 is inside the server's 1..500 clamp. */
  let rows;
  try{rows=await api('GET','/users?limit='+(PAGE_SIZE+1)+'&offset='+offset)}catch(e){return'<div class="page-title">Users</div><p style="color:var(--text-danger)">'+esc(e.message)+'</p>'}
  const hasMore=rows.length>PAGE_SIZE;
  const users=rows.slice(0,PAGE_SIZE);
  let html='<div class="page-title">Users</div><div class="page-desc">Manage server members</div>';
  /* Approval-mode applications wait here until someone with MANAGE_SERVER
     decides; the card only appears when there is something to decide. */
  if(can(PERM.MANAGE_SERVER)){
    let pending=[];
    try{pending=await api('GET','/registrations')||[]}catch(e){pending=[]}
    if(pending.length){
      html+='<div class="section-card"><div class="section-card-header"><h3>Pending registrations ('+pending.length+')</h3></div><div class="section-card-body no-pad"><table class="tbl"><thead><tr><th>User</th><th>Applied</th><th style="text-align:right">Decision</th></tr></thead><tbody>';
      pending.forEach(p=>{
        html+='<tr><td><strong>'+esc(p.username)+'</strong></td><td>'+fmtLocal(p.created_at)+'</td><td><div class="act-group" style="justify-content:flex-end">'
          +'<button class="act-btn" title="Approve" aria-label="Approve" data-action="decideRegistration" data-args="'+actArgs(p.id,'approve')+'">'+I.check+'</button>'
          +'<button class="act-btn danger" title="Deny" aria-label="Deny" data-action="decideRegistration" data-args="'+actArgs(p.id,'deny')+'">'+I.ban+'</button></div></td></tr>';
      });
      html+='</tbody></table></div></div>';
    }
  }
  html+='<div class="section-card"><div class="section-card-body no-pad"><table class="tbl"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Banned</th><th style="text-align:right">Actions</th></tr></thead><tbody>';
  if(!users.length)html+='<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:24px">No users found</td></tr>';
  users.forEach(u=>{
    const uid=u.id||u.ID;const uname=u.Username||u.username||'';const rid=u.role_id||u.RoleID||4;
    const status=u.Status||u.status||'offline';const banned=effectiveBan(u);
    const statusDot=banned?'banned':status;const statusLabel=banned?'Banned':status==='online'?'Online':'Offline';
    const initial=uname?uname[0].toUpperCase():'?';
    html+='<tr><td><div style="display:flex;align-items:center;gap:8px"><div class="avatar" style="background:var(--accent)">'+initial+'</div><strong>'+esc(uname)+'</strong></div></td>';
    html+='<td><span class="role-badge"><span class="role-dot" style="background:'+esc(roleColor(rid))+'"></span>'+esc(roleName(rid,u.role_name||u.RoleName))+'</span></td>';
    html+='<td><span class="dot '+statusDot+'"></span>'+statusLabel+'</td>';
    // The ban reason is collected on ban and stored server-side; showing it
    // here is the only place an admin can read back why someone was banned.
    const banReason=u.ban_reason||u.BanReason||'';
    const bannedCell=banned
      ?'<span class="badge badge-red" title="'+esc(banReason||'No reason given')+'">Yes</span>'
        +(banReason?'<div style="font-size:11px;color:var(--text-muted);margin-top:2px">'+esc(banReason)+'</div>':'')
      :'<span class="badge badge-muted">No</span>';
    html+='<td>'+bannedCell+'</td>';
    html+='<td><div class="act-group" style="justify-content:flex-end">';
    if(can(PERM.MANAGE_ROLES))html+='<button class="act-btn" title="Edit role" aria-label="Edit role" data-action="openEditUser" data-args="'+actArgs(uid,uname,rid)+'">'+I.edit+'</button>';
    if(can(PERM.KICK_MEMBERS))html+='<button class="act-btn" title="Force Logout" aria-label="Force Logout" data-action="forceLogout" data-args="'+actArgs(uid)+'">'+I.disconnect+'</button>';
    if(isOwner()&&!banned&&uid!==(state.me&&state.me.id))html+='<button class="act-btn" title="Issue recovery credential" aria-label="Issue recovery credential" data-action="openIssueRecovery" data-args="'+actArgs(uid,uname)+'">'+I.lock+'</button>';
    if(can(PERM.BAN_MEMBERS)){
      if(banned)html+='<button class="act-btn" title="Unban" aria-label="Unban" data-action="unbanUser" data-args="'+actArgs(uid)+'">'+I.check+'</button>';
      else html+='<button class="act-btn danger" title="Ban" aria-label="Ban" data-action="openBanUser" data-args="'+actArgs(uid,uname)+'">'+I.ban+'</button>';
    }
    /* Erasure (B4-9) is the only irreversible action in the panel, so it sits
       last behind a gap rather than beside Force Logout — a slip aimed at a
       reversible control must not be able to reach it. ADMINISTRATOR matches
       the route's gate; the service refuses erasing yourself, so that row
       does not offer it. */
    if(can(PERM.ADMINISTRATOR)&&uid!==(state.me&&state.me.id))
      html+='<span style="display:inline-block;width:14px"></span><button class="act-btn danger" title="Erase account permanently" aria-label="Erase account permanently" data-action="openEraseUser" data-args="'+actArgs(uid,uname)+'">'+I.trash+'</button>';
    html+='</div></td></tr>';
  });
  html+='</tbody></table></div></div>';
  html+='<div class="pagination"><div class="pagination-info">Page '+state.usersPage+'</div><div class="pagination-btns">';
  html+='<button class="page-btn" '+(state.usersPage<=1?'disabled':'')+' data-action="turnUsersPage" data-args="[-1]">&lt;</button>';
  html+='<button class="page-btn active">'+state.usersPage+'</button>';
  html+='<button class="page-btn" '+(hasMore?'':'disabled')+' data-action="turnUsersPage" data-args="[1]">&gt;</button>';
  html+='</div></div>';
  return html;
}

/* Seeded roles with their hierarchy positions — the fallback used only when the
   live list cannot be read. Role CRUD means the real set is whatever /roles
   returns, so assigning a custom role must not depend on this literal. */
const ROLE_CHOICES=[{id:1,name:'Owner',position:100},{id:2,name:'Admin',position:80},{id:3,name:'Moderator',position:60},{id:4,name:'Member',position:40}];

/* The picker needs every assignable role, not the four seeded ones. The button
   that opens this is gated on MANAGE_ROLES, which is exactly what GET /roles
   requires, so the fetch is authorized whenever the modal is reachable; a
   failure degrades to the seeded list rather than blocking the edit. */
async function openEditUser(uid,uname,currentRole){
  const myPos=(state.me&&state.me.role_position)||0;
  let roles;
  try{roles=await api('GET','/roles');state.roleList=roles||[]}
  catch(e){roles=ROLE_CHOICES}
  /* The server refuses to assign a role positioned at or above the actor's
     own, so anything higher is dropped rather than offered as a guaranteed
     403. The current role is always listed so the select can show it. */
  const opts=roles.filter(r=>r.position<myPos||r.id===currentRole)
    .map(r=>'<option value="'+r.id+'" '+(currentRole===r.id?'selected':'')+'>'+esc(r.name)+'</option>').join('');
  openModal('<div class="modal-header"><h3>Edit User</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><div style="display:flex;align-items:center;gap:12px;margin-bottom:20px"><div class="avatar" style="background:var(--accent);width:48px;height:48px;font-size:20px">'+uname[0].toUpperCase()+'</div><div style="font-size:16px;font-weight:700;color:var(--text-normal)">'+esc(uname)+'</div></div><div class="form-group"><label class="form-label" for="editRoleSelect">Role</label><select class="form-input" id="editRoleSelect" style="appearance:auto">'+opts+'</select></div></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-accent" data-action="saveUserRole" data-args="'+actArgs(uid)+'">Save</button></div>');
}

async function saveUserRole(uid){
  const sel=document.getElementById('editRoleSelect');if(!sel)return;
  try{await api('PATCH','/users/'+uid,{role_id:parseInt(sel.value)});closeModal();showToast('Role updated');renderContent()}catch(e){showToast(e.message,'error')}
}

function openBanUser(uid,uname){
  openModal('<div class="modal-header"><h3>Ban User</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><p style="color:var(--text-muted);margin-bottom:16px">Ban <strong style="color:var(--text-normal)">'+esc(uname)+'</strong> from the server?</p><div class="form-group"><label class="form-label" for="banReason">Reason</label><textarea class="form-input form-textarea" id="banReason" placeholder="Reason for ban..."></textarea></div></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="confirmBan" data-args="'+actArgs(uid)+'">Ban User</button></div>');
}

function openIssueRecovery(uid,uname){
  openModal('<div class="modal-header"><h3>Issue Recovery Credential</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><p style="color:var(--text-muted);margin-bottom:12px">Give <strong style="color:var(--text-normal)">'+esc(uname)+'</strong> a one-time credential to get back in. Redeeming it sets a new password, signs out every device and skips two-factor. It works once and expires in 15 minutes. Make sure you know who you are talking to first.</p><div class="form-group"><label class="form-label" for="recoveryVerification">How did you verify them?</label><select class="form-input" id="recoveryVerification"><option value="in_person">In person</option><option value="voice_call">Voice call</option><option value="video_call">Video call</option><option value="trusted_contact">Through a trusted contact</option></select></div></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-primary" data-action="confirmIssueRecovery" data-args="'+actArgs(uid)+'">Issue credential</button></div>');
}

async function confirmIssueRecovery(uid){
  const verification=document.getElementById('recoveryVerification')?.value||'';
  try{
    const r=await api('POST','/users/'+uid+'/recovery-credential',{verification});
    const until=r.expires_at?new Date(r.expires_at).toLocaleTimeString():'15 minutes from now';
    openModal('<div class="modal-header"><h3>Recovery Credential</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><p style="color:var(--text-muted);margin-bottom:12px">Hand this to <strong style="color:var(--text-normal)">'+esc(r.username)+'</strong> over the channel you verified them on. It is shown once and expires at '+esc(until)+'.</p><code style="display:block;font-size:18px;letter-spacing:1px;padding:12px;background:var(--bg-tertiary);border-radius:6px;user-select:all;text-align:center">'+esc(r.credential)+'</code><p style="color:var(--text-muted);font-size:12px;margin-top:10px">They enter it with their username and a new password in the client\u2019s account-recovery form (POST /api/v1/auth/recover). Issuing another one replaces this credential.</p></div><div class="modal-footer"><button class="btn btn-primary" data-action="closeModal">Done</button></div>');
  }catch(e){showToast(e.message,'error')}
}

async function confirmBan(uid){
  const reason=document.getElementById('banReason')?.value||'';
  try{await api('PATCH','/users/'+uid,{banned:true,ban_reason:reason});closeModal();showToast('User banned');renderContent()}catch(e){showToast(e.message,'error')}
}

async function unbanUser(uid){
  try{await api('PATCH','/users/'+uid,{banned:false});showToast('User unbanned');renderContent()}catch(e){showToast(e.message,'error')}
}

/* Account erasure (B4-9) hard-deletes the account and everything
   attributable to it — this is not the anonymising ban path it replaces, and
   no backup taken afterwards brings any of it back. The confirmation names
   what goes and asks for the username to be typed, so the action cannot be
   completed by clicking through. */
function openEraseUser(uid,uname){
  openModal('<div class="modal-header"><h3>Erase Account</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div>'
    +'<div class="modal-body">'
    +'<p style="color:var(--text-muted)">Permanently erase <strong style="color:var(--text-normal)">'+esc(uname)+'</strong>. <strong style="color:var(--text-danger)">This cannot be undone</strong> — nothing erased here can be recovered afterwards.</p>'
    +'<p style="color:var(--text-muted);margin-top:10px">Deleted for good: the account, every message and direct message it sent, its uploads and avatar, its reactions, read state, sessions, API tokens, two-factor secrets and recovery codes, and the invites it created.</p>'
    +'<p style="color:var(--text-muted);font-size:12px;margin-top:8px">Kept: its audit-log entries, with the account no longer named, and any custom emoji it uploaded, reassigned to another admin.</p>'
    +'<div class="form-group" style="margin-top:16px"><label class="form-label" for="eraseConfirm">Type <strong style="color:var(--text-normal)">'+esc(uname)+'</strong> to confirm</label><input class="form-input" id="eraseConfirm" autocomplete="off" autocapitalize="off" spellcheck="false"></div>'
    +'</div>'
    +'<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="confirmEraseUser" data-args="'+actArgs(uid,uname)+'">Erase permanently</button></div>');
}

async function confirmEraseUser(uid,uname){
  const typed=(document.getElementById('eraseConfirm')?.value||'').trim();
  if(typed!==uname){showToast('Type the username exactly to confirm','error');return}
  try{await api('DELETE','/users/'+uid);closeModal();showToast('Account erased permanently');renderContent()}catch(e){showToast(e.message,'error')}
}

async function forceLogout(uid){
  openModal('<div class="modal-header"><h3>Force Logout</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body"><p style="color:var(--text-muted)">Terminate all sessions for this user? They can sign back in immediately &mdash; this is not a removal.</p></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-danger" data-action="confirmForceLogout" data-args="'+actArgs(uid)+'">Force Logout</button></div>');
}

async function confirmForceLogout(uid){
  try{await api('DELETE','/users/'+uid+'/sessions');closeModal();showToast('Forced logout: all sessions terminated');renderContent()}catch(e){showToast(e.message,'error')}
}

Object.assign(ACTIONS,{confirmBan,confirmEraseUser,confirmForceLogout,confirmIssueRecovery,decideRegistration,
  forceLogout,openBanUser,openEditUser,openEraseUser,openIssueRecovery,saveUserRole,unbanUser,
  turnUsersPage(delta){state.usersPage+=delta;renderContent()}});
