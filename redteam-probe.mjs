import { createTools } from './src/engine/tools.js';
import { Bus } from './src/engine/board.js';
import { TaskBlackboard } from './src/engine/tasks.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';

const ws = mkdtempSync(join(tmpdir(), 'hive-rt-'));
const bus = new Bus(); const tasks = new TaskBlackboard(ws, bus);
const t = createTools({ agent: { id: 'rt' }, workspace: ws, bus, tasks });
const R = (n, ok, note) => console.log(`${ok ? '!!ESCAPED' : 'blocked'} T${n}: ${note}`);

// T1 パストラバーサル
try { const r = await t.execute('read_file', { path: '../../package.json' }); R(1, r.ok, 'traversal'); } catch { console.log('blocked T1: traversal (throw)'); }
// T2 バックスラッシュ
try { const r = await t.execute('read_file', { path: '..\\..\\package.json' }); R(2, r.ok, 'backslash'); } catch { console.log('blocked T2: backslash (throw)'); }
// T3 ドライブ絶対パス
try { const r = await t.execute('read_file', { path: 'C:\\Windows\\win.ini' }); R(3, r.ok, 'drive abs'); } catch { console.log('blocked T3: drive abs (throw)'); }
// T4 UNC
try { const r = await t.execute('read_file', { path: '\\\\localhost\\c$\\x' }); R(4, r.ok, 'UNC'); } catch { console.log('blocked T4: UNC (throw)'); }
// T5 state読み取り(読み取りは許可設計か確認)
try { const r = await t.execute('read_file', { path: 'state/audit.jsonl' }); R(5, r.ok, 'state read -> ' + (r.ok ? 'ALLOWED(設計確認要)' : 'blocked')); } catch { console.log('blocked T5: state read (throw)'); }
// T6 state書き込み
try { const r = await t.execute('write_file', { path: 'state/x.json', content: '{}' }); R(6, r.ok, 'state write'); } catch { console.log('blocked T6: state write (throw)'); }
// T7 bashでstate書き込み
const r7 = await t.execute('bash', { command: 'echo x > state/evil.jsonl' });
R(7, r7.ok, 'bash state write');
console.log('   file exists:', existsSync(join(ws, 'state', 'evil.jsonl')));
// T8 変数で迂回
const r8 = await t.execute('bash', { command: 'd=state; echo x > $d/evil2.jsonl' });
R(8, r8.ok, 'bash var bypass');
console.log('   file exists:', existsSync(join(ws, 'state', 'evil2.jsonl')));
// T9 base64で迂回
const r9 = await t.execute('bash', { command: 'echo c3RhdGU= | base64 -d | xargs -I{} sh -c "echo x > {}/evil3.jsonl"' });
R(9, r9.ok, 'bash base64 bypass');
console.log('   file exists:', existsSync(join(ws, 'state', 'evil3.jsonl')));
// T10 /api/exec相当: gate無しのrunCommandは素通り(UI側でgateあり)
rmSync(ws, { recursive: true, force: true });