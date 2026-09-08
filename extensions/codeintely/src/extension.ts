import * as vscode from "vscode";
import { authorize } from "./auth";
import { askCommand } from "./commands/ask";
import { explainCommand } from "./commands/explain";
import { editCommand } from "./commands/edit";
import { agentRemoteCommand, agentLocalCommand } from "./commands/agent";
import { fixCommand } from "./commands/fix";
import { testCommand } from "./commands/test";
import { secureCommand, scanOnSave } from "./commands/secure";
import { ProposedContentProvider } from "./diffProvider";
import { SecurityPanelProvider, AgentPanelProvider } from "./sidebar";
import { AgentChatPanel } from "./agentChatPanel";
import { initLicenseStatusBar, refreshLicenseNow, requireAgentLicense } from "./license";

/**
 * Part II Phase 29 — CodeIntely as a built-in extension of the CodeIntely
 * editor (a VS Code OSS fork), not an optional Marketplace install the way
 * Phase 28 shipped it. Same extension API, same command logic (ported
 * near-verbatim from vscode-extension/src/) — the "first-class" part is
 * this extension being bundled and always active by default, plus two
 * separate always-visible panels instead of one combined sidebar tree.
 */
export function activate(context: vscode.ExtensionContext) {
  const secrets = context.secrets;
  const proposedContentProvider = new ProposedContentProvider();
  const diagnostics = vscode.languages.createDiagnosticCollection("codeintely");
  const securityProvider = new SecurityPanelProvider(secrets);
  const agentProvider = new AgentPanelProvider(secrets);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ProposedContentProvider.SCHEME, proposedContentProvider),
    diagnostics,
    vscode.window.registerTreeDataProvider("codeintelySecurity", securityProvider),
    vscode.window.registerTreeDataProvider("codeintelyAgent", agentProvider),

    vscode.commands.registerCommand("codeintely.authorize", async () => {
      await authorize(secrets);
      await refreshLicenseNow(secrets);
    }),
    vscode.commands.registerCommand("codeintely.ask", () => askCommand(secrets)),
    vscode.commands.registerCommand("codeintely.explain", () => explainCommand(secrets)),
    vscode.commands.registerCommand("codeintely.edit", () => editCommand(secrets, proposedContentProvider)),
    vscode.commands.registerCommand("codeintely.agentRemote", async () => {
      if (await requireAgentLicense()) await agentRemoteCommand(secrets, proposedContentProvider);
    }),
    vscode.commands.registerCommand("codeintely.agentLocal", async () => {
      if (await requireAgentLicense()) await agentLocalCommand(secrets, proposedContentProvider);
    }),
    vscode.commands.registerCommand("codeintely.fix", () => fixCommand(secrets, proposedContentProvider)),
    vscode.commands.registerCommand("codeintely.test", () => testCommand(secrets)),
    vscode.commands.registerCommand("codeintely.secure", () => secureCommand(secrets, diagnostics)),
    vscode.commands.registerCommand("codeintely.openAgentChat", async (sessionId?: number) => {
      if (!(await requireAgentLicense())) return;
      if (sessionId === undefined) await AgentChatPanel.openNew(secrets);
      else await AgentChatPanel.openExisting(secrets, sessionId);
    }),
    vscode.commands.registerCommand("codeintely.refresh", () => {
      securityProvider.refresh();
      agentProvider.refresh();
    }),

    vscode.workspace.onDidSaveTextDocument((document) => scanOnSave(document, secrets, diagnostics)),
  );

  initLicenseStatusBar(context, secrets);
}

export function deactivate() {}
