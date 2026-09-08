import * as vscode from "vscode";
import { api, SecureFinding } from "../api";
import { ensureAuthorized, getStoredToken } from "../auth";

const SEVERITY_MAP: Record<string, vscode.DiagnosticSeverity> = {
  CRITICAL: vscode.DiagnosticSeverity.Error,
  HIGH: vscode.DiagnosticSeverity.Error,
  MEDIUM: vscode.DiagnosticSeverity.Warning,
  LOW: vscode.DiagnosticSeverity.Information,
};

function toDiagnostics(document: vscode.TextDocument, filePath: string, findings: SecureFinding[]): vscode.Diagnostic[] {
  return findings
    .filter((f) => f.file_path === filePath)
    .map((f) => {
      const line = Math.max((f.line_number ?? 1) - 1, 0);
      const range = document.lineAt(Math.min(line, document.lineCount - 1)).range;
      const diag = new vscode.Diagnostic(range, `[${f.scanner}/${f.rule_id}] ${f.message}`, SEVERITY_MAP[f.severity] ?? vscode.DiagnosticSeverity.Warning);
      diag.source = "CodeIntely";
      return diag;
    });
}

async function runScan(document: vscode.TextDocument, token: string, diagnostics: vscode.DiagnosticCollection): Promise<number> {
  const filePath = vscode.workspace.asRelativePath(document.uri);
  const result = await api.secure(token, [{ path: filePath, content: document.getText() }]);
  const diags = toDiagnostics(document, filePath, result.findings);
  diagnostics.set(document.uri, diags);
  return diags.length;
}

export async function secureCommand(secrets: vscode.SecretStorage, diagnostics: vscode.DiagnosticCollection) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("CodeIntely: open a file to scan first.");
    return;
  }
  const token = await ensureAuthorized(secrets);
  if (!token) return;

  const filePath = vscode.workspace.asRelativePath(editor.document.uri);
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "CodeIntely: scanning…" }, async () => {
    try {
      const count = await runScan(editor.document, token, diagnostics);
      vscode.window.showInformationMessage(
        count ? `CodeIntely: found ${count} issue(s) in ${filePath}.` : `CodeIntely: no issues found in ${filePath}.`,
      );
    } catch (err) {
      vscode.window.showErrorMessage(`CodeIntely Secure failed: ${(err as Error).message}`);
    }
  });
}

/**
 * Phase 29 "First-class Security panel": scan automatically on save rather
 * than only on manual invocation. Debounced per-document (rapid successive
 * saves — autosave, format-on-save — collapse to one scan) and silent by
 * design: an unauthenticated save must never trigger the interactive
 * sign-in flow or an error popup, only `codeintely.secure` (explicit user
 * action) does that.
 */
const SCAN_ON_SAVE_DEBOUNCE_MS = 1500;
const pendingScans = new Map<string, ReturnType<typeof setTimeout>>();

export function scanOnSave(document: vscode.TextDocument, secrets: vscode.SecretStorage, diagnostics: vscode.DiagnosticCollection): void {
  if (document.uri.scheme !== "file") return;
  if (!vscode.workspace.getConfiguration("codeintely").get<boolean>("scanOnSave", true)) return;

  const key = document.uri.toString();
  const pending = pendingScans.get(key);
  if (pending) clearTimeout(pending);

  pendingScans.set(
    key,
    setTimeout(() => {
      pendingScans.delete(key);
      void (async () => {
        const token = await getStoredToken(secrets);
        if (!token) return;
        try {
          await runScan(document, token, diagnostics);
        } catch {
          // Silent by design — a background scan must never interrupt typing with an error popup.
        }
      })();
    }, SCAN_ON_SAVE_DEBOUNCE_MS),
  );
}
