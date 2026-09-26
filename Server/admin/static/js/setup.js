/* OwnCord admin panel: first-run setup wizard and the sign-in overlay. */

/* ═══ First-Run Setup Wizard ═══ */
/* Multi-step overlay shown while needs_setup is true. Collects the owner
   account plus the basics (name, port, security, uploads, voice, access) and
   submits everything as one POST /admin/api/setup — the server writes both
   the settings table and config.yaml, and restarts itself if startup-only
   values changed. "Skip" falls back to the legacy account-only payload. */
const wiz={step:0,skip:false,defaults:null,data:{},busy:false};
const WIZ_STEP_COUNT=6;

function wizInit(defaults){
  wiz.defaults=defaults||null;wiz.step=0;wiz.skip=false;wiz.busy=false;
  const d=defaults||{};
  wiz.data={setup_token:'',username:'',password:'',confirm:'',
    server_name:d.server_name||'OwnCord Server',
    motd:(d.motd===undefined||d.motd===null)?'Welcome!':d.motd,
    registration_mode:d.registration_mode||'invite',
    port:d.port||8443,
    tls_mode:d.tls_mode||'self_signed',
    tls_domain:d.tls_domain||'',
    upload_max_size_mb:d.upload_max_size_mb||100,
    voice_quality:d.voice_quality||'medium',
    voice_auto_download:d.voice_auto_download!==undefined?!!d.voice_auto_download:true};
  renderWizard();
}

function wizDots(){
  let h='<div class="wiz-steps">';
  for(let i=0;i<WIZ_STEP_COUNT;i++)h+='<div class="wiz-dot '+(i===wiz.step?'active':i<wiz.step?'done':'')+'"></div>';
  return h+'</div>';
}

function wizField(id,label,input){return '<div class="form-group"><label class="form-label" for="'+id+'">'+label+'</label>'+input+'</div>'}

function renderWizard(){
  const box=document.getElementById('wizardBox');
  const d=wiz.data;
  let h=wizDots();
  const err='<div class="auth-error" id="wizErr"></div>';
  const nav=nextLabel=>'<div class="wiz-nav"><button class="btn btn-ghost" data-action="wizBack">Back</button><button class="btn btn-accent" id="wizNextBtn" data-action="wizNext">'+nextLabel+'</button></div>';
  switch(wiz.step){
    case 0:
      h+='<h2>Welcome to OwnCord</h2>'
        +'<p class="wiz-sub">Your own private chat server is almost ready. This one-minute setup creates your admin account and configures the basics — no config files to edit, everything is saved for you.</p>'
        +'<button class="btn btn-accent" style="width:100%" data-action="wizNext">Get Started</button>'
        +'<button class="wiz-skip" data-action="wizSkip">Skip the questions — use recommended defaults</button>';
      break;
    case 1:
      h+='<h2>Create your admin account</h2>'
        +'<p class="wiz-sub">This is the owner account for managing the server. Pick a strong password — this account can do everything.</p>'
        +wizField('wizToken','Setup Token','<input class="form-input" id="wizToken" autocomplete="off" spellcheck="false" value="'+esc(d.setup_token)+'"><div class="wiz-hint">Printed in the server&#39;s start-up output (the terminal it runs in, <code>docker compose logs owncord</code>, or the service log). It proves you have access to the server itself.</div>')
        +wizField('wizUser','Username','<input class="form-input" id="wizUser" autocomplete="username" placeholder="Choose a username" value="'+esc(d.username)+'">')
        +wizField('wizPass','Password','<input class="form-input" id="wizPass" type="password" autocomplete="new-password" placeholder="Min 8 characters">')
        +wizField('wizConfirm','Confirm Password','<input class="form-input" id="wizConfirm" type="password" autocomplete="new-password" placeholder="Re-enter password">')
        +err+nav(wiz.skip?'Create Owner Account':'Next');
      break;
    case 2:
      h+='<h2>Server basics</h2>'
        +'<p class="wiz-sub">How your server introduces itself, and how people connect to it.</p>'
        +wizField('wizName','Server Name','<input class="form-input" id="wizName" maxlength="100" value="'+esc(d.server_name)+'">')
        +wizField('wizPort','Port','<input class="form-input" id="wizPort" type="number" min="1" max="65535" value="'+esc(d.port)+'"><div class="wiz-hint">The network port people connect to. Keep the default unless it clashes with something else on this machine.</div>')
        +wizField('wizTLS','Security','<select class="filter-select" id="wizTLS" style="width:100%" data-change-action="wizTLSChanged">'
          +'<option value="self_signed"'+(d.tls_mode==='self_signed'?' selected':'')+'>Self-signed HTTPS &mdash; recommended</option>'
          +'<option value="acme"'+(d.tls_mode==='acme'?' selected':'')+'>Let&#39;s Encrypt certificate &mdash; needs a public domain</option>'
          +'<option value="manual"'+(d.tls_mode==='manual'?' selected':'')+'>Manual certificates &mdash; advanced</option>'
          +'<option value="off"'+(d.tls_mode==='off'?' selected':'')+'>No encryption &mdash; not recommended</option>'
          +'</select><div class="wiz-hint" id="wizTLSHint"></div>')
        +'<div class="form-group" id="wizDomainGroup" style="display:none"><label class="form-label" for="wizDomain">Domain</label><input class="form-input" id="wizDomain" placeholder="chat.example.com" value="'+esc(d.tls_domain)+'"><div class="wiz-hint">Must already point at this machine, with ports 80 and 443 reachable from the internet. If that isn&#39;t set up yet, pick self-signed for now — you can switch later.</div></div>'
        +err+nav('Next');
      break;
    case 3:
      h+='<h2>Uploads &amp; voice</h2>'
        +'<p class="wiz-sub">Limits for file sharing and voice chat quality.</p>'
        +wizField('wizUpload','Max upload size (MB)','<input class="form-input" id="wizUpload" type="number" min="1" max="10240" value="'+esc(d.upload_max_size_mb)+'"><div class="wiz-hint">The largest file anyone can share. 100 MB suits most servers.</div>')
        +'<div class="wiz-toggle-row"><div><div class="lbl" id="wizVoiceDl-name">Voice chat</div><div class="wiz-hint" style="margin-top:2px">Downloads the voice engine (LiveKit, ~40 MB, one time) from the official LiveKit project and manages it for you. Turn off only if you run your own LiveKit server.</div></div><button class="toggle'+(d.voice_auto_download?' on':'')+'" id="wizVoiceDl" role="switch" aria-checked="'+(d.voice_auto_download?'true':'false')+'" aria-labelledby="wizVoiceDl-name" data-action="toggleSwitch"></button></div>'
        +wizField('wizVoice','Voice quality','<select class="filter-select" id="wizVoice" style="width:100%">'
          +'<option value="low"'+(d.voice_quality==='low'?' selected':'')+'>Low &mdash; least bandwidth, phone-call quality</option>'
          +'<option value="medium"'+(d.voice_quality==='medium'?' selected':'')+'>Medium &mdash; recommended balance</option>'
          +'<option value="high"'+(d.voice_quality==='high'?' selected':'')+'>High &mdash; best quality, most bandwidth</option>'
          +'</select>')
        +err+nav('Next');
      break;
    case 4:
      h+='<h2>Who can join?</h2>'
        +'<p class="wiz-sub">You&#39;ll get an invite code either way — these control what happens after that.</p>'
        +'<div class="wiz-toggle-row"><div><div class="lbl" id="wizReg-name">Registration</div><div class="wiz-hint" style="margin-top:2px">Who can create an account. Invite-only is the default; approval holds new accounts until you approve them in Users.</div></div><select class="form-input" id="wizReg" aria-labelledby="wizReg-name" style="width:auto">'+regModeOptions(d.registration_mode)+'</select></div>'
        +wizField('wizMotd','Welcome message','<input class="form-input" id="wizMotd" maxlength="500" value="'+esc(d.motd)+'" placeholder="Welcome!"><div class="wiz-hint">Shown to members when they connect.</div>')
        +err+nav('Next');
      break;
    case 5:{
      const secLabel={self_signed:'Self-signed HTTPS',acme:'Let&#39;s Encrypt ('+esc(d.tls_domain)+')',manual:'Manual certificates',off:'No encryption'}[d.tls_mode]||esc(d.tls_mode);
      const rows=[['Username',esc(d.username)],['Server name',esc(d.server_name)],['Port',esc(d.port)],['Security',secLabel],['Max upload',esc(d.upload_max_size_mb)+' MB'],['Voice chat',d.voice_auto_download?'Automatic (LiveKit downloaded for you)':'Self-managed / off'],['Voice quality',esc(d.voice_quality)],['Registration',esc(regModeLabel(d.registration_mode))],['Welcome message',esc(d.motd)||'&mdash;']];
      h+='<h2>Review &amp; finish</h2><p class="wiz-sub">Everything look right? You can change any of this later in the admin panel.</p>';
      rows.forEach(r=>{h+='<div class="wiz-review-row"><span class="k">'+r[0]+'</span><span class="v">'+r[1]+'</span></div>'});
      if(wizNeedsRestart())h+='<div class="wiz-callout">The server will restart once to apply your connection settings, then point you to the right address.</div>';
      h+=err+nav('Finish Setup');
      break;}
  }
  box.innerHTML=h;
  if(wiz.step===2)wizTLSChanged();
  box.querySelectorAll('input').forEach(el=>el.addEventListener('keydown',e=>{if(e.key==='Enter')wizNext()}));
  const first=box.querySelector('input');if(first)first.focus();
}

function wizTLSChanged(){
  const sel=document.getElementById('wizTLS');if(!sel)return;
  const hints={
    self_signed:'Works out of the box on your network. Browsers show a one-time security warning you can safely accept.',
    acme:'A free, trusted certificate from Let’s Encrypt. Only choose this if you own a domain that points at this machine.',
    manual:'Bring your own certificate files (data/cert.pem and data/key.pem).',
    off:'Traffic is unencrypted. Only for testing, or behind a reverse proxy that handles HTTPS.'};
  document.getElementById('wizTLSHint').textContent=hints[sel.value]||'';
  document.getElementById('wizDomainGroup').style.display=sel.value==='acme'?'block':'none';
}

function wizNeedsRestart(){
  const f=wiz.defaults;if(!f)return false;const d=wiz.data;
  return Number(d.port)!==f.port||d.tls_mode!==f.tls_mode||Number(d.upload_max_size_mb)!==f.upload_max_size_mb||d.voice_quality!==f.voice_quality||d.voice_auto_download!==!!f.voice_auto_download||(d.tls_mode==='acme'&&d.tls_domain!==(f.tls_domain||''));
}

function wizCollect(){
  const g=id=>{const el=document.getElementById(id);return el?el.value:undefined};
  const d=wiz.data;
  switch(wiz.step){
    case 1:d.setup_token=(g('wizToken')||'').trim();d.username=(g('wizUser')||'').trim();d.password=g('wizPass')||'';d.confirm=g('wizConfirm')||'';break;
    case 2:d.server_name=(g('wizName')||'').trim();d.port=g('wizPort');d.tls_mode=g('wizTLS')||d.tls_mode;d.tls_domain=(g('wizDomain')||'').trim();break;
    case 3:{d.upload_max_size_mb=g('wizUpload');d.voice_quality=g('wizVoice')||d.voice_quality;const vd=document.getElementById('wizVoiceDl');if(vd)d.voice_auto_download=vd.classList.contains('on');break}
    case 4:{const t=document.getElementById('wizReg');if(t)d.registration_mode=t.value;d.motd=(g('wizMotd')||'').trim();break}
  }
}

function wizBack(){
  if(wiz.busy)return;
  wizCollect();
  if(wiz.step===1)wiz.skip=false;
  wiz.step=Math.max(0,wiz.step-1);
  renderWizard();
}

function wizSkip(){wiz.skip=true;wiz.step=1;renderWizard()}

function wizNext(){
  if(wiz.busy)return;
  wizCollect();
  const d=wiz.data;
  const fail=msg=>{const e=document.getElementById('wizErr');if(e)e.textContent=msg};
  switch(wiz.step){
    case 1:
      if(!d.setup_token)return fail('Enter the setup token from the server\'s start-up output.');
      if(!d.username||!d.password)return fail('Username and password are required.');
      if(d.password.length<8)return fail('Password must be at least 8 characters.');
      if(d.password!==d.confirm)return fail('Passwords do not match.');
      if(wiz.skip)return wizFinish();
      break;
    case 2:{
      if(!d.server_name)return fail('Server name is required.');
      const p=Number(d.port);
      if(!Number.isInteger(p)||p<1||p>65535)return fail('Port must be a number between 1 and 65535.');
      if(d.tls_mode==='acme'&&!d.tls_domain)return fail('A domain is required for Let’s Encrypt.');
      break;}
    case 3:{
      const u=Number(d.upload_max_size_mb);
      if(!Number.isInteger(u)||u<1||u>10240)return fail('Max upload size must be between 1 and 10240 MB.');
      break;}
    case 5:return wizFinish();
  }
  wiz.step++;renderWizard();
}

async function wizFinish(){
  if(wiz.busy)return;wiz.busy=true;
  const btn=document.getElementById('wizNextBtn');if(btn){btn.disabled=true;btn.innerHTML='<div class="spinner"></div> Setting up…'}
  const d=wiz.data;
  const body={setup_token:d.setup_token,username:d.username,password:d.password};
  if(!wiz.skip){
    body.wizard={server_name:d.server_name,motd:d.motd,registration_mode:d.registration_mode||'invite',
      port:Number(d.port),tls_mode:d.tls_mode,upload_max_size_mb:Number(d.upload_max_size_mb),
      voice_quality:d.voice_quality,voice_auto_download:!!d.voice_auto_download};
    if(d.tls_mode==='acme')body.wizard.tls_domain=d.tls_domain;
  }
  try{
    const r=await fetch('/admin/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const resp=await r.json();if(!r.ok)throw new Error(resp.message||'Setup failed');
    state.token=resp.token;localStorage.setItem('admin_token',state.token);
    document.getElementById('inviteCode').textContent=resp.invite_code;
    const warn=document.getElementById('setupWarnings');warn.innerHTML='';
    (resp.warnings||[]).forEach(wm=>{const div=document.createElement('div');div.className='wiz-callout';div.style.marginBottom='12px';div.textContent=wm;warn.appendChild(div)});
    const fp=document.getElementById('setupFingerprint');const fpc=document.getElementById('certFingerprint');
    if(resp.certificate_fingerprint&&fp&&fpc){fpc.textContent=resp.certificate_fingerprint;fp.style.display='block'}
    showOverlay('setupSuccessOverlay');
    if(resp.restart_required&&resp.restart_url)beginRestartWait(resp.restart_url);
  }catch(e){
    const err=document.getElementById('wizErr');if(err)err.textContent=e.message;
    const b=document.getElementById('wizNextBtn');if(b){b.disabled=false;b.textContent=wiz.step===1?'Create Owner Account':'Finish Setup'}
  }finally{wiz.busy=false}
}

/* Poll until the restarted server answers, then follow it. no-cors: an opaque
   response resolving means "up" even across a port change; rejection means
   still down. A self-signed cert the browser hasn't accepted yet keeps the
   poll failing — the visible link is the primary path, this redirect is
   best-effort sugar. */
function beginRestartWait(url){
  document.getElementById('setupContinueBtn').style.display='none';
  document.getElementById('setupRestart').style.display='block';
  const link=document.getElementById('restartLink');link.href=url;link.textContent=url;
  let elapsed=0;
  setTimeout(function poll(){
    fetch(url+'/api/setup/status',{mode:'no-cors',cache:'no-store'})
      .then(()=>{window.location=url})
      .catch(()=>{elapsed+=2000;if(elapsed<60000)setTimeout(poll,2000)});
  },4000);
}

document.getElementById('setupContinueBtn').onclick=()=>{enterApp().catch(()=>showOverlay('loginOverlay'))};
function copyInvite(){navigator.clipboard.writeText(document.getElementById('inviteCode').textContent).then(()=>showToast('Copied!','info')).catch(()=>showToast('Copy failed','error'))}

document.getElementById('loginBtn').onclick=async()=>{
  const btn=document.getElementById('loginBtn');
  const u=document.getElementById('loginUser').value.trim(),p=document.getElementById('loginPass').value,err=document.getElementById('loginErr');
  err.textContent='';
  if(!u||!p){err.textContent='Username and password are required.';return}
  // Each submit counts against the login lockout counter — don't spend two.
  if(btn.disabled)return;
  btn.disabled=true;
  try{const r=await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});const d=await r.json();if(!r.ok)throw new Error(d.message||'Login failed');
    /* A TOTP account is answered with 200 and {partial_token,requires_2fa}
       and NO token — the session token comes from the second leg below.
       Without this branch the panel stored `undefined`, and every retry ended
       at a false "session expired": an operator who turned two-factor on
       could never open /admin again, which is where the owner-assisted
       recovery that would let them back in lives. */
    if(d.requires_2fa&&d.partial_token){showLoginTotp(d.partial_token);return}
    if(!d.token)throw new Error('Login failed');
    state.token=d.token;localStorage.setItem('admin_token',state.token);await enterApp();
  }catch(e){err.textContent=e.message}
  finally{btn.disabled=false}
};

function showLoginTotp(partialToken){
  state.partialToken=partialToken;
  document.getElementById('loginErr').textContent='';
  document.getElementById('loginStep1').classList.add('hidden');
  document.getElementById('loginTotpStep').classList.remove('hidden');
  const t=document.getElementById('loginTotp');t.value='';t.focus();
}

/* Second leg: POST /api/v1/auth/verify-totp authenticated with the partial
   token, exactly the exchange Client/src/lib/api.ts verifyTotp makes. The one
   field takes either the authenticator's 6-digit code or an emergency
   recovery code — the two have different shapes and AuthService.VerifyTOTP
   routes on that, so nothing here has to choose. The partial token is NOT
   cleared on a rejected code: the code is single-use, the challenge is not,
   so a retry has to keep working. */
document.getElementById('totpBtn').onclick=async()=>{
  const btn=document.getElementById('totpBtn');
  const err=document.getElementById('loginErr');
  const code=document.getElementById('loginTotp').value.trim();
  err.textContent='';
  if(!code){err.textContent='Enter your authentication code.';return}
  if(!state.partialToken){resetLoginSteps();err.textContent='That sign-in expired — start again.';return}
  if(btn.disabled)return;
  btn.disabled=true;
  try{
    const r=await fetch('/api/v1/auth/verify-totp',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+state.partialToken},body:JSON.stringify({code})});
    const d=await r.json();
    if(!r.ok)throw new Error(d.message||'Verification failed');
    if(!d.token)throw new Error('Verification failed');
    state.partialToken='';
    state.token=d.token;localStorage.setItem('admin_token',state.token);await enterApp();
  }catch(e){err.textContent=e.message}
  finally{btn.disabled=false}
};
document.getElementById('totpCancelBtn').onclick=()=>{resetLoginSteps();document.getElementById('loginErr').textContent=''};
document.getElementById('loginTotp').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('totpBtn').click()});

/* Wizard inputs bind Enter dynamically in renderWizard(). */
['loginUser','loginPass'].forEach(id=>document.getElementById(id).addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('loginBtn').click()}));

Object.assign(ACTIONS,{copyInvite,wizBack,wizNext,wizSkip,wizTLSChanged});
