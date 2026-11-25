import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const hostModules = process.env.DSH_TEST_HOST_MODULES;

// Opt-in host integration: unit tests use lightweight service doubles, while this
// mounts the production entry through the same Cordis injection enforcement that
// failed in the installed web profile.
test('production entry declares and mounts systemPrompt through real Cordis', {
  skip: hostModules ? false : 'set DSH_TEST_HOST_MODULES to the host node_modules directory',
}, async (t) => {
  const shotDir = await mkdtemp(join(tmpdir(), 'vision-cordis-startup-'));
  t.after(() => rm(shotDir, { recursive: true, force: true }));
  process.env.DSH_APP_MODULES = hostModules;

  const cordisUrl = pathToFileURL(join(hostModules, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href;
  const { Context, Service } = await import(cordisUrl);
  const pluginEntry = process.env.DSH_TEST_PLUGIN_ENTRY
    ? pathToFileURL(process.env.DSH_TEST_PLUGIN_ENTRY).href
    : new URL('../index.js', import.meta.url).href;
  const plugin = await import(pluginEntry);

  class Tools extends Service {
    definitions = new Map();
    constructor(ctx) { super(ctx, 'tools'); }
    register(definition) { this.definitions.set(definition.name, definition); return definition; }
    get(name) { return this.definitions.get(name); }
    restrict() { return () => {}; }
  }
  class Prompt extends Service {
    definitions = [];
    constructor(ctx) { super(ctx, 'systemPrompt'); }
    context(definition) { this.definitions.push(definition); return () => {}; }
  }

  const root = new Context();
  t.after(() => root.fiber.dispose());
  await root.plugin(Tools);
  await root.plugin(Prompt);
  await root.plugin({ name: 'vision-control-startup-test', apply: plugin.apply, inject: plugin.inject }, {
    defaultEnabled: false,
    shotDir,
    auditLog: false,
    browser: false,
    appLaunch: { enabled: false },
    tokenGuard: { enabled: false },
    realtime: { bundled: false },
  });

  assert.ok(plugin.inject.includes('tools'));
  assert.ok(plugin.inject.includes('systemPrompt'), 'mode-prompt.mjs reads ctx.systemPrompt during apply');
  assert.equal(root.systemPrompt.definitions.length, 1);
  assert.equal(root.systemPrompt.definitions[0].name, 'computer-use:mode');
  assert.ok(root.tools.definitions.size > 0, 'the host tool surface actually mounted');
});
