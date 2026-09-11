import * as vscode from "vscode";
import { api, currentRepositoryFullName } from "./api";
import { ensureAuthorized } from "./auth";

/**
 * Registers CodeIntely as a proper VS Code Chat Participant (`@codeintely`
 * in the built-in Chat view), a separate surface from `agentChatPanel.ts`'s
 * dedicated webview panel — that one keeps its full plan-approval/edit UI,
 * this one is a lighter `@`-mention bridge into the same backend session
 * for people who live in the shared Chat view instead of the Agent
 * sidebar. Reuses the exact same `/api/agent-sessions/*` endpoints — no new
 * backend behavior.
 *
 * One backend session per VS Code window for now (not per Chat-view
 * conversation — the Chat Participant API doesn't expose a stable
 * conversation id to key off of, only message history), created lazily on
 * first `@codeintely` message.
 */
let activeSessionId: number | undefined;

async function ensureSession(token: string): Promise<number | undefined> {
  if (activeSessionId !== undefined) return activeSessionId;
  const repoFullName = await currentRepositoryFullName();
  if (!repoFullName) return undefined;
  const repoId = await api.resolveRepositoryId(token, repoFullName);
  if (!repoId) return undefined;
  const session = await api.createAgentSession(token, repoId);
  activeSessionId = session.id;
  return activeSessionId;
}

export function registerChatParticipant(secrets: vscode.SecretStorage, extensionUri: vscode.Uri): vscode.ChatParticipant {
  const handler: vscode.ChatRequestHandler = async (request, _context, response) => {
    const token = await ensureAuthorized(secrets);
    if (!token) {
      response.markdown("Sign in to CodeIntely first — run **CodeIntely: Sign In** from the Command Palette.");
      return;
    }

    const sessionId = await ensureSession(token);
    if (sessionId === undefined) {
      response.markdown(
        "Couldn't determine this workspace's GitHub repository, or it isn't indexed by CodeIntely yet — open a folder that's a CodeIntely-connected GitHub repo.",
      );
      return;
    }

    response.progress("Asking CodeIntely's agent…");
    const session = await api.postSessionMessage(token, sessionId, request.prompt);
    const lastMessage = session.messages?.[session.messages.length - 1];
    response.markdown(lastMessage?.content ?? "(no response)");

    if (session.task?.steps?.length && session.plan_status === "draft") {
      response.markdown("\n\nCodeIntely has drafted a plan for this.");
      response.button({ command: "codeintely.openAgentChat", title: "Review & approve plan", arguments: [sessionId] });
    }
  };

  const participant = vscode.chat.createChatParticipant("codeintely.chat", handler);
  participant.iconPath = vscode.Uri.joinPath(extensionUri, "resources", "icon.svg");
  return participant;
}
