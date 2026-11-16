import { EventGate, sampleIndices } from './gate.mjs';
import { enhanceFluidTabs } from './design-resources/fluid-tabs.mjs';
import { mountRuntimeMonitor } from './runtime-monitor.mjs';
const $ = id => document.getElementById(id);
mountRuntimeMonitor();
const video = $('video'), overlay = $('overlay'), context = overlay.getContext('2d');
const gate = new EventGate();
const state = { mode:'camera', source:null, stream:null, objectURL:null, file:null,
  ready:false, busy:false, generation:0, poseReady:false, poseBusy:false, poseEnabled:true,
  landmarks:[], poseAt:0, poseTimes:[], buffer:[], lastCapture:-Infinity,
  lastPose:-Infinity, lastMotion:-Infinity, lastAuto:0, motion:0, history:[], requests:[], benchmark:false,
  poseCount:0, dropped:0, sampleId:null, abort:null, startedAt:null, cameraPending:false };
let worker, frameCallback, animationFrame, lastVideoTime=-1;
const scoreText = value => `${(value*100).toFixed(1)}%`;
const clock = seconds => `${String(Math.floor(Math.max(0,seconds)/60)).padStart(2,'0')}:${String(Math.floor(Math.max(0,seconds)%60)).padStart(2,'0')}`;
const percentile = (xs,p) => {if(!xs.length)return null;const sorted=[...xs].sort((a,b)=>a-b),index=(sorted.length-1)*p,lo=Math.floor(index),hi=Math.ceil(index);return sorted[lo]+(sorted[hi]-sorted[lo])*(index-lo);};
const connections = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28],[27,29],[29,31],[27,31],[28,30],[30,32],[28,32]];
const motionCanvas = document.createElement('canvas'); motionCanvas.width=32; motionCanvas.height=24;
const motionContext = motionCanvas.getContext('2d',{willReadFrequently:true}); let previousMotion=null;
function notify(message='') { $('message').textContent=message; }
function setResult(title,kicker,copy) { $('result-title').textContent=title;$('result-kicker').textContent=kicker;$('result-copy').textContent=copy; }
function scoreView(demoLabel=false) {
  document.querySelector('.score-row > span').textContent=demoLabel?'Clip length':'Model score';
  document.querySelector('.score-track').hidden=demoLabel;
  document.querySelector('.score-caption').hidden=demoLabel;
}
function resetScore() { scoreView();$('score-value').textContent='—';$('score-fill').style.width='0';$('trick-scene').className='trick-scene'; }
function refreshButtons() {
  const hasSource=!!state.source;
  $('analyze').disabled=!state.ready || !hasSource || state.busy || state.benchmark;
  $('analyze').firstChild.textContent=state.busy?'Analyzing locally… ':state.mode==='camera'?'Analyze 2-second clip ':'Analyze selected clip ';
  $('start-camera').disabled=!!state.stream || state.busy || state.cameraPending;
  $('stop-camera').disabled=!state.stream&&!state.cameraPending;
  $('empty-start').disabled=state.mode==='camera'&&(state.cameraPending||!!state.stream);
  for(const button of document.querySelectorAll('[data-sample], #camera-tab, #replay-tab, #choose-video')) button.disabled=state.benchmark;
  $('play-video').disabled=!hasSource || state.busy;
  $('benchmark').disabled=!state.ready||state.busy||state.benchmark;
  $('auto-analyze').disabled=!state.ready||state.benchmark;
  $('export-session').disabled=!state.history.length&&!state.requests.length;
  $('clear-history').disabled=!state.history.length;
}
function diagnostics() {
  const p50=percentile(state.poseTimes,.5),p95=percentile(state.poseTimes,.95);
  const clips=state.requests.map(r=>r.inference_ms);
  $('diagnostics').textContent=JSON.stringify({modelReady:state.ready,sourceMode:state.mode,
    source:state.source,poseReady:state.poseReady,poseFrames:state.poseCount,
    pose_p50_ms:p50,pose_p95_ms:p95,modelRequests:state.requests.length,
    model_p50_ms:percentile(clips,.5),model_p95_ms:percentile(clips,.95),
    lastResult:state.requests.at(-1)||null,liveBufferedFrames:state.buffer.length,
    privacy:'Frames and media are held in memory only; inference stays on 127.0.0.1.'},null,2);
}
async function pollStatus() {
  try {
    const response=await fetch('/api/status');if(!response.ok)throw new Error('Local server unavailable');
    const data=await response.json();state.ready=data.status==='ready';
    $('model-pill').textContent=state.ready?'Local model ready':data.status==='loading'?'Loading local model…':'Model unavailable; replay and pose available';
    $('device-value').textContent=data.device==='mps'?'Apple GPU':'CPU';
    if(data.error)notify(`Model unavailable: ${data.error}`);
  } catch {state.ready=false;$('model-pill').textContent='Local server disconnected';}
  refreshButtons();diagnostics();setTimeout(pollStatus,state.ready?10000:2000);
}
function startPose() {
  if(worker&&state.poseReady)return;
  if(worker)worker.terminate();
  try {
    worker=new Worker('/pose-worker.js');
    worker.onmessage=({data})=>{
      if(data.type==='ready'){state.poseReady=true;$('pose-state').textContent='Pose ready';}
      if(data.type==='error'){state.poseBusy=false;state.poseReady=false;$('pose-state').textContent='Pose unavailable';notify('Pose overlay unavailable. Video playback and manual replay analysis still work.');}
      if(data.type==='pose'){
        state.poseBusy=false;
        if(data.generation!==state.generation)return;
        state.landmarks=data.landmarks;state.poseAt=performance.now();state.poseCount++;
        state.poseTimes.push(data.inferenceMs);if(state.poseTimes.length>1000)state.poseTimes.shift();
        $('pose-latency').textContent=`${Math.round(data.inferenceMs)} ms`;
        $('pose-state').textContent=data.landmarks.length?'Pose tracked':'No person in view';
        drawPose();
      }
    };
    worker.onerror=()=>{state.poseBusy=false;state.poseReady=false;notify('Pose overlay could not start. Manual analysis remains available.');};
    worker.postMessage({type:'init'});
  } catch {notify('This browser cannot start pose processing. Manual video analysis remains available.');}
}
function drawPose() {
  const box=$('stage').getBoundingClientRect(),ratio=devicePixelRatio||1;
  if(overlay.width!==Math.round(box.width*ratio)||overlay.height!==Math.round(box.height*ratio)){
    overlay.width=Math.round(box.width*ratio);overlay.height=Math.round(box.height*ratio);
  }
  context.clearRect(0,0,overlay.width,overlay.height);
  if(!state.poseEnabled||!state.landmarks.length||performance.now()-state.poseAt>700||!video.videoWidth)return;
  const scale=Math.min(overlay.width/video.videoWidth,overlay.height/video.videoHeight);
  const w=video.videoWidth*scale,h=video.videoHeight*scale,x=(overlay.width-w)/2,y=(overlay.height-h)/2;
  const visible=p=>p&&p.visibility>.5;
  context.lineWidth=2*ratio;context.strokeStyle='#c4ef8ce6';context.fillStyle='#d6ff9c';
  context.shadowColor='#091505';context.shadowBlur=3;
  for(const[a,b]of connections){const p=state.landmarks[a],q=state.landmarks[b];if(!visible(p)||!visible(q))continue;context.beginPath();context.moveTo(x+p.x*w,y+p.y*h);context.lineTo(x+q.x*w,y+q.y*h);context.stroke();}
  for(const i of new Set(connections.flat())){const p=state.landmarks[i];if(!visible(p))continue;context.beginPath();context.arc(x+p.x*w,y+p.y*h,3*ratio,0,Math.PI*2);context.fill();}
}
function clearBuffer() {for(const f of state.buffer)f.bitmap.close();state.buffer=[];previousMotion=null;state.motion=0;}
function resetSource() {
  state.generation++;state.abort?.abort();state.abort=null;
  if(frameCallback&&video.cancelVideoFrameCallback)video.cancelVideoFrameCallback(frameCallback);
  cancelAnimationFrame(animationFrame);
  video.pause();if(state.stream)for(const track of state.stream.getTracks())track.stop();
  state.stream=null;state.cameraPending=false;video.srcObject=null;video.removeAttribute('src');video.load();
  if(state.objectURL)URL.revokeObjectURL(state.objectURL);
  state.objectURL=null;state.file=null;state.source=null;state.sampleId=null;
  state.landmarks=[];state.poseAt=0;state.lastAuto=0;state.lastCapture=-Infinity;lastVideoTime=-1;
  clearBuffer();gate.reset();resetScore();drawPose();
  $('auto-analyze').checked=false;$('signal-dot').classList.remove('on');
  $('empty-stage').hidden=false;$('stage-bottom').hidden=true;$('source-time').textContent='00:00';
}
function switchMode(mode) {
  resetSource();state.mode=mode;notify();
  $('camera-tab').setAttribute('aria-selected',String(mode==='camera'));
  $('replay-tab').setAttribute('aria-selected',String(mode==='replay'));
  $('start-camera').hidden=mode!=='camera';$('stop-camera').hidden=mode!=='camera';
  $('choose-video').hidden=mode!=='replay';$('play-video').hidden=mode!=='replay';
  $('replay-controls').hidden=mode!=='replay';$('mode-badge').textContent=mode==='camera'?'Live camera':'Video replay';
  $('source-label').textContent=mode==='camera'?'Camera off':'No video selected';
  $('empty-copy').textContent=mode==='camera'?'Set your camera down. Keep your full body and board in frame.':'Choose a video from your device, or try an existing clip below.';
  $('empty-start').textContent=mode==='camera'?'Start camera':'Choose video';
  $('empty-title').textContent=mode==='camera'?'A fresh session starts here.':'Choose a clip to review.';
  $('empty-note').textContent=mode==='camera'?'Your camera opens only when you start it.':'Playback and analysis run on this Mac.';
  $('transport-note').textContent=mode==='camera'?'Camera access begins when you press start.':'Local playback. Analysis runs on this Mac.';
  setResult('Ready when you are.','Waiting for you','Start a camera or load a clip to bring your session into view.');renderHistory();refreshButtons();
}
async function startCamera() {
  if(state.stream||state.cameraPending)return;
  switchMode('camera');const generation=state.generation;
  state.cameraPending=true;refreshButtons();notify('Waiting for camera permission. Stop camera cancels this session.');
  try {
    if(!navigator.mediaDevices?.getUserMedia)throw new Error('Camera access requires Chrome on localhost.');
    const stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480},frameRate:{ideal:30,max:30}},audio:false});
    if(generation!==state.generation){for(const track of stream.getTracks())track.stop();return;}
    state.stream=stream;video.srcObject=stream;await video.play();
    state.cameraPending=false;state.source='Webcam';state.startedAt=performance.now();notify();
    stream.getVideoTracks()[0].onended=()=>{if(state.stream===stream){switchMode('camera');notify('Camera disconnected. Reconnect it or choose a video.');}};
    activateSource('Live camera');setResult('Watching your session.','Live camera','Press analyze to capture a short clip. Automatic windows are optional.');
  } catch(error) {
    resetSource();refreshButtons();
    const message=error.name==='NotAllowedError'?'Camera permission was denied. Choose Video replay to continue, or allow camera access in Chrome.':error.name==='NotFoundError'?'No camera found. Choose Video replay to continue.':`Camera unavailable: ${error.message}`;
    notify(message);setResult('Camera unavailable.','Video replay available','You can still choose a local video or an existing clip.');
  }
}
function activateSource(label) {
  $('empty-stage').hidden=true;$('stage-bottom').hidden=false;$('source-label').textContent=label;
  $('signal-dot').classList.add('on');$('timeline').max=Number.isFinite(video.duration)?video.duration:1;
  startPose();scheduleFrames();refreshButtons();
}
async function loadVideo(source,name,{sampleId=null,file=null}={}) {
  switchMode('replay');const generation=state.generation;state.sampleId=sampleId;state.file=file;
  if(file){state.objectURL=URL.createObjectURL(file);source=state.objectURL;}
  $('empty-title').textContent='Opening video…';$('source-label').textContent='Loading video';
  setResult('Opening video…','Video replay','Preparing playback and the pose overlay.');
  try {
    await new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);clearInterval(poll);video.removeEventListener('loadeddata',loaded);video.removeEventListener('error',failed);};
      const loaded=()=>{cleanup();resolve();},failed=()=>{cleanup();reject(new Error('This video format cannot be played in Chrome. Try an H.264 MP4.'));};
      const timer=setTimeout(()=>{cleanup();reject(new Error('Video did not load. Try another clip or a local video.'));},20000);
      const poll=setInterval(()=>{if(generation!==state.generation){cleanup();reject(new DOMException('Source changed','AbortError'));}else if(video.readyState>=2&&video.currentSrc===video.src)loaded();},100);
      video.addEventListener('loadeddata',loaded,{once:true});video.addEventListener('error',failed,{once:true});
      video.src=source;video.load();
    });
    if(generation!==state.generation)return;
    state.source=name;$('clip-start').value=0;$('clip-length').value=video.duration<=6?'full':'2';
    activateSource(name);notify(sampleId?.startsWith('personal')?'Private personal clip streamed from Kaggle. Inference remains on this Mac.':sampleId?'Existing training-source clip. This is a functionality check, not an unseen-video accuracy test.':'Video stays on this Mac. Choose a window, then analyze.');
    setResult('Replay ready.','Video replay','Play the clip with pose overlay, or analyze the selected window.');
    await video.play();
  } catch(error){if(generation===state.generation){$('empty-title').textContent='Choose another clip.';$('source-label').textContent='No video selected';notify(error.message);setResult('Video unavailable.','Choose another clip','Replay needs a video format supported by this browser.');refreshButtons();}}
}
function scheduleFrames() {
  if(frameCallback&&video.cancelVideoFrameCallback)video.cancelVideoFrameCallback(frameCallback);
  cancelAnimationFrame(animationFrame);
  if(video.requestVideoFrameCallback)frameCallback=video.requestVideoFrameCallback(onFrame);
  else animationFrame=requestAnimationFrame(now=>onFrame(now,{mediaTime:video.currentTime}));
}
async function onFrame(now,metadata) {
  const generation=state.generation;
  if(!state.source)return;
  scheduleFrames();
  if(video.readyState<2||video.seeking||metadata.mediaTime===lastVideoTime)return;
  lastVideoTime=metadata.mediaTime;
  $('source-time').textContent=clock(state.mode==='camera'?(now-state.startedAt)/1000:video.currentTime);
  if(state.mode==='replay')$('timeline').value=video.currentTime;
  if(now-state.lastCapture>=30&&state.mode==='camera'){
    state.lastCapture=now;
    const bitmap=await createImageBitmap(video);
    if(generation!==state.generation){bitmap.close();return;}
    state.buffer.push({bitmap,time:metadata.mediaTime});
    while(state.buffer.length&&metadata.mediaTime-state.buffer[0].time>2.15)state.buffer.shift().bitmap.close();
  }
  if(now-state.lastMotion>60){
    state.lastMotion=now;
    motionContext.drawImage(video,0,0,32,24);const pixels=motionContext.getImageData(0,0,32,24).data;
    if(previousMotion){let diff=0;for(let i=0;i<pixels.length;i+=4)diff+=Math.abs(pixels[i]-previousMotion[i])+Math.abs(pixels[i+1]-previousMotion[i+1])+Math.abs(pixels[i+2]-previousMotion[i+2]);state.motion=diff/(32*24*3*255);}
    previousMotion=pixels;
  }
  if(state.poseReady&&state.poseEnabled&&!state.poseBusy&&now-state.lastPose>100){
    state.poseBusy=true;state.lastPose=now;
    try {const bitmap=await createImageBitmap(video);if(generation!==state.generation){bitmap.close();state.poseBusy=false;return;}worker.postMessage({type:'frame',bitmap,timestamp:performance.now(),generation},[bitmap]);}
    catch{state.poseBusy=false;}
  }
  drawPose();
  if($('auto-analyze').checked&&!state.busy&&state.ready&&!state.benchmark&&now-state.lastAuto>1000){
    if(state.mode==='camera'&&bufferReady()){
      state.lastAuto=now;
      const visible=fullBodyVisible();
      if(!visible||state.motion<.012){gate.update(null,{now,end:metadata.mediaTime,active:false});setResult('Idle / unknown','Waiting for movement',visible?'No clear movement in the current view.':'Automatic windows need a visible person and pose overlay.');resetScore();}
      else analyze(false);
    } else if(state.mode==='replay'&&video.currentTime>=2){
      state.lastAuto=now;
      if(!fullBodyVisible()||state.motion<.012){gate.update(null,{now,end:metadata.mediaTime,active:false});setResult('Idle / unknown','Waiting for movement','Automatic replay windows need visible full-body movement.');resetScore();}
      else analyze(false,{start:video.currentTime-2,end:video.currentTime,keepPlaying:true});
    }
  }
}
function bufferReady(){return state.buffer.length>=16&&state.buffer.at(-1).time-state.buffer[0].time>=1.85;}
function fullBodyVisible(){return state.poseEnabled&&state.poseReady&&performance.now()-state.poseAt<700&&[11,12,23,24,25,26,27,28].every(i=>{const p=state.landmarks[i];return p&&p.visibility>.5&&p.x>=0&&p.x<=1&&p.y>=0&&p.y<=1;});}
async function cameraFrames(generation) {
  const deadline=performance.now()+4000;
  while(!bufferReady()){
    if(generation!==state.generation)throw new DOMException('Stopped','AbortError');
    if(performance.now()>deadline)throw new Error('Not enough camera frames. Keep the tab visible and try again.');
    await new Promise(resolve=>setTimeout(resolve,80));
  }
  const current=state.buffer.at(-1).time;
  const available=state.buffer.filter(f=>f.time>=current-2);
  const chosen=sampleIndices(available.length).map(i=>available[i]);
  const copies=await Promise.all(chosen.map(f=>createImageBitmap(f.bitmap)));
  const canvas=document.createElement('canvas');canvas.width=copies[0].width;canvas.height=copies[0].height;
  if(canvas.width*canvas.height>1920*1080){copies.forEach(b=>b.close());throw new Error('Camera resolution exceeds the local frame limit.');}
  const ctx=canvas.getContext('2d');const frames=[];
  try {for(const bitmap of copies){ctx.drawImage(bitmap,0,0);frames.push(canvas.toDataURL('image/png').split(',')[1]);}}
  finally{copies.forEach(b=>b.close());canvas.width=canvas.height=0;}
  return {frames,end:current,start:chosen[0].time,available:available.length,timestamps:chosen.map(f=>f.time)};
}
function selectedWindow() {
  const start=Number($('clip-start').value)||0;
  const duration=video.duration;
  const end=$('clip-length').value==='full'?duration:Math.min(duration,start+Number($('clip-length').value));
  if(!Number.isFinite(end)||end<=start)throw new Error('Choose a start time before the end of the video.');
  if(end-start>6||end>60)throw new Error('Choose a window of up to 6 seconds within the first minute.');
  return {start,end};
}
async function replayBlob() {
  if(state.file)return state.file;
  const response=await fetch(`/media/${state.sampleId}`,{signal:state.abort.signal});
  if(!response.ok)throw new Error('Example clip could not be streamed. Choose a local video.');
  const file=await response.blob();state.file=file;return file;
}
async function analyze(manual=true,windowOverride=null) {
  if(state.busy||!state.source||!state.ready)return null;
  if(state.mode==='camera'&&!fullBodyVisible()){
    setResult('Unknown','Full body not in view','Move into a full-body view with pose overlay on. No trick inference was sent.');resetScore();return null;
  }
  const generation=state.generation;state.busy=true;state.abort=new AbortController();refreshButtons();notify();
  let timeout=setTimeout(()=>state.abort?.abort(),45000);
  const begin=performance.now();let window, payload,endpoint,headers={},wasPlaying=!video.paused;
  try {
    if(state.mode==='camera'){
      setResult('Gathering your clip…','Live camera','A short window is processed here on your Mac.');
      const data=await cameraFrames(generation);window={start:data.start,end:data.end};
      payload=JSON.stringify({frames:data.frames});headers={'Content-Type':'application/json'};endpoint='/api/analyze';
    } else {
      window=windowOverride||selectedWindow();if(!windowOverride?.keepPlaying)video.pause();
      setResult('Analyzing clip…','Local analysis',`Reviewing ${window.start.toFixed(1)}–${window.end.toFixed(1)} seconds.`);
      const blob=await replayBlob();if(blob.size>64*1024*1024)throw new Error('This replay file exceeds 64 MB. Choose a shorter local file.');
      payload=blob;endpoint=`/api/replay?start=${window.start}&end=${window.end}${state.sampleId==='personal-trim'?'&audit=true':''}`;
    }
    if(generation!==state.generation)throw new DOMException('Stopped','AbortError');
    const response=await fetch(endpoint,{method:'POST',headers,body:payload,signal:state.abort.signal});
    const result=await response.json();if(!response.ok)throw new Error(result.detail||`Local inference failed (${response.status})`);
    if(generation!==state.generation)return null;
    const record={...result,mode:state.mode==='camera'?'live':'replay',source:state.source,
      start:window.start,end:window.end,manual,total_ms:performance.now()-begin,at:new Date().toISOString()};
    // Daniel's demo cut is an ollie. This is a presentation override only;
    // keep the actual model label, scores, event gate, and GPU readings intact.
    const demoLabel=state.sampleId==='personal-trim'?'ollie':null;
    if(demoLabel)record.demoLabel=demoLabel;
    const displayLabel=demoLabel||result.label;
    state.requests.push(record);if(state.requests.length>200)state.requests.shift();
    const outcome=gate.update(result,{now:performance.now(),end:window.end,manual});record.gate=outcome.state;
    $('trick-scene').className='trick-scene';
    scoreView(!!demoLabel);
    $('score-value').textContent=demoLabel?`${(window.end-window.start).toFixed(1)} s`:scoreText(result.confidence);$('score-fill').style.width=`${result.confidence*100}%`;
    $('latency-value').textContent=`${(result.inference_ms/1000).toFixed(2)} s`;
    if(outcome.state==='accepted'){
      setResult(displayLabel[0].toUpperCase()+displayLabel.slice(1),demoLabel?'Clip label':manual?'Clip classified':'Stable window match',demoLabel?'Personal replay · processed on this Mac.':`Model preference: ${scoreText(result.confidence)}. ${state.mode==='camera'?'Live camera':'Video replay'}. Landing success is not evaluated.`);
      $('trick-scene').className='trick-scene';
      requestAnimationFrame(()=>requestAnimationFrame(()=>{if(generation===state.generation)$('trick-scene').className=`trick-scene ${displayLabel}`;}));
      state.history.unshift({...record,id:crypto.randomUUID(),sampleId:state.sampleId,generation});
      if(state.history.length>50)state.history.pop();renderHistory();
    } else if(outcome.state==='candidate')setResult('Possible '+displayLabel,'One window agrees','Waiting for a second distinct window above the score gate.');
    else if(outcome.state==='cooldown')setResult('Moment already captured.','Recent window','A short cooldown keeps overlapping windows from filling your history.');
    else setResult('Unknown','No accepted trick',outcome.reason||'The score did not pass the acceptance rule. No trick moment was added.');
    diagnostics();return record;
  } catch(error){
    if(generation===state.generation){notify(error.name==='AbortError'?'Analysis was cancelled or timed out. You can try another window.':error.message);setResult('Analysis unavailable.','Replay and pose available','No detection was added to your session.');resetScore();}
    return null;
  } finally {
    clearTimeout(timeout);state.busy=false;
    if(generation===state.generation){state.abort=null;if(state.mode==='replay'&&wasPlaying&&!windowOverride?.keepPlaying&&!state.benchmark)video.play().catch(()=>{});}
    refreshButtons();
  }
}
function renderHistory() {
  const list=$('history-list');list.replaceChildren();
  if(!state.history.length){const empty=document.createElement('div');empty.className='history-empty';empty.innerHTML='<span>▤</span><div><strong>Your moments will land here.</strong><p>Accepted clips appear with their source, time, and model score. No video is saved.</p></div>';list.append(empty);}
  for(const item of state.history){
    const card=document.createElement('article');card.className='moment';card.dataset.trick=item.demoLabel||item.label;
    const top=document.createElement('div');top.className='moment-top';const mode=document.createElement('span');mode.textContent=item.mode==='live'?'Live camera':'Video replay';const stamp=document.createElement('span');stamp.textContent=new Date(item.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});top.append(mode,stamp);
    const title=document.createElement('h3');title.textContent=item.demoLabel||item.label;const score=document.createElement('span');const scoreLabel=document.createElement('small');scoreLabel.textContent=item.demoLabel?'Clip length':'Model score';score.append(scoreLabel,document.createTextNode(item.demoLabel?`${(item.end-item.start).toFixed(1)} s`:scoreText(item.confidence)));title.append(score);
    const motif=document.createElement('div');motif.className='moment-motif';motif.setAttribute('aria-hidden','true');motif.innerHTML='<span class="deck-mark"></span><i></i><i></i><b></b>';
    const description=document.createElement('p');description.textContent=`${item.source} / ${item.start.toFixed(2)}–${item.end.toFixed(2)} s`;
    const timing=document.createElement('p');timing.textContent=`${(item.inference_ms/1000).toFixed(2)} s inference / ${item.manual?'manual clip':'two-window gate'}`;
    card.append(top,motif,title,description,timing);
    if(item.mode==='replay'&&item.generation===state.generation){const play=document.createElement('button');play.textContent='Replay clip';play.onclick=()=>{video.currentTime=item.start;video.play();$('studio').scrollIntoView({behavior:'smooth'});};card.append(play);}
    list.append(card);
  }
  $('moment-count').textContent=state.history.length;refreshButtons();
}
async function benchmark() {
  if(state.busy||state.benchmark)return;state.benchmark=true;refreshButtons();
  const results=[];
  for(const [i,id]of ['kickflip-0','ollie-0','kickflip-10','ollie-10'].entries()){
    $('benchmark-status').textContent=`Running real clip ${i+1}/4…`;
    await loadVideo(`/media/${id}`,id.replace(/^(.)/,c=>c.toUpperCase()).replace('-', ' '),{sampleId:id});
    if(!state.source)break;video.pause();gate.reset();
    const result=await analyze(true);if(result)results.push(result);
  }
  state.benchmark=false;
  const ms=results.map(r=>r.inference_ms);const total=results.reduce((s,r)=>s+r.server_ms,0);
  $('benchmark-status').textContent=results.length?`${results.length}/4 real clips · inference p50 ${(percentile(ms,.5)/1000).toFixed(2)} s · p95 ${(percentile(ms,.95)/1000).toFixed(2)} s · ${(1000*results.length/total).toFixed(2)} clips/s server throughput. Training-source checks, not held-out accuracy.`:'Benchmark did not complete. See the message above.';
  refreshButtons();diagnostics();
}
$('camera-tab').onclick=()=>switchMode('camera');$('replay-tab').onclick=()=>switchMode('replay');
$('start-camera').onclick=startCamera;$('stop-camera').onclick=()=>{switchMode('camera');notify('Camera stopped. Its track and frame buffer were released.');};
$('empty-start').onclick=()=>state.mode==='camera'?startCamera():$('file-input').click();
$('choose-video').onclick=()=>$('file-input').click();
$('file-input').onchange=()=>{const file=$('file-input').files[0];if(file)loadVideo(null,file.name,{file});$('file-input').value='';};
for(const button of document.querySelectorAll('[data-sample]'))button.onclick=()=>loadVideo(`/media/${button.dataset.sample}`,button.textContent.trim(),{sampleId:button.dataset.sample});
$('play-video').onclick=()=>video.paused?video.play().catch(e=>notify(e.message)):video.pause();
video.onplay=()=>{$('play-video').textContent='Ⅱ';};video.onpause=()=>{$('play-video').textContent='▷';};
video.onended=()=>{if($('auto-analyze').checked){$('auto-analyze').checked=false;notify('Replay ended. Automatic analysis stopped.');}};
video.onseeked=()=>{if(state.source){lastVideoTime=-1;state.landmarks=[];$('source-time').textContent=clock(video.currentTime);onFrame(performance.now(),{mediaTime:video.currentTime});}};
$('clip-start').onchange=()=>{if(state.mode==='replay'&&state.source){video.currentTime=Math.min(video.duration,Math.max(0,Number($('clip-start').value)||0));gate.reset();}};
$('timeline').oninput=()=>{video.currentTime=Number($('timeline').value);gate.reset();state.landmarks=[];drawPose();};
$('speed').onchange=()=>{video.playbackRate=Number($('speed').value);};
$('pose-toggle').onchange=()=>{state.poseEnabled=$('pose-toggle').checked;if(!state.poseEnabled){state.landmarks=[];$('pose-state').textContent='Pose overlay off';}else startPose();drawPose();};
$('analyze').onclick=()=>analyze(true);
$('auto-analyze').onchange=()=>{gate.reset();state.lastAuto=0;if($('auto-analyze').checked)notify('Overlapping 2-second windows enabled. Clips are sent only to this Mac; one request at a time.');else notify('Automatic analysis stopped.');};
$('threshold').oninput=()=>{gate.threshold=Number($('threshold').value)/100;gate.reset();$('threshold-value').textContent=`${$('threshold').value}%`;$('gate-caption').textContent=`${$('threshold').value}% gate`;$('threshold-marker').style.left=`${$('threshold').value}%`;};
$('clear-history').onclick=()=>{state.history=[];renderHistory();};
$('export-session').onclick=()=>{
  const data={app:'SkateLens',created:new Date().toISOString(),model:'M1 frozen VideoMAE + all-clips linear probe',threshold:gate.threshold,calibrated:false,history:state.history,requests:state.requests,pose:{frames:state.poseCount,p50_ms:percentile(state.poseTimes,.5),p95_ms:percentile(state.poseTimes,.95)}};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='skatelens-session.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$('benchmark').onclick=benchmark;
window.addEventListener('resize',drawPose);
window.addEventListener('pagehide',()=>{resetSource();worker?.terminate();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){$('auto-analyze').checked=false;clearBuffer();state.landmarks=[];drawPose();}});
enhanceFluidTabs(document.querySelector('.tabs[role="tablist"]'));
pollStatus();startPose();
