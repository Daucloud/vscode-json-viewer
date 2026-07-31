import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  try {
    const downloadedExecutable = await downloadAndUnzipVSCode('stable');
    // VS Code 1.131 renamed the macOS app binary from Electron to Code before
    // @vscode/test-electron updated its resolver. Preserve older runtimes and
    // use the new sibling binary only when the resolved path does not exist.
    const codeExecutable = path.join(path.dirname(downloadedExecutable), 'Code');
    const vscodeExecutablePath = !existsSync(downloadedExecutable) && existsSync(codeExecutable)
      ? codeExecutable
      : downloadedExecutable;
    await runTests({
      vscodeExecutablePath,
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
