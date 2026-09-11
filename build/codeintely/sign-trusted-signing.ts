/*---------------------------------------------------------------------------------------------
 *  CodeIntely fork addition (not upstream). Real Windows code-signing via Azure Trusted
 *  Signing — NOT the same thing as build/azure-pipelines/common/sign.ts's "sign-windows"
 *  path, which calls Microsoft's own internal ESRP pipeline (reads SYSTEM_ACCESSTOKEN /
 *  EsrpCliDllPath, calls Microsoft-internal key codes) and only works from inside Microsoft's
 *  own Azure DevOps org — confirmed unusable here.
 *
 *  Requires:
 *    - signtool.exe on PATH (Windows SDK — see the Windows code-signing note in PLANNING.md
 *      for the exact fix if "spawn signtool.exe ENOENT" comes back).
 *    - CODEINTELY_TRUSTED_SIGNING_DLIB: full path to Azure.CodeSigning.Dlib.dll, from the
 *      Microsoft.Trusted.Signing.Client NuGet package (not vendored into this repo —
 *      download once, e.g. into D:\SecureAI\editor\trusted-signing-client\, outside git).
 *    - CODEINTELY_TRUSTED_SIGNING_METADATA: full path to a metadata.json naming the Trusted
 *      Signing endpoint/account/certificate-profile, e.g.:
 *        { "Endpoint": "https://eus.codesigning.azure.net/",
 *          "CodeSigningAccountName": "codeintely-signing",
 *          "CertificateProfileName": "codeintely-editor" }
 *    - An Azure identity signtool can pick up (DefaultAzureCredential — an `az login` session
 *      is enough) that's been granted the "Artifact Signing Identity Verifier" and
 *      "Artifact Signing Certificate Profile Signer" roles on that account.
 *
 *  Usage: node build/codeintely/sign-trusted-signing.ts <path-to-file-to-sign>
 *  Also wired as gulpfile.vscode.win32.ts's Inno Setup `/sesrp` callback (one file per call),
 *  and as this file's own sibling task in gulpfile.codeintely.ts for signing the built .exe
 *  directly, before packaging.
 *--------------------------------------------------------------------------------------------*/

import cp from 'child_process';

function main(filePath: string): void {
	const dlibPath = process.env['CODEINTELY_TRUSTED_SIGNING_DLIB'];
	const metadataPath = process.env['CODEINTELY_TRUSTED_SIGNING_METADATA'];

	if (!dlibPath || !metadataPath) {
		throw new Error(
			'CODEINTELY_TRUSTED_SIGNING_DLIB and CODEINTELY_TRUSTED_SIGNING_METADATA must both be set to sign — see build/codeintely/sign-trusted-signing.ts\'s header comment for setup.'
		);
	}

	const args = [
		'sign', '/v',
		'/fd', 'SHA256',
		'/tr', 'http://timestamp.acs.microsoft.com',
		'/td', 'SHA256',
		'/dlib', dlibPath,
		'/dmdf', metadataPath,
		filePath,
	];

	cp.execFileSync('signtool.exe', args, { stdio: 'inherit' });
}

if (import.meta.main) {
	const filePath = process.argv[2];
	if (!filePath) {
		throw new Error('Usage: node sign-trusted-signing.ts <path-to-file-to-sign>');
	}
	main(filePath);
}
