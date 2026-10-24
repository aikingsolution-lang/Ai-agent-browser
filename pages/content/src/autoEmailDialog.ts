/**
 * "Find HR emails" dialog shown on the JobForm Automator Automation Hub when the page asks for an
 * email extraction ("Extract Emails"). It collects the job search, starts the extension's Auto Email
 * run and shows its progress. Rendered in a closed shadow root, so the website's styles and the
 * dialog's styles never affect each other; text is only ever set with textContent.
 */

export interface AutoEmailStartResponse {
  ok: boolean;
  reason?: string;
}

export interface AutoEmailDialogHandlers {
  /** Starts a run for the search; resolves with the background's answer (null if unreachable). */
  onStart: (query: string) => Promise<AutoEmailStartResponse | null>;
  onStop: () => void;
}

export interface AutoEmailProgressUpdate {
  type: 'SCRAPING' | 'EXTRACTING' | 'PROGRESS' | 'COMPLETE' | 'ERROR' | string;
  message: string;
}

const HOST_ID = 'jobform-automator-auto-email-dialog';

const START_ERRORS: Record<string, string> = {
  'signed-out': 'Sign in to the JobForm Automator extension first: open it from the toolbar and choose Login.',
  'already-running': 'An email search is already running. Wait for it to finish or stop it first.',
  'invalid-query': 'Enter a job title or search (up to 200 characters).',
};

const STYLES = `
  :host { all: initial; }
  .backdrop { position: fixed; inset: 0; z-index: 2147483646; display: flex; align-items: center; justify-content: center;
    padding: 16px; background: rgba(15, 23, 42, 0.55); font-family: Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
  .dialog { width: 100%; max-width: 420px; box-sizing: border-box; background: #fff; color: #0f172a; border-radius: 16px;
    box-shadow: 0 24px 60px rgba(15, 23, 42, 0.25); padding: 24px; }
  .brand { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: #1e76e8; margin: 0 0 12px; }
  .dot { width: 8px; height: 8px; border-radius: 999px; background: #1e76e8; }
  h2 { margin: 0 0 4px; font-size: 20px; font-weight: 700; line-height: 1.3; }
  p { margin: 0; font-size: 14px; line-height: 1.5; color: #475569; }
  label { display: block; margin: 18px 0 6px; font-size: 13px; font-weight: 600; color: #334155; }
  input { width: 100%; box-sizing: border-box; padding: 11px 12px; font: inherit; font-size: 14px; color: #0f172a;
    border: 1px solid #cbd5e1; border-radius: 10px; outline: none; background: #fff; }
  input:focus { border-color: #1e76e8; box-shadow: 0 0 0 3px rgba(30, 118, 232, 0.18); }
  .status { margin-top: 16px; padding: 12px; border-radius: 10px; font-size: 13px; line-height: 1.5; background: #f1f5f9; color: #334155; }
  .status.error { background: #fef2f2; color: #b91c1c; }
  .status.done { background: #ecfdf5; color: #047857; }
  .note { margin-top: 10px; font-size: 12px; color: #64748b; }
  .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
  button { font: inherit; font-size: 14px; font-weight: 600; padding: 10px 18px; border-radius: 10px; cursor: pointer; border: 1px solid transparent; }
  button:disabled { opacity: 0.6; cursor: not-allowed; }
  .primary { background: #1e76e8; color: #fff; }
  .primary:hover:not(:disabled) { background: #1a65c6; }
  .secondary { background: #fff; color: #334155; border-color: #cbd5e1; }
  .secondary:hover:not(:disabled) { background: #f8fafc; }
  .danger { background: #fff; color: #b91c1c; border-color: #fecaca; }
  .danger:hover:not(:disabled) { background: #fef2f2; }
  .spinner { display: inline-block; width: 12px; height: 12px; margin-right: 8px; vertical-align: -2px; border-radius: 999px;
    border: 2px solid #cbd5e1; border-top-color: #1e76e8; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
`;

type View = 'form' | 'running' | 'done' | 'error';

interface DialogState {
  host: HTMLElement;
  render: (view: View, text?: string) => void;
  view: View;
  onKeyDown: (event: KeyboardEvent) => void;
}

let current: DialogState | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string> } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  return node;
}

export function closeAutoEmailDialog(): void {
  if (!current) return;
  document.removeEventListener('keydown', current.onKeyDown, true);
  current.host.remove();
  current = null;
}

/** Opens the dialog (or brings back the open one). */
export function openAutoEmailDialog(handlers: AutoEmailDialogHandlers): void {
  if (current) return;

  const host = el('div', { attrs: { id: HOST_ID } });
  const root = host.attachShadow({ mode: 'closed' });
  root.appendChild(el('style', { text: STYLES }));

  const backdrop = el('div', { className: 'backdrop' });
  const dialog = el('div', {
    className: 'dialog',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'jfa-auto-email-title' },
  });
  backdrop.appendChild(dialog);
  root.appendChild(backdrop);

  let lastQuery = '';

  const render = (view: View, text?: string) => {
    if (current) current.view = view;
    dialog.replaceChildren();

    const brand = el('p', { className: 'brand' });
    brand.append(el('span', { className: 'dot' }), document.createTextNode('JobForm Automator'));
    dialog.append(brand, el('h2', { text: 'Find HR emails', attrs: { id: 'jfa-auto-email-title' } }));

    const actions = el('div', { className: 'actions' });

    if (view === 'form') {
      dialog.append(
        el('p', {
          text: 'Search jobs on Google and collect the HR email of each company. Results appear on this page.',
        }),
      );
      const label = el('label', { text: 'Job title and location', attrs: { for: 'jfa-auto-email-query' } });
      const input = el('input', {
        attrs: {
          id: 'jfa-auto-email-query',
          type: 'text',
          maxlength: '200',
          placeholder: 'e.g. React Developer Bangalore',
          autocomplete: 'off',
        },
      });
      input.value = lastQuery;
      const errorBox = el('div', { className: 'status error', attrs: { role: 'alert', hidden: '' } });
      if (text) {
        errorBox.textContent = text;
        errorBox.removeAttribute('hidden');
      }
      const cancel = el('button', { className: 'secondary', text: 'Cancel', attrs: { type: 'button' } });
      const start = el('button', { className: 'primary', text: 'Start', attrs: { type: 'button' } });

      const submit = async () => {
        const query = input.value.trim();
        if (!query) {
          errorBox.textContent = START_ERRORS['invalid-query'];
          errorBox.removeAttribute('hidden');
          input.focus();
          return;
        }
        lastQuery = query;
        start.disabled = true;
        cancel.disabled = true;
        const response = await handlers.onStart(query);
        if (!current) return; // closed meanwhile
        if (response?.ok) {
          render('running', `Searching Google Jobs for “${query}”…`);
        } else {
          render(
            'form',
            (response?.reason && START_ERRORS[response.reason]) ||
              'Could not start the email search. Reload this page and try again.',
          );
        }
      };

      cancel.addEventListener('click', closeAutoEmailDialog);
      start.addEventListener('click', submit);
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') submit();
      });
      actions.append(cancel, start);
      dialog.append(label, input, errorBox, actions);
      setTimeout(() => input.focus(), 0);
      return;
    }

    if (view === 'running') {
      dialog.append(
        el('p', { text: 'A Google tab opens to collect the jobs. Keep it open; you can keep using this page.' }),
      );
      const status = el('div', { className: 'status', attrs: { role: 'status', 'aria-live': 'polite' } });
      status.append(
        el('span', { className: 'spinner', attrs: { 'aria-hidden': 'true' } }),
        document.createTextNode(text ?? ''),
      );
      dialog.append(
        status,
        el('p', {
          className: 'note',
          text: 'The emails are added to Applications on this page when the search finishes.',
        }),
      );
      const stop = el('button', { className: 'danger', text: 'Stop', attrs: { type: 'button' } });
      const hide = el('button', { className: 'secondary', text: 'Hide', attrs: { type: 'button' } });
      stop.addEventListener('click', () => {
        handlers.onStop();
        stop.disabled = true;
        stop.textContent = 'Stopping…';
      });
      hide.addEventListener('click', closeAutoEmailDialog);
      actions.append(stop, hide);
      dialog.append(actions);
      setTimeout(() => hide.focus(), 0);
      return;
    }

    // done / error
    dialog.append(
      el('div', {
        className: view === 'done' ? 'status done' : 'status error',
        text: text ?? '',
        attrs: { role: view === 'done' ? 'status' : 'alert' },
      }),
    );
    const close = el('button', {
      className: view === 'done' ? 'primary' : 'secondary',
      text: 'Close',
      attrs: { type: 'button' },
    });
    close.addEventListener('click', closeAutoEmailDialog);
    if (view === 'error') {
      const retry = el('button', { className: 'primary', text: 'Try again', attrs: { type: 'button' } });
      retry.addEventListener('click', () => render('form'));
      actions.append(close, retry);
    } else {
      actions.append(close);
    }
    dialog.append(actions);
    setTimeout(() => close.focus(), 0);
  };

  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) closeAutoEmailDialog();
  });
  // On the document, so Escape works wherever focus is (focus can drop to the page when a view changes)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') closeAutoEmailDialog();
  };
  document.addEventListener('keydown', onKeyDown, true);

  current = { host, render, view: 'form', onKeyDown };
  document.documentElement.appendChild(host);
  render('form');
}

/** Shows run progress in the open dialog (a closed dialog stays closed; the run continues). */
export function updateAutoEmailDialog(progress: AutoEmailProgressUpdate): void {
  if (!current || typeof progress?.message !== 'string') return;
  if (progress.type === 'COMPLETE') current.render('done', progress.message);
  else if (progress.type === 'ERROR') current.render('error', progress.message);
  else current.render('running', progress.message);
}
