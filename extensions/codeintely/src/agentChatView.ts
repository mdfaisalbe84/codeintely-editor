import * as vscode from "vscode";
import { api, currentRepositoryFullName } from "./api";
import { ensureAuthorized, getStoredToken } from "./auth";

/**
 * Docked chat, built as a real vscode.WebviewView (not agentChatPanel.ts's
 * WebviewPanel) so it lives *inside* the panel area alongside other AI-tool
 * tabs (Claude Code, Codex, etc.) instead of opening as a separate
 * main-editor-area tab — confirmed live tonight that a WebviewPanel is the
 * wrong primitive for "docked like Claude Code's own chat," and that the
 * same WebviewView approach built for the standalone vscode-extension
 * project works correctly. Supersedes agentChatPanel.ts entirely.
 *
 * A WebviewView is a single persistent surface, not one-tab-per-session —
 * so this adds a session-list screen inside the same view, with "New
 * Chat"/back navigation between the list and an active session, rather
 * than multiple simultaneous panels.
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

function needsPolling(session: any): boolean {
  if (session.status === "running") return true;
  if (session.status === "awaiting_approval" && session.plan_status !== "draft") return true;
  return false;
}

export class AgentChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codeintelyChat";

  private view?: vscode.WebviewView;
  private currentSessionId?: number;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private secrets: vscode.SecretStorage) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderHtml();
    webviewView.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    webviewView.onDidDispose(() => {
      this.disposed = true;
      if (this.pollTimer) clearTimeout(this.pollTimer);
    });
    void this.showSessionList();
  }

  async startNewFromOutside(): Promise<void> {
    if (this.view) this.view.show?.(true);
    await this.createNew();
  }

  async openExistingFromOutside(sessionId: number): Promise<void> {
    if (this.view) this.view.show?.(true);
    await this.loadSession(sessionId);
  }

  /**
   * Called after a sign-in triggered from *outside* this view (the status
   * bar "CodeIntely: Sign In" item) so the webview leaves its "signedOut"
   * screen without needing a manual reload. Only re-renders the list when
   * we're not already inside an active session — signing in again while a
   * session is open should not reset it.
   */
  async refreshAuthState(): Promise<void> {
    if (this.currentSessionId === undefined) await this.showSessionList();
  }

  private post(msg: unknown): void {
    if (this.disposed || !this.view) return;
    void this.view.webview.postMessage(msg);
  }

  private async showSessionList(): Promise<void> {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.currentSessionId = undefined;
    const token = await getStoredToken(this.secrets);
    if (!token) {
      this.post({ type: "signedOut" });
      return;
    }
    try {
      const sessions = await api.listAgentSessions(token);
      this.post({ type: "sessionList", sessions });
    } catch (err) {
      this.post({ type: "error", message: (err as Error).message });
    }
  }

  private async createNew(): Promise<void> {
    const token = await ensureAuthorized(this.secrets);
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
      this.currentSessionId = session.id;
      this.post({ type: "state", session });
      if (needsPolling(session)) this.schedulePoll();
    } catch (err) {
      vscode.window.showErrorMessage(`CodeIntely: couldn't start a chat session — ${(err as Error).message}`);
    }
  }

  private async loadSession(sessionId: number): Promise<void> {
    const token = await ensureAuthorized(this.secrets);
    if (!token) return;
    try {
      const session = await api.getAgentSession(token, sessionId);
      this.currentSessionId = sessionId;
      this.post({ type: "state", session });
      if (needsPolling(session)) this.schedulePoll();
    } catch (err) {
      vscode.window.showErrorMessage(`CodeIntely: couldn't open session #${sessionId} — ${(err as Error).message}`);
    }
  }

  private schedulePoll(): void {
    if (this.disposed) return;
    const sessionId = this.currentSessionId;
    this.pollTimer = setTimeout(async () => {
      if (this.disposed || this.currentSessionId !== sessionId) return;
      const token = await ensureAuthorized(this.secrets);
      if (!token) return;
      try {
        const session = await api.getAgentSession(token, sessionId!);
        this.post({ type: "state", session });
        if (needsPolling(session)) this.schedulePoll();
      } catch {
        this.schedulePoll();
      }
    }, POLL_MS);
  }

  private async onMessage(msg: any): Promise<void> {
    if (msg.type === "refreshList") return this.showSessionList();
    if (msg.type === "newSession") return this.createNew();
    if (msg.type === "selectSession") return this.loadSession(msg.id);
    if (msg.type === "back") return this.showSessionList();
    if (msg.type === "authorize") return void vscode.commands.executeCommand("codeintely.authorize").then(() => this.showSessionList());

    const sessionId = this.currentSessionId;
    if (sessionId === undefined) return;
    const token = await ensureAuthorized(this.secrets);
    if (!token) return;

    try {
      switch (msg.type) {
        case "send": {
          const session = await api.postSessionMessage(token, sessionId, msg.content);
          this.post({ type: "state", session });
          if (needsPolling(session)) this.schedulePoll();
          break;
        }
        case "addStep":
          await api.addPlanStep(token, sessionId, msg.description, msg.targetFiles ?? []);
          this.post({ type: "state", session: await api.getAgentSession(token, sessionId) });
          break;
        case "editStep":
          await api.editPlanStep(token, sessionId, msg.stepId, { description: msg.description });
          this.post({ type: "state", session: await api.getAgentSession(token, sessionId) });
          break;
        case "deleteStep":
          await api.deletePlanStep(token, sessionId, msg.stepId);
          this.post({ type: "state", session: await api.getAgentSession(token, sessionId) });
          break;
        case "approve": {
          const session = await api.approveSession(token, sessionId);
          this.post({ type: "state", session });
          if (needsPolling(session)) this.schedulePoll();
          break;
        }
        case "listFiles": {
          const pattern = `**/*${msg.query ?? ""}*`;
          const uris = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 30);
          const paths = uris.map((u) => vscode.workspace.asRelativePath(u));
          this.post({ type: "filesResult", requestId: msg.requestId, files: paths });
          break;
        }
        case "openPr":
          if (msg.url) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
          break;
      }
    } catch (err) {
      this.post({ type: "error", message: (err as Error).message });
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
  #sessionList { padding: 8px; overflow-y: auto; }
  #sessionList .row { padding: 6px 8px; cursor: pointer; border-radius: 3px; }
  #sessionList .row:hover { background: var(--vscode-list-hoverBackground); }
  #sessionList button { width: 100%; margin-bottom: 8px; }
  #chat { display: none; flex-direction: column; height: 100%; }
  #backRow { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
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
  <div id="sessionList">
    <button id="newChatBtn">+ New Agent Chat Session…</button>
    <div id="sessionRows"></div>
  </div>
  <div id="chat">
    <div id="backRow"><button class="secondary" id="backBtn">&larr; Sessions</button></div>
    <div id="messages"></div>
    <div id="plan" style="display:none"></div>
    <div id="status"></div>
    <div id="inputRow">
      <div id="mentionPopup"></div>
      <textarea id="inputBox" placeholder="Describe what CodeIntely's agent should do. Type @ to reference @repo, @file:, @folder:, @errors, @github#…"></textarea>
      <button id="sendBtn">Send</button>
    </div>
  </div>
<script nonce="${nonce}">
(function() {
  const vscodeApi = acquireVsCodeApi();
  const MENTION_KINDS = ${mentionData};
  const sessionListEl = document.getElementById('sessionList');
  const sessionRowsEl = document.getElementById('sessionRows');
  const chatEl = document.getElementById('chat');
  const messagesEl = document.getElementById('messages');
  const planEl = document.getElementById('plan');
  const statusEl = document.getElementById('status');
  const inputBox = document.getElementById('inputBox');
  const sendBtn = document.getElementById('sendBtn');
  const popup = document.getElementById('mentionPopup');

  let session = null;
  let mentionState = null;
  let fileListRequestSeq = 0;

  document.getElementById('newChatBtn').addEventListener('click', () => vscodeApi.postMessage({ type: 'newSession' }));
  document.getElementById('backBtn').addEventListener('click', () => vscodeApi.postMessage({ type: 'back' }));

  function showList(sessions) {
    chatEl.style.display = 'none';
    sessionListEl.style.display = 'block';
    sessionRowsEl.innerHTML = '';
    (sessions || []).forEach((s) => {
      const row = document.createElement('div');
      row.className = 'row';
      row.textContent = 'Chat #' + s.id + ' [' + s.status + '] ' + (s.created_by || 'unknown') + ' — ' + s.repository;
      row.addEventListener('click', () => vscodeApi.postMessage({ type: 'selectSession', id: s.id }));
      sessionRowsEl.appendChild(row);
    });
    if (!sessions || sessions.length === 0) {
      const empty = document.createElement('div');
      empty.style.opacity = '0.7';
      empty.style.padding = '6px 8px';
      empty.textContent = 'No chat sessions yet.';
      sessionRowsEl.appendChild(empty);
    }
  }

  function showSignedOut() {
    chatEl.style.display = 'none';
    sessionListEl.style.display = 'block';
    sessionRowsEl.innerHTML = '';
    const btn = document.createElement('button');
    btn.textContent = 'Sign in to CodeIntely';
    btn.addEventListener('click', () => vscodeApi.postMessage({ type: 'authorize' }));
    sessionRowsEl.appendChild(btn);
  }

  function render() {
    if (!session) return;
    sessionListEl.style.display = 'none';
    chatEl.style.display = 'flex';
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
        input.addEventListener('change', () => vscodeApi.postMessage({ type: 'editStep', stepId: step.id, description: input.value }));
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
    if (/\\s/.test(token)) return null;
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
    if (hashIdx !== -1) { closeMentionPopup(); return; }
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
    if (e.key === 'Enter' && !e.shiftKey && !mentionState) { e.preventDefault(); send(); }
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
    if (msg.type === 'sessionList') { session = null; showList(msg.sessions); }
    else if (msg.type === 'signedOut') { session = null; showSignedOut(); }
    else if (msg.type === 'state') { session = msg.session; render(); }
    else if (msg.type === 'filesResult' && mentionState && mentionState.requestId === msg.requestId) {
      mentionState.candidates = msg.files.map((f) => mentionState.prefix + f);
      mentionState.activeIndex = 0;
      renderMentionPopup(mentionState.candidates);
    } else if (msg.type === 'error') {
      statusEl.textContent = 'Error: ' + msg.message;
    }
  });

  vscodeApi.postMessage({ type: 'refreshList' });
})();
</script>
</body>
</html>`;
  }
}
