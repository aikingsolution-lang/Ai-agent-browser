# 🚀 JobPilot (NanoBrowser) — Team Member Onboarding & Setup Guide

Welcome to the **JobPilot / NanoBrowser** team! This guide will walk you through cloning, building, loading, and running the Chrome extension locally on Windows.

---

## 📌 Architecture & Environment Overview

* **Backend Service**: You **do NOT need to set up or configure a local backend or `.env` file**. The extension is pre-configured to connect out-of-the-box to our production Google Cloud Run backend (`https://nanobrowser-backend-336340854879.asia-south1.run.app`).
* **Database & Auth**: User sessions, credit balances, daily quotas, and application tracking are managed securely via **Firebase Realtime Database (RTDB)**.
* **AI Engine**: Form questions and resume match evaluations are powered by Google Gemini (`gemini-3.5-flash`) via our Cloud Run backend.

---

## 💻 1. Prerequisites

Before getting started, make sure your Windows machine has the following tools installed:

1. **Git for Windows**: [Download & Install Git](https://git-scm.com/downloads)
2. **Node.js (v20 or v22 LTS)**: [Download & Install Node.js](https://nodejs.org/)
3. **pnpm (Package Manager)**:
   Open **PowerShell** and run:
   ```powershell
   npm install -g pnpm
   ```
   *Verify installations:*
   ```powershell
   node -v
   pnpm -v
   git --version
   ```
4. **Google Chrome**: Latest version.

---

## 📥 2. Clone the Repository

Open **PowerShell** or **Command Prompt**, navigate to your preferred directory (e.g. `Desktop`), and clone the repository:

```powershell
git clone https://github.com/aikingsolution-lang/Ai-agent-browser.git
cd Ai-agent-browser
```

Ensure you are on the `main` branch:
```powershell
git checkout main
git pull origin main
```

---

## 📦 3. Install Dependencies

Install all monorepo workspace dependencies:

```powershell
pnpm install
```

---

## 🏗️ 4. Build the Extension

To build the Chrome extension bundles:

```powershell
pnpm build
```

### What this command does:
1. Performs TypeScript type-checking across all monorepo packages.
2. Compiles React components, background service workers, content scripts, and assets.
3. Automatically audits that the production backend URL is verified.
4. Generates a production-ready **`dist`** folder in the root directory.

---

## 🧩 5. Load the Extension into Google Chrome

1. Open **Google Chrome**.
2. Navigate to: `chrome://extensions`
3. In the top-right corner, toggle **Developer mode** to **ON**.
4. In the top-left corner, click **Load unpacked**.
5. Browse to the cloned repository and select the **`dist`** folder:
   ```
   C:\path\to\Ai-agent-browser\dist
   ```
6. The extension **JobPilot / NanoBrowser** will appear in your installed extensions list!

---

## ⚙️ 6. First-Time Extension Setup

1. **Pin & Open**: Click the puzzle piece icon (Extensions) in the Chrome toolbar and click **JobPilot** to open the **Side Panel**.
2. **Register / Log In**:
   - Create a new account or log in with your email.
   - Your account will automatically receive initial trial credits to test job applications.
3. **Configure Career Brain**:
   - Upload your Resume (PDF/DOCX) or fill in your details manually.
   - Set your **Target Role** (e.g., `Software Developer`, `Full Stack Developer`, etc.).
   - Set your **Target Location** (e.g., `Bengaluru`, `Remote`, `Mumbai`, etc.).
   - Ensure the **"Easy Apply Only"** toggle is enabled for automated applications.

---

## 🎯 7. Running Applications (LinkedIn, Naukri, Indeed)

### ⚠️ Crucial Rules for Automation:
* **LinkedIn Must Be Logged In**: Open `https://www.linkedin.com` in a normal tab first and make sure you are actively signed in. If LinkedIn prompts for a CAPTCHA or phone OTP, solve it manually once.
* **Keep DevTools Closed on the Runner Tab**: Do NOT open F12 / Inspect on the automated runner tab. Chrome only allows one debugger client at a time; opening DevTools will detach the extension.
* **LinkedIn Language**: Ensure your LinkedIn interface language is set to **English**.

### How to Run:
1. Open the **JobPilot Side Panel**.
2. Select your desired platform (e.g., **LinkedIn**).
3. Click **"Start Auto Apply"**.
4. A dedicated runner tab will automatically open, scan for matching jobs, click **Easy Apply**, answer form questions using your Career Brain via Gemini AI, and submit the application!
5. You can monitor live progress and logs directly inside the Side Panel.

---

## 🛠️ 8. Useful Developer Commands

* **Live Development with Hot-Reload**:
  ```powershell
  pnpm dev
  ```
* **Package Distributable ZIP**:
  ```powershell
  pnpm zip
  ```
  *(Output is created in the `dist-zip/` folder).*
* **Run Type-Checking**:
  ```powershell
  pnpm type-check
  ```
* **Run Unit Tests**:
  ```powershell
  pnpm test
  ```

---

## ❓ 9. Troubleshooting FAQ

* **Q: Do I need a `.env` file?**
  * **A:** No! The production Cloud Run backend is already set as default in `packages/shared/lib/config.ts`. You do not need any local environment variables.
* **Q: Getting `Protocol error: Detached while handling command`?**
  * **A:** Make sure you do not have DevTools (F12) open on the runner tab and no conflicting automation extensions installed.
* **Q: Jobs are skipping with "No Easy Apply"?**
  * **A:** Make sure you pulled the latest `main` branch (`git pull origin main`) and ran `pnpm build`. Reload the extension in `chrome://extensions`.
* **Q: Is data shared between team members?**
  * **A:** No. Each team member registers their own account in the side panel. All quotas, application history, and candidate profiles are stored separately per user in Firebase Realtime Database.
