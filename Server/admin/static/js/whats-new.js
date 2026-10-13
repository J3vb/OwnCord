/* What's new: the version this server runs, its release notes, every earlier
   version and the GitHub repository. The notes are changelog.md, a copy of
   the released part of the repository's CHANGELOG.md embedded with the panel
   (TestBundledChangelog keeps it in sync), so nothing leaves the server. */

const REPO_URL='https://github.com/J3vb/OwnCord';

/* The released sections of the changelog: [{version, body}], newest first. */
function parseChangelog(md){
  const out=[];let cur=null;
  for(const line of md.split(/\r?\n/)){
    if(line.startsWith('## ')){
      if(cur)out.push(cur);
      const m=/^## v(\d\S*)(?:\s.*)?$/.exec(line);
      cur=m?{version:m[1],lines:[]}:null;
      continue;
    }
    if(cur)cur.lines.push(line);
  }
  if(cur)out.push(cur);
  return out.map(v=>({version:v.version,body:v.lines.join('\n').trim()}));
}

/* **bold**, `code` and https links, on text that is escaped first. */
function changelogInline(text){
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g,'$1');
}

function changelogHtml(body){
  const out=[];let para=[];let items=null;
  const flushPara=()=>{
    if(!para.length)return;
    const text=para.join(' ');para=[];
    const sub=/^\*\*([^*]+)\*\*$/.exec(text);
    out.push(sub?'<h5 class="changelog-subheading">'+esc(sub[1])+'</h5>':'<p>'+changelogInline(text)+'</p>');
  };
  const flushList=()=>{if(items){out.push('<ul>'+items.map(i=>'<li>'+changelogInline(i)+'</li>').join('')+'</ul>');items=null}};
  for(const raw of body.split(/\r?\n/)){
    const line=raw.trimEnd();
    if(/^#{3,4} /.test(line)){flushPara();flushList();out.push('<h4 class="changelog-heading">'+esc(line.replace(/^#+\s*/,''))+'</h4>')}
    else if(/^\s*[-*] /.test(line)){flushPara();(items||(items=[])).push(line.replace(/^\s*[-*] /,''))}
    else if(line.trim()===''){flushPara();flushList()}
    else if(items)items[items.length-1]+=' '+line.trim();
    else para.push(line.trim());
  }
  flushPara();flushList();
  return'<div class="changelog-body">'+out.join('')+'</div>';
}

async function renderWhatsNew(){
  const ver=String((state.me&&state.me.version)||'').replace(/^v/,'');
  let versions=null;
  try{
    const res=await fetch('/admin/changelog.md',{cache:'no-cache'});
    if(!res.ok)throw new Error('HTTP '+res.status);
    versions=parseChangelog(await res.text());
  }catch(e){console.warn('[Admin] changelog unavailable',e)}
  const repo='<a class="whats-new-repo" href="'+REPO_URL+'" target="_blank" rel="noopener noreferrer">OwnCord on GitHub</a>';
  let html='<div class="page-title">What\'s new</div><div class="page-desc">What changed in the version this server runs, and in earlier versions.</div>';
  html+='<div class="status-line"><div style="flex:1;min-width:0"><div class="status-line-title">This server runs OwnCord '+esc(verLabel(ver)||'(unknown version)')+'</div><div class="status-line-sub">These notes ship with the server, so nothing is downloaded.</div></div>'+repo+'</div>';
  if(!versions){
    return html+'<p class="card-note">The release notes could not be loaded. <a class="whats-new-link" href="'+REPO_URL+'/releases" target="_blank" rel="noopener noreferrer">See the releases on GitHub</a>.</p>';
  }
  const current=versions.find(v=>v.version===ver)||null;
  if(current){
    html+='<div class="section-card"><div class="section-card-header"><h3>What\'s new in '+esc(verLabel(current.version))+'</h3></div><div class="section-card-body">'+changelogHtml(current.body)+'</div></div>';
  }else{
    html+='<p class="card-note">This build has no release notes. <a class="whats-new-link" href="'+REPO_URL+'/releases" target="_blank" rel="noopener noreferrer">See the releases on GitHub</a>.</p>';
  }
  const older=versions.filter(v=>v!==current);
  if(older.length){
    html+='<div class="section-card"><div class="section-card-header"><h3>Version history</h3></div><div class="section-card-body whats-new-history">'
      +older.map(v=>disclosure(esc(verLabel(v.version)),changelogHtml(v.body),false)).join('')+'</div></div>';
  }
  return html;
}
