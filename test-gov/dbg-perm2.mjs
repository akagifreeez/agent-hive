// 疑似: テストが失敗する理由を再現 — busの購読タイミング
import { startUi } from '../src/ui/server.js';
import { Bus } from '../src/engine/board.js';
import { PermissionGate } from '../src/engine/permissions.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ws = mkdtempSync(join(tmpdir(), 'dbg2-'));
const bus = new Bus();
const gate = new PermissionGate({ bus, askTimeoutSec: 30 });
const config = { workspace: ws, ui: { port: 0 }, model: { model: 'test' }, agents: [], budget: { maxTokensPerRun: 1 }, permissions: {} };
const ui = await startUi({ config, modelFactory: () => ({}), bus, autoStart: false });
const checkPromise = gate.check('git push origin main');
await new Promise((r) => setTimeout(r, 100));
const st = await fetch('http://127.0.0.1:' + config.ui.port + '/api/state').then((r) => r.json());
const pending = (st.live?.requests ?? []).find((r) => r.state === 'pending');
console.log('pending found:', JSON.stringify(pending));
// 承認を送る
const res = await fetch('http://127.0.0.1:' + config.ui.port + '/api/permission', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: pending.id, approve: true }),
});
console.log('approve status:', res.status);
console.log('gate resolved:', JSON.stringify(await checkPromise));
process.exit(0);