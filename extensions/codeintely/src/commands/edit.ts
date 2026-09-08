import * as vscode from "vscode";
import { api, currentRepositoryFullName } from "../api";
import { ensureAuthorized } from "../auth";
import { ProposedContentProvider } from "../diffProvider";

export async function editCommand(secrets: vscode.SecretStorage, proposedContentProvider: ProposedContentProvider) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("CodeIntely: open a file to edit first.");
    return;
  }
  const token = await ensureAuthorized(secrets);
  if (!token) return;
  const repo = await currentRepositoryFullName();
  if (!repo) {
    vscode.window.showErrorMessage("CodeIntely: couldn't determine this workspace's GitHub repository.");
    return;
  }
  const instruction = await vscode.window.showInputBox({ prompt: "Describe the change (CodeIntely will edit this file directly, no full plan)" });
  if (!instruction) return;

  const filePath = vscode.workspace.asRelativePath(editor.document.uri);
  const currentContent = editor.document.getText();

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "CodeIntely: generating edit…" }, async () => {
    try {
      const result = await api.edit(token, repo, filePath, currentContent, instruction);
      if (!result.patched_content) {
        vscode.window.showErrorMessage("CodeIntely: the generated edit could not be applied — no safe match found in the file.");
        return;
      }
      const proposedUri = proposedContentProvider.set(`${Date.now()}-${filePath}`, result.patched_content);
      await vscode.commands.executeCommand("vscode.diff", editor.document.uri, proposedUri, `${filePath} ↔ CodeIntely edit (proposed)`);

      const choice = await vscode.window.showInformationMessage(
        "CodeIntely: apply this edit to the file?",
        { modal: false },
        "Apply locally",
        "Discard",
      );
      if (choice === "Apply locally") {
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(0, 0, editor.document.lineCount, 0);
        edit.replace(editor.document.uri, fullRange, result.patched_content);
        await vscode.workspace.applyEdit(edit);
        vscode.window.showInformationMessage("CodeIntely: edit applied.");
      }
    } catch (err) {
      vscode.window.showErrorMessage(`CodeIntely Edit failed: ${(err as Error).message}`);
    }
  });
}
