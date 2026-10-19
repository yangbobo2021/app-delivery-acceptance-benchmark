import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const port = Number(process.env.PORT || process.argv[2] || 8080);
const server = http.createServer(async (req,res) => {
 const path = req.url === '/' ? 'index.html' : req.url?.slice(1);
 if (!['index.html','app.js','app.js.map'].includes(path)) {res.writeHead(404).end();return;}
 try {const body = await readFile(fileURLToPath(new URL('./dist/'+path,import.meta.url)));res.setHeader('Content-Type',path.endsWith('.html')?'text/html; charset=utf-8':path.endsWith('.map')?'application/json':'text/javascript');res.end(body);}catch {res.writeHead(500).end();}
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));
