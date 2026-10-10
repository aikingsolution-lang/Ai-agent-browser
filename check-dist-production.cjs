/**
 * Post-build verification check.
 * Ensures dist/ contains NO occurrences of backend development URLs (localhost:5000 / 127.0.0.1:5000),
 * manifest.json has NO localhost permissions, background bundle positively includes production backend URL,
 * and no unauthorized localhost / 127.0.0.1 / ws:// URLs exist.
 *
 * Specific allowed patterns per file:
 * - dist/background.iife.js:
 *     - http://localhost:1984 (LangSmith SDK client default fallback)
 *     - http://localhost:3000 (LangSmith SDK client default fallback)
 *     - http://localhost:11434 and http://127.0.0.1:11434 (Local Ollama LLM provider)
 * - dist/options/assets/index-*.js:
 *     - http://localhost:11434 and http://127.0.0.1:11434 (Local Ollama LLM provider in settings UI)
 */

const fs = require('fs');
const path = require('path');

const distDir = path.resolve(__dirname, 'dist');
if (!fs.existsSync(distDir)) {
  console.error('❌ dist directory does not exist.');
  process.exit(1);
}

const envProdPath = path.resolve(__dirname, '.env.production');
let PRODUCTION_BACKEND_URL = '';
if (fs.existsSync(envProdPath)) {
  const envContent = fs.readFileSync(envProdPath, 'utf8');
  const match = envContent.match(/^VITE_BACKEND_API_URL\s*=\s*(.+)$/m);
  if (match) {
    PRODUCTION_BACKEND_URL = match[1].trim().replace(/^['"]|['"]$/g, '');
  }
}

if (!PRODUCTION_BACKEND_URL) {
  console.error('❌ [Post-Build Audit] Unable to read VITE_BACKEND_API_URL from .env.production');
  process.exit(1);
}

// 1. Positive Assertion: background bundle must contain the production backend URL
const bgScriptPath = path.join(distDir, 'background.iife.js');
if (!fs.existsSync(bgScriptPath)) {
  console.error('❌ [Post-Build Audit] dist/background.iife.js does not exist.');
  process.exit(1);
}
const bgContent = fs.readFileSync(bgScriptPath, 'utf8');
if (!bgContent.includes(PRODUCTION_BACKEND_URL)) {
  console.error(`❌ [Post-Build Audit] dist/background.iife.js does NOT contain production backend URL (${PRODUCTION_BACKEND_URL})!`);
  process.exit(1);
}

// 2. Check manifest.json permissions
const manifestPath = path.join(distDir, 'manifest.json');
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const hostPerms = manifest.host_permissions || [];
  for (const perm of hostPerms) {
    if (perm.includes('localhost') || perm.includes('127.0.0.1')) {
      console.error(`❌ [Post-Build Audit] manifest.json host_permissions contains local URL: ${perm}`);
      process.exit(1);
    }
  }
}

function scanFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      scanFiles(filePath, fileList);
    } else if (/\.(js|html|json|css)$/i.test(file)) {
      fileList.push(filePath);
    }
  }
  return fileList;
}

const files = scanFiles(distDir);
let violationsFound = 0;

for (const filePath of files) {
  const content = fs.readFileSync(filePath, 'utf8');
  const normalizedRelPath = path.relative(__dirname, filePath).replace(/\\/g, '/');

  // Forbidden: Any backend dev URL (localhost:5000 / 127.0.0.1:5000)
  if (content.includes('localhost:5000') || content.includes('127.0.0.1:5000')) {
    console.error(`❌ [Post-Build Audit] Backend dev URL (localhost:5000) found in: ${normalizedRelPath}`);
    violationsFound++;
  }

  // Forbidden: VITE_BACKEND_API_URL or backend URL pointing to local URL
  if (/VITE_BACKEND_API_URL["':\s]+https?:\/\/(localhost|127\.0\.0\.1)/i.test(content)) {
    console.error(`❌ [Post-Build Audit] VITE_BACKEND_API_URL pointing to local URL found in: ${normalizedRelPath}`);
    violationsFound++;
  }

  // Forbidden: Any ws:// or wss:// pointing to localhost or 127.0.0.1
  const wsMatches = content.match(/wss?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?/gi) || [];
  for (const match of wsMatches) {
    console.error(`❌ [Post-Build Audit] WebSocket local URL "${match}" found in: ${normalizedRelPath}`);
    violationsFound++;
  }

  // Forbidden: Portless localhost URLs (http://localhost or https://localhost without a port)
  const portlessMatches = content.match(/https?:\/\/localhost(?![:\w.-])/gi) || [];
  for (const match of portlessMatches) {
    console.error(`❌ [Post-Build Audit] Portless localhost URL "${match}" found in: ${normalizedRelPath}`);
    violationsFound++;
  }

  // HTTP local URLs with port: check against strict per-file allowlist
  const urlMatches = content.match(/https?:\/\/(localhost|127\.0\.0\.1):(\d+)/gi) || [];
  for (const match of urlMatches) {
    const portMatch = match.match(/:(\d+)/);
    const port = portMatch ? portMatch[1] : '';

    let isAllowed = false;
    if (normalizedRelPath === 'dist/background.iife.js') {
      // Background worker may bundle LangSmith defaults (1984, 3000) and Ollama provider (11434)
      if (['1984', '3000', '11434'].includes(port)) {
        isAllowed = true;
      }
    } else if (normalizedRelPath.startsWith('dist/options/assets/index-') && normalizedRelPath.endsWith('.js')) {
      // Options UI settings bundle may reference Ollama provider (11434)
      if (port === '11434') {
        isAllowed = true;
      }
    }

    if (!isAllowed) {
      console.error(
        `❌ [Post-Build Audit] Unauthorized local URL "${match}" found in unapproved file: ${normalizedRelPath}`,
      );
      violationsFound++;
    }
  }
}

if (violationsFound > 0) {
  console.error(`\n🛑 Post-build check failed with ${violationsFound} violation(s)! Production build aborted.`);
  process.exit(1);
}

console.log('✅ [Post-Build Audit] Production backend URL positively verified in background bundle.');
console.log('✅ [Post-Build Audit] Zero backend localhost/127.0.0.1/ws:// references in dist/ assets. Build verified!');
