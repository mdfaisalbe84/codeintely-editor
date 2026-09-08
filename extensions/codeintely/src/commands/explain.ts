import * as vscode from "vscode";
import { api, currentRepositoryFullName } from "../api";
import { ensureAuthorized } from "../auth";

export async function explainCommand(secrets: vscode.SecretStorage) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showErrorMessage("CodeIntely: select some code to explain first.");
    return;
  }
  const token = await ensureAuthorized(secrets);
  if (!token) return;
  const repo = await currentRepositoryFullName();
  if (!repo) {
    vscode.window.showErrorMessage("CodeIntely: couldn't determine this workspace's GitHub repository.");
    return;
  }
  const selectionText = editor.document.getText(editor.selection);
  const filePath = vscode.workspace.asRelativePath(editor.document.uri);

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "CodeIntely: explaining…" }, async () => {
    try {
      const result = await api.explain(token, repo, filePath, selectionText);
      const doc = await vscode.workspace.openTextDocument({ content: result.explanation, language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
    } catch (err) {
      vscode.window.showErrorMessage(`CodeIntely Explain failed: ${(err as Error).message}`);
    }
  });
}
