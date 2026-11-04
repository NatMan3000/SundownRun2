// Serves a built game with a small script added, so real Safari on the simulator can open any screen by URL
// (it has no way to run __dev commands otherwise). ?sweep=<screen>&tab=<tab> or ?demo=<hud scene>.
// usage: bun sweep-server.ts <distDir> <port>
const [dist, port] = [process.argv[2], Number(process.argv[3] ?? 5223)]
const inject = `<script>addEventListener('load',()=>{const q=new URLSearchParams(location.search),s=q.get('sweep'),d=q.get('hud');const t=setInterval(()=>{const v=window.__dev;if(!v||!v.ui)return;clearInterval(t);setTimeout(()=>{if(s)v.ui(s,q.get('tab')||undefined);if(d)v.uiHudDemo(d)},+(q.get('after')||6000))},300)})</script>`
Bun.serve({
  port,
  async fetch(req) {
    const p = new URL(req.url).pathname
    const f = Bun.file(dist + (p === '/' ? '/index.html' : p))
    if (!(await f.exists())) return new Response('not found', { status: 404 })
    if (p === '/' || p.endsWith('.html')) return new Response((await f.text()).replace('</head>', inject + '</head>'), { headers: { 'content-type': 'text/html' } })
    return new Response(f)
  },
})
console.log('sweep server on', port)
