import * as vscode from "vscode";

export function apiBaseUrl(): string {
  return vscode.workspace.getConfiguration("codeintely").get<string>("apiBaseUrl", "http://localhost:8000");
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(token: string, path: string, body?: unknown, method?: "GET" | "POST" | "PATCH" | "DELETE"): Promise<T> {
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail: any = await res.json().catch(() => null);
    throw new ApiError(res.status, (detail && (detail.error || detail.detail)) || `${path} failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Best-effort git remote -> "owner/repo", read directly from .git/config
 * rather than depending on VS Code's built-in Git extension API surface
 * (simpler, no extension-to-extension dependency for one string).
 */
export async function currentRepositoryFullName(): Promise<string | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  try {
    const configUri = vscode.Uri.joinPath(folder.uri, ".git", "config");
    const bytes = await vscode.workspace.fs.readFile(configUri);
    const text = Buffer.from(bytes).toString("utf-8");
    const match = text.match(/github\.com[:/]([^/\s]+\/[^/\s.]+)(?:\.git)?/);
    return match ? match[1] : undefined;
  } catch {
    return undefined;
  }
}

export interface AskResult {
  answer: string;
  sources: string[];
}
export interface ExplainResult {
  explanation: string;
}
export interface EditResult {
  patch_diff: string;
  patched_content: string | null;
}
export interface FixResult {
  patch_diff: string;
  explanation: string;
  patched_content: string | null;
}
export interface TestResult {
  test_code: string;
  framework: string;
  explanation: string;
}
export interface SecureFinding {
  rule_id: string;
  severity: string;
  file_path: string;
  line_number: number | null;
  message: string;
  scanner: string;
}

export const api = {
  ask: (token: string, repository_full_name: string, question: string) =>
    request<AskResult>(token, "/api/vscode/ask/", { repository_full_name, question }),
  explain: (token: string, repository_full_name: string, file_path: string, selection_text: string) =>
    request<ExplainResult>(token, "/api/vscode/explain/", { repository_full_name, file_path, selection_text }),
  edit: (token: string, repository_full_name: string, file_path: string, current_content: string, instruction: string) =>
    request<EditResult>(token, "/api/vscode/edit/", { repository_full_name, file_path, current_content, instruction }),
  fix: (token: string, finding_type: string, finding_id: number, current_content?: string) =>
    request<FixResult>(token, "/api/vscode/fix/", { finding_type, finding_id, current_content }),
  test: (token: string, finding_type: string, finding_id: number, patch_diff: string) =>
    request<TestResult>(token, "/api/vscode/test/", { finding_type, finding_id, patch_diff }),
  secure: (token: string, files: { path: string; content: string }[]) =>
    request<{ findings: SecureFinding[] }>(token, "/api/vscode/secure/", { files }),
  createAgentTask: (token: string, repository_full_name: string, description: string, output_mode: "pr" | "local") =>
    request<{ id: number }>(token, "/api/agent-tasks/", { repository_full_name, description, output_mode }),
  getAgentTask: (token: string, id: number) => request<any>(token, `/api/agent-tasks/${id}/`),
  listAgentTasks: (token: string) => request<any[]>(token, "/api/agent-tasks/"),
  listFindings: (token: string) => request<any[]>(token, "/api/findings/"),

  // Part II Phase 29 — Agent panel: the same Phase 27 chat-session REST
  // surface the web dashboard's AgentChat.tsx already calls (no new
  // backend behavior, just a native-panel port of the interaction design).
  // AgentSession is created against a Repository *id*, not its full name —
  // resolve the workspace's "owner/repo" (from .git/config) against the
  // org's real indexed repositories rather than guessing an id.
  resolveRepositoryId: async (token: string, fullName: string): Promise<number | undefined> => {
    const repos = await request<{ id: number; full_name: string }[]>(token, "/api/repositories/");
    return repos.find((r) => r.full_name.toLowerCase() === fullName.toLowerCase())?.id;
  },
  listAgentSessions: (token: string) => request<any[]>(token, "/api/agent-sessions/"),
  createAgentSession: (token: string, repository_id: number) =>
    request<any>(token, "/api/agent-sessions/", { repository: repository_id }),
  getAgentSession: (token: string, id: number) => request<any>(token, `/api/agent-sessions/${id}/`),
  postSessionMessage: (token: string, id: number, content: string) =>
    request<any>(token, `/api/agent-sessions/${id}/messages/`, { content }),
  addPlanStep: (token: string, id: number, description: string, target_files: string[]) =>
    request<any>(token, `/api/agent-sessions/${id}/plan-steps/`, { description, target_files }),
  editPlanStep: (token: string, id: number, stepId: number, patch: { description?: string; target_files?: string[]; order?: number }) =>
    request<any>(token, `/api/agent-sessions/${id}/plan-steps/${stepId}/`, patch, "PATCH"),
  deletePlanStep: (token: string, id: number, stepId: number) =>
    request<void>(token, `/api/agent-sessions/${id}/plan-steps/${stepId}/`, undefined, "DELETE"),
  approveSession: (token: string, id: number) => request<any>(token, `/api/agent-sessions/${id}/approve/`, {}),

  // Part II Phase 29 "Licensing / distribution": the same billing status
  // Billing.tsx already reads — this is a read of existing state, not a new
  // billing surface. `plan`/`plan_status` are what license.ts uses to
  // decide whether this org's token is entitled to the coding agent.
  billingStatus: (token: string) =>
    request<{ plan: string; plan_status: string; products: string[] }>(token, "/api/billing/status/"),
};
