import * as vscode from "vscode";
import { api, currentRepositoryFullName } from "../api";
import { ensureAuthorized } from "../auth";
import { ProposedContentProvider } from "../diffProvider";

const TERMINAL_STATUSES = new Set(["done", "failed"]);

async function pollUntilTerminal(token: string, taskId: number, title: string): Promise<any> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, cancellationToken) => {
    while (!cancellationToken.isCancellationRequested) {
      const task = await api.getAgentTask(token, taskId);
      progress.report({ message: task.status });
      if (TERMINAL_STATUSES.has(task.status)) return task;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return undefined;
  });
}

async function runAgent(secrets: vscode.SecretStorage, outputMode: "pr" | "local", proposedContentProvider: ProposedContentProvider) {
  const token = await ensureAuthorized(secrets);
  if (!token) return;
  const repo = await currentRepositoryFullName();
  if (!repo) {
    vscode.window.showErrorMessage("CodeIntely: couldn't determine this workspace's GitHub repository.");
    return;
  }
  const description = await vscode.window.showInputBox({ prompt: "Describe the task for CodeIntely's agent (same engine as the dashboard/chat)" });
  if (!description) return;

  const created = await api.createAgentTask(token, repo, description, outputMode);
  vscode.window.showInformationMessage(`CodeIntely: task #${created.id} created — planning, coding, and testing…`);

  const finalTask = await pollUntilTerminal(token, created.id, `CodeIntely: running task #${created.id}`);
  if (!finalTask) return;

  if (finalTask.status === "failed") {
    vscode.window.showErrorMessage(`CodeIntely: task #${created.id} failed — ${finalTask.last_error}`);
    return;
  }

  if (outputMode === "pr") {
    const openPr = await vscode.window.showInformationMessage(`CodeIntely: task #${created.id} done — opened ${finalTask.pr_url}`, "Open in browser");
    if (openPr) await vscode.env.openExternal(vscode.Uri.parse(finalTask.pr_url));
    return;
  }

  // Local mode: diff + offer to apply each touched file, one at a time —
  // never silent, per the plan's "gated behind an explicit 'Apply locally'
  // action" requirement.
  const folder = vscode.workspace.workspaceFolders?.[0];
  for (const snapshot of finalTask.file_snapshots as { file_path: string; content: string | null }[]) {
    const localUri = folder ? vscode.Uri.joinPath(folder.uri, snapshot.file_path) : undefined;
    const proposedUri = proposedContentProvider.set(`agent-${created.id}-${snapshot.file_path}`, snapshot.content ?? "");
    if (localUri) {
      await vscode.commands.executeCommand("vscode.diff", localUri, proposedUri, `${snapshot.file_path} ↔ CodeIntely agent result`);
    }
    const choice = await vscode.window.showInformationMessage(`CodeIntely: apply agent's change to ${snapshot.file_path}?`, "Apply locally", "Skip");
    if (choice === "Apply locally" && localUri && snapshot.content !== null) {
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(localUri, { overwrite: true, contents: Buffer.from(snapshot.content, "utf-8") });
      await vscode.workspace.applyEdit(edit);
    }
  }
  vscode.window.showInformationMessage(`CodeIntely: task #${created.id} complete.`);
}

export const agentRemoteCommand = (secrets: vscode.SecretStorage, provider: ProposedContentProvider) => runAgent(secrets, "pr", provider);
export const agentLocalCommand = (secrets: vscode.SecretStorage, provider: ProposedContentProvider) => runAgent(secrets, "local", provider);
