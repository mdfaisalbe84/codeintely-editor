import * as vscode from "vscode";
import { api, currentRepositoryFullName } from "./api";
import { ensureAuthorized } from "./auth";

/**
 * Part II Phase 29 — the Agent panel's chat UI, reimplemented as a native
 * editor panel (a real `WebviewPanel`, not a webview iframe of the React
 * dashboard) against the exact same Phase 27 REST endpoints `AgentChat.tsx`
 * already calls. Two things this phase's editor-native surface adds over
 * Phase 27's web version: a real `@`-mention autocomplete popup (Phase 27
 * shipped only a plain-text hint) and inline plan approval/editing with no
 * "open the dashboard" round-trip — both built here, no new backend calls.
 */

const MENTION_KINDS: { insert: string; detail: string; dynamic?: "file" | "folder" }[] = [
  { insert: "repo", detail: "Repo architecture summary" },
  { insert: "errors", detail: "Most recent CI failure logs" },
  { insert: "terminal", detail: "Most recent sandbox run output" },
  { insert: "file:", detail: "Reference a specific file", dynamic: "file" },
  { insert: "folder:", detail: "Reference a folder", dynamic: "folder" },
  { insert: "github#", detail: "Reference a GitHub issue/PR by number" },
];

const POLL_MS = 3000;

/**
 * `session.status` flips to "awaiting_approval" the instant a `CodingTask`
 * is created (`agent/session_chat.py`) — well before plan generation (a
 * separate, async `run_coding_task_async` Celery job) actually finishes.
 * Found live: polling only on `status === "running"` meant a completed
 * plan never appeared in the panel — the state landed server-side but
 * nothing fetched it. Also keep polling once approved, until the run
 * reaches a real terminal `session.plan_status` ("draft" means still
 * mid-generation, not yet reviewable).
 */
function needsPolling(session: any): boolean {
  if (session.status === "running") return true;
  if (session.status === "awaiting_approval" && session.plan_status !== "draft") return true;
  return false;
}

export class AgentChatPanel {
  private static panels = new Map<number, AgentChatPanel>();

  private readonly panel: vscode.WebviewPanel;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  static async openNew(secrets: vscode.SecretStorage): Promise<void> {
    const token = await ensureAuthorized(secrets);
    if (!token) return;
    const repoFullName = await currentRepositoryFullName();
    if (!repoFullName) {
      vscode.window.showErrorMessage("CodeIntely: couldn't determine this workspace's GitHub repository.");
      return;
    }
    const repoId = await api.resolveRepositoryId(token, repoFullName);
    if (!repoId) {
      vscode.window.showErrorMessage(`CodeIntely: ${repoFullName} isn't indexed by CodeIntely yet.`);
      return;
    }
    try {
      const session = await api.createAgentSession(token, repoId);
      new AgentChatPanel(secrets, session);
    } catch (err) {
      vscode.window.showErrorMessage(`CodeIntely: couldn't start a chat session — ${(err as Error).message}`);
    }
  }

  static async openExisting(secrets: vscode.SecretStorage, sessionId: number): Promise<void> {
    const existing = AgentChatPanel.panels.get(sessionId);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const token = await ensureAuthorized(secrets);
    if (!token) return;
    try {
      const session = await api.getAgentSession(token, sessionId);
      new AgentChatPanel(secrets, session);
    } catch (err) {
      vscode.window.showErrorMessage(`CodeIntely: couldn't open session #${sessionId} — ${(err as Error).message}`);
    }
  }

  private constructor(private secrets: vscode.SecretStorage, session: any) {
    this.panel = vscode.window.createWebviewPanel(
      "codeintelyAgentChat",
      `CodeIntely Agent — ${session.repository} #${session.id}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    AgentChatPanel.panels.set(session.id, this);

    this.panel.webview.html = this.renderHtml();
    this.panel.webview.onDidReceiveMessage((msg) => void this.onMessage(session.id, msg));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (this.pollTimer) clearTimeout(this.pollTimer);
      AgentChatPanel.panels.delete(session.id);
    });

    this.pushState(session);
    if (needsPolling(session)) this.schedulePoll(session.id);
  }

  private pushState(session: any): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({ type: "state", session });
  }

  private schedulePoll(sessionId: number): void {
    if (this.disposed) return;
    this.pollTimer = setTimeout(async () => {
      if (this.disposed) return;
      const token = await ensureAuthorized(this.secrets);
      if (!token) return;
      try {
        const session = await api.getAgentSession(token, sessionId);
        this.pushState(session);
        if (needsPolling(session)) this.schedulePoll(sessionId);
      } catch {
        this.schedulePoll(sessionId); // transient network hiccup — keep polling, don't give up silently
      }
    }, POLL_MS);
  }

  private async onMessage(sessionId: number, msg: any): Promise<void> {
    const token = await ensureAuthorized(this.secrets);
    if (!token) return;

    try {
      switch (msg.type) {
        case "send": {
          const session = await api.postSessionMessage(token, sessionId, msg.content);
          this.pushState(session);
          if (needsPolling(session)) this.schedulePoll(sessionId);
          break;
        }
        case "addStep": {
          await api.addPlanStep(token, sessionId, msg.description, msg.targetFiles ?? []);
          this.pushState(await api.getAgentSession(token, sessionId));
          break;
        }
        case "editStep": {
          await api.editPlanStep(token, sessionId, msg.stepId, { description: msg.description });
          this.pushState(await api.getAgentSession(token, sessionId));
          break;
        }
        case "deleteStep": {
          await api.deletePlanStep(token, sessionId, msg.stepId);
          this.pushState(await api.getAgentSession(token, sessionId));
          break;
        }
        case "approve": {
          const session = await api.approveSession(token, sessionId);
          this.pushState(session);
          if (needsPolling(session)) this.schedulePoll(sessionId);
          break;
        }
        case "listFiles": {
          const pattern = `**/*${msg.query ?? ""}*`;
          const uris = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 30);
          const paths = uris.map((u) => vscode.workspace.asRelativePath(u));
          void this.panel.webview.postMessage({ type: "filesResult", requestId: msg.requestId, files: paths });
          break;
        }
        case "openPr": {
          if (msg.url) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
          break;
        }
      }
    } catch (err) {
      void this.panel.webview.postMessage({ type: "error", message: (err as Error).message });
    }
  }

  private renderHtml(): string {
    const nonce = Array.from({ length: 32 }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 62)]).join("");
    const mentionData = JSON.stringify(MENTION_KINDS);
    return `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; display: flex; flex-direction: column; height: 100vh; }
  #messages { flex: 1; overflow-y: auto; padding: 12px; }
  .msg { margin-bottom: 12px; white-space: pre-wrap; }
  .msg .role { font-weight: 600; opacity: 0.75; margin-right: 6px; }
  .msg.user .role { color: var(--vscode-textLink-foreground); }
  #plan { border-top: 1px solid var(--vscode-panel-border); padding: 10px 12px; }
  #plan h3 { margin: 0 0 8px 0; font-size: 12px; text-transform: uppercase; opacity: 0.7; }
  .step { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .step input[type=text] { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 3px 6px; }
  .step-status { font-size: 11px; opacity: 0.7; min-width: 90px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 4px 10px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  #approveRow { margin-top: 8px; display: flex; gap: 8px; align-items: center; }
  #inputRow { position: relative; border-top: 1px solid var(--vscode-panel-border); padding: 10px 12px; display: flex; gap: 8px; }
  #inputBox { flex: 1; min-height: 32px; max-height: 120px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); padding: 6px; font-family: inherit; }
  #mentionPopup { position: absolute; bottom: 100%; left: 12px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-editorWidget-border); max-height: 160px; overflow-y: auto; min-width: 220px; display: none; }
  #mentionPopup .item { padding: 4px 8px; cursor: pointer; }
  #mentionPopup .item.active, #mentionPopup .item:hover { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  #status { padding: 4px 12px; font-size: 11px; opacity: 0.7; }
</style>
</head>
<body>
  <div id="messages"></div>
  <div id="plan" style="display:none"></div>
  <div id="status"></div>
  <div id="inputRow">
    <div id="mentionPopup"></div>
    <textarea id="inputBox" placeholder="Describe what CodeIntely's agent should do. Type @ to reference @repo, @file:, @folder:, @errors, @github#…"></textarea>
    <button id="sendBtn">Send</button>
  </div>
<script nonce="${nonce}">
(function() {
  const vscodeApi = acquireVsCodeApi();
  const MENTION_KINDS = ${mentionData};
  const messagesEl = document.getElementById('messages');
  const planEl = document.getElementById('plan');
  const statusEl = document.getElementById('status');
  const inputBox = document.getElementById('inputBox');
  const sendBtn = document.getElementById('sendBtn');
  const popup = document.getElementById('mentionPopup');

  let session = null;
  let mentionState = null; // { start, query, activeIndex, candidates }
  let fileListRequestSeq = 0;

  function render() {
    if (!session) return;
    messagesEl.innerHTML = '';
    for (const m of session.messages || []) {
      const div = document.createElement('div');
      div.className = 'msg ' + m.role;
      const roleLabel = document.createElement('span');
      roleLabel.className = 'role';
      roleLabel.textContent = m.role === 'user' ? 'You' : 'CodeIntely';
      div.appendChild(roleLabel);
      div.appendChild(document.createTextNode(m.content));
      messagesEl.appendChild(div);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;

    renderPlan();
    statusEl.textContent = 'Session status: ' + session.status + (session.task ? (' · task: ' + session.task.status) : '');
  }

  function renderPlan() {
    const task = session.task;
    const plan = task && task.steps ? task : null;
    if (!task || !task.steps || task.steps.length === 0) {
      planEl.style.display = 'none';
      planEl.innerHTML = '';
      return;
    }
    planEl.style.display = 'block';
    planEl.innerHTML = '';
    const heading = document.createElement('h3');
    heading.textContent = 'Plan (' + session.plan_status + ')';
    planEl.appendChild(heading);

    for (const step of task.steps) {
      const row = document.createElement('div');
      row.className = 'step';
      const status = document.createElement('span');
      status.className = 'step-status';
      status.textContent = '[' + step.status + ']';
      row.appendChild(status);

      const isDraft = session.plan_status === 'draft';
      if (isDraft) {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = step.description;
        input.addEventListener('change', () => {
          vscodeApi.postMessage({ type: 'editStep', stepId: step.id, description: input.value });
        });
        row.appendChild(input);
        const del = document.createElement('button');
        del.className = 'secondary';
        del.textContent = 'Remove';
        del.addEventListener('click', () => vscodeApi.postMessage({ type: 'deleteStep', stepId: step.id }));
        row.appendChild(del);
      } else {
        const label = document.createElement('span');
        label.textContent = step.description;
        row.appendChild(label);
      }
      planEl.appendChild(row);
    }

    const approveRow = document.createElement('div');
    approveRow.id = 'approveRow';
    if (session.plan_status === 'draft') {
      const addBtn = document.createElement('button');
      addBtn.className = 'secondary';
      addBtn.textContent = '+ Add step';
      addBtn.addEventListener('click', () => {
        const description = prompt('Describe the new step:');
        if (description) vscodeApi.postMessage({ type: 'addStep', description, targetFiles: [] });
      });
      approveRow.appendChild(addBtn);

      const approveBtn = document.createElement('button');
      approveBtn.textContent = 'Approve & Run';
      approveBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'approve' }));
      approveRow.appendChild(approveBtn);
    } else if (task.status === 'done' && task.pr_url) {
      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open PR';
      openBtn.addEventListener('click', () => vscodeApi.postMessage({ type: 'openPr', url: task.pr_url }));
      approveRow.appendChild(openBtn);
    } else if (task.status === 'failed') {
      const failLabel = document.createElement('span');
      failLabel.textContent = 'Failed: ' + (task.last_error || 'unknown error');
      approveRow.appendChild(failLabel);
    }
    planEl.appendChild(approveRow);
  }

  function currentMentionQuery() {
    const value = inputBox.value;
    const caret = inputBox.selectionStart;
    const uptoCaret = value.slice(0, caret);
    const at = uptoCaret.lastIndexOf('@');
    if (at === -1) return null;
    const token = uptoCaret.slice(at + 1);
    if (/\\s/.test(token)) return null; // '@' no longer part of the token being typed
    return { start: at, query: token };
  }

  function closeMentionPopup() {
    mentionState = null;
    popup.style.display = 'none';
    popup.innerHTML = '';
  }

  function renderMentionPopup(candidates) {
    popup.innerHTML = '';
    candidates.forEach((c, i) => {
      const item = document.createElement('div');
      item.className = 'item' + (i === mentionState.activeIndex ? ' active' : '');
      item.textContent = '@' + c;
      item.addEventListener('mousedown', (e) => { e.preventDefault(); applyMention(c); });
      popup.appendChild(item);
    });
    popup.style.display = candidates.length ? 'block' : 'none';
  }

  function applyMention(value) {
    if (!mentionState) return;
    const before = inputBox.value.slice(0, mentionState.start);
    const after = inputBox.value.slice(mentionState.start + 1 + mentionState.query.length);
    const insertTrailingSpace = !value.endsWith(':') && !value.endsWith('#');
    const mentionText = '@' + value + (insertTrailingSpace ? ' ' : '');
    inputBox.value = before + mentionText + after;
    const caret = (before + mentionText).length;
    inputBox.setSelectionRange(caret, caret);
    closeMentionPopup();
    inputBox.focus();
  }

  function updateMentionPopup() {
    const found = currentMentionQuery();
    if (!found) { closeMentionPopup(); return; }

    const colonIdx = found.query.indexOf(':');
    const hashIdx = found.query.indexOf('#');
    if (colonIdx !== -1) {
      const kind = found.query.slice(0, colonIdx);
      const kindDef = MENTION_KINDS.find((k) => k.insert === kind + ':');
      if (!kindDef || !kindDef.dynamic) { closeMentionPopup(); return; }
      const partial = found.query.slice(colonIdx + 1);
      mentionState = { start: found.start, query: found.query, activeIndex: 0, candidates: [] };
      const requestId = 'req' + (++fileListRequestSeq);
      mentionState.requestId = requestId;
      mentionState.prefix = kind + ':';
      vscodeApi.postMessage({ type: 'listFiles', query: partial, requestId });
      popup.style.display = 'block';
      popup.innerHTML = '<div class="item">searching…</div>';
      return;
    }
    if (hashIdx !== -1) { closeMentionPopup(); return; } // github#<N> — user types the number directly, nothing to suggest

    const matches = MENTION_KINDS.filter((k) => k.insert.startsWith(found.query)).map((k) => k.insert);
    if (matches.length === 0) { closeMentionPopup(); return; }
    mentionState = { start: found.start, query: found.query, activeIndex: 0, candidates: matches };
    renderMentionPopup(matches);
  }

  inputBox.addEventListener('input', updateMentionPopup);
  inputBox.addEventListener('keydown', (e) => {
    if (mentionState && mentionState.candidates && mentionState.candidates.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionState.activeIndex = (mentionState.activeIndex + 1) % mentionState.candidates.length; renderMentionPopup(mentionState.candidates); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionState.activeIndex = (mentionState.activeIndex - 1 + mentionState.candidates.length) % mentionState.candidates.length; renderMentionPopup(mentionState.candidates); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(mentionState.candidates[mentionState.activeIndex]); return; }
      if (e.key === 'Escape') { closeMentionPopup(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !mentionState) {
      e.preventDefault();
      send();
    }
  });

  function send() {
    const content = inputBox.value.trim();
    if (!content) return;
    vscodeApi.postMessage({ type: 'send', content });
    inputBox.value = '';
    closeMentionPopup();
  }
  sendBtn.addEventListener('click', send);

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'state') {
      session = msg.session;
      render();
    } else if (msg.type === 'filesResult' && mentionState && mentionState.requestId === msg.requestId) {
      mentionState.candidates = msg.files.map((f) => mentionState.prefix + f);
      mentionState.activeIndex = 0;
      renderMentionPopup(mentionState.candidates);
    } else if (msg.type === 'error') {
      statusEl.textContent = 'Error: ' + msg.message;
    }
  });
})();
</script>
</body>
</html>`;
  }
}
