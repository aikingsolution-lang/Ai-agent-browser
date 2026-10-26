/**
 * Shared structural, layout-independent helper to locate the active Easy Apply modal container.
 * Finds a visible <dialog>, [role="dialog"], or classic modal wrapper containing:
 * - At least one form control (input, select, textarea, fieldset, role="radiogroup", role="group", contenteditable, file upload), OR
 * - At least one forward/submit button identified by VISIBLE TEXT ('Next', 'Review', 'Submit application', 'Submit', 'Continue').
 *
 * Does NOT depend on aria-label, atomic CSS classes, or heading regexes (/apply|application|job/).
 * Classic .jobs-easy-apply-modal and .artdeco-modal layouts remain fully supported.
 */
export function findActiveEasyApplyContainer(
  root: Document | ShadowRoot | Element = typeof document !== 'undefined' ? document : (null as any),
): HTMLElement | null {
  if (!root) return null;

  function isVisible(el: HTMLElement): boolean {
    if (!el || !el.isConnected) return false;
    try {
      if (typeof window !== 'undefined' && window.getComputedStyle) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') <= 0.05) {
          return false;
        }
      }
      if (typeof el.getBoundingClientRect === 'function') {
        const rect = el.getBoundingClientRect();
        if ((rect.width > 0 || rect.height > 0) && (rect.width < 120 || rect.height < 60)) {
          return false;
        }
      }
    } catch {}
    return true;
  }

  function search(node: Document | ShadowRoot | Element): HTMLElement | null {
    const candidates = node.querySelectorAll
      ? (Array.from(
          node.querySelectorAll(
            'dialog, dialog[open], .jobs-easy-apply-modal, [data-test-modal-id="easy-apply-modal"], [data-easy-apply-modal], div.artdeco-modal[role="dialog"], div.artdeco-modal, .artdeco-modal, div[role="dialog"][aria-modal="true"], div[role="dialog"], [role="dialog"], [data-test-modal], [aria-modal="true"]',
          ),
        ) as HTMLElement[])
      : [];

    for (const c of candidates) {
      if (!c || !c.isConnected) continue;
      // Exclude global navigation, footers, headers, dropdowns, and chat dock
      if (
        typeof c.closest === 'function' &&
        c.closest(
          'nav, header, footer, #footer, .artdeco-footer, [data-view-name="footer"], #global-nav, .global-nav, .msg-overlay-container, #msg-overlay, .artdeco-dropdown',
        )
      ) {
        continue;
      }
      const aria = (typeof c.getAttribute === 'function' ? c.getAttribute('aria-label') || '' : '').toLowerCase();
      if (aria.includes('messaging') || aria.includes('chat') || aria.includes('notification')) {
        continue;
      }
      const text = (c.innerText || c.textContent || '').trim().toLowerCase();
      if (
        /^\d+\s*notifications?$/i.test(text) ||
        (typeof c.closest === 'function' && c.closest('.notifications-badge'))
      ) {
        continue;
      }
      if (text.includes('select language') && (text.includes('privacy') || text.includes('help center'))) {
        continue;
      }
      // Intermediate sheets ("Save this application?", "Discard draft?") are not the form itself
      if (/save this application|save application|discard draft/i.test(text)) {
        continue;
      }
      if (!isVisible(c)) continue;

      // 1. Explicit classic markers
      if (
        (c.classList && c.classList.contains('jobs-easy-apply-modal')) ||
        (typeof c.hasAttribute === 'function' && c.hasAttribute('data-easy-apply-modal')) ||
        (typeof c.getAttribute === 'function' && c.getAttribute('data-test-modal-id') === 'easy-apply-modal') ||
        (typeof c.querySelector === 'function' &&
          c.querySelector(
            '.jobs-easy-apply-modal, .jobs-easy-apply-modal__content, .jobs-easy-apply-modal__header, .jobs-easy-apply-modal__footer, .jobs-easy-apply-content, .jobs-easy-apply-form-section, .jobs-easy-apply-form-element, form.jobs-easy-apply-form, [data-easy-apply-modal], [data-test-modal-id="easy-apply-modal"], h2.jobs-easy-apply-modal__title',
          ) !== null)
      ) {
        return c;
      }

      // 2. Structural detection: contains at least one form control
      const hasFormControls =
        typeof c.querySelector === 'function' &&
        c.querySelector(
          'input:not([type="hidden"]), select, textarea, fieldset, [role="radiogroup"], [role="group"], [contenteditable="true"], .jobs-document-upload, [type="file"]',
        ) !== null;

      // 3. Structural detection: contains at least one forward or submit button identified by VISIBLE TEXT
      const buttons =
        typeof c.querySelectorAll === 'function'
          ? (Array.from(
              c.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'),
            ) as HTMLElement[])
          : [];
      const hasForwardOrSubmitButton = buttons.some(b => {
        const bt = (b.innerText || b.textContent || '').trim().toLowerCase();
        return (
          bt.includes('next') ||
          bt.includes('review') ||
          bt.includes('submit application') ||
          bt.includes('submit') ||
          bt.includes('continue')
        );
      });

      if (hasFormControls || hasForwardOrSubmitButton) {
        return c;
      }
    }

    // Traverse shadow roots
    const all = node.querySelectorAll ? node.querySelectorAll('*') : [];
    for (let i = 0; i < all.length; i++) {
      if ((all[i] as any).shadowRoot) {
        const found = search((all[i] as any).shadowRoot);
        if (found) return found;
      }
    }

    // Inline application container (details pane embed)
    const inlineForms = (
      node.querySelectorAll
        ? (Array.from(
            node.querySelectorAll('.jobs-easy-apply-content, form.jobs-easy-apply-form, [data-easy-apply-modal]'),
          ) as HTMLElement[])
        : []
    ).filter(el => {
      if (!el || !el.isConnected) return false;
      if (
        typeof el.closest === 'function' &&
        el.closest('nav, header, footer, #footer, .artdeco-footer, [data-view-name="footer"]')
      ) {
        return false;
      }
      return isVisible(el);
    });
    if (inlineForms.length > 0) return inlineForms[0];

    return null;
  }

  return search(root);
}
