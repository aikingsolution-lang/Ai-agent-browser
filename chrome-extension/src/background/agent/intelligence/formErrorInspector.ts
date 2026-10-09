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

      // Common error indicators across platforms
      const errorSelectors = [
        '.artdeco-inline-feedback--error',
        '[aria-invalid="true"]',
        '.error-message',
        '.input-error',
        '.field-error',
        '.invalid-feedback',
        '.err-msg',
        'p[class*="error" i]',
        'span[class*="error" i]',
        'div[data-testid*="error" i]',
      ];

      const errorElements = Array.from(root.querySelectorAll(errorSelectors.join(', ')));
      const errors: Array<{ fieldLabel: string; errorMessage: string; fieldType: string }> = [];
      let healed = 0;

      for (const errEl of errorElements) {
        const errorText = (errEl.textContent || '').trim();
        if (!errorText || errorText.length < 3) continue;

        // Find associated input/select/textarea
        const parentContainer =
          errEl.closest(
            '.jobs-easy-apply-form-section__grouping, .fb-dash-form-element, .ia-JobForm-element, .form-group, .input-container, div[class*="field" i]',
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

          // 1. Minimum character requirement (e.g. "minimum 50 characters required")
          const minCharMatch = errL.match(/(?:minimum|at\s*least|min)\s*(\d+)\s*(?:characters?|chars?)/i);
          if (minCharMatch && (fieldType === 'textarea' || fieldType === 'input')) {
            const minNeeded = parseInt(minCharMatch[1], 10);
            let current = (inputEl as HTMLInputElement).value || '';
            while (current.length < minNeeded) {
              current += ' ' + current;
            }
            (inputEl as HTMLInputElement).value = current.trim();
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            healed++;
            continue;
          }

          // 2. Numeric required error (e.g. "Enter a decimal number larger than 0.0" or "please enter a number")
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
            (inputEl as HTMLInputElement).value = cleanNum;
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            healed++;
            continue;
          }

          // 3. Required dropdown left blank
          if (fieldType === 'select' && (inputEl as HTMLSelectElement).options.length > 1) {
            const sel = inputEl as HTMLSelectElement;
            // Pick first non-empty option
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
