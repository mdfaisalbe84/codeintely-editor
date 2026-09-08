import * as vscode from "vscode";
import { api } from "./api";
import { getStoredToken } from "./auth";

/**
 * Part II Phase 29 "Licensing / distribution": a license/org-binding check
 * embedded in the client build, needed once this is a standalone installed
 * application rather than an optional Marketplace extension (Phase 28).
 * The "binding" is implicit and server-enforced: an `ApiToken` is minted
 * per-organization by the real device flow (Phase 28), so reading
 * `/api/billing/status/` with the stored token IS the org-binding check —
 * no separate device/license key mechanism to invent or keep in sync.
 * Adapted for an always-running editor rather than a per-command token:
 * checked once at startup and periodically after, with a persistent status
 * bar item, rather than only reacting after an API call already failed.
 */

const AGENT_PLANS = new Set(["AGENT", "ENTERPRISE"]);
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export interface LicenseState {
  signedIn: boolean;
  plan?: string;
  planStatus?: string;
  agentLicensed: boolean;
}

let cached: LicenseState = { signedIn: false, agentLicensed: false };
let statusBarItem: vscode.StatusBarItem | undefined;
let refreshTimer: ReturnType<typeof setInterval> | undefined;

function dashboardBaseUrl(): string {
  return vscode.workspace.getConfiguration("codeintely").get<string>("dashboardUrl", "http://localhost:5173");
}

export function currentLicense(): LicenseState {
  return cached;
}

export function isAgentLicensed(): boolean {
  return cached.agentLicensed;
}

async function refresh(secrets: vscode.SecretStorage): Promise<void> {
  const token = await getStoredToken(secrets);
  if (!token) {
    cached = { signedIn: false, agentLicensed: false };
    render();
    return;
  }
  try {
    const status = await api.billingStatus(token);
    cached = { signedIn: true, plan: status.plan, planStatus: status.plan_status, agentLicensed: AGENT_PLANS.has(status.plan) };
  } catch {
    // A network hiccup or an expired/revoked token shouldn't flip a
    // previously-licensed session to "unlicensed" on a transient failure —
    // keep the last known state and let the next refresh (or an explicit
    // sign-in) resolve it, matching Phase 28's own "signed in" persistence.
  }
  render();
}

function render(): void {
  if (!statusBarItem) return;
  if (!cached.signedIn) {
    statusBarItem.text = "$(sign-in) CodeIntely: Sign In";
    statusBarItem.tooltip = "Sign in to CodeIntely";
    statusBarItem.command = "codeintely.authorize";
  } else if (!cached.agentLicensed) {
    statusBarItem.text = "$(warning) CodeIntely: Not Licensed";
    statusBarItem.tooltip = `Plan: ${cached.plan} — the coding agent needs the Agent or Enterprise plan.`;
    statusBarItem.command = "codeintely.openBilling";
  } else {
    statusBarItem.text = `$(check) CodeIntely: ${cached.plan}`;
    statusBarItem.tooltip = `Signed in — plan: ${cached.plan} (${cached.planStatus})`;
    statusBarItem.command = "codeintely.openBilling";
  }
  statusBarItem.show();
}

export function initLicenseStatusBar(context: vscode.ExtensionContext, secrets: vscode.SecretStorage): void {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(
    vscode.commands.registerCommand("codeintely.openBilling", () =>
      vscode.env.openExternal(vscode.Uri.parse(`${dashboardBaseUrl()}/dashboard/billing`)),
    ),
  );
  void refresh(secrets);
  refreshTimer = setInterval(() => void refresh(secrets), REFRESH_INTERVAL_MS);
  context.subscriptions.push({ dispose: () => refreshTimer && clearInterval(refreshTimer) });
}

export async function refreshLicenseNow(secrets: vscode.SecretStorage): Promise<void> {
  await refresh(secrets);
}

/** Gate for the coding-agent commands specifically (single-shot Agent
 * commands and the chat panel) — Ask/Explain/Edit/Fix/Test/Secure stay
 * available regardless, matching the real server-side gate's scope
 * (`billing/plan_gate.py::is_agent_allowed`, only ever checked before a
 * `CodingTask` is created). Client-side and advisory only: the server
 * remains authoritative and re-checks on every real request.
 */
export async function requireAgentLicense(): Promise<boolean> {
  if (!cached.signedIn) return true; // let the normal sign-in flow run and produce its own message
  if (cached.agentLicensed) return true;
  const choice = await vscode.window.showWarningMessage(
    `CodeIntely: your organization's plan (${cached.plan}) doesn't include the coding agent — upgrade to Agent or Enterprise.`,
    "View Plans",
  );
  if (choice === "View Plans") await vscode.commands.executeCommand("codeintely.openBilling");
  return false;
}
