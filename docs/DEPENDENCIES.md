# Monorepo Dependencies Audit

## 1. Workspace Dependencies Map

### Root (`package.json`)
- **Package Manager**: `pnpm@9.x`
- **Monorepo Tools**: `turbo` (Turborepo), `cross-env`, `husky`, `rimraf`, `typescript`.

### Backend (`backend/package.json`)
- **Runtime Core**: `express` (4.21), `mongoose` (8.7), `cors`, `helmet`, `morgan`, `dotenv`.
- **Security & Identity**: `bcryptjs`, `jsonwebtoken`, `zod`.
- **Payments & External**: `razorpay`, `@aws-sdk/client-bedrock-runtime`, `openai`.
- **Document Processing**: `pdf-parse`, `mammoth`, `multer`.
- **Scheduling & Utilities**: `node-cron`, `winston`.
- **Dev & Testing**: `tsx`, `vitest`, `supertest`, `eslint`, `prettier`.

### Chrome Extension (`chrome-extension/package.json`)
- **Agent & AI**: `@langchain/core`, `@langchain/openai`, `@langchain/anthropic`, `@langchain/community`.
- **Browser Automation**: `puppeteer-core`.
- **Build**: `vite`, `@crxjs/vite-plugin`.

### UI Pages (`pages/side-panel/` & `pages/options/`)
- **UI Framework**: `react` (18.3), `react-dom` (18.3), `lucide-react`.
- **Styling**: `tailwindcss`, `postcss`, `autoprefixer`.

---

## 2. Dependency Health & Deprecation Check
- All primary dependencies are actively maintained.
- Node.js 20+ runtime is utilized.
- TypeScript 5.5 ensures strong type checking across all monorepo packages.
