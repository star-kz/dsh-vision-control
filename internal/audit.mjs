/**
 * 动作审计 JSONL（新-P1-04，devil 硬化字段集）。
 *
 * 「AI 动了什么」必须可追责：每个**动桌面**的调用落成一行 JSONL，成功与失败都记——
 * 事故复盘要的正是「试过什么、哪一步出事」。只记 movesDesktop 为真的调用：读与盯屏
 * 轮询不入账，否则日志会被噪声淹没。
 *
 * 字段纪律是 devil 硬化的，碰不得：
 *
 *   - type/paste/key 的**内容永不落盘**——只存长度。键和弦本身也算内容
 *     （'ctrl+v' 倒不敏感，逐键序列 'p a s s w o r d {enter}' 是），所以
 *     `describeCall` 里 `key ${args.keys}` 的拼法在这里被刻意改成只存长度；
 *   - 进程名可存（launch 的 target），窗口标题一律不存（连哈希都不存）；
 *   - 会话标识只存 sha256 截 16 位的脱敏 tag，文件名同理——审计文件本身不泄漏会话 id。
 *
 * 生命周期与会话绑定（前置=优-P0-04 撤销链的可落点）：grant 开账、revoke / dispose
 * 合账（合账前落最后一行事件）。审计是旁路：写挂了（盘满、权限）只置 disabled 并
 * warn，绝不拖累动作本身。
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** 会话 id 的脱敏形态：sha256 截 16 位；匿名会话落 'anonymous'。 */
export function auditSessionTag(sessionKey) {
  const key = String(sessionKey ?? '');
  return key === '' ? 'anonymous' : createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/**
 * 一个调用的脱敏一句短语（devil 字段集：内容类参数只存长度不存内容）。
 * @param cmd - 后端命令。
 * @param args - 后端参数。
 * @returns 不含任何用户内容的描述。
 */
export function auditDescribe(cmd, args) {
  const len = (value) => String(value ?? '').length;
  switch (cmd) {
    case 'click': return `click (${args?.x},${args?.y})`;
    case 'drag': return `drag (${args?.fromX},${args?.fromY})->(${args?.toX},${args?.toY})`;
    case 'scroll': return `scroll ${args?.direction}`;
    case 'type':
    case 'paste': return `${cmd} ${len(args?.text)} char(s)`;
    // 键和弦只存长度——见文件头字段纪律。
    case 'key': return `key ${len(args?.keys)} char(s)`;
    case 'focus': return `focus hwnd=${args?.hwnd}`;
    // 进程名/目标可存（devil：存进程名不存窗口标题哈希）。
    case 'launch': return `launch ${args?.target}`;
    case 'uiact': return `uiact ${args?.action}`;
    case 'clipboard': return `clipboard ${args?.op ?? 'get'}`;
    case 'batch': {
      const steps = Array.isArray(args?.steps) ? args.steps : [];
      const summary = steps.map((step) => {
        const action = String(step?.action ?? '').toLowerCase();
        if (action === 'type' || action === 'paste') return `${action}(${len(step?.text)} chars)`;
        if (action === 'key') return `key(${len(step?.keys)} chars)`;
        return action;
      });
      const dryRun = args?.dryRun === true || args?.dry_run === true ? ' dry-run' : '';
      return `batch ${steps.length} step(s) [${summary.join(',')}]${dryRun}`;
    }
    default: return String(cmd);
  }
}

/**
 * 建一份审计日志（每个插件实例一份）。
 * @param options - `{ dir, logger }`；dir 必须是本实例可写的目录。
 * @returns `{ record, close, closeAll, dir }`；close/closeAll 返回 Promise 以便测试等冲刷。
 */
export function createAuditLog({ dir, logger } = {}) {
  /** sessionTag -> WriteStream（懒开：从不动作、从不授权的会话不留文件）。 */
  const streams = new Map();
  let disabled = false;

  const fail = (error) => {
    disabled = true;
    logger?.warn?.(`computer-use: audit log disabled (${String(error?.message ?? error)})`);
  };

  function streamFor(tag) {
    let stream = streams.get(tag);
    if (stream === undefined) {
      try {
        mkdirSync(dir, { recursive: true });
        stream = createWriteStream(join(dir, `${tag}.jsonl`), { flags: 'a', encoding: 'utf8' });
        stream.on('error', fail);
        streams.set(tag, stream);
      } catch (error) {
        fail(error);
        return undefined;
      }
    }
    return stream;
  }

  /** 落一行。entry 的字段原样进 JSON，本函数只补 ts 与脱敏 tag。 */
  function record(sessionKey, entry) {
    if (disabled) return;
    const tag = auditSessionTag(sessionKey);
    const stream = streamFor(tag);
    if (stream === undefined) return;
    try {
      stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
    } catch (error) {
      fail(error);
    }
  }

  /** 合上一个会话的审计流（revoke/dispose）；给了 entry 就先落最后一行事件。 */
  function close(sessionKey, entry) {
    const tag = auditSessionTag(sessionKey);
    if (entry !== undefined) record(sessionKey, entry);
    const stream = streams.get(tag);
    if (stream === undefined) return Promise.resolve();
    streams.delete(tag);
    return new Promise((resolve) => {
      try { stream.end(resolve); } catch { resolve(); }
    });
  }

  /** 插件卸载时全合。 */
  function closeAll() {
    return Promise.all([...streams.keys()].map((tag) => closeTag(tag)));
    function closeTag(tag) {
      const stream = streams.get(tag);
      if (stream === undefined) return Promise.resolve();
      streams.delete(tag);
      return new Promise((resolve) => {
        try { stream.end(resolve); } catch { resolve(); }
      });
    }
  }

  return { record, close, closeAll, dir };
}
