// Natural-language ATC speech matching. Browser speech recognition supplies the
// transcript; this layer accepts varied wording instead of requiring the menu label.
const STOP = new Set(['the','a','an','to','for','of','my','me','please','i','we','would','like','is','and','it','at','in','on','uh','um','could','can','may','tower','ground','approach','control']);

function normalise(s) {
  return String(s || '').toLowerCase()
    .replace(/numbers?/g, 'number').replace(/feet|foot/g, 'ft')
    .replace(/take off/g, 'takeoff').replace(/line up/g, 'lineup')
    .replace(/push back/g, 'pushback').replace(/frequency/g, 'freq')
    .replace(/[^a-z0-9. ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function words(s) {
  return normalise(s).split(' ').filter(w => w.length > 1 && !STOP.has(w));
}
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({length:b.length + 1}, (_,i)=>i);
  for (let i=1;i<=a.length;i++) {
    const row=[i];
    for (let j=1;j<=b.length;j++) row[j]=Math.min(row[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));
    prev=row;
  }
  return prev[b.length];
}
const INTENTS = [
  {keys:['pushback','tug','stand'], phrases:['request pushback','pushback approved','need pushback','request a tug','push me back','push us back','pushback from the gate','ready for pushback','start pushback','need to leave the stand','request push back clearance','ground request pushback']},
  {keys:['takeoff','departure','depart','ready'], phrases:['ready for departure','ready for takeoff','request takeoff clearance','request departure clearance','can we depart','ready to roll','ready to go','request permission to take off','cleared to depart','departing runway','holding short and ready','ready at the runway']},
  {keys:['landing','land','approach'], phrases:['request landing','request to land','request approach','bring us in to land','need landing clearance','inbound to land','request straight in approach','request an approach','cleared to land','looking for landing clearance','want to land','on final']},
  {keys:['vector','heading','direction'], phrases:['request vectors','need vectors','which way should I go','request a heading','give me a heading','vectors to destination','request navigation assistance','where should I turn','need directions','request radar vectors']},
  {keys:['altitude','climb','descend','higher','lower'], phrases:['request altitude change','request climb','request descent','climb higher','descend lower','need to climb','need to descend','request a new altitude','change my altitude','maintain a different altitude','request flight level change']},
  {keys:['weather','altimeter','pressure','conditions'], phrases:['request weather','request altimeter','what is the weather','current conditions','give me the pressure','request airport weather','need the altimeter setting','weather information','wind and pressure','request atis']},
  {keys:['emergency','mayday','pan'], phrases:['declare an emergency','mayday mayday','pan pan','we have an emergency','request emergency assistance','priority landing','need immediate assistance','aircraft emergency']},
  {keys:['cancel','never','mind'], phrases:['cancel emergency','cancel that','never mind','disregard my request','ignore that request','no further assistance','cancel request']},
  {keys:['wilco','affirm','roger','acknowledge'], phrases:['wilco','roger','affirmative','we will comply','understood and will comply','message received','copy that','acknowledged']},
  {keys:['unable','low'], phrases:['unable to comply','unable','negative','cannot comply','unable at this time','request to remain low','staying at this altitude']},
  {keys:['sight','visual','runway'], phrases:['field in sight','runway in sight','airport in sight','have the field visual','visual with the runway','traffic in sight']},
  {keys:['frequency','freq','switch','tune'], phrases:['switch frequency','change frequency','request a frequency change','tune me to tower','contact another station','change to ground frequency','switch to approach','what frequency should I use','request tower frequency','change radio frequency']},
  {keys:['map','waypoint','destination'], phrases:['put it on my map','set my waypoint','mark that airport','make that my destination','add destination to map','navigate to that field','set direct to','show that airport on the map','add a waypoint','select destination']},
  {keys:['mind','close','cancel'], phrases:['close the radio menu','cancel this request','stand by','no request','that is all','nothing further','cancel my last request']}
];
// A 100-entry phrase bank is generated for each live menu option. The bank
// combines 10 natural lead-ins with 10 request forms, then semantic aliases.
const LEADS = ['tower','ground','approach','control','hello tower','good day','radio check','this is the aircraft','from the aircraft','request'];
const FORMS = ['please help us with','we would like','we need','can we get','could you give us','request','please arrange','we are looking for','may we have','please provide'];
function intentFor(label, plain) {
  const text = normalise(label + ' ' + (plain || ''));
  let best = null, score = 0;
  for (const intent of INTENTS) {
    const n = intent.keys.filter(k => text.includes(k)).length;
    if (n > score) { score=n; best=intent; }
  }
  return best;
}
function phraseBank(option) {
  const label = normalise(option.label || '');
  const plain = normalise(option.plain || '');
  const intent = intentFor(label, plain);
  const bank = new Set([label, plain]);
  if (intent) for (const p of intent.phrases) bank.add(normalise(p));
  const subject = label.replace(/^request /,'').replace(/^ready for /,'');
  for (const lead of LEADS) for (const form of FORMS) {
    bank.add(normalise(`${lead} ${form} ${subject}`));
  }
  // Include simple paraphrases around the option's descriptive text.
  if (plain) for (const form of FORMS) bank.add(normalise(`${form} ${plain}`));
  return Array.from(bank).slice(0,100);
}
export function pickOption(said, opts) {
  const heard = normalise(said);
  if (!heard) return -1;
  const hw = words(heard);
  let best=-1, bestScore=0;
  (opts || []).forEach((o,i) => {
    const label=normalise(o.label || ''), plain=normalise(o.plain || '');
    const candidates=phraseBank(o);
    let score=0;
    for (const p of candidates) {
      if (!p) continue;
      if (heard===p || heard.includes(p) || p.includes(heard)) { score=Math.max(score, 1.15); continue; }
      const pw=words(p);
      if (!pw.length || !hw.length) continue;
      const hits=pw.filter(w=>hw.includes(w)).length;
      const coverage=hits/pw.length, heardCoverage=hits/hw.length;
      score=Math.max(score, coverage*0.58 + heardCoverage*0.28 + (hits?0.08:0));
    }
    // Word-level fuzzy matching handles common speech-to-text mishearings.
    const lw=words(label+' '+plain);
    for (const w of hw) {
      let near=0;
      for (const q of lw) if (Math.min(w.length,q.length)>=4 && editDistance(w,q)<=1) near=Math.max(near,1);
      if (near) score+=0.025;
    }
    if (score>bestScore) {bestScore=score;best=i;}
  });
  return bestScore >= 0.34 ? best : -1;
}
export function initVoiceAtc({ button, getOpts, respond, say }) {
  if (!button) return null;
  const SR=window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { button.disabled=true; button.title='Speaking to ATC needs Chrome or Edge'; return null; }
  const rec=new SR();
  rec.lang='en-US'; rec.interimResults=true; rec.maxAlternatives=8; rec.continuous=false;
  // Chrome supports contextual phrase biasing in newer builds; safely ignore on older ones.
  let listening=false, finalTranscript='';
  const done=()=>{listening=false;button.classList.remove('live');};
  rec.onresult=e=>{
    let interim='';
    for(let i=e.resultIndex;i<e.results.length;i++){
      const result=e.results[i], alts=Array.from(result).map(a=>a.transcript);
      if(result.isFinal) finalTranscript += ' '+alts[0];
      else interim += ' '+alts[0];
      if(!result.isFinal) continue;
      const opts=getOpts()||[];
      let idx=-1, heard='';
      for(const t of alts){const pick=pickOption(t,opts);if(pick>=0){idx=pick;heard=t;break;}}
      if(idx<0){const pick=pickOption(finalTranscript,opts);if(pick>=0){idx=pick;heard=finalTranscript.trim();}}
      if(idx>=0){say('Heard: "'+(heard||finalTranscript.trim())+'"');respond(idx);}
      else say('Heard "'+(finalTranscript.trim()||interim.trim())+'" — try saying the request another way');
      finalTranscript='';
    }
  };
  rec.onend=done;
  rec.onerror=e=>{done();say('Microphone: '+(e.error||'error'));};
  button.addEventListener('click',e=>{
    e.stopPropagation();
    if(listening){rec.stop();return;}
    finalTranscript='';
    try{
      const opts=getOpts()||[];
      if('phrases' in rec) rec.phrases=opts.slice(0,20).map(o=>({phrase:o.label||'',boost:8}));
      rec.start();listening=true;button.classList.add('live');say('Listening — use natural wording...');
    }catch(err){say('Microphone not available');}
  });
  return rec;
}
