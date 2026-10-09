// chrome-extension/src/background/agent/intelligence/formErrorInspector.ts

export interface IFormValidationError {
  fieldId?: string;
  fieldLabel: string;
  errorMessage: string;
  fieldType: string;
}

export interface ISelfHealingResult {
  hasErrors: boolean;
  errorsFound: IFormValidationError[];
  correctedCount: number;
}

/**
 * Universal Self-Healing Form Error Inspector
 * Detects inline validation errors on LinkedIn, Indeed, and Naukri, and auto-corrects them.
 */
export async function inspectAndHealFormErrors(page: any, containerSelector?: string): Promise<ISelfHealingResult> {
  const puppeteerPage = page?.puppeteerPage;
  if (!puppeteerPage) {
    return { hasErrors: false, errorsFound: [], correctedCount: 0 };
  }

  try {
    const outcome = await puppeteerPage.evaluate((containerSel?: string) => {
      const root = containerSel ? document.querySelector(containerSel) || document.body : document.body;

      // Common error indicators across platforms (LinkedIn, Indeed, Naukri)
      const errorSelectors = [
        '.err-msg',
        '.err',
        'span.err',
        'p.err',
        'div.err',
        '[class*="err-msg" i]',
        '[class*="field-error" i]',
        '[class*="error-msg" i]',
        '[class*="input-error" i]',
        '[class*="validation-error" i]',
        '[class*="validation-err" i]',
        '[class*="errText" i]',
        '[class*="errorText" i]',
        '.artdeco-inline-feedback--error',
        '[aria-invalid="true"]',
        '.error-message',
        '.invalid-feedback',
        'p[class*="error" i]',
        'span[class*="error" i]',
        'div[data-testid*="error" i]',
      ];

      function setNativeVal(el: HTMLElement, v: string) {
        try {
          const proto =
            el instanceof HTMLTextAreaElement
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (desc) {
            desc.call(el, v);
          } else {
            (el as any).value = v;
          }
          const tracker = (el as any)._valueTracker;
          if (tracker) {
            tracker.setValue(v);
          }
        } catch {
          try {
            (el as any).value = v;
          } catch {}
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: v }));
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true, composed: true }));
      }

      const errorElements = Array.from(root.querySelectorAll(errorSelectors.join(', ')));
      const errors: Array<{ fieldLabel: string; errorMessage: string; fieldType: string }> = [];
      let healed = 0;

      for (const errEl of errorElements) {
        const errorText = (errEl.textContent || '').trim();
        if (!errorText || errorText.length < 3) continue;

        // Find associated input/select/textarea
        const parentContainer =
          errEl.closest(
            '.jobs-easy-apply-form-section__grouping, .fb-dash-form-element, .ia-JobForm-element, .form-group, .input-container, .drawer-field, div[class*="field" i], div[class*="group" i], div[class*="wrap" i]',
          ) || errEl.parentElement;

        const inputEl = parentContainer
          ? (parentContainer.querySelector('input, select, textarea') as
              | HTMLInputElement
              | HTMLSelectElement
              | HTMLTextAreaElement
              | null)
          : null;

        const labelEl = parentContainer ? parentContainer.querySelector('label, [class*="label" i]') : null;

        const fieldLabel = (labelEl?.textContent || '').trim() || 'Form Field';
        const fieldType = inputEl ? inputEl.tagName.toLowerCase() : 'unknown';

        errors.push({
          fieldLabel,
          errorMessage: errorText,
          fieldType,
        });

        // Auto-heal common issues
        if (inputEl) {
          const errL = errorText.toLowerCase();
          const lblL = fieldLabel.toLowerCase();

          // 1. CTC / Lakhs specific healing
          if (
            errL.includes('lac') ||
            errL.includes('lakh') ||
            errL.includes('ctc') ||
            lblL.includes('ctc') ||
            lblL.includes('lac') ||
            lblL.includes('lakh')
          ) {
            const raw = (inputEl as HTMLInputElement).value || '7';
            const numMatch = raw.match(/(\d+(?:\.\d+)?)/);
            let val = '7';
            if (numMatch) {
              let num = parseFloat(numMatch[1]);
              if (num >= 1000) num = Number((num / 100000).toFixed(2));
              val = String(num).replace(/\.00$/, '');
            }
            setNativeVal(inputEl, val);
            healed++;
            continue;
          }

          // 2. Minimum character requirement (e.g. "minimum 50 characters required")
          const minCharMatch = errL.match(/(?:minimum|at\s*least|min)\s*(\d+)\s*(?:characters?|chars?)/i);
          if (minCharMatch && (fieldType === 'textarea' || fieldType === 'input')) {
            const minNeeded = parseInt(minCharMatch[1], 10);
            let current = (inputEl as HTMLInputElement).value || '';
            while (current.length < minNeeded) {
              current += ' ' + current;
            }
            setNativeVal(inputEl, current.trim());
            healed++;
            continue;
          }

          // 3. Numeric required error (e.g. "Enter a decimal number larger than 0.0" or "please enter a number")
          if (
            errL.includes('decimal') ||
            errL.includes('number') ||
            errL.includes('numeric') ||
            errL.includes('digits') ||
            errL.includes('larger than')
          ) {
            const raw = (inputEl as HTMLInputElement).value || '1';
            let cleanNum = raw.replace(/[^0-9.]/g, '') || '1';
            if (errL.includes('larger than 0') && (cleanNum === '0' || cleanNum === '0.0')) {
              cleanNum = '1';
            }
            setNativeVal(inputEl, cleanNum);
            healed++;
            continue;
          }

          // 4. Required dropdown left blank
          if (fieldType === 'select' && (inputEl as HTMLSelectElement).options.length > 1) {
            const sel = inputEl as HTMLSelectElement;
            for (let i = 1; i < sel.options.length; i++) {
              if (sel.options[i].value && !sel.options[i].text.toLowerCase().includes('select')) {
                sel.selectedIndex = i;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                healed++;
                break;
              }
            }
          }
        }
      }

      return {
        hasErrors: errors.length > 0,
        errorsFound: errors,
        correctedCount: healed,
      };
    }, containerSelector);

    return outcome;
  } catch {
    return { hasErrors: false, errorsFound: [], correctedCount: 0 };
  }
}
