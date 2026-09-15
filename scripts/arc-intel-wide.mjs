// Wide Arc testnet scan: rank contracts by appearances in a large recent-tx window,
// then resolve the top ones to REAL lifetime tx count + name + verified + tags + token.
import fs from 'fs';
const API='https://testnet.arcscan.app/api/v2';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(path){for(let a=0;a<6;a++){try{const r=await fetch(`${API}${path}`,{headers:{accept:'application/json'}});if(r.status===429){await sleep(1200*(a+1));continue;}if(!r.ok)return null;return await r.json();}catch{await sleep(600);}}return null;}
const inc=(m,k)=>{if(k)m.set(k,(m.get(k)||0)+1);};
const toFreq=new Map(),toName=new Map();
let path='/transactions?filter=validated',pages=0;
const MAXP=60;
while(path&&pages<MAXP){
  const j=await get(path);if(!j||!j.items)break;
  for(const t of j.items){const h=(t.to?.hash||'').toLowerCase();inc(toFreq,h);if(t.to?.name)toName.set(h,t.to.name);}
  pages++;const np=j.next_page_params;
  path=np?'/transactions?filter=validated&'+new URLSearchParams(np).toString():null;
  await sleep(300);
}
console.error(`scanned ${pages} pages, ${toFreq.size} distinct contracts`);
const top=[...toFreq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,45);
const out=[];
for(const [h,freq] of top){
  const a=await get(`/addresses/${h}`);await sleep(250);
  if(!a) { out.push({addr:h,freq,name:toName.get(h)||null}); continue; }
  out.push({
    addr:h, freq,
    name:a.name||toName.get(h)||null,
    verified:!!a.is_verified,
    isContract:!!a.is_contract,
    txCount:a.transactions_count!=null?Number(a.transactions_count):(a.counters?.transactions_count?Number(a.counters.transactions_count):null),
    token:a.token?(a.token.symbol||a.token.name):null,
    tokenType:a.token?.type||null,
    tags:(a.public_tags||[]).map(t=>t.display_name||t.label).filter(Boolean),
  });
}
fs.writeFileSync('scripts/intel-wide.json',JSON.stringify(out,null,1));
console.error('wrote intel-wide.json');
// pretty print
for(const o of out) console.log(`${String(o.freq).padStart(4)} freq  tx=${String(o.txCount??'?').padStart(9)}  ${o.verified?'V':' '}${o.isContract?'C':' '}  ${o.addr}  ${o.name||'(unnamed)'}${o.token?' TOKEN:'+o.token:''}${o.tags?.length?' #'+o.tags.join(','):''}`);
