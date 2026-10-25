const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://resultados.tse.jus.br/oficial/';
const PORT = 3000;
const UA = 'painel-apuracao-pessoal (uso local)';
const cache = new Map();
const pendentes = new Map();
let pausaAte = 0; // se o TSE responder 429/403, para de consultar por 1 min
const hora = () => new Date().toLocaleTimeString('pt-BR');
const nome = c => c.split('/').pop();
const mediana = a => { const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

async function baixar(caminho, ant) {
  if (Date.now() < pausaAte) { if (ant) return ant; throw new Error('pausado pelo limite do TSE'); }
  const h = {'User-Agent': UA};
  if (ant?.etag) h['If-None-Match'] = ant.etag;
  if (ant?.mod) h['If-Modified-Since'] = ant.mod;
  const r = await fetch(BASE + caminho, {headers: h});
  if (r.status === 304 && ant) { ant.em = Date.now(); return ant; }
  if (r.status === 429 || (r.status === 403 && !caminho.includes('/fotos/'))) {
    pausaAte = Date.now() + 60000;
    console.log(`[${hora()}] TSE respondeu ${r.status}. Pausando 1 min para não ser bloqueado.`);
    if (ant) return ant;
  }
  const corpo = Buffer.from(await r.arrayBuffer());
  const novo = {
    status: r.status, corpo, em: Date.now(), mudancas: ant?.mudancas || [],
    tipo: r.headers.get('content-type') || 'application/octet-stream',
    etag: r.headers.get('etag'), mod: r.headers.get('last-modified'),
    hash: crypto.createHash('md5').update(corpo).digest('hex'),
  };
  if (caminho.endsWith('.json') && r.status === 200 && ant?.status === 200 && ant.hash !== novo.hash) {
    const agora = Date.now(), anterior = novo.mudancas[novo.mudancas.length - 1];
    novo.mudancas.push(agora);
    if (novo.mudancas.length > 30) novo.mudancas.shift();
    const ints = novo.mudancas.slice(1).map((t, i) => t - novo.mudancas[i]);
    let txt = `[${hora()}] mudou ${nome(caminho)}`;
    try { const d = JSON.parse(corpo); if (d.s?.pst) txt += ` | ${d.s.pst}% seções, TSE ${d.dt || d.dg} ${d.ht || d.hg}`; } catch {}
    if (anterior) txt += ` (+${Math.round((agora - anterior) / 1000)} s`;
    if (ints.length >= 2) txt += `, mediana ${Math.round(mediana(ints) / 1000)} s`;
    if (anterior) txt += ')';
    console.log(txt);
  }
  cache.set(caminho, novo);
  return novo;
}

function obter(caminho) {
  const c = cache.get(caminho);
  if (c && c.status === 200 && caminho.includes('/fotos/')) return Promise.resolve(c);
  if (c && c.status === 404 && Date.now() - c.em < 60000) return Promise.resolve(c); // 404 repetido pode bloquear o IP
  if (c && Date.now() - c.em < 2000) return Promise.resolve(c);
  if (pendentes.has(caminho)) return pendentes.get(caminho);
  const job = baixar(caminho, c).finally(() => pendentes.delete(caminho));
  pendentes.set(caminho, job);
  return job;
}

// Vigia contínuo do presidente no 2º turno: mede a frequência real de atualização do TSE.
// O código da eleição vem do ele-c.json (cdt2 da eleição federal); 6258 é o reserva.
let VIGIAR = ['ele2026/6258/dados/br/br-c0001-e006258-u.json'];
obter('comum/config/ele-c.json').then(c => {
  const cfg = JSON.parse(c.corpo);
  for (const pl of cfg.pl || []) for (const e of pl.e || []) {
    const cargos = (e.abr || []).flatMap(a => (a.cp || []).map(x => String(x.cd)));
    if (pl.c === 'ele2026' && String(e.t) === '1' && e.cdt2 && cargos.includes('1')) {
      const cd = String(e.cdt2), p6 = cd.padStart(6, '0');
      VIGIAR = [`ele2026/${cd}/dados/br/br-c0001-e${p6}-u.json`];
    }
  }
  console.log(`Eleição do 2º turno: ${VIGIAR[0].split('/')[1]}`);
}).catch(() => console.log('ele-c.json indisponível, usando 6258'));
// Só no seu PC: na Vercel não há processo contínuo, então o vigia fica desligado
if (!process.env.VERCEL) setInterval(() => { for (const c of VIGIAR) obter(c).catch(() => {}); }, 5000);

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname.startsWith('/tse/')) {
    const caminho = decodeURIComponent(u.pathname.slice(5));
    if (caminho.includes('..')) { res.writeHead(400); return res.end(); }
    try {
      const c = await obter(caminho);
      // s-maxage: a CDN da Vercel guarda a resposta por alguns segundos e entrega a todos,
      // então o TSE recebe 1 pedido por arquivo, não 1 por pessoa
      res.writeHead(c.status, {
        'Content-Type': c.tipo,
        'Cache-Control': caminho.includes('/fotos/') ? 'public, max-age=86400, s-maxage=86400'
          : c.status === 200 ? 'public, max-age=0, s-maxage=5, stale-while-revalidate=20'
          : 'public, max-age=0, s-maxage=30',
      });
      return res.end(c.corpo);
    } catch (e) {
      res.writeHead(502);
      return res.end(String(e));
    }
  }
  if (u.pathname === '/image.png') {
    res.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600, s-maxage=86400'});
    return res.end(fs.readFileSync(path.join(__dirname, 'image.png')));
  }
  if (u.pathname === '/favicon.ico' || u.pathname === '/robots.txt') { res.writeHead(404); return res.end(); }
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=60'});
  res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
}).listen(PORT, () => console.log('Abra http://localhost:' + PORT + '\n2º turno, fonte TSE (resultados.tse.jus.br). Mudanças aparecem aqui embaixo:'));
