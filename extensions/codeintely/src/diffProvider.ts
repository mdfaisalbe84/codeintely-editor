import * as vscode from "vscode";

/**
 * Backs `vscode.diff`'s "proposed" side with in-memory content — no temp
 * file on disk, matching the plan's "inline diff review via VS Code's
 * native vscode.diff/WorkspaceEdit APIs, not a custom diff renderer."
 */
export class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private content = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this.emitter.event;

  static SCHEME = "codeintely-proposed";

  set(id: string, text: string): vscode.Uri {
    this.content.set(id, text);
    return vscode.Uri.parse(`${ProposedContentProvider.SCHEME}:/${id}`);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.path.replace(/^\//, "")) ?? "";
  }
}
