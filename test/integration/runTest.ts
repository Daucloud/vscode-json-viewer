import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    await runTests({
      version: 'stable',
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.resolve(__dirname, 'suite.cjs'),
      launchArgs: ['--disable-workspace-trust'],
    });
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

void main();
