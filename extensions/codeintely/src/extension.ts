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
import { registerChatParticipant } from "./chatParticipant";
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
    vscode.commands.registerCommand("codeintely.openAgentChat", async (sessionId?: unknown) => {
      if (!(await requireAgentLicense())) return;
      // Tree items (sidebar.ts) pass a real number as sessionId. Anything
      // else — undefined, or the context object VS Code passes when this
      // is invoked from the Agent panel's title-bar icon instead of a tree
      // item — means "no specific session", i.e. start a new one.
      // Confirmed live: `sessionId === undefined` alone let a title-bar
      // click fall through to openExisting() with a stray object, which
      // then failed with "couldn't open session #[object Object]".
      if (typeof sessionId === "number") await AgentChatPanel.openExisting(secrets, sessionId);
      else await AgentChatPanel.openNew(secrets);
    }),
    vscode.commands.registerCommand("codeintely.refresh", () => {
      securityProvider.refresh();
      agentProvider.refresh();
    }),
    // Clicking a Security panel finding — sidebar.ts previously built these
    // tree items with no `command` at all, so clicking one silently did
    // nothing (confirmed live: no error, just inert). Opens the file at
    // the finding's line, same location-resolution logic secure.ts already
    // uses for diagnostics (clamp to a valid line, 1-based -> 0-based).
    vscode.commands.registerCommand("codeintely.openFinding", async (filePath: string, lineNumber: number | null) => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return;
      try {
        const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder.uri, filePath));
        const editor = await vscode.window.showTextDocument(document);
        const line = Math.max((lineNumber ?? 1) - 1, 0);
        const range = document.lineAt(Math.min(line, document.lineCount - 1)).range;
        editor.selection = new vscode.Selection(range.start, range.start);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      } catch (err) {
        vscode.window.showErrorMessage(`CodeIntely: could not open ${filePath} (${(err as Error).message}).`);
      }
    }),

    vscode.workspace.onDidSaveTextDocument((document) => scanOnSave(document, secrets, diagnostics)),
    registerChatParticipant(secrets, context.extensionUri),
  );

  initLicenseStatusBar(context, secrets);
}

export function deactivate() {}
