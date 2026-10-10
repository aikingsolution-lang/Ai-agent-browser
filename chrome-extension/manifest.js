import fs from 'node:fs';
import deepmerge from 'deepmerge';

const packageJson = JSON.parse(fs.readFileSync('../package.json', 'utf8'));

const isFirefox = process.env.__FIREFOX__ === 'true';

/** JobForm Automator website (see JOBFORM_WEBSITE_ORIGINS in packages/shared/lib/config.ts). */
const JOBFORM_WEBSITE_MATCHES = ['https://www.jobformautomator.com/*', 'https://jobformautomator.com/*'];
const isOpera = process.env.__OPERA__ === 'true';

/**
 * If you want to disable the sidePanel, you can delete withSidePanel function and remove the sidePanel HoC on the manifest declaration.
 *
 * ```js
 * const manifest = { // remove `withSidePanel()`
 * ```
 */
function withSidePanel(manifest) {
  // Firefox does not support sidePanel
  if (isFirefox) {
    return manifest;
  }
  return deepmerge(manifest, {
    side_panel: {
      default_path: 'side-panel/index.html',
    },
    permissions: ['sidePanel'],
  });
}

/**
 * Adds Opera sidebar support using the sidebar_action API.
 * This is compatible with Chrome extensions and won't break Chrome Web Store validation.
 */
function withOperaSidebar(manifest) {
  // Only add Opera sidebar_action if building specifically for Opera
  if (isFirefox || !isOpera) {
    return manifest;
  }

  return deepmerge(manifest, {
    sidebar_action: {
      default_panel: 'side-panel/index.html',
      default_title: 'Nanobrowser',
      default_icon: 'icon-32.png',
    },
  });
}

/**
 * After changing, please reload the extension at `chrome://extensions`
 * @type {chrome.runtime.ManifestV3}
 */
const manifest = withOperaSidebar(
  withSidePanel({
    manifest_version: 3,
    default_locale: 'en',
    /**
     * if you want to support multiple languages, you can use the following reference
     * https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Internationalization
     */
    name: '__MSG_app_metadata_name__',
    version: packageJson.version,
    minimum_chrome_version: '116',
    host_permissions: ['https://*/*', '<all_urls>'],
    permissions: [
      'storage',
      'scripting',
      'tabs',
      'activeTab',
      'debugger',
      'unlimitedStorage',
      'webNavigation',
      'cookies',
      'alarms',
    ],
    options_page: 'options/index.html',
    background: {
      service_worker: 'background.iife.js',
      type: 'module',
    },
    action: {
      default_icon: 'icon-32.png',
    },
    icons: {
      128: 'icon-128.png',
    },
    content_scripts: [
      {
        matches: ['http://*/*', 'https://*/*', '<all_urls>'],
        exclude_matches: JOBFORM_WEBSITE_MATCHES,
        all_frames: true,
        js: ['content/index.iife.js'],
      },
      {
        // JobForm Automator website: only the session bridge runs here (top frame), injected before the
        // page's scripts so a sign-in announced while the page loads is never missed.
        matches: JOBFORM_WEBSITE_MATCHES,
        run_at: 'document_start',
        js: ['content/index.iife.js'],
      },
    ],
    web_accessible_resources: [
      {
        resources: [
          '*.js',
          '*.css',
          '*.svg',
          'icon-128.png',
          'icon-32.png',
          'permission/index.html',
          'permission/permission.js',
        ],
        matches: ['*://*/*'],
      },
    ],
  }),
);

export default manifest;
