#!/usr/bin/env node
import { PACKAGE_ROOT, publishNativeProjects } from './native-runtime.mjs';

if (process.argv.length !== 2) {
  console.error('usage: node tools/build-native.mjs');
  process.exitCode = 2;
} else {
  try {
    const outputs = publishNativeProjects(PACKAGE_ROOT);
    console.log(JSON.stringify({
      ok: true,
      runtime: 'win-x64',
      frameworkDependent: true,
      prerequisite: '.NET 8 Desktop Runtime',
      outputs: outputs.map(({ name, output, executable }) => ({ name, output, executable })),
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
