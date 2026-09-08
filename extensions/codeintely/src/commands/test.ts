import * as vscode from "vscode";
import { api } from "../api";
import { ensureAuthorized } from "../auth";
import { pickFinding } from "./fix";

export async function testCommand(secrets: vscode.SecretStorage) {
  const token = await ensureAuthorized(secrets);
  if (!token) return;
  const finding = await pickFinding(token);
  if (!finding) return;
  const patchDiff = await vscode.window.showInputBox({
    prompt: "Paste the patch diff this test should validate (e.g. from CodeIntely: Fix Finding)",
  });
  if (!patchDiff) return;

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "CodeIntely: generating test…" }, async () => {
    try {
      const result = await api.test(token, finding.type, finding.id, patchDiff);
      const language = result.framework.includes("jest") || result.framework.includes("mocha") ? "javascript" : "python";
      const doc = await vscode.workspace.openTextDocument({ content: result.test_code, language });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      vscode.window.showInformationMessage(result.explanation);
    } catch (err) {
      vscode.window.showErrorMessage(`CodeIntely Test failed: ${(err as Error).message}`);
    }
  });
}
