/* OwnCord admin panel: first-run setup wizard and the sign-in overlay. */

/* ═══ First-Run Setup Wizard ═══ */
/* Multi-step overlay shown while needs_setup is true. Collects the owner
   account plus the basics (name, port, security, uploads, voice, access) and
   submits everything as one POST /admin/api/setup — the server writes both
   the settings table and config.yaml, and restarts itself if startup-only
   values changed. "Skip" falls back to the legacy account-only payload.
   The steps render into #wizardBox inside <form id="wizardForm">: Enter or the
   submit button advances (wizNext), Back is a plain button. */
const wiz={step:0,skip:false,defaults:null,data:{},busy:false};
/* Short step names for the "Step 3 of 6 · Server" progress line. */
const WIZ_STEPS=['Welcome','Account','Server','Uploads & voice','Access','Review'];
const WIZ_STEP_COUNT=WIZ_STEPS.length;
const TLS_OPTIONS={self_signed:'Self-signed certificate — recommended',acme:'Let’s Encrypt — needs a public domain and port 80',manual:'Manual certificate files — advanced',off:'Off — only behind an HTTPS reverse proxy'};
const TLS_LABELS={self_signed:'Self-signed certificate',acme:'Let’s Encrypt',manual:'Manual certificate files',off:'Off (behind an HTTPS reverse proxy)'};
const VOICE_QUALITY_LABELS={low:'Low',medium:'Medium',high:'High'};

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

/* "Step 3 of 6 · Server" plus the bar. The bar is decoration; the text line
   carries the position for everyone. The quick (skip) path is one step. */
function wizProgress(){
  if(wiz.skip)return '<p class="wiz-progress">Quick setup · <strong>Account</strong></p>';
  let h='<p class="wiz-progress">Step '+(wiz.step+1)+' of '+WIZ_STEP_COUNT+' · <strong>'+esc(WIZ_STEPS[wiz.step])+'</strong></p><div class="wiz-steps" aria-hidden="true">';
  for(let i=0;i<WIZ_STEP_COUNT;i++)h+='<div class="wiz-dot '+(i===wiz.step?'active':i<wiz.step?'done':'')+'"></div>';
  return h+'</div>';
}

function wizField(id,label,input,hint){
  return '<div class="form-group"><label class="form-label" for="'+id+'">'+label+'</label>'+input
    +(hint?'<p class="wiz-hint" id="'+id+'Hint">'+hint+'</p>':'')+'</div>';
}

/* The Security hint per TLS mode. The desktop client pins whatever
   certificate it is shown and connects only over wss://, which is what the
   choice really decides; `port` is the server.port the wizard is setting. */
function wizTLSHint(mode,port){
  const p=esc(port||8443);
  return {
    self_signed:'Works out of the box, on your network or over the internet. The desktop app asks each member to trust this certificate on first connect: publish its fingerprint (shown when setup finishes) so they can compare it before accepting. Browsers show a one-time warning for this page.',
    acme:'A free certificate for a domain that already points at this machine. Let’s Encrypt checks the domain over port 80, so both port 80 and port '+p+' must be reachable from the internet. It renews automatically, and the desktop app pins the certificate, so after every renewal each member sees a certificate-changed warning and has to accept the new fingerprint. A reverse proxy that owns the certificate is the recommended setup for a domain.',
    manual:'Your own certificate and key, loaded from <code>data/cert.pem</code> and <code>data/key.pem</code> at start-up. The desktop app pins this certificate too: replacing it means every member accepts the new fingerprint.',
    off:'No encryption on this server. The desktop app connects only over encrypted wss://, so it cannot connect at all unless a reverse proxy in front of this server serves HTTPS. Choose this only for that setup.'}[mode]||'';
}

function renderWizard(){
  const box=document.getElementById('wizardBox');
  const d=wiz.data;
  const title=t=>'<h1 class="auth-title" id="wizTitle" tabindex="-1">'+t+'</h1>';
  let h=wizProgress();
  const err='<div class="auth-error" id="wizErr" role="alert"></div>';
  const nav=nextLabel=>'<div class="wiz-nav"><button type="button" class="btn btn-ghost" data-action="wizBack">Back</button><button type="submit" class="btn btn-accent" id="wizNextBtn">'+nextLabel+'</button></div>';
  switch(wiz.step){
    case 0:
      h+=title('Welcome to OwnCord')
        +'<p class="wiz-sub">Your own private chat server is almost ready. This one-minute setup creates your admin account and configures the basics — no config files to edit, everything is saved for you.</p>'
        +'<button type="submit" class="btn btn-accent auth-submit" id="wizNextBtn">Get Started</button>'
        +'<button type="button" class="wiz-skip" data-action="wizSkip">Skip the questions — use recommended defaults</button>';
      break;
    case 1:
      h+=title('Create your admin account')
        +'<p class="wiz-sub">This is the owner account for managing the server. Pick a strong password — this account can do everything.</p>'
        +wizField('wizToken','Setup token','<input class="form-input" id="wizToken" name="setup_token" autocomplete="off" autocapitalize="off" spellcheck="false" required value="'+esc(d.setup_token)+'">',
          'Printed in the server&#39;s start-up output (the terminal it runs in, <code>docker compose logs owncord</code>, or the service log). It proves you have access to the server itself.')
        +wizField('wizUser','Username','<input class="form-input" id="wizUser" name="username" autocomplete="username" autocapitalize="off" spellcheck="false" required value="'+esc(d.username)+'">')
        +wizField('wizPass','Password','<input class="form-input" id="wizPass" name="password" type="password" autocomplete="new-password" minlength="8" required>','At least 8 characters.')
        +wizField('wizConfirm','Confirm password','<input class="form-input" id="wizConfirm" name="confirm" type="password" autocomplete="new-password" required>')
        +err+nav(wiz.skip?'Create Owner Account':'Next');
      break;
    case 2:
      h+=title('Server basics')
        +'<p class="wiz-sub">How your server introduces itself, and how people connect to it.</p>'
        +wizField('wizName','Server name','<input class="form-input" id="wizName" maxlength="100" required value="'+esc(d.server_name)+'">')
        +wizField('wizPort','Port','<input class="form-input" id="wizPort" type="number" inputmode="numeric" min="1" max="65535" required data-input-action="wizTLSChanged" value="'+esc(d.port)+'">',
          'The port the desktop app and this panel connect to. Keep the default unless it clashes with something else on this machine.')
        +wizField('wizTLS','Security (TLS)','<select class="form-input" id="wizTLS" data-change-action="wizTLSChanged">'
          +Object.keys(TLS_OPTIONS).map(m=>'<option value="'+m+'"'+(d.tls_mode===m?' selected':'')+'>'+TLS_OPTIONS[m]+'</option>').join('')
          +'</select>',' ')
        +'<div id="wizDomainGroup" hidden>'+wizField('wizDomain','Domain','<input class="form-input" id="wizDomain" autocapitalize="off" spellcheck="false" placeholder="chat.example.com" value="'+esc(d.tls_domain)+'">',
          'A hostname, not an IP address. If it doesn&#39;t point at this machine yet, pick self-signed for now — you can switch later.')+'</div>'
        +err+nav('Next');
      break;
    case 3:
      h+=title('Uploads &amp; voice')
        +'<p class="wiz-sub">Limits for file sharing and voice chat quality.</p>'
        +wizField('wizUpload','Max upload size (MB)','<input class="form-input" id="wizUpload" type="number" inputmode="numeric" min="1" max="10240" required value="'+esc(d.upload_max_size_mb)+'">','The largest file anyone can share. 100 MB suits most servers.')
        +'<div class="wiz-toggle-row"><div><div class="lbl" id="wizVoiceDl-name">Voice chat</div><p class="wiz-hint" id="wizVoiceDl-hint">Downloads the voice engine (LiveKit, ~40 MB, one time) from the official LiveKit project and manages it for you. Turn off only if you run your own LiveKit server.</p></div><button type="button" class="toggle'+(d.voice_auto_download?' on':'')+'" id="wizVoiceDl" role="switch" aria-checked="'+(d.voice_auto_download?'true':'false')+'" aria-labelledby="wizVoiceDl-name" aria-describedby="wizVoiceDl-hint" data-action="toggleSwitch"></button></div>'
        +wizField('wizVoice','Voice quality','<select class="form-input" id="wizVoice">'
          +'<option value="low"'+(d.voice_quality==='low'?' selected':'')+'>Low &mdash; least bandwidth, phone-call quality</option>'
          +'<option value="medium"'+(d.voice_quality==='medium'?' selected':'')+'>Medium &mdash; recommended balance</option>'
          +'<option value="high"'+(d.voice_quality==='high'?' selected':'')+'>High &mdash; best quality, most bandwidth</option>'
          +'</select>')
        +err+nav('Next');
      break;
    case 4:
      h+=title('Who can join?')
        +'<p class="wiz-sub">You&#39;ll get an invite code either way — these control what happens after that.</p>'
        +wizField('wizReg','Registration','<select class="form-input" id="wizReg">'+regModeOptions(d.registration_mode)+'</select>',
          'Who can create an account. Invite-only is the default; approval holds new accounts until you approve them in Members.')
        +wizField('wizMotd','Welcome message','<input class="form-input" id="wizMotd" maxlength="500" value="'+esc(d.motd)+'">','Shown to members when they connect.')
        +err+nav('Next');
      break;
    case 5:{
      const secLabel=d.tls_mode==='acme'?'Let’s Encrypt ('+esc(d.tls_domain)+')':esc(TLS_LABELS[d.tls_mode]||d.tls_mode);
      const rows=[['Username',esc(d.username)],['Server name',esc(d.server_name)],['Port',esc(d.port)],['Security',secLabel],['Max upload',esc(d.upload_max_size_mb)+' MB'],['Voice chat',d.voice_auto_download?'Automatic (LiveKit downloaded for you)':'Self-managed / off'],['Voice quality',esc(VOICE_QUALITY_LABELS[d.voice_quality]||d.voice_quality)],['Registration',esc(regModeLabel(d.registration_mode))],['Welcome message',esc(d.motd)||'&mdash;']];
      h+=title('Review &amp; finish')+'<p class="wiz-sub">Everything look right? You can change any of this later in the admin panel.</p><dl class="wiz-review">';
      rows.forEach(r=>{h+='<div class="wiz-review-row"><dt>'+r[0]+'</dt><dd>'+r[1]+'</dd></div>'});
      h+='</dl>';
      if(d.tls_mode==='off')h+='<div class="wiz-callout">Security is off: the desktop app cannot connect until a reverse proxy in front of this server serves HTTPS.</div>';
      if(wizNeedsRestart())h+='<div class="wiz-callout">The server will restart once to apply your connection settings, then point you to the right address.</div>';
      h+=err+nav('Finish Setup');
      break;}
  }
  box.innerHTML=h;
  box.querySelectorAll('.form-group').forEach(g=>{const c=g.querySelector('input,select'),hint=g.querySelector('.wiz-hint');if(c&&hint)c.setAttribute('aria-describedby',hint.id)});
  if(wiz.step===2)wizTLSChanged();
  const first=box.querySelector('input,select');
  (first||document.getElementById('wizTitle')).focus();
}

function wizTLSChanged(){
  const sel=document.getElementById('wizTLS');if(!sel)return;
  const port=document.getElementById('wizPort');
  document.getElementById('wizTLSHint').innerHTML=wizTLSHint(sel.value,port&&port.value);
  document.getElementById('wizDomainGroup').hidden=sel.value!=='acme';
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

/* Shows msg in the step's alert region and, when a field is named, marks it
   invalid, points it at the message and moves focus there. */
function wizFail(msg,fieldId){
  const e=document.getElementById('wizErr');if(e)e.textContent=msg;
  document.querySelectorAll('#wizardBox [aria-invalid]').forEach(el=>{
    el.removeAttribute('aria-invalid');
    const rest=(el.getAttribute('aria-describedby')||'').replace(/\bwizErr\b/,'').trim();
    if(rest)el.setAttribute('aria-describedby',rest);else el.removeAttribute('aria-describedby');
  });
  const f=fieldId&&document.getElementById(fieldId);
  if(f){
    f.setAttribute('aria-invalid','true');
    f.setAttribute('aria-describedby',('wizErr '+(f.getAttribute('aria-describedby')||'')).trim());
    f.focus();
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
  switch(wiz.step){
    case 1:
      if(!d.setup_token)return wizFail('Enter the setup token from the server’s start-up output.','wizToken');
      if(!d.username)return wizFail('Choose a username.','wizUser');
      if(d.password.length<8)return wizFail('Password must be at least 8 characters.','wizPass');
      if(d.password!==d.confirm)return wizFail('Passwords do not match.','wizConfirm');
      if(wiz.skip)return wizFinish();
      break;
    case 2:{
      if(!d.server_name)return wizFail('Server name is required.','wizName');
      const p=Number(d.port);
      if(!Number.isInteger(p)||p<1||p>65535)return wizFail('Port must be a number between 1 and 65535.','wizPort');
      if(d.tls_mode==='acme'&&!d.tls_domain)return wizFail('A domain is required for Let’s Encrypt.','wizDomain');
      break;}
    case 3:{
      const u=Number(d.upload_max_size_mb);
      if(!Number.isInteger(u)||u<1||u>10240)return wizFail('Max upload size must be between 1 and 10240 MB.','wizUpload');
      break;}
    case 5:return wizFinish();
  }
  wiz.step++;renderWizard();
}

/* The address members type into the desktop app (host:port). Let's Encrypt
   serves its domain; otherwise it is the host this browser reached, on the
   port the restart moves to. */
function setupAddress(resp){
  const d=wiz.data;
  if(!wiz.skip&&d.tls_mode==='acme'&&d.tls_domain)return d.tls_domain+':'+d.port;
  if(resp.restart_url){try{return new URL(resp.restart_url).host}catch(e){}}
  return location.host;
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
    const resp=await r.json();if(!r.ok)throw new Error(authMessage(r.status,resp.message,'Setup failed'));
    state.token=resp.token;localStorage.setItem('admin_token',state.token);
    renderSetupSuccess(resp);
    showOverlay('setupSuccessOverlay');
    document.getElementById('setupTitle').focus();
    if(resp.restart_required&&resp.restart_url)beginRestartWait(resp.restart_url);
  }catch(e){
    wizFail(e.message);
    const b=document.getElementById('wizNextBtn');if(b){b.disabled=false;b.textContent=wiz.step===1?'Create Owner Account':'Finish Setup'}
  }finally{wiz.busy=false}
}

/* Fills the success card: the address to connect to, the invite code, and
   the certificate fingerprint members compare against their trust prompt. */
function renderSetupSuccess(resp){
  const addr=setupAddress(resp);
  document.getElementById('setupAddress').textContent=addr;
  if(/^(localhost|127\.|\[::1\])/.test(addr))document.getElementById('setupAddressHint').textContent='This is this computer’s own address. Members on other machines use its network address or domain, with the same port.';
  document.getElementById('inviteCode').textContent=resp.invite_code;
  const warn=document.getElementById('setupWarnings');warn.innerHTML='';
  (resp.warnings||[]).forEach(wm=>{const div=document.createElement('div');div.className='wiz-callout';div.textContent=wm;warn.appendChild(div)});
  const fp=!!resp.certificate_fingerprint;
  if(fp)document.getElementById('certFingerprint').textContent=resp.certificate_fingerprint;
  document.getElementById('setupFingerprint').classList.toggle('hidden',!fp);
  const mode=wiz.skip?wiz.defaults&&wiz.defaults.tls_mode:wiz.data.tls_mode;
  document.getElementById('setupFingerprintLater').classList.toggle('hidden',fp||mode==='off'||mode==='acme');
}

/* Poll until the restarted server answers, then follow it. no-cors: an opaque
   response resolving means "up" even across a port change; rejection means
   still down. A self-signed cert the browser hasn't accepted yet keeps the
   poll failing — the visible link is the primary path, this redirect is
   best-effort sugar. */
function beginRestartWait(url){
  document.getElementById('setupContinueBtn').classList.add('hidden');
  document.getElementById('setupRestart').classList.remove('hidden');
  const link=document.getElementById('restartLink');link.href=url;link.textContent=url;
  let elapsed=0;
  setTimeout(function poll(){
    fetch(url+'/api/setup/status',{mode:'no-cors',cache:'no-store'})
      .then(()=>{window.location=url})
      .catch(()=>{elapsed+=2000;if(elapsed<60000)setTimeout(poll,2000)});
  },4000);
}

document.getElementById('wizardForm').addEventListener('submit',e=>{e.preventDefault();wizNext()});
document.getElementById('setupContinueBtn').onclick=()=>{enterApp().catch(()=>showOverlay('loginOverlay'))};
function copyCode(id){navigator.clipboard.writeText(document.getElementById(id).textContent).then(()=>showToast('Copied!','info')).catch(()=>showToast('Copy failed','error'))}

/* ═══ Sign-in ═══ */
/* Server auth errors are terse lower-case codes ("invalid credentials");
   show a sentence. A 401 on the password step says which fields to recheck. */
function authMessage(status,message,fallback){
  if(status===401&&message==='invalid credentials')return 'Wrong username or password.';
  const m=message||fallback;
  return m.charAt(0).toUpperCase()+m.slice(1);
}

async function submitLogin(){
  const btn=document.getElementById('loginBtn');
  const u=document.getElementById('loginUser').value.trim(),p=document.getElementById('loginPass').value,err=document.getElementById('loginErr');
  err.textContent='';
  if(!u||!p){err.textContent='Username and password are required.';document.getElementById(u?'loginPass':'loginUser').focus();return}
  // Each submit counts against the login lockout counter — don't spend two.
  if(btn.disabled)return;
  btn.disabled=true;
  try{const r=await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});const d=await r.json();if(!r.ok)throw new Error(authMessage(r.status,d.message,'Login failed'));
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
}

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
async function submitTotp(){
  const btn=document.getElementById('totpBtn');
  const err=document.getElementById('loginErr');
  const code=document.getElementById('loginTotp').value.trim();
  err.textContent='';
  if(!code){err.textContent='Enter your authentication code.';document.getElementById('loginTotp').focus();return}
  if(!state.partialToken){resetLoginSteps();err.textContent='That sign-in expired — start again.';return}
  if(btn.disabled)return;
  btn.disabled=true;
  try{
    const r=await fetch('/api/v1/auth/verify-totp',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+state.partialToken},body:JSON.stringify({code})});
    const d=await r.json();
    if(!r.ok)throw new Error(authMessage(r.status,d.message,'Verification failed'));
    if(!d.token)throw new Error('Verification failed');
    state.partialToken='';
    state.token=d.token;localStorage.setItem('admin_token',state.token);await enterApp();
  }catch(e){err.textContent=e.message}
  finally{btn.disabled=false}
}

document.getElementById('loginStep1').addEventListener('submit',e=>{e.preventDefault();submitLogin()});
document.getElementById('loginTotpStep').addEventListener('submit',e=>{e.preventDefault();submitTotp()});
document.getElementById('totpCancelBtn').onclick=()=>{resetLoginSteps();document.getElementById('loginErr').textContent='';document.getElementById('loginUser').focus()};

Object.assign(ACTIONS,{copyCode,wizBack,wizSkip,wizTLSChanged});
