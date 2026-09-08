import * as vscode from "vscode";
import { api, currentRepositoryFullName } from "../api";
import { ensureAuthorized } from "../auth";

export async function askCommand(secrets: vscode.SecretStorage) {
  const token = await ensureAuthorized(secrets);
  if (!token) return;
  const repo = await currentRepositoryFullName();
  if (!repo) {
    vscode.window.showErrorMessage("CodeIntely: couldn't determine this workspace's GitHub repository.");
    return;
  }
  const question = await vscode.window.showInputBox({ prompt: "Ask CodeIntely about this repository" });
  if (!question) return;

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "CodeIntely: thinking…" }, async () => {
    try {
      const result = await api.ask(token, repo, question);
      const doc = await vscode.workspace.openTextDocument({ content: result.answer, language: "markdown" });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      vscode.window.showErrorMessage(`CodeIntely Ask failed: ${(err as Error).message}`);
    }
  });
}
