import * as vscode from "vscode";
import { api } from "./api";
import { getStoredToken } from "./auth";

/**
 * Part II Phase 29 — split into two real panels (Security, Agent), not one
 * combined tree the way Phase 28's extension-sidebar version was: the
 * whole point of "first-class, not a sidebar bolted on" is that each has
 * its own always-visible, dedicated view, matching how VS Code's own
 * built-in Source Control / Debug views are separate panels, not one
 * catch-all tree. Backed by the exact same REST endpoints the dashboard
 * and Phase 28's extension already call — no parallel API surface.
 */
class TreeItem extends vscode.TreeItem {
  constructor(label: string, commandId?: string, args?: unknown[]) {
    super(label, vscode.TreeItemCollapsibleState.None);
    if (commandId) this.command = { command: commandId, title: label, arguments: args };
  }
}

abstract class CodeIntelyTreeBase implements vscode.TreeDataProvider<TreeItem> {
  protected emitter = new vscode.EventEmitter<TreeItem | undefined>();
  onDidChangeTreeData = this.emitter.event;

  constructor(protected secrets: vscode.SecretStorage) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  abstract getChildren(): Promise<TreeItem[]>;
}

export class SecurityPanelProvider extends CodeIntelyTreeBase {
  async getChildren(): Promise<TreeItem[]> {
    const token = await getStoredToken(this.secrets);
    if (!token) return [new TreeItem("Sign in to CodeIntely to see findings", "codeintely.authorize")];
    const findings = await api.listFindings(token);
    const open = findings.filter((f: any) => f.status === "OPEN");
    if (open.length === 0) return [new TreeItem("No open findings.")];
    return open.slice(0, 50).map((f: any) => new TreeItem(`${f.severity} · ${f.rule_id} — ${f.file_path}:${f.line_number ?? "?"}`));
  }
}

export class AgentPanelProvider extends CodeIntelyTreeBase {
  async getChildren(): Promise<TreeItem[]> {
    const token = await getStoredToken(this.secrets);
    if (!token) return [new TreeItem("Sign in to CodeIntely to see agent tasks", "codeintely.authorize")];

    const newChat = new TreeItem("$(comment-discussion) New Agent Chat Session…", "codeintely.openAgentChat");
    const [sessions, tasks] = await Promise.all([api.listAgentSessions(token), api.listAgentTasks(token)]);

    const sessionItems = sessions
      .slice(0, 10)
      .map((s: any) => new TreeItem(`Chat #${s.id} [${s.status}] ${s.repository}`, "codeintely.openAgentChat", [s.id]));

    const taskItems = tasks.length
      ? tasks.slice(0, 20).map((t: any) => new TreeItem(`#${t.id} [${t.status}] ${t.description.slice(0, 60)}`))
      : [new TreeItem("No single-shot agent tasks yet — run \"CodeIntely: Agent\" to start one.")];

    return [newChat, ...sessionItems, ...taskItems];
  }
}
