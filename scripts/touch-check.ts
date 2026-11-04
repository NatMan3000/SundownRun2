// ============================================================
//  TOUCH CHECK - the phone controls, through real touch events
// ------------------------------------------------------------
//  Opens a production preview in a phone-shaped headless Chrome
//  (on its side and stood up) and drives it with CDP touch points:
//  two thumbs at once, slides between buttons, a cancelled touch,
//  the top row, the menus' Back button, and handing over to a
//  keyboard and back. Screenshots land in --out.
//
//    bunx vite build && bunx vite preview --port 5220 --strictPort
//    bun run touch:check 5220
// ============================================================

import puppeteer from 'puppeteer-core'
import { findChrome } from './chrome'

const chrome = findChrome
const port=process.argv[2]??'5220'
const OUT=process.argv[3]??'/tmp/sr2/touch'
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
const UA='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const browser=await puppeteer.launch({executablePath:chrome(),headless:true,args:['--use-angle=metal','--enable-gpu','--ignore-gpu-blocklist','--enable-webgl','--autoplay-policy=no-user-gesture-required','--window-size=900,500']})
const out:string[]=[]
const log=(s:string)=>{out.push(s);console.log(s)}
let fails=0
const ok=(c:boolean,s:string)=>{log(`${c?'PASS':'FAIL'} ${s}`);if(!c)fails++}
async function open(w:number,h:number,q='track=afterglow&mode=free&nomusic=1&quality=low'){
  const page=await browser.newPage()
  page.on('pageerror',e=>log('PAGEERROR '+e.message))
  await page.setUserAgent(UA)
  await page.setViewport({width:w,height:h,deviceScaleFactor:2,isMobile:true,hasTouch:true})
  await page.goto(`http://localhost:${port}/?${q}`,{waitUntil:'load'})
  const cdp=await page.createCDPSession()
  return {page,cdp}
}
type P={x:number,y:number,id:number}
const touch=(cdp:any,type:string,pts:P[])=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:pts})
const inp=(page:any)=>page.evaluate(()=>{const g=(window as any).__game;const i=g.get('input');const t=g.telemetry;return {device:i.device,ctx:i.context,touch:i.touch,kmh:t.speedKmh,steer:t.steer,th:t.throttle,br:t.brake,hb:t.handbrake}})
const rect=(page:any,sel:string)=>page.evaluate((s:string)=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,l:r.left,t:r.top,r:r.right,b:r.bottom}},sel)

for(const [name,w,h] of [['landscape',844,390],['portrait',390,844]] as const){
  const {page,cdp}=await open(w,h)
  await sleep(9000)
  const before=await inp(page)
  log(`${name} boot ${JSON.stringify(before)}`)
  ok(before.device==='touch',`${name}: phone boots on touch`)
  await page.screenshot({path:`${OUT}/${name}-0-boot.png`})
  const started=await page.evaluate(()=>(window as any).__game.get('ui'))
  log(`${name} ui ${JSON.stringify({stack:started.stack,ctx:started.inputContext})}`)
  if(started.stack.length){ await page.evaluate(()=>(window as any).__dev.ui('hud')); await sleep(6000) }
  const shown=await page.evaluate(()=>!!document.querySelector('.touch'))
  ok(shown,`${name}: controls on screen while driving`)
  await page.screenshot({path:`${OUT}/${name}-1-drive.png`})
  const gas=await rect(page,'.touch-pedal--gas'),brk=await rect(page,'.touch-pedal--brake'),dr=await rect(page,'.touch-pedal--drift'),st=await rect(page,'.touch-stick')
  log(`${name} rects ${JSON.stringify({gas,brk,dr,st})}`)
  // gas + steer at once
  await touch(cdp,'touchStart',[{x:gas.x,y:gas.y,id:1}])
  await sleep(1500)
  await touch(cdp,'touchStart',[{x:gas.x,y:gas.y,id:1},{x:st.x,y:st.y,id:2}])
  await sleep(60)
  await touch(cdp,'touchMove',[{x:gas.x,y:gas.y,id:1},{x:st.x+60,y:st.y,id:2}])
  await sleep(700)
  let s=await inp(page); log(`${name} gas+right ${JSON.stringify(s)}`)
  ok(s.touch.gas&&s.th>0.8,`${name}: gas held, throttle ${s.th.toFixed(2)}`)
  ok(s.kmh>10,`${name}: car moves, ${s.kmh.toFixed(0)} km/h`)
  ok(s.touch.steer>0.9&&s.steer>0.3,`${name}: stick right steers right (raw ${s.touch.steer.toFixed(2)}, car ${s.steer.toFixed(2)})`)
  await page.screenshot({path:`${OUT}/${name}-2-held.png`})
  // follow: overshoot right then come back 15 px: steer should fall at once
  await touch(cdp,'touchMove',[{x:gas.x,y:gas.y,id:1},{x:st.x+95,y:st.y,id:2}])
  await sleep(30)
  await touch(cdp,'touchMove',[{x:gas.x,y:gas.y,id:1},{x:st.x+80,y:st.y,id:2}])
  await sleep(30)
  s=await inp(page); ok(s.touch.steer<0.8,`${name}: stick follows the thumb, 15 px back gives ${s.touch.steer.toFixed(2)}`)
  // slide gas -> drift keeps gas
  await touch(cdp,'touchMove',[{x:dr.x,y:dr.y,id:1},{x:st.x+80,y:st.y,id:2}])
  await sleep(200)
  s=await inp(page); log(`${name} slid to drift ${JSON.stringify(s.touch)}`)
  ok(s.touch.gas&&s.touch.handbrake&&s.hb===true,`${name}: slide Gas to Drift keeps gas and pulls handbrake`)
  // slide on to brake
  await touch(cdp,'touchMove',[{x:brk.x,y:brk.y,id:1},{x:st.x+80,y:st.y,id:2}])
  await sleep(200)
  s=await inp(page); ok(s.touch.brake&&!s.touch.gas&&!s.touch.handbrake,`${name}: slide to Brake lets go of gas and drift (${JSON.stringify(s.touch)})`)
  // release
  await touch(cdp,'touchEnd',[])
  await sleep(250)
  s=await inp(page); log(`${name} released ${JSON.stringify(s)}`)
  ok(!s.touch.gas&&!s.touch.brake&&!s.touch.handbrake&&s.touch.steer===0,`${name}: lifting both thumbs lets go of everything`)
  ok(s.th<0.1,`${name}: throttle falls (${s.th.toFixed(3)})`)
  // pointer cancel path
  await touch(cdp,'touchStart',[{x:gas.x,y:gas.y,id:3}]); await sleep(100)
  await touch(cdp,'touchCancel',[]); await sleep(100)
  s=await inp(page); ok(!s.touch.gas,`${name}: a cancelled touch lets go of the gas`)
  // camera button
  const cam0=await page.evaluate(()=>(window as any).__game.settings?.camera)
  const tops=await page.evaluate(()=>[...document.querySelectorAll('.touch-top')].map(b=>{const r=b.getBoundingClientRect();return {l:b.getAttribute('aria-label'),x:r.left+r.width/2,y:r.top+r.height/2}}))
  log(`${name} top ${JSON.stringify(tops.map((t:any)=>t.l))}`)
  const tap=async(x:number,y:number)=>{await touch(cdp,'touchStart',[{x,y,id:9}]);await sleep(50);await touch(cdp,'touchEnd',[]);await sleep(150)}
  const btn=(l:string)=>tops.find((t:any)=>t.l===l)
  // rewind hold
  await touch(cdp,'touchStart',[{...btn('Rewind'),id:5}]); await sleep(120)
  s=await inp(page); ok(s.touch.rewind===true,`${name}: Rewind is held`)
  await touch(cdp,'touchEnd',[]); await sleep(120)
  s=await inp(page); ok(s.touch.rewind===false,`${name}: Rewind lets go`)
  const sig0=await page.evaluate(()=>(window as any).__game.telemetry.speedKmh)
  // pause by tapping Menu
  await tap(btn('Menu').x,btn('Menu').y)
  await sleep(500)
  let ph=await page.evaluate(()=>(window as any).__game.get('ui'))
  log(`${name} after Menu ${JSON.stringify({stack:ph.stack,ctx:ph.inputContext})}`)
  ok(ph.stack.includes('pause'),`${name}: Menu opens the pause menu`)
  ok(!(await page.evaluate(()=>!!document.querySelector('.touch'))),`${name}: controls step aside on a menu`)
  await page.screenshot({path:`${OUT}/${name}-3-pause.png`})
  // is the pause menu scrollable / all reachable
  const pm=await page.evaluate(()=>{const e=document.querySelector('.pause-panel') as HTMLElement;const r=e.getBoundingClientRect();return {t:r.top,b:r.bottom,sh:e.scrollHeight,ch:e.clientHeight,ov:getComputedStyle(e).overflowY,vh:innerHeight}})
  log(`${name} pause panel ${JSON.stringify(pm)}`)
  // settings -> back
  const sb=await rect(page,'[data-nav="settings"]')
  if(sb){await tap(sb.x,sb.y);await sleep(500)}
  ph=await page.evaluate(()=>(window as any).__game.get('ui'))
  ok(ph.stack.includes('settings'),`${name}: tapping Settings opens it (${ph.stack})`)
  await page.screenshot({path:`${OUT}/${name}-4-settings.png`})
  const bk=await rect(page,'.touch-back')
  ok(!!bk,`${name}: Back button present`)
  if(bk){await tap(bk.x,bk.y);await sleep(400)}
  ph=await page.evaluate(()=>(window as any).__game.get('ui'))
  ok(!ph.stack.includes('settings'),`${name}: Back closes Settings (${ph.stack})`)
  const rb=await rect(page,'.touch-back')
  if(rb){await tap(rb.x,rb.y);await sleep(500)}
  ph=await page.evaluate(()=>(window as any).__game.get('ui'))
  ok(ph.stack.length===0,`${name}: Resume by the Back button returns to driving (${ph.stack})`)
  ok(await page.evaluate(()=>!!document.querySelector('.touch')),`${name}: controls back after resume`)
  // keyboard takes over, finger takes it back
  await page.keyboard.press('KeyW'); await sleep(200)
  s=await inp(page); ok(s.device==='keyboard',`${name}: a key hands over to keyboard`)
  ok(!(await page.evaluate(()=>!!document.querySelector('.touch'))),`${name}: controls leave for the keyboard`)
  await tap(w/2,h/2); await sleep(200)
  s=await inp(page); ok(s.device==='touch',`${name}: a finger takes it back`)
  // layout overlap check
  const overlap=await page.evaluate(()=>{const R=(s:string)=>{const e=document.querySelector(s);return e?e.getBoundingClientRect():null};const items:[string,DOMRect|null][]=[['tl',R('.hud-stack--tl')],['map',R('.hud-map')],['row',R('.touch-row')],['speed',R('.hud-speed')],['stick',R('.touch-stick')],['brake',R('.touch-pedal--brake')],['gas',R('.touch-pedal--gas')],['drift',R('.touch-pedal--drift')]];const out:string[]=[];for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){const a=items[i][1],b=items[j][1];if(!a||!b||!(a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom))continue;const round=(n:string)=>['stick','brake','gas','drift'].includes(n);if(round(items[i][0])&&round(items[j][0])){const d=Math.hypot(a.left+a.width/2-b.left-b.width/2,a.top+a.height/2-b.top-b.height/2);if(d>=a.width/2+b.width/2)continue}out.push(items[i][0]+'/'+items[j][0])}return out})
  log(`${name} overlaps: ${JSON.stringify(overlap)}`)
  ok(overlap.length===0,`${name}: nothing overlaps`)
  await page.close()
}
log(fails?`\n${fails} FAILED`:'\nALL PASS')
await browser.close()
process.exit(fails?1:0)
