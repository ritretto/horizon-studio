import { createServer } from 'node:http';
import type { AgentInfo } from '@horizon/protocol';
import pkg from '../package.json' with { type: 'json' };

const port = Number(process.env.HORIZON_AGENT_PORT ?? 7400);
const info: AgentInfo = { version: pkg.version };

createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(info));
    return;
  }
  res.writeHead(404).end();
}).listen(port, '127.0.0.1', () => {
  console.log(`horizon agent ${info.version} listening on 127.0.0.1:${port}`);
});
