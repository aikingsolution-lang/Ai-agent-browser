/**
 * Ported from noah-master background.js fetchHREmailForCompany().
 * Opens a silent Google Search tab for "HR email of {companyName}", waits for it
 * to finish loading, injects a regex to extract the first email from page text,
 * then closes the tab. Resolves with the email string or null (timeout: 10 s).
 */
export function fetchHrEmailForCompany(companyName: string): Promise<string | null> {
  return new Promise(resolve => {
    const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(`HR email of ${companyName}`)}`;
    let tabId: number | null = null;
    let resolved = false;

    const onUpdated = (_updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (tab.id !== tabId || changeInfo.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(onUpdated);

      setTimeout(async () => {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tabId! },
            func: () => {
              const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
              const match = emailRegex.exec(document.body.innerText);
              return match ? match[0] : null;
            },
          });
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            chrome.tabs.remove(tabId!).catch(() => {});
            resolve((results?.[0]?.result as string | null) ?? null);
          }
        } catch {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            chrome.tabs.remove(tabId!).catch(() => {});
            resolve(null);
          }
        }
      }, 500);
    };

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        if (tabId !== null) chrome.tabs.remove(tabId).catch(() => {});
        resolve(null);
      }
    }, 10000);

    chrome.tabs.create({ url: googleSearchUrl, active: false }, tab => {
      tabId = tab.id ?? null;
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
  });
}
