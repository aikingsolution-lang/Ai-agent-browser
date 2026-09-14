import { z } from 'zod';

export interface ActionSchema {
  name: string;
  description: string;
  schema: z.ZodType;
}

export const doneActionSchema: ActionSchema = {
  name: 'done',
  description: 'Complete task',
  schema: z.object({
    text: z.string().optional().default('').describe('summary or final output text'),
    success: z.boolean().optional().default(true),
  }),
};

const flexibleIndex = z.union([z.number(), z.string(), z.array(z.union([z.number(), z.string()]))]).transform(val => {
  if (Array.isArray(val)) return val.length > 0 ? Math.round(Number(val[0])) : 0;
  const n = Number(val);
  return isNaN(n) ? 0 : Math.round(n);
});

const optionalFlexibleIndex = z
  .union([z.number(), z.string(), z.array(z.union([z.number(), z.string()]))])
  .nullable()
  .optional()
  .transform(val => {
    if (val === undefined || val === null) return undefined;
    if (Array.isArray(val)) return val.length > 0 ? Math.round(Number(val[0])) : undefined;
    const n = Number(val);
    return isNaN(n) ? undefined : Math.round(n);
  });

export const submitFormActionSchema: ActionSchema = {
  name: 'submit_form',
  description: 'Submit form or search input element',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: optionalFlexibleIndex.default(0).describe('index of the element to submit'),
  }),
};

// Basic Navigation Actions
export const searchGoogleActionSchema: ActionSchema = {
  name: 'search_google',
  description:
    'Search the query in Google in the current tab, the query should be a search query like humans search in Google, concrete and not vague or super long. More the single most important items.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    query: z.string(),
  }),
};

export const searchYouTubeActionSchema: ActionSchema = {
  name: 'search_youtube',
  description:
    'Search for videos or songs on YouTube in the current tab. Use concrete search queries (e.g. song name, artist).',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    query: z.string().describe('YouTube search query or song title'),
  }),
};

export const goToUrlActionSchema: ActionSchema = {
  name: 'go_to_url',
  description: 'Navigate to URL in the current tab',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    url: z.string(),
  }),
};

export const goBackActionSchema: ActionSchema = {
  name: 'go_back',
  description: 'Go back to the previous page',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
  }),
};

export const clickElementActionSchema: ActionSchema = {
  name: 'click_element',
  description: 'Click element by index',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: flexibleIndex.describe('index of the element'),
    xpath: z.string().nullable().optional().describe('xpath of the element'),
  }),
};

export const inputTextActionSchema: ActionSchema = {
  name: 'input_text',
  description:
    'Input text into an interactive input element. For search inputs, set press_enter: true to submit the search automatically.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: flexibleIndex.describe('index of the element'),
    text: z.string().optional().default('').describe('text to input'),
    xpath: z.string().nullable().optional().describe('xpath of the element'),
    press_enter: z
      .boolean()
      .optional()
      .default(false)
      .describe('whether to press Enter after typing to submit the query/form'),
  }),
};

export const switchTabActionSchema: ActionSchema = {
  name: 'switch_tab',
  description: 'Switch to tab by tab id',
  schema: z
    .object({
      intent: z.string().default('').describe('purpose of this action'),
      tab_id: z.number().int().optional().describe('id of the tab to switch to'),
      tabId: z.number().int().optional().describe('id of the tab to switch to'),
    })
    .transform(data => ({
      intent: data.intent,
      tab_id: data.tab_id !== undefined ? data.tab_id : data.tabId !== undefined ? data.tabId : 0,
    })),
};

export const openTabActionSchema: ActionSchema = {
  name: 'open_tab',
  description: 'Open URL in new tab',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    url: z.string().optional().default('https://www.google.com').describe('url to open'),
  }),
};

export const closeTabActionSchema: ActionSchema = {
  name: 'close_tab',
  description: 'Close tab by tab id',
  schema: z
    .object({
      intent: z.string().default('').describe('purpose of this action'),
      tab_id: z.number().int().optional().describe('id of the tab'),
      tabId: z.number().int().optional().describe('id of the tab'),
    })
    .transform(data => ({
      intent: data.intent,
      tab_id: data.tab_id !== undefined ? data.tab_id : data.tabId !== undefined ? data.tabId : 0,
    })),
};

export const extractTextActionSchema: ActionSchema = {
  name: 'extract_text',
  description: 'Extract text or information from an element or the current page',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: optionalFlexibleIndex.describe('optional index of the element to extract text from'),
    text: z.string().optional().default('').describe('extracted text or observation'),
    content: z.string().optional().default('').describe('content to extract or record'),
    goal: z.string().optional().default('').describe('information goal to extract'),
  }),
};

// Cache Actions
export const cacheContentActionSchema: ActionSchema = {
  name: 'cache_content',
  description: 'Cache what you have found so far from the current page for future use',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    content: z.string().default('').describe('content to cache'),
  }),
};

export const scrollToElementActionSchema: ActionSchema = {
  name: 'scroll_to_element',
  description: 'Scroll an element into view by its index',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: flexibleIndex.describe('index of the element to scroll to'),
  }),
};

export const scrollToPercentActionSchema: ActionSchema = {
  name: 'scroll_to_percent',
  description:
    'Scrolls to a particular vertical percentage of the document or an element. If no index of element is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    yPercent: z.number().int().describe('percentage to scroll to - min 0, max 100; 0 is top, 100 is bottom'),
    index: optionalFlexibleIndex.describe('index of the element'),
  }),
};

export const scrollToTopActionSchema: ActionSchema = {
  name: 'scroll_to_top',
  description: 'Scroll the document in the window or an element to the top',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: optionalFlexibleIndex.describe('index of the element'),
  }),
};

export const scrollToBottomActionSchema: ActionSchema = {
  name: 'scroll_to_bottom',
  description: 'Scroll the document in the window or an element to the bottom',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: optionalFlexibleIndex.describe('index of the element'),
  }),
};

export const previousPageActionSchema: ActionSchema = {
  name: 'previous_page',
  description:
    'Scroll the document in the window or an element to the previous page. If no index is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: optionalFlexibleIndex.describe('index of the element'),
  }),
};

export const nextPageActionSchema: ActionSchema = {
  name: 'next_page',
  description:
    'Scroll the document in the window or an element to the next page. If no index is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: optionalFlexibleIndex.describe('index of the element'),
  }),
};

export const scrollToTextActionSchema: ActionSchema = {
  name: 'scroll_to_text',
  description: 'If you dont find something which you want to interact with in current viewport, try to scroll to it',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    text: z.string().describe('text to scroll to'),
    nth: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('which occurrence of the text to scroll to (1-indexed, default: 1)'),
  }),
};

export const sendKeysActionSchema: ActionSchema = {
  name: 'send_keys',
  description:
    'Send strings of special keys like Backspace, Insert, PageDown, Delete, Enter. Shortcuts such as `Control+o`, `Control+Shift+T` are supported as well. This gets used in keyboard press. Be aware of different operating systems and their shortcuts',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    keys: z.string().describe('keys to send'),
  }),
};

export const getDropdownOptionsActionSchema: ActionSchema = {
  name: 'get_dropdown_options',
  description: 'Get all options from a native dropdown',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: flexibleIndex.describe('index of the dropdown element'),
  }),
};

export const selectDropdownOptionActionSchema: ActionSchema = {
  name: 'select_dropdown_option',
  description: 'Select dropdown option for interactive element index by the text of the option you want to select',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: flexibleIndex.describe('index of the dropdown element'),
    text: z.string().describe('text of the option'),
  }),
};

export const skipAdActionSchema: ActionSchema = {
  name: 'skip_ad',
  description: 'Skip ad on video player if an ad or skip button is present',
  schema: z.object({
    intent: z.string().default('Skip video ad').describe('purpose of this action'),
  }),
};

export const waitActionSchema: ActionSchema = {
  name: 'wait',
  description: 'Wait for x seconds default 3, do NOT use this action unless user asks to wait explicitly',
  schema: z
    .object({
      intent: z.string().default('').describe('purpose of this action'),
      seconds: z.union([z.number(), z.string()]).optional().describe('amount of seconds'),
      time: z.union([z.number(), z.string()]).optional().describe('amount of seconds'),
      timeout: z.union([z.number(), z.string()]).optional().describe('timeout'),
    })
    .transform(data => {
      const raw = data.seconds ?? data.time ?? data.timeout ?? 3;
      const n = Number(raw);
      const sec = isNaN(n) ? 3 : Math.min(Math.round(n > 100 ? n / 1000 : n), 30);
      return {
        intent: data.intent,
        seconds: Math.max(1, sec),
      };
    }),
};

export const linkedinEasyApplyActionSchema: ActionSchema = {
  name: 'linkedin_easy_apply',
  description:
    'Apply to the currently viewed LinkedIn job listing using the Easy Apply engine. Handles fit-scoring, career-brain form filling, screening questions, and dry-run/live submission automatically. Only use when on a LinkedIn job page that has an Easy Apply button.',
  schema: z.object({
    intent: z.string().default('Apply to LinkedIn job via Easy Apply').describe('purpose of this action'),
  }),
};
