/* OwnCord admin panel: the Dashboard health row. Four tiles (CPU, RAM, disk
   free, uptime) from GET /system/stats, each CPU and RAM tile with a one-hour
   line, refreshed every 5 seconds while the Dashboard is on screen.

   Polling belongs to one Dashboard render at a time. Each render starts a new
   generation (health.seq); a poll checks it still owns the page (same
   generation, still on the Dashboard, same session) before it fetches and
   again before it paints or schedules the next one, so a late answer after
   leaving the page, signing out or re-rendering is dropped and its loop ends.
   A figure the server could not read is null and shows as a dash, never 0. */
const HEALTH_POLL_MS=5000;
const health={seq:0,timer:null,data:null};

/* CPU tone: the average over the last five minutes. RAM tone: the share of
   machine (or container) memory in use now. */
const HEALTH_CPU_WARN=80,HEALTH_CPU_CRIT=95,HEALTH_MEM_WARN=0.9,HEALTH_MEM_CRIT=0.97;
const HEALTH_SUSTAIN_S=300;

function healthOwns(seq,token){return seq===health.seq&&state.section==='dashboard'&&state.token===token}

/* Called by renderDashboard. Waits for the first answer so the row paints
   with figures, then hands over to the poll loop. */
async function startHealthPoll(){
  if(health.timer){clearTimeout(health.timer);health.timer=null}
  const seq=++health.seq,token=state.token;
  await loadHealth(seq,token);
  if(healthOwns(seq,token))health.timer=setTimeout(()=>pollHealth(seq,token),HEALTH_POLL_MS);
}
async function pollHealth(seq,token){
  health.timer=null;
  if(!healthOwns(seq,token))return;
  /* A hidden tab skips the request but keeps the loop. */
  if(document.visibilityState!=='hidden'){
    const ok=await loadHealth(seq,token);
    if(!healthOwns(seq,token)||!ok)return;
    paintHealth();
  }
  if(healthOwns(seq,token))health.timer=setTimeout(()=>pollHealth(seq,token),HEALTH_POLL_MS);
}
/* Reads one answer into health.data. False when the poll should stop: a
   refusal (the permission was removed) or the session ended. A failed read
   keeps the last figures and the loop. */
async function loadHealth(seq,token){
  try{
    const data=await api('GET','/system/stats?window=1h');
    if(healthOwns(seq,token))health.data=data;
    return true;
  }catch(e){return!(e&&(e.status===403||e.status===401))&&state.token===token}
}
function paintHealth(){
  const el=document.getElementById('healthRow');
  if(el)el.innerHTML=healthTiles(health.data);
}
function healthRow(){
  return'<section id="healthRow" class="health-row" aria-label="Server resources">'+healthTiles(health.data)+'</section>';
}

const HEALTH_DASH='–';
function healthPct(v){return typeof v==='number'?(v<10?v.toFixed(1):Math.round(v))+'%':HEALTH_DASH}
function healthGB(b){return(b/1073741824).toFixed(b<10737418240?1:0)}
function healthUptime(s){
  if(typeof s!=='number')return HEALTH_DASH;
  const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  return d?d+'d '+h+'h':h?h+'h '+m+'m':m+'m';
}
/* The worst figure over the last HEALTH_SUSTAIN_S seconds is not the test:
   the average is, so one busy second does not colour the tile. */
function healthRecentAvg(series,key){
  if(!series.length)return null;
  const from=series[series.length-1].t-HEALTH_SUSTAIN_S;
  let sum=0,n=0;
  series.forEach(p=>{if(p.t>from&&typeof p[key]==='number'){sum+=p[key];n++}});
  return n?sum/n:null;
}
function healthTone(v,warn,crit){return v===null?'':v>=crit?'crit':v>=warn?'warn':''}
const HEALTH_PILL={warn:['badge-yellow','High'],crit:['badge-red','Very high']};
function healthPill(tone,words){const p=words||HEALTH_PILL[tone];return p?' <span class="badge '+p[0]+'">'+p[1]+'</span>':''}

/* A quiet server's line would hug the floor of a 0-100% scale, so the top is
   a quarter above the hour's peak, at least 20% and at most 100%. */
function healthCpuScale(series,key){
  let peak=0;
  series.forEach(p=>{if(typeof p[key]==='number'&&p[key]>peak)peak=p[key]});
  return Math.min(100,Math.max(20,peak*1.25));
}
/* A one-hour line: y runs from lo to hi, a null figure breaks the line. */
function healthSpark(series,key,lo,hi){
  const pts=series.filter(p=>typeof p[key]==='number');
  if(pts.length<2)return'<div class="health-spark-empty"></div>';
  const t0=series[0].t,t1=series[series.length-1].t,span=Math.max(t1-t0,1),range=Math.max(hi-lo,1e-9);
  const x=p=>(p.t-t0)/span*200,y=v=>34-(Math.min(Math.max(v,lo),hi)-lo)/range*32;
  let line='',area='',run=[];
  const flush=()=>{
    if(run.length>1){
      const d=run.map((p,i)=>(i?'L':'M')+x(p).toFixed(1)+' '+y(p[key]).toFixed(1)).join(' ');
      line+=d;area+=d+' L'+x(run[run.length-1]).toFixed(1)+' 36 L'+x(run[0]).toFixed(1)+' 36Z';
    }
    run=[];
  };
  series.forEach(p=>{if(typeof p[key]==='number')run.push(p);else flush()});
  flush();
  return'<svg class="health-spark" viewBox="0 0 200 36" preserveAspectRatio="none" aria-hidden="true" focusable="false"><path class="health-spark-area" d="'+area+'"/><path class="health-spark-line" d="'+line+'"/></svg>';
}

function healthTile(id,label,value,sub,extra,tone,pill){
  return'<div class="health-tile'+(tone?' '+tone:'')+'" id="'+id+'"><div class="stat-card-label">'+label+pill+'</div>'
    +'<div class="health-value">'+value+'</div><div class="health-sub">'+sub+'</div>'+extra+'</div>';
}

function healthTiles(d){
  d=d||{};
  const series=d.series||[],cur=d.current||{},disk=d.disk||{};

  /* CPU: the machine's figure, with OwnCord's share beside it. Where the
     system gives no machine figure, OwnCord's own is the headline. */
  const machKey=series.some(p=>typeof p.machine_cpu==='number')||typeof cur.machine_cpu==='number'?'machine_cpu':'process_cpu';
  const cpuNow=cur[machKey];
  const cpuSub=[];
  if(typeof cur.process_cpu==='number')cpuSub.push('OwnCord '+healthPct(cur.process_cpu));
  if(typeof cur.machine_cpu==='number')cpuSub.push('machine '+healthPct(cur.machine_cpu));
  if(d.cpu_cores)cpuSub.push(d.cpu_cores+(d.cpu_cores===1?' core':' cores'));
  if(typeof cpuNow!=='number'&&d.current)cpuSub.unshift('Measuring…');
  const cpuTone=healthTone(healthRecentAvg(series,machKey),HEALTH_CPU_WARN,HEALTH_CPU_CRIT);
  let html=healthTile('healthCpu','CPU',healthPct(cpuNow),esc(cpuSub.join(' · '))||HEALTH_DASH,healthSpark(series,machKey,0,healthCpuScale(series,machKey)),cpuTone,healthPill(cpuTone));

  /* RAM: OwnCord's resident memory, with the machine's (or container's) use. */
  const memVals=series.map(p=>p.process_memory).filter(v=>typeof v==='number');
  const memHi=memVals.length?Math.max(...memVals)*1.15:1,memLo=memVals.length?Math.min(...memVals)*0.85:0;
  let memSub=HEALTH_DASH,memTone='';
  if(typeof cur.memory_used==='number'&&d.memory_total){
    memSub=(d.memory_scope==='container'?'container ':'machine ')+healthGB(cur.memory_used)+' / '+healthGB(d.memory_total)+' GB used';
    memTone=healthTone(cur.memory_used/d.memory_total,HEALTH_MEM_WARN,HEALTH_MEM_CRIT);
  }
  html+=healthTile('healthRam','RAM',typeof cur.process_memory==='number'?fmtBytes(cur.process_memory):HEALTH_DASH,esc(memSub),healthSpark(series,'process_memory',memLo,memHi),memTone,healthPill(memTone));

  /* Disk free on the data volume. Below server.min_free_disk_mb uploads are
     refused (red); under a tenth free is a yellow early warning. */
  const free=disk.free,total=disk.total;
  let diskTone='',diskPill='',diskSub=HEALTH_DASH,meter='';
  if(typeof free==='number'){
    if(disk.low){diskTone='crit';diskPill=healthPill('',['badge-red','Low'])}
    else if(total&&free/total<0.1){diskTone='warn';diskPill=healthPill('',['badge-yellow','Low'])}
    const parts=[];
    if(total)parts.push('of '+fmtBytes(total));
    if(typeof disk.uploads==='number')parts.push('uploads '+fmtBytes(disk.uploads));
    diskSub=parts.join(' · ')||HEALTH_DASH;
    if(total){
      const up=typeof disk.uploads==='number'?Math.min(disk.uploads,total-free):0;
      const pct=v=>(Math.max(v,0)/total*100).toFixed(1)+'%';
      meter='<div class="health-meter" aria-hidden="true"><span class="m-other" style="width:'+pct(total-free-up)+'"></span><span class="m-uploads" style="width:'+pct(up)+'"></span></div>';
    }
  }
  html+=healthTile('healthDisk','Disk free',typeof free==='number'?fmtBytes(free):HEALTH_DASH,esc(diskSub),meter,diskTone,diskPill);

  const online=typeof d.online_users==='number'?d.online_users+' online':HEALTH_DASH;
  html+=healthTile('healthUptime','Uptime',healthUptime(d.uptime_seconds),esc(online),'','','');
  return html;
}
