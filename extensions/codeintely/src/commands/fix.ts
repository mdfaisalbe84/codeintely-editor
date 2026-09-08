import * as vscode from "vscode";
import { api } from "../api";
import { ensureAuthorized } from "../auth";
import { ProposedContentProvider } from "../diffProvider";

export async function pickFinding(token: string): Promise<{ id: number; type: string; file_path: string } | undefined> {
  const findings = await api.listFindings(token);
  const items = findings.map((f: any) => ({
    label: f.rule_id,
    description: `${f.file_path}:${f.line_number ?? "?"}`,
    detail: f.message,
    finding: f,
  }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: "Pick a finding to fix" });
  if (!picked) return undefined;
  return { id: picked.finding.id, type: picked.finding.type, file_path: picked.finding.file_path };
}

export async function fixCommand(secrets: vscode.SecretStorage, proposedContentProvider: ProposedContentProvider) {
  const token = await ensureAuthorized(secrets);
  if (!token) return;
  const finding = await pickFinding(token);
  if (!finding) return;

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "CodeIntely: generating fix…" }, async () => {
    try {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const localUri = folder ? vscode.Uri.joinPath(folder.uri, finding.file_path) : undefined;
      let currentContent: string | undefined;
      if (localUri) {
        try {
          currentContent = Buffer.from(await vscode.workspace.fs.readFile(localUri)).toString("utf-8");
        } catch {
          currentContent = undefined; // file not present locally — still show the raw patch below
        }
      }

      const result = await api.fix(token, finding.type, finding.id, currentContent);

      if (result.patched_content !== null && localUri) {
        const proposedUri = proposedContentProvider.set(`fix-${finding.id}`, result.patched_content);
        await vscode.commands.executeCommand("vscode.diff", localUri, proposedUri, `${finding.file_path} ↔ CodeIntely fix (proposed)`);
        const choice = await vscode.window.showInformationMessage(`CodeIntely: apply this fix to ${finding.file_path}?`, "Apply locally", "Discard");
        if (choice === "Apply locally") {
          const edit = new vscode.WorkspaceEdit();
          const doc = await vscode.workspace.openTextDocument(localUri);
          edit.replace(localUri, new vscode.Range(0, 0, doc.lineCount, 0), result.patched_content);
          await vscode.workspace.applyEdit(edit);
        }
      } else {
        // No local copy of the target file (or it couldn't be applied
        // safely) — show the raw diff and explanation for manual review
        // instead of silently discarding a real, generated fix.
        const doc = await vscode.workspace.openTextDocument({ content: `${result.explanation}\n\n${result.patch_diff}`, language: "diff" });
        await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      }
    } catch (err) {
      vscode.window.showErrorMessage(`CodeIntely Fix failed: ${(err as Error).message}`);
    }
  });
}
