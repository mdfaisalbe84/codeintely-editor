import * as vscode from "vscode";
import { apiBaseUrl } from "./api";

const TOKEN_KEY = "codeintely.apiToken";

export async function getStoredToken(secrets: vscode.SecretStorage): Promise<string | undefined> {
  return secrets.get(TOKEN_KEY);
}

export async function signOut(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(TOKEN_KEY);
}

/**
 * Device-code flow (RFC 8628-flavored, backend: vscode_api/models.py::DeviceAuthRequest):
 * 1. POST /device/start/ -> {device_code, user_code, verification_url}
 * 2. Open the browser to verification_url; show the user_code so the user
 *    can type it into the dashboard's "Authorize VS Code" page.
 * 3. Poll /device/poll/ every `interval` seconds until a real token is issued.
 * 4. Store the raw token in VS Code's SecretStorage — never in settings.json,
 *    which is often committed to source control.
 */
export async function authorize(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const base = apiBaseUrl();
  const startResp = await fetch(`${base}/api/vscode/device/start/`, { method: "POST" });
  if (!startResp.ok) {
    vscode.window.showErrorMessage("CodeIntely: could not start sign-in.");
    return undefined;
  }
  const { device_code, user_code, verification_url, interval } = (await startResp.json()) as {
    device_code: string;
    user_code: string;
    verification_url: string;
    interval: number;
  };

  vscode.window.showInformationMessage(
    `CodeIntely: enter code ${user_code} at ${verification_url} (opening in your browser)`,
  );
  await vscode.env.openExternal(vscode.Uri.parse(`${verification_url}?user_code=${encodeURIComponent(user_code)}`));

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `CodeIntely: waiting for authorization (code ${user_code})`, cancellable: true },
    async (_progress, cancellationToken) => {
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        if (cancellationToken.isCancellationRequested) return undefined;
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        const pollResp = await fetch(`${base}/api/vscode/device/poll/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code }),
        });
        const data = (await pollResp.json()) as { status: string; token?: string };
        if (data.status === "approved" && data.token) {
          await secrets.store(TOKEN_KEY, data.token);
          vscode.window.showInformationMessage("CodeIntely: signed in.");
          return data.token;
        }
        if (data.status === "expired") {
          vscode.window.showWarningMessage("CodeIntely: sign-in code expired — try again.");
          return undefined;
        }
      }
      vscode.window.showWarningMessage("CodeIntely: sign-in timed out — try again.");
      return undefined;
    },
  );
}

export async function ensureAuthorized(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const existing = await getStoredToken(secrets);
  if (existing) return existing;
  return authorize(secrets);
}
