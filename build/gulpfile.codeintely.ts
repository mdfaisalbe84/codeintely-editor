/*---------------------------------------------------------------------------------------------
 *  CodeIntely fork addition (not upstream). Signs the built app executable itself, before
 *  packaging — see build/codeintely/sign-trusted-signing.ts for the actual signing mechanism
 *  and its required env vars.
 *
 *  Run after `gulp vscode-win32-x64-min`, before `gulp vscode-win32-x64-system-setup`, so the
 *  installer packages an already-signed .exe (installer packaging itself is signed separately,
 *  see gulpfile.vscode.win32.ts's `--sign` flag, now wired to this same script).
 *--------------------------------------------------------------------------------------------*/
import cp from 'child_process';
import path from 'path';
import product from '../product.json' with { type: 'json' };
import * as task from './lib/gulp/task.ts';

const repoPath = path.dirname(import.meta.dirname);
const buildPath = (arch: string) => path.join(path.dirname(repoPath), `VSCode-win32-${arch}`);
const signScriptPath = path.join(import.meta.dirname, 'codeintely', 'sign-trusted-signing.ts');

function signExe(arch: string): task.CallbackTask {
	return (cb) => {
		const exePath = path.join(buildPath(arch), `${product.nameShort}.exe`);
		try {
			cp.execFileSync('node', [signScriptPath, exePath], { stdio: 'inherit' });
			cb();
		} catch (err) {
			cb(err as Error);
		}
	};
}

task.task(task.define('codeintely-sign-win32-x64', signExe('x64')));
task.task(task.define('codeintely-sign-win32-arm64', signExe('arm64')));
