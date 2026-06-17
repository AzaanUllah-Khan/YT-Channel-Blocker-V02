'use strict';
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function toast(msg,type){var t=document.getElementById('toast');t.textContent=msg;t.className='toast'+(type?' '+type:'');t.classList.add('show');setTimeout(function(){t.classList.remove('show');},2400);}
function pad(n){return String(n).padStart(2,'0');}
function todayKey(){return new Date().toDateString();}

var curCid=null,curCname='',curVid=null,curVtitle='',curHandle=null;
var pendingUnlock=null,quizQs=[],quizIdx=0,quizFailed=false;

document.addEventListener('DOMContentLoaded',async function(){
  await loadPage();
  await renderBlocked();
  await checkNuclear();

  document.querySelectorAll('.tab').forEach(function(b){
    b.addEventListener('click',function(){
      document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active');
      var t=b.dataset.tab;
      ['block','streak','stats'].forEach(function(id){
        var el=document.getElementById('tab-'+id);
        if(el) el.style.display=(id===t)?'':'none';
      });
      if(t==='streak') renderStreak();
      if(t==='stats')  renderStats();
    });
  });

  document.getElementById('btn-nuc').addEventListener('click',activateNuclear);
  document.getElementById('btn-quiz').addEventListener('click',function(){startQuiz(null);});
  document.getElementById('q-cancel').addEventListener('click',function(){switchView('main');});
  document.getElementById('btn-focus').addEventListener('click',markFocus);
  document.getElementById('btn-fetch-channel').addEventListener('click',fetchChannelInfo);
  document.getElementById('btn-manual-block').addEventListener('click',confirmManualBlock);
  document.getElementById('manual-cid').addEventListener('keydown',function(e){
    if(e.key==='Enter') fetchChannelInfo();
  });
  document.getElementById('manual-cid').addEventListener('input',function(){
    // Any edit invalidates the previous fetch result
    manualResolved = null;
    document.getElementById('manual-preview').style.display = 'none';
    document.getElementById('manual-status').textContent = '';
  });

  chrome.storage.onChanged.addListener(function(changes,area){
    if(area!=='local') return;
    if(changes.blockedChannels){renderBlocked();renderCur();}
    if(changes.nuclearMode||changes.nuclearUntil){checkNuclear();renderBlocked();}
  });
});

async function loadPage(){
  try{
    var tabs=await chrome.tabs.query({active:true,currentWindow:true});
    var tab=tabs[0];
    if(!tab||!tab.url||!tab.url.includes('youtube.com')) return;
    var res=await chrome.scripting.executeScript({
      target:{tabId:tab.id},
      func:function(){
        if(typeof window.__ytgCurrentPage==='function') return window.__ytgCurrentPage();
        var cid='',cname='',vid=null,vtitle='',chandle=null;
        try{var pr=window.ytInitialPlayerResponse;if(pr&&pr.videoDetails){cid=pr.videoDetails.channelId||'';cname=pr.videoDetails.author||'';vid=pr.videoDetails.videoId||null;vtitle=pr.videoDetails.title||'';}}catch(_){}
        if(!cid){try{var yd=window.ytInitialData;if(yd&&yd.header&&yd.header.c4TabbedHeaderRenderer){cid=yd.header.c4TabbedHeaderRenderer.channelId||'';cname=yd.header.c4TabbedHeaderRenderer.title||cname;}}catch(_){}}
        if(!cid){try{var yd2=window.ytInitialData;if(yd2&&yd2.metadata&&yd2.metadata.channelMetadataRenderer){cid=yd2.metadata.channelMetadataRenderer.externalId||'';cname=yd2.metadata.channelMetadataRenderer.title||cname;}}catch(_){}}
        if(!cid){var um=location.pathname.match(/\/channel\/(UC[\w-]{22})/);if(um)cid=um[1];}
        if(!vid){var vm=location.search.match(/[?&]v=([\w-]{11})/);if(vm)vid=vm[1];}
        if(!cname)cname=document.title.replace(' - YouTube','').trim();
        if(!cname||cname==='YouTube') cname = cid || 'Unknown Channel';
        // Resolve @handle
        try{
          var hm=location.pathname.match(/^\/@([\w.-]+)/);
          if(hm) chandle='@'+hm[1].toLowerCase();
          if(!chandle){
            var yd3=window.ytInitialData;
            if(yd3&&yd3.metadata&&yd3.metadata.channelMetadataRenderer&&yd3.metadata.channelMetadataRenderer.vanityChannelUrl){
              var vmm=yd3.metadata.channelMetadataRenderer.vanityChannelUrl.match(/\/@([\w.-]+)/);
              if(vmm) chandle='@'+vmm[1].toLowerCase();
            }
          }
        }catch(_){}
        return{channelId:cid,channelName:cname,videoId:vid,videoTitle:vtitle,channelHandle:chandle};
      }
    });
    if(res&&res[0]&&res[0].result){
      var r=res[0].result;
      curCid=r.channelId||null; curCname=r.channelName||'';
      curVid=r.videoId||null;   curVtitle=r.videoTitle||'';
      curHandle=r.channelHandle||null;
      if(!curCid&&!curVid){
        setTimeout(async function(){
          try{
            var r2=await chrome.scripting.executeScript({target:{tabId:tab.id},func:function(){
              if(typeof window.__ytgCurrentPage==='function') return window.__ytgCurrentPage();
              var pr=window.ytInitialPlayerResponse;
              if(pr&&pr.videoDetails) return{channelId:pr.videoDetails.channelId,channelName:pr.videoDetails.author,videoId:pr.videoDetails.videoId,videoTitle:pr.videoDetails.title};
              return null;
            }});
            if(r2&&r2[0]&&r2[0].result&&(r2[0].result.channelId||r2[0].result.videoId)){
              var rr=r2[0].result;
              curCid=rr.channelId||null;curCname=rr.channelName||'';curVid=rr.videoId||null;curVtitle=rr.videoTitle||'';
              renderCur();
            }
          }catch(_){}
        },900);
      }
      renderCur();
    }
  }catch(e){}
}

async function renderCur(){
  var el=document.getElementById('cur-display');
  if(!curCid&&!curVid){el.innerHTML='<div class="no-page">Open a YouTube channel or video</div>';return;}
  var data=await chrome.storage.local.get('blockedChannels');
  var blocked=data.blockedChannels||{};
  var isBl=!!(curCid&&blocked[curCid]);
  var html='';
  if(curCid){
    html+='<div class="ch-row"><div class="ch-info"><div class="ch-name">'+esc(curCname)+'</div><div class="ch-id">'+esc(curCid)+'</div>'+(isBl?'<div class="meta-red">🚫 Blocked</div>':'')+'</div>'
      +'<button class="btn '+(isBl?'btn-ghost':'btn-red')+'" id="btn-blk-ch"'+(isBl?' disabled':'')+' style="flex-shrink:0;">'+(isBl?'✓ Blocked':'+ Block')+'</button></div>';
  }
  if(curVid){
    html+='<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--b1);font-size:10px;color:var(--t2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">🎬 '+esc((curVtitle||'Video').slice(0,50))+'</div>';
  }
  el.innerHTML=html;
  if(curCid&&!isBl){var b=document.getElementById('btn-blk-ch');if(b)b.addEventListener('click',blockCur);}
}

async function blockCur(){
  if(!curCid) return;
  await chrome.runtime.sendMessage({type:'BLOCK_CHANNEL',channelId:curCid,channelName:curCname,channelHandle:curHandle});
  toast('Channel blocked','red');
}

// ── Manual "Get Channel" / "+ Block" two-step flow ──
var manualResolved = null; // { channelId, name, handle }

async function fetchChannelInfo(){
  var input  = document.getElementById('manual-cid');
  var status = document.getElementById('manual-status');
  var preview = document.getElementById('manual-preview');
  var raw    = input.value.trim();

  preview.style.display = 'none';
  manualResolved = null;

  // Allow pasting full URLs — extract the UC id if present
  var urlMatch = raw.match(/\/channel\/(UC[\w-]{22})/);
  var cid = urlMatch ? urlMatch[1] : raw;

  if (!/^UC[\w-]{22}$/.test(cid)) {
    status.textContent = 'Invalid channel ID — must start with UC and be 24 characters total.';
    status.style.color = 'var(--red)';
    return;
  }

  status.textContent = 'Fetching channel info…';
  status.style.color = 'var(--t3)';
  var fetchBtn = document.getElementById('btn-fetch-channel');
  fetchBtn.disabled = true;

<<<<<<< HEAD
  var resp;
  try {
    resp = await chrome.runtime.sendMessage({ type:'FETCH_CHANNEL_INFO', channelId: cid });
  } catch (e) {
    fetchBtn.disabled = false;
    status.textContent = 'Extension error — try reloading the extension.';
    status.style.color = 'var(--red)';
    return;
  }
=======
  var resp = await chrome.runtime.sendMessage({ type:'FETCH_CHANNEL_INFO', channelId: cid });
>>>>>>> 04b6454885ce733a11d6222a7ac4034aa6c17963
  fetchBtn.disabled = false;

  if (resp && resp.success) {
    manualResolved = { channelId: resp.channelId, name: resp.name, handle: resp.handle };
    document.getElementById('manual-preview-name').textContent = resp.name || cid;
    document.getElementById('manual-preview-id').textContent = resp.channelId + (resp.handle ? ' · ' + resp.handle : '');
    preview.style.display = '';
    status.textContent = '';
  } else if (resp && resp.reason === 'already_blocked') {
    status.textContent = 'Already blocked: ' + (resp.name || cid);
    status.style.color = 'var(--amb)';
  } else if (resp && resp.reason === 'invalid_format') {
    status.textContent = 'Invalid channel ID format.';
    status.style.color = 'var(--red)';
  } else if (resp && resp.reason === 'fetch_failed') {
<<<<<<< HEAD
    status.textContent = 'Channel not found' + (resp.detail ? ' (' + resp.detail + ')' : '') + '.';
    status.style.color = 'var(--red)';
  } else if (resp && resp.reason === 'fetch_error') {
    status.textContent = 'Network error' + (resp.detail ? ': ' + resp.detail : '') + '.';
=======
    status.textContent = 'Channel not found — check the ID and try again.';
>>>>>>> 04b6454885ce733a11d6222a7ac4034aa6c17963
    status.style.color = 'var(--red)';
  } else {
    status.textContent = 'Could not verify channel — try again.';
    status.style.color = 'var(--red)';
  }
}

async function confirmManualBlock(){
  if (!manualResolved) return;
  await chrome.runtime.sendMessage({
    type: 'BLOCK_CHANNEL',
    channelId: manualResolved.channelId,
    channelName: manualResolved.name,
    channelHandle: manualResolved.handle
  });
  toast('Channel blocked', 'red');

  // Reset the manual block UI
  document.getElementById('manual-cid').value = '';
  document.getElementById('manual-status').textContent = '';
  document.getElementById('manual-preview').style.display = 'none';
  manualResolved = null;
}

async function renderBlocked(){
  var data=await chrome.storage.local.get(['blockedChannels','nuclearMode','nuclearUntil']);
  var blocked=data.blockedChannels||{};
  var ids=Object.keys(blocked);
  var nuclear=!!(data.nuclearMode&&data.nuclearUntil&&Date.now()<data.nuclearUntil);
  document.getElementById('blk-count').textContent=ids.length;
  document.getElementById('main-footer').style.display=(nuclear&&ids.length>0)?'':'none';
  var list=document.getElementById('blk-list');
  if(!ids.length){list.innerHTML='<div class="empty"><div class="empty-icon">🔓</div>No channels blocked yet.<br>Visit a YouTube channel or video<br>and tap + Block.</div>';return;}
  list.innerHTML='';
  ids.forEach(function(id,i){
    var ch=blocked[id];
    var item=document.createElement('div');item.className='item';item.style.animationDelay=(i*0.03)+'s';
    var btn=nuclear?'<button class="btn btn-ghost" disabled style="font-size:10px;padding:5px 10px;opacity:.4;">Locked</button>'
      :'<button class="btn btn-ghost" data-id="'+esc(id)+'" style="font-size:10px;padding:5px 10px;">Remove</button>';
    item.innerHTML='<div class="i-icon i-red">🚫</div><div class="i-info"><div class="i-name">'+esc(ch.name)+'</div><div class="i-sub" style="font-family:monospace;font-size:9px;">'+esc(id)+'</div>'+(nuclear?'<div class="meta-amb">☢️ Nuclear locked</div>':'')+'</div>'+btn;
    if(!nuclear) item.querySelector('button').addEventListener('click',function(e){unblock(e.target.dataset.id);});
    list.appendChild(item);
  });
}

async function unblock(cid){
  var r=await chrome.runtime.sendMessage({type:'UNBLOCK_CHANNEL',channelId:cid});
  if(r&&r.success) toast('Channel removed','green');
  else toast('☢️ Nuclear active — cannot unlock','amb');
}

async function checkNuclear(){
  var data=await chrome.storage.local.get(['nuclearMode','nuclearUntil']);
  var active=!!(data.nuclearMode&&data.nuclearUntil&&Date.now()<data.nuclearUntil);
  document.getElementById('nuc-badge').style.display=active?'':'none';
  document.getElementById('nuc-active').style.display=active?'':'none';
  document.getElementById('nuc-setup').style.display=active?'none':'';
  if(active) countdown(data.nuclearUntil);
}
function countdown(until){
  var el=document.getElementById('nuc-cd');
  function tick(){
    var diff=until-Date.now();
    if(diff<=0){el.textContent='EXPIRED';checkNuclear();return;}
    var d=Math.floor(diff/86400000),h=Math.floor((diff%86400000)/3600000),m=Math.floor((diff%3600000)/60000),s=Math.floor((diff%60000)/1000);
    el.textContent=(d>0?d+'d ':'')+pad(h)+':'+pad(m)+':'+pad(s);
    setTimeout(tick,1000);
  }
  tick();
}
async function activateNuclear(){
  var d=parseInt(document.getElementById('dur-d').value)||0;
  var h=parseInt(document.getElementById('dur-h').value)||0;
  var m=parseInt(document.getElementById('dur-m').value)||0;
  var ms=(d*86400000)+(h*3600000)+(m*60000);
  if(ms<=0){toast('Set a duration first','amb');return;}
  await chrome.storage.local.set({nuclearMode:true,nuclearUntil:Date.now()+ms});
  toast('☢️ Nuclear active','amb');
}

async function renderStreak(){
  var r=await chrome.runtime.sendMessage({type:'GET_STREAK'});
  var s=(r&&r.streak)||{currentStreak:0,longestStreak:0,lastFocusDay:null,history:[]};
  document.getElementById('s-num').textContent=s.currentStreak;
  document.getElementById('s-best').textContent=s.longestStreak;
  var mfb=document.getElementById('btn-focus');
  if(s.lastFocusDay===todayKey()){mfb.textContent='✓ Focus day recorded today';mfb.disabled=true;}
  else{mfb.textContent='✓ Mark Today as Focus Day';mfb.disabled=false;}

  var cal=document.getElementById('cal');cal.innerHTML='';
  var ld=await chrome.storage.local.get('addictionLog');
  var fSet={};(s.history||[]).forEach(function(h){fSet[h.date]=true;});
  var days=[];for(var i=27;i>=0;i--) days.push(new Date(Date.now()-i*86400000));
  var lr=document.createElement('div');lr.className='cal-grid';
  ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(function(l){var d=document.createElement('div');d.className='cal-lbl';d.textContent=l;lr.appendChild(d);});
  cal.appendChild(lr);
  var g=document.createElement('div');g.className='cal-grid';
  days.forEach(function(d){
    var ds=d.toDateString(),cell=document.createElement('div');cell.className='cal-day';
    if(fSet[ds]) cell.classList.add('focus');
    if(ds===todayKey()) cell.classList.add('today');
    cell.title=ds;g.appendChild(cell);
  });
  cal.appendChild(g);
  var leg=document.createElement('div');leg.className='cal-legend';
  leg.innerHTML='<div class="leg-item"><div class="leg-dot" style="background:#FFCDD2;border:1px solid #EF9A9A;"></div>Focus day</div><div class="leg-item"><div class="leg-dot" style="border:2px solid var(--red);"></div>Today</div>';
  cal.appendChild(leg);

  var hist=document.getElementById('s-hist');hist.innerHTML='';
  var rec=(s.history||[]).slice().reverse().slice(0,10);
  if(!rec.length){hist.innerHTML='<div class="empty"><div class="empty-icon">📅</div>No focus days yet.</div>';return;}
  rec.forEach(function(h,i){
    var row=document.createElement('div');row.className='item';row.style.animationDelay=(i*0.04)+'s';
    row.innerHTML='<div class="i-icon" style="background:var(--red-l);">🔥</div><div class="i-info"><div class="i-name">'+esc(h.date)+'</div><div class="i-sub">Streak: '+h.streak+' day'+(h.streak!==1?'s':'')+'</div></div><span class="badge badge-red">#'+h.streak+'</span>';
    hist.appendChild(row);
  });
}
async function markFocus(){
  var r=await chrome.runtime.sendMessage({type:'MARK_FOCUS_DAY'});
  if(r&&r.streak){toast('🔥 '+r.streak.currentStreak+' day streak!','green');renderStreak();}
}

async function renderStats(){
  var data=await chrome.storage.local.get(['blockedChannels','addictionLog','focusStreak']);
  document.getElementById('st-blk').textContent=Object.keys(data.blockedChannels||{}).length;
  document.getElementById('st-att').textContent=(data.addictionLog||[]).length;
  document.getElementById('st-str').textContent=(data.focusStreak||{}).currentStreak||0;
  document.getElementById('st-days').textContent=((data.focusStreak||{}).history||[]).length;
  var log=document.getElementById('att-log');
  var list=(data.addictionLog||[]).slice().reverse().slice(0,10);
  if(!list.length){log.innerHTML='<div class="empty"><div class="empty-icon">✅</div>No blocked attempts yet!</div>';return;}
  log.innerHTML=list.map(function(e,i){
    var d=new Date(e.at);
    return '<div class="item" style="margin-bottom:6px;animation-delay:'+(i*0.03)+'s;"><div class="i-icon i-gray">⚠️</div><div class="i-info"><div class="i-name">'+esc(e.channelName)+'</div><div class="i-sub">'+d.toLocaleDateString()+' · '+d.toLocaleTimeString()+'</div></div></div>';
  }).join('');
}

function startQuiz(cid){
  pendingUnlock=cid;
  var sh=GK_QUESTIONS.slice().sort(function(){return Math.random()-.5;});
  quizQs=[];while(quizQs.length<200)[].push.apply(quizQs,sh);
  quizQs=quizQs.slice(0,200).map(function(q){
    var opts=q.o.slice(),correct=opts[q.a];opts.sort(function(){return Math.random()-.5;});
    return{q:q.q,o:opts,a:opts.indexOf(correct)};
  });
  quizIdx=0;quizFailed=false;
  document.getElementById('q-bar').style.background='var(--red)';
  switchView('quiz');renderQ();
}
function renderQ(){
  if(quizFailed||quizIdx>=200) return;
  document.getElementById('q-bar').style.width=((quizIdx/200)*100)+'%';
  document.getElementById('q-score').textContent=quizIdx+' / 200';
  var q=quizQs[quizIdx],L=['A','B','C','D'];
  document.getElementById('q-body').innerHTML='<div class="q-num">Question '+(quizIdx+1)+' of 200</div><div class="q-q">'+esc(q.q)+'</div><div class="q-opts">'+q.o.map(function(o,i){return'<button class="q-opt" data-idx="'+i+'"><span class="opt-key">'+L[i]+'</span>'+esc(o)+'</button>';}).join('')+'</div>';
  document.querySelectorAll('.q-opt').forEach(function(b){b.addEventListener('click',function(){handleA(parseInt(b.dataset.idx),q.a);});});
}
function handleA(sel,correct){
  document.querySelectorAll('.q-opt').forEach(function(b){b.disabled=true;var i=parseInt(b.dataset.idx);if(i===correct)b.classList.add('correct');else if(i===sel)b.classList.add('wrong');});
  if(sel!==correct){
    quizFailed=true;
    var f=document.createElement('div');f.className='q-fail';
    f.innerHTML='<div class="q-fail-title">Wrong Answer!</div><div class="q-fail-sub">Failed at Q'+(quizIdx+1)+'. 100% required. Restart from Q1.</div><button class="btn btn-outline" id="q-restart">↺ Restart</button>';
    document.getElementById('q-body').appendChild(f);
    document.getElementById('q-restart').addEventListener('click',function(){startQuiz(pendingUnlock);});
    return;
  }
  quizIdx++;
  if(quizIdx>=200) onPass(); else setTimeout(renderQ,350);
}
async function onPass(){
  document.getElementById('q-body').innerHTML='<div style="text-align:center;padding:44px 20px;"><div style="font-size:52px;margin-bottom:14px;">🏆</div><div style="font-size:22px;font-weight:800;color:var(--green);margin-bottom:6px;">Perfect Score!</div><div style="font-size:11px;color:var(--t3);">200/200 — unlocking…</div></div>';
  if(pendingUnlock){
    var r=await chrome.runtime.sendMessage({type:'UNBLOCK_CHANNEL',channelId:pendingUnlock});
    if(!r||!r.success) document.getElementById('q-body').innerHTML='<div style="text-align:center;padding:44px 20px;"><div style="font-size:48px;">☢️</div><div style="font-size:18px;font-weight:800;color:var(--amb);">Nuclear Active</div><div style="font-size:11px;color:var(--t3);">Wait for timer.</div></div>';
    else toast('Channel unlocked','green');
  }
  setTimeout(function(){switchView('main');},2200);
}
function switchView(n){
  document.getElementById('view-main').classList.toggle('active',n==='main');
  document.getElementById('view-quiz').classList.toggle('active',n==='quiz');
}
