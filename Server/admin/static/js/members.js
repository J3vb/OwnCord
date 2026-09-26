/* OwnCord admin panel: Members (the member list, pending registrations, bans,
   recovery credentials and erasure). */

/* ═══ Users ═══ */

/* Registration modes (B4-1): the four values the server accepts. */
const REG_MODES=[['closed','Closed'],['invite','Invite-only'],['approval','Approval'],['open','Open']];
function regModeLabel(m){const f=REG_MODES.find(x=>x[0]===m);return f?f[1]:'Invite-only'}
function regModeOptions(cur){return REG_MODES.map(([v,l])=>'<option value="'+v+'"'+(cur===v?' selected':'')+'>'+l+'</option>').join('')}
async function decideRegistration(id,action){
  try{await api('POST','/registrations/'+id+'/'+action);showToast(action==='approve'?'Registration approved':'Registration denied');renderContent()}
  catch(e){showToast(e.message,'error')}
}
/* AO-4: the Members page. Three tabs (All, Pending, Banned); search, the role
   filter and the Banned tab are server-side (GET /users?q=&role_id=&banned=1),
   so they narrow every page rather than the fetched one. Each row has one
   visible Manage button and an overflow menu of the moderation actions. */
state.membersTab='all';state.membersQuery='';state.membersRole=0;
let membersRows={};let membersSearchTimer=null;let membersListSeq=0;
const MORE_ICON='<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
const MEMBER_TABS=[['all','All'],['pending','Pending'],['banned','Banned']];

/* Self-protection mirrors the server, which refuses every one of these
   actions on your own account and on anyone at or above your rank
   (ModerationService.requireOutranks). Hiding them is only the affordance;
   role_position comes from the users list. */
function memberGuard(u){
  const me=state.me||{};
  if(u.id===me.id)return'self';
  if(typeof u.role_position==='number'&&u.role_position>=(me.role_position||0))return'rank';
  return'';
}
const MEMBER_GUARD_TEXT={self:'This is your account. You cannot change your own role, or ban, force logout or erase yourself.',
  rank:'Their role is at or above yours, so you cannot change their role or moderate them.'};

function usersQuery(){
  let q='';
  if(state.membersQuery)q+='&q='+encodeURIComponent(state.membersQuery);
  if(state.membersRole)q+='&role_id='+state.membersRole;
  if(state.membersTab==='banned')q+='&banned=1';
  return q;
}

async function membersRoleList(){
  if(can(PERM.MANAGE_ROLES)){try{const r=await api('GET','/roles');if(Array.isArray(r))state.roleList=r}catch(e){}}
  /* ponytail: without MANAGE_ROLES (GET /roles) the filter offers the seeded
     roles only; a custom role needs a roles read the moderator lacks. */
  return state.roleList&&state.roleList.length?state.roleList:ROLE_CHOICES;
}

async function renderUsers(){
  const pendingAllowed=can(PERM.MANAGE_SERVER);
  if(state.membersTab==='pending'&&!pendingAllowed)state.membersTab='all';
  /* Approval-mode applications wait on the Pending tab until someone with
     MANAGE_SERVER decides. The fetch also keeps the nav badge current. */
  let pending=[];
  if(pendingAllowed){try{pending=await api('GET','/registrations')||[]}catch(e){pending=[]}}
  const tab=state.membersTab;
  let html='<div class="page-title">Members</div><div class="page-desc">Search, review and moderate the people on this server</div>';
  html+='<div class="member-tabs" role="tablist" aria-label="Member lists">'+MEMBER_TABS.filter(t=>t[0]!=='pending'||pendingAllowed).map(([id,label])=>{
    const sel=tab===id;
    const count=id==='pending'&&pending.length?'<span class="tab-count">'+(pending.length>=REGISTRATIONS_PAGE?REGISTRATIONS_PAGE+'+':pending.length)+'</span>':'';
    return'<button class="member-tab" role="tab" id="membersTab-'+id+'" aria-selected="'+sel+'" aria-controls="membersPanel" tabindex="'+(sel?0:-1)+'" data-action="setMembersTab" data-args="'+actArgs(id)+'">'+label+count+'</button>';
  }).join('')+'</div>';
  html+='<div role="tabpanel" id="membersPanel" aria-labelledby="membersTab-'+tab+'">';
  if(tab==='pending')html+=pendingHtml(pending);
  else{
    const roles=await membersRoleList();
    html+='<div class="filter-bar members-filter" role="search">'
      +'<label class="sr-only" for="membersSearch">Search members</label>'
      +'<input class="filter-search" id="membersSearch" type="search" maxlength="64" autocomplete="off" spellcheck="false" placeholder="Search by username" value="'+esc(state.membersQuery)+'" data-input-action="searchMembers">'
      +'<label class="sr-only" for="membersRole">Filter by role</label>'
      +'<select class="filter-select" id="membersRole" data-change-action="filterMembersRole"><option value="0">All roles</option>'
      +roles.map(r=>'<option value="'+r.id+'"'+(state.membersRole===r.id?' selected':'')+'>'+esc(r.name)+'</option>').join('')+'</select></div>';
    const list=await membersListHtml();
    html+='<p class="members-summary" id="membersSummary" role="status">'+esc(list.summary)+'</p><div id="membersList">'+list.html+'</div>';
  }
  html+='</div><div class="member-menu hidden" id="memberMenu" role="menu"></div>';
  return html;
}

function pendingHtml(pending){
  if(!pending.length)return'<div class="section-card"><div class="section-card-body members-empty">No registrations are waiting for a decision.</div></div>';
  let html='<div class="section-card"><div class="section-card-body no-pad"><table class="tbl"><thead><tr><th scope="col">Applicant</th><th scope="col">Applied</th><th scope="col" class="col-actions">Decision</th></tr></thead><tbody>';
  pending.forEach(p=>{
    html+='<tr><td><strong>'+esc(p.username)+'</strong></td><td>'+fmtLocal(p.created_at)+'</td><td class="col-actions"><div class="act-group member-actions">'
      +'<button class="btn btn-outline member-btn" data-action="decideRegistration" data-args="'+actArgs(p.id,'approve')+'">Approve<span class="sr-only"> '+esc(p.username)+'</span></button>'
      +'<button class="btn btn-outline member-btn danger" data-action="decideRegistration" data-args="'+actArgs(p.id,'deny')+'">Deny<span class="sr-only"> '+esc(p.username)+'</span></button></div></td></tr>';
  });
  return html+'</tbody></table></div></div>';
}

/* The table and pager, without the toolbar, so a search keystroke can
   replace just this and keep focus in the search box. */
async function membersListHtml(){
  const offset=(state.usersPage-1)*PAGE_SIZE;
  /* Fetch one row past the page: a page of exactly PAGE_SIZE rows is
     otherwise indistinguishable from "a full page and nothing after it", and
     the ">" button offered a phantom empty page at every exact multiple.
     Same shape as MessageService.GetMessages (limit+1, hasMore from the
     overflow); limit=51 is inside the server's 1..500 clamp. */
  let rows;
  try{rows=await api('GET','/users?limit='+(PAGE_SIZE+1)+'&offset='+offset+usersQuery())}
  catch(e){return{summary:'',html:'<p class="members-error">'+esc(e.message)+'</p>'}}
  const hasMore=rows.length>PAGE_SIZE;
  const users=rows.slice(0,PAGE_SIZE).map(u=>({...u,id:u.id||u.ID,username:u.Username||u.username||'',role_id:u.role_id||u.RoleID||4}));
  membersRows={};users.forEach(u=>{membersRows[u.id]=u});
  const filtered=!!(state.membersQuery||state.membersRole);
  const banned=state.membersTab==='banned';
  const noun=banned?'banned member':'member';
  const summary=!users.length&&state.usersPage===1?(filtered?'No '+noun+'s match':banned?'Nobody is banned':'No members yet')
    :users.length+(hasMore?'+':'')+' '+noun+(users.length===1&&!hasMore?'':'s')+(filtered?' match':'')+(state.usersPage>1?' on page '+state.usersPage:'');
  let html='<div class="section-card"><div class="section-card-body no-pad"><table class="tbl members-tbl"><thead><tr><th scope="col">Member</th><th scope="col" class="col-role">Role</th><th scope="col">Status</th><th scope="col" class="col-actions"><span class="sr-only">Actions</span></th></tr></thead><tbody>';
  if(!users.length)html+='<tr><td colspan="4" class="members-empty">'+esc(summary)+'</td></tr>';
  users.forEach(u=>{html+=memberRowHtml(u)});
  html+='</tbody></table></div></div>';
  html+='<div class="pagination"><div class="pagination-info">Page '+state.usersPage+'</div><div class="pagination-btns">';
  html+='<button class="page-btn" '+(state.usersPage<=1?'disabled':'')+' data-action="turnUsersPage" data-args="[-1]" aria-label="Previous page">&lt;</button>';
  html+='<button class="page-btn active" aria-current="page">'+state.usersPage+'</button>';
  html+='<button class="page-btn" '+(hasMore?'':'disabled')+' data-action="turnUsersPage" data-args="[1]" aria-label="Next page">&gt;</button>';
  html+='</div></div>';
  return{summary,html};
}

function memberStatusHtml(u){
  if(!effectiveBan(u)){
    const online=(u.Status||u.status)==='online';
    return'<span class="dot '+(online?'online':'offline')+'"></span>'+(online?'Online':'Offline');
  }
  // The ban reason is collected on ban and stored server-side; showing it
  // here is the only place an admin can read back why someone was banned.
  const reason=u.ban_reason||u.BanReason||'';const exp=u.ban_expires||u.BanExpires;
  return'<span class="badge badge-red">Banned</span>'+(exp?' <span class="member-sub">until '+fmtLocal(exp)+'</span>':'')
    +(reason?'<div class="member-sub">'+esc(reason)+'</div>':'');
}

function memberRowHtml(u){
  const guard=memberGuard(u);const items=guard?[]:memberMenuItems(u);
  const initial=u.username?u.username[0].toUpperCase():'?';
  const name=esc(u.username);
  const more=guard?MEMBER_GUARD_TEXT[guard]:items.length?'More actions for '+u.username:'No other actions available for '+u.username;
  const role='<span class="role-badge"><span class="role-dot" style="background:'+esc(roleColor(u.role_id))+'"></span>'+esc(roleName(u.role_id,u.role_name||u.RoleName))+'</span>';
  return'<tr><td><div class="member-cell"><span class="avatar" aria-hidden="true" style="background:var(--accent)">'+esc(initial)+'</span><div><strong>'+name+'</strong>'+(guard==='self'?' <span class="badge badge-accent">You</span>':'')+'<div class="member-role-inline">'+role+'</div></div></div></td>'
    +'<td class="col-role">'+role+'</td>'
    +'<td>'+memberStatusHtml(u)+'</td>'
    +'<td class="col-actions"><div class="act-group member-actions">'
    +'<button class="btn btn-outline member-btn" data-action="openEditUser" data-args="'+actArgs(u.id,u.username,u.role_id)+'">Manage<span class="sr-only"> '+name+'</span></button>'
    +'<button class="act-btn member-more" aria-haspopup="menu" aria-expanded="false" aria-label="'+esc(more)+'" title="'+esc(more)+'"'+(items.length?'':' disabled')+' data-action="toggleMemberMenu" data-args="'+actArgs(u.id)+'">'+MORE_ICON+'</button>'
    +'</div></td></tr>';
}

/* The overflow menu's actions, gated like their routes. Erasure (B4-9) is the
   only irreversible action in the panel, so it sits last behind a separator
   rather than beside Force Logout — a slip aimed at a reversible item must not
   be able to reach it. */
function memberMenuItems(u){
  const banned=effectiveBan(u);const items=[];
  if(can(PERM.KICK_MEMBERS))items.push(['forceLogout','Force logout',I.disconnect,[u.id]]);
  if(isOwner()&&!banned)items.push(['openIssueRecovery','Issue recovery credential',I.lock,[u.id,u.username]]);
  if(can(PERM.BAN_MEMBERS))items.push(banned?['unbanUser','Unban',I.check,[u.id]]:['openBanUser','Ban',I.ban,[u.id,u.username],'danger']);
  if(can(PERM.ADMINISTRATOR))items.push(null,['openEraseUser','Erase account permanently',I.trash,[u.id,u.username],'danger']);
  while(items[0]===null)items.shift();
  return items;
}

let memberMenuBtn=null;
function closeMemberMenu(restoreFocus){
  const menu=document.getElementById('memberMenu');
  if(menu)menu.classList.add('hidden');
  if(memberMenuBtn){memberMenuBtn.setAttribute('aria-expanded','false');if(restoreFocus&&memberMenuBtn.isConnected)memberMenuBtn.focus()}
  memberMenuBtn=null;
}
function toggleMemberMenu(uid){
  const btn=this;const open=memberMenuBtn===btn;
  closeMemberMenu(false);
  const u=membersRows[uid];const menu=document.getElementById('memberMenu');
  if(open||!u||!menu||!(btn instanceof HTMLElement))return;
  menu.innerHTML=memberMenuItems(u).map(it=>it===null?'<div class="member-menu-sep" role="separator"></div>'
    :'<button class="user-menu-item'+(it[4]?' '+it[4]:'')+'" role="menuitem" tabindex="-1" data-action="'+it[0]+'" data-args="'+actArgs(...it[3])+'">'+it[2]+'<span>'+it[1]+'</span></button>').join('');
  menu.setAttribute('aria-label','Actions for '+u.username);
  menu.classList.remove('hidden');
  /* Fixed to the button, so the table's scroll wrapper cannot clip it; it
     opens upward when there is no room below. */
  const r=btn.getBoundingClientRect();const h=menu.offsetHeight,w=menu.offsetWidth;
  menu.style.top=Math.max(8,r.bottom+4+h>window.innerHeight?r.top-4-h:r.bottom+4)+'px';
  menu.style.left=Math.max(8,Math.min(r.right-w,window.innerWidth-w-8))+'px';
  memberMenuBtn=btn;btn.setAttribute('aria-expanded','true');
  menu.querySelector('[role="menuitem"]')?.focus();
}
/* Choosing an item closes the menu before the delegated action runs (this
   listener is on the menu, the dispatcher on the document), with focus back
   on the menu button so a dialog it opens returns there. Arrows, Home and End
   move between items; Escape and Tab close it. */
document.addEventListener('click',e=>{
  const t=e.target instanceof Element?e.target:null;
  if(!memberMenuBtn||!t)return;
  if(t.closest('#memberMenu [role="menuitem"]'))closeMemberMenu(true);
  else if(!t.closest('#memberMenu')&&!memberMenuBtn.contains(t))closeMemberMenu(false);
},true);
document.addEventListener('keydown',e=>{
  const t=e.target instanceof Element?e.target:null;
  if(t&&memberMenuBtn&&t.closest('#memberMenu')){
    const items=[...document.querySelectorAll('#memberMenu [role="menuitem"]')];
    const i=items.indexOf(document.activeElement);
    const next={ArrowDown:i+1,ArrowUp:i-1,Home:0,End:items.length-1}[e.key];
    if(next!==undefined){e.preventDefault();items[(next+items.length)%items.length].focus()}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeMemberMenu(true)}
    else if(e.key==='Tab')closeMemberMenu(false);
    return;
  }
  /* Tabs: arrows (and Home/End) move and select, as the ARIA tabs pattern
     describes. */
  if(t&&t.matches('.member-tab')){
    const tabs=[...document.querySelectorAll('.member-tab')];const i=tabs.indexOf(t);
    const next={ArrowRight:i+1,ArrowLeft:i-1,Home:0,End:tabs.length-1}[e.key];
    if(next===undefined)return;
    e.preventDefault();tabs[(next+tabs.length)%tabs.length].click();
  }
});
window.addEventListener('resize',()=>closeMemberMenu(false));
document.getElementById('content').addEventListener('scroll',()=>closeMemberMenu(false));

/* Re-render the page in place for a tab switch, keeping keyboard focus on the
   chosen tab. */
async function setMembersTab(tab){
  if(tab===state.membersTab&&document.getElementById('membersPanel'))return;
  state.membersTab=tab;state.usersPage=1;
  const html=await renderUsers();
  if(state.section!=='users')return;
  document.getElementById('content').innerHTML=html;
  document.getElementById('membersTab-'+tab)?.focus();
}

/* Only the list is replaced, so the search box keeps focus. A later request
   supersedes an earlier one still in flight. */
async function refreshMembersList(){
  const seq=++membersListSeq;
  const list=await membersListHtml();
  const el=document.getElementById('membersList');
  if(seq!==membersListSeq||state.section!=='users'||!el)return;
  closeMemberMenu(false);
  el.innerHTML=list.html;
  document.getElementById('membersSummary').textContent=list.summary;
}
function searchMembers(){
  state.membersQuery=this.value.trim();state.usersPage=1;
  clearTimeout(membersSearchTimer);membersSearchTimer=setTimeout(refreshMembersList,250);
}
function filterMembersRole(){state.membersRole=parseInt(this.value,10)||0;state.usersPage=1;refreshMembersList()}

/* Seeded roles with their hierarchy positions — the fallback used only when the
   live list cannot be read. Role CRUD means the real set is whatever /roles
   returns, so assigning a custom role must not depend on this literal. */
const ROLE_CHOICES=[{id:1,name:'Owner',position:100},{id:2,name:'Admin',position:80},{id:3,name:'Moderator',position:60},{id:4,name:'Member',position:40}];

/* Manage: who the member is, and the role picker when the caller may change
   it. The picker needs every assignable role, not the four seeded ones; GET
   /roles requires MANAGE_ROLES, which is exactly what the picker needs, and a
   failure degrades to the seeded list rather than blocking the edit. Your own
   row and anyone at or above your rank get the reason instead of a picker. */
async function openEditUser(uid,uname,currentRole){
  const u=membersRows[uid]||{id:uid,username:uname,role_id:currentRole};
  const guard=memberGuard(u);
  const head='<div class="modal-header"><h3>Manage '+esc(uname)+'</h3><button class="modal-close" aria-label="Close dialog" data-action="closeModal">&times;</button></div><div class="modal-body">'
    +'<div class="member-card"><span class="avatar" aria-hidden="true" style="background:var(--accent)">'+esc((uname||'?')[0].toUpperCase())+'</span><div><div class="member-card-name">'+esc(uname)+'</div>'
    +'<div class="member-card-meta"><span class="role-badge"><span class="role-dot" style="background:'+esc(roleColor(currentRole))+'"></span>'+esc(roleName(currentRole,u.role_name))+'</span> '+memberStatusHtml(u)+'</div></div></div>';
  const done='<div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Close</button></div>';
  if(guard){openModal(head+'<p class="member-note">'+esc(MEMBER_GUARD_TEXT[guard])+'</p></div>'+done);return}
  if(!can(PERM.MANAGE_ROLES)){openModal(head+'<p class="member-note">Changing roles needs the Manage Roles permission. The other actions are in the row’s ⋮ menu.</p></div>'+done);return}
  const myPos=(state.me&&state.me.role_position)||0;
  let roles;
  try{roles=await api('GET','/roles');state.roleList=roles||[]}
  catch(e){roles=ROLE_CHOICES}
  /* The server refuses to assign a role positioned at or above the actor's
     own, so anything higher is dropped rather than offered as a guaranteed
     403. The current role is always listed so the select can show it. */
  const opts=roles.filter(r=>r.position<myPos||r.id===currentRole)
    .map(r=>'<option value="'+r.id+'" '+(currentRole===r.id?'selected':'')+'>'+esc(r.name)+'</option>').join('');
  openModal(head+'<div class="form-group"><label class="form-label" for="editRoleSelect">Role</label><select class="form-input" id="editRoleSelect" style="appearance:auto">'+opts+'</select></div></div><div class="modal-footer"><button class="btn btn-ghost" data-action="closeModal">Cancel</button><button class="btn btn-accent" data-action="saveUserRole" data-args="'+actArgs(uid)+'">Save</button></div>');
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
  setMembersTab,toggleMemberMenu,searchMembers,filterMembersRole,
  turnUsersPage(delta){state.usersPage+=delta;renderContent()}});
