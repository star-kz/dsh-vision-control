/**
 * 表征测试：internal/audit.mjs —— 动作审计 JSONL（新-P1-04，devil 硬化字段集）。
 *
 * 钉住的契约：
 *   - 内容永不落盘：type/paste 的 text、key 的 keys（含键和弦）只存长度；
 *   - batch 逐步列出动作名，内容步带长度；dryRun/dry_run 双拼都打出 dry-run 标记；
 *   - 进程名可存（launch target），会话 id 只存 sha256 截 16 位（文件名同理）；
 *   - 生命周期：record 懒开文件、close 落最后一行并合流、closeAll 全合；
 *   - 目录不可写时置 disabled 并 warn，绝不抛出拖累动作。
 *
 * 本文件独立可跑：node --test tests/internal-audit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuditLog, auditDescribe, auditSessionTag } from '../internal/audit.mjs';

test('auditDescribe：内容类参数只存长度不存内容', () => {
  assert.equal(auditDescribe('type', { text: 'p@ssw0rd秘密' }), 'type 10 char(s)');
  assert.equal(auditDescribe('paste', { text: 'clipboard contents here' }), 'paste 23 char(s)');
  // 键和弦也是内容：'ctrl+shift+t' 这个串永不出现，只有长度。
  assert.equal(auditDescribe('key', { keys: 'ctrl+shift+t' }), 'key 12 char(s)');
  assert.equal(auditDescribe('key', { keys: 'p' }), 'key 1 char(s)');
  // 坐标与方向不是内容。
  assert.equal(auditDescribe('click', { x: 100, y: 200 }), 'click (100,200)');
  assert.equal(auditDescribe('scroll', { direction: 'down' }), 'scroll down');
  // 进程名可存（devil：存进程名不存窗口标题哈希）。
  assert.equal(auditDescribe('launch', { target: 'notepad.exe' }), 'launch notepad.exe');
  assert.equal(auditDescribe('focus', { hwnd: 1234 }), 'focus hwnd=1234');
});

test('auditDescribe：batch 逐步列动作名、内容步带长度、dry-run 打标记', () => {
  const steps = [
    { action: 'click', x: 1, y: 2 },
    { action: 'type', text: 'secret text' },
    { action: 'key', keys: 'enter' },
    { action: 'wait', seconds: 1 },
  ];
  assert.equal(auditDescribe('batch', { steps }), 'batch 4 step(s) [click,type(11 chars),key(5 chars),wait]');
  assert.match(auditDescribe('batch', { steps, dryRun: true }), / dry-run$/);
  assert.match(auditDescribe('batch', { steps, dry_run: true }), / dry-run$/);
  assert.equal(auditDescribe('batch', {}), 'batch 0 step(s) []');
});

test('auditSessionTag：会话 id 脱敏、匿名归 anonymous、确定性', () => {
  assert.equal(auditSessionTag(''), 'anonymous');
  assert.equal(auditSessionTag(null), 'anonymous');
  const tag = auditSessionTag('session-abc-123');
  assert.match(tag, /^[0-9a-f]{16}$/);
  assert.equal(tag, auditSessionTag('session-abc-123'));
  assert.notEqual(tag, auditSessionTag('session-abc-124'));
});

test('createAuditLog：record 落 JSONL、close 合账落最后一行、内容纪律端到端', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'audit-test-'));
  const audit = createAuditLog({ dir });
  audit.record('session-abc-123', { event: 'grant' });
  audit.record('session-abc-123', { event: 'action', cmd: 'type', what: auditDescribe('type', { text: 'never written' }), ok: true, ms: 5 });
  audit.record('', { event: 'action', cmd: 'click', what: auditDescribe('click', { x: 1, y: 2 }), ok: true, ms: 3 });
  await audit.close('session-abc-123', { event: 'revoke', reason: 'test', cancelled: 0, released: 0 });
  await audit.closeAll();

  const files = await readdir(dir);
  assert.equal(files.length, 2);
  assert.ok(files.includes('anonymous.jsonl'));
  const sessionFile = files.find((f) => f !== 'anonymous.jsonl');
  assert.match(sessionFile, /^[0-9a-f]{16}\.jsonl$/);

  const lines = (await readFile(join(dir, sessionFile), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].event, 'grant');
  assert.equal(lines[1].event, 'action');
  assert.equal(lines[1].what, 'type 13 char(s)');
  assert.equal(lines[2].event, 'revoke');
  for (const line of lines) assert.ok(typeof lines[0].ts === 'string' && typeof lines[2].ts === 'string');
  // 端到端内容纪律：全文里搜不到被审计动作的内容。
  const raw = await readFile(join(dir, sessionFile), 'utf8');
  assert.ok(!raw.includes('never written'));
});

test('createAuditLog：目录不可写时置 disabled 并 warn，不抛出', async () => {
  const warnings = [];
  const audit = createAuditLog({
    dir: join(tmpdir(), 'audit-test-\u0000impossible'),
    logger: { warn: (msg) => warnings.push(msg) },
  });
  audit.record('s', { event: 'grant' }); // 不抛
  assert.ok(warnings.length > 0);
  await audit.closeAll();
});
