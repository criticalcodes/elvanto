/**
 * A self-contained web chat page.
 *
 * One HTML string with inline CSS and JS, and no build step, bundler, framework or
 * external asset. That is a deliberate ceiling on ambition: this exists so
 * `serve` gives you something to talk to in a browser immediately, on Node and on
 * Workers alike, without adding a front-end toolchain to an agent project.
 *
 * For a real application, use `@flue/react`'s `useFlueAgent()` — it reconstructs
 * the transcript from durable events, streams partial text, and renders tool parts
 * properly. This page polls, which is enough for one person asking one question at
 * a time and no more than that.
 *
 * It speaks the documented wire protocol directly:
 *   POST /:id            → 202 with a submissionId
 *   GET  /:id            → a materialized snapshot; poll until that id settles
 */
export interface WebChatOptions {
  /** Where the agent router is mounted, e.g. `/agents/wpcc`. */
  mount: string
  /** Shown in the header. */
  title: string
  /** Conversation id the page opens. */
  conversationId: string
  /** Name of the signed-in person, when the deployment signs people in. */
  signedInAs?: string
  /** Where the sign-out button posts to. Shown only alongside `signedInAs`. */
  logoutUrl?: string
  /**
   * The signed-in person's Elvanto id, sent as `initialData` with the first
   * message so the agent knows whose grant to read.
   *
   * Not a credential — the grant it points at is held server-side — and it is
   * checked against the session by the guard in front of the mount, so a page
   * that claimed someone else's id would be refused rather than believed.
   */
  personId?: string
}

export function webChatPage(options: WebChatOptions): string {
  // JSON-encoded rather than interpolated raw: a mount path or title containing a
  // quote would otherwise break out of the script.
  const config = JSON.stringify({
    mount: options.mount.replace(/\/$/, ''),
    conversationId: options.conversationId,
    ...(options.personId ? { personId: options.personId } : {}),
  })

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa; --fg: #1a1a18; --muted: #6b6b66;
    --line: #e4e4e0; --user: #ecebe6; --card: #ffffff; --accent: #3d6b52;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #17181a; --fg: #e8e8e4; --muted: #97978f;
      --line: #2c2d30; --user: #24262a; --card: #1d1e21; --accent: #7fb096;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
    display: flex; flex-direction: column; height: 100dvh;
  }
  header {
    padding: .85rem 1.1rem; border-bottom: 1px solid var(--line);
    display: flex; align-items: baseline; gap: .6rem; flex: none;
  }
  header h1 { font-size: .95rem; font-weight: 600; margin: 0; letter-spacing: -.01em; }
  header span { color: var(--muted); font-size: .78rem; font-family: ui-monospace, monospace; }
  header .who { margin-left: auto; font-family: inherit; }
  header .out { margin: 0; }
  header .out button {
    background: none; color: var(--muted); border: 1px solid var(--line);
    padding: .15rem .55rem; font-size: .78rem; font-weight: 400; border-radius: .4rem;
  }
  main { flex: 1; overflow-y: auto; padding: 1.1rem; }
  .wrap { max-width: 46rem; margin: 0 auto; display: flex; flex-direction: column; gap: .8rem; }
  .msg { padding: .7rem .9rem; border-radius: .6rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  .msg.user { background: var(--user); align-self: flex-end; max-width: 85%; }
  .msg.assistant { background: var(--card); border: 1px solid var(--line); }
  .msg.error { border-color: #b4553f; color: #b4553f; background: transparent; }
  .tools { color: var(--muted); font-size: .78rem; font-family: ui-monospace, monospace; padding-left: .3rem; }
  .empty { color: var(--muted); text-align: center; padding: 3rem 1rem; }
  footer { border-top: 1px solid var(--line); padding: .8rem 1.1rem; flex: none; }
  form { max-width: 46rem; margin: 0 auto; display: flex; gap: .5rem; }
  textarea {
    flex: 1; resize: none; font: inherit; color: inherit; background: var(--card);
    border: 1px solid var(--line); border-radius: .5rem; padding: .55rem .7rem;
    min-height: 2.6rem; max-height: 10rem;
  }
  textarea:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  button {
    font: inherit; font-weight: 550; padding: 0 1.1rem; border: 0; border-radius: .5rem;
    background: var(--accent); color: #fff; cursor: pointer;
  }
  button:disabled { opacity: .45; cursor: default; }
  .thinking { color: var(--muted); font-size: .82rem; }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(options.title)}</h1>
  <span id="cid"></span>
  ${
    options.signedInAs && options.logoutUrl
      ? `<span class="who">${escapeHtml(options.signedInAs)}</span>` +
        `<form method="post" action="${escapeHtml(options.logoutUrl)}" class="out">` +
        `<button type="submit">Sign out</button></form>`
      : ''
  }
</header>
<main><div class="wrap" id="log"><p class="empty">Ask a question to begin.</p></div></main>
<footer>
  <form id="form">
    <textarea id="input" rows="1" placeholder="Who is on the roster this Sunday?" autofocus></textarea>
    <button type="submit" id="send">Send</button>
  </form>
</footer>
<script>
const CONFIG = ${config};
const url = CONFIG.mount + '/' + encodeURIComponent(CONFIG.conversationId);
const log = document.getElementById('log');
const form = document.getElementById('form');
const input = document.getElementById('input');
const send = document.getElementById('send');
document.getElementById('cid').textContent = CONFIG.conversationId;

// Grow the textarea with its content, up to the CSS max.
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 'px';
});
// Enter sends; Shift-Enter is a newline.
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); }
});

function atBottom() {
  const main = document.querySelector('main');
  return main.scrollHeight - main.scrollTop - main.clientHeight < 80;
}
function scroll() {
  const main = document.querySelector('main');
  main.scrollTop = main.scrollHeight;
}

function render(messages) {
  const visible = messages.filter((m) => m.display === 'visible' && m.role !== 'system');
  if (visible.length === 0) return;

  const stick = atBottom();
  log.innerHTML = '';
  for (const message of visible) {
    const text = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\\n')
      .trim();

    // Tool calls are shown as a compact activity line rather than raw JSON: the
    // arguments are member data, and a wall of it is not what the reader wants.
    const tools = message.parts
      .filter((part) => part.type === 'dynamic-tool')
      .map((part) => part.toolName + (part.state === 'output-error' ? ' (failed)' : ''));

    if (tools.length) {
      const el = document.createElement('div');
      el.className = 'tools';
      el.textContent = '⚙ ' + [...new Set(tools)].join(', ');
      log.append(el);
    }
    if (text) {
      const el = document.createElement('div');
      el.className = 'msg ' + message.role + (message.settlement ? ' error' : '');
      el.textContent = text;
      log.append(el);
    }
  }
  if (stick) scroll();
}

async function snapshot() {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (response.status === 404) return null;   // no conversation yet
  if (!response.ok) throw new Error('read failed: ' + response.status);
  return response.json();
}

function note(message, className) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = message;
  log.append(el);
  scroll();
  return el;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = input.value.trim();
  if (!body) return;

  input.value = '';
  input.style.height = 'auto';
  send.disabled = input.disabled = true;

  // Optimistic, so typing feels immediate; the poll below replaces it with the
  // durable copy.
  if (log.querySelector('.empty')) log.innerHTML = '';
  const mine = document.createElement('div');
  mine.className = 'msg user';
  mine.textContent = body;
  log.append(mine);
  const pending = note('thinking…', 'thinking');

  try {
    // initialData is only recorded on the message that creates the conversation
    // and ignored on every later one, so sending it every time is harmless and
    // saves the page tracking whether it has been sent yet.
    const payload = { kind: 'user', body };
    if (CONFIG.personId) payload.initialData = { personId: CONFIG.personId };

    const admission = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (admission.status === 401) {
      note('Your session has ended. Reload the page to sign in again.', 'msg error');
      return;
    }
    if (!admission.ok) throw new Error('send failed: ' + admission.status);
    const { submissionId } = await admission.json();

    // Poll until this submission settles. The settlements array is the reliable
    // signal — text parts can look finished mid-turn while tools are still running.
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const data = await snapshot();
      if (!data) continue;
      render(data.messages);
      const settled = (data.settlements || []).find((s) => s.submissionId === submissionId);
      if (settled) {
        if (settled.outcome !== 'completed') {
          note('the run ' + settled.outcome, 'msg error');
        }
        break;
      }
    }
  } catch (error) {
    note(String(error && error.message ? error.message : error), 'msg error');
  } finally {
    pending.remove();
    send.disabled = input.disabled = false;
    input.focus();
  }
});

// Show any earlier turns in this conversation on load.
snapshot()
  .then((data) => { if (data) render(data.messages); })
  .catch(() => {});
</script>
</body>
</html>`
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  )
}
