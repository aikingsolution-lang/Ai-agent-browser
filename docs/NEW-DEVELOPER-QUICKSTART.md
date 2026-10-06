# New Developer 30-Minute Quickstart

Welcome to the **NanoBrowser / JobPilot** repository! This document will get your local environment running and verified within 30 minutes.

---

## Prerequisites Check
Ensure you have the following installed on your workstation:
- **Node.js**: Version `>= 20.0.0` (Node 20 or 22 LTS recommended).
- **PNPM**: Version `>= 9.0.0` (`npm install -g pnpm`).
- **MongoDB**: Version `>= 6.0` running locally on port `27017` OR a MongoDB Atlas connection string.
- **Google Chrome**: Modern version supporting Manifest V3 SidePanel API.

---

## Step 1: Clone & Install Dependencies (5 Minutes)
From the root directory of the repository:

```bash
# 1. Install all monorepo dependencies across all 8 workspaces
pnpm install

# 2. Verify workspace linking
pnpm turbo ready
```

---

## Step 2: Configure Environment Variables (5 Minutes)
Navigate to `backend/` and create your local environment file:

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` with minimum local defaults:
```ini
PORT=5000
NODE_ENV=development
MONGO_URI=mongodb://127.0.0.1:27017/nanobrowser_saas
JWT_SECRET=development_super_secret_jwt_key_min_32_chars_12345
JWT_EXPIRES_IN=15m
JWT_REFRESH_SECRET=development_super_secret_jwt_refresh_key_min_32_chars_12345
JWT_REFRESH_EXPIRES_IN=7d
RAZORPAY_KEY_ID=rzp_test_mock_key_id_12345
RAZORPAY_KEY_SECRET=rzp_test_mock_key_secret_67890
RAZORPAY_WEBHOOK_SECRET=rzp_test_mock_webhook_secret_abcde
AWS_BEDROCK_API_KEY=mock_bedrock_api_key
AWS_BEDROCK_REGION=us-east-1
LLM_DEFAULT_MODEL=anthropic.claude-3-5-sonnet-20240620-v1:0
```

---

## Step 3: Seed Default Subscription Plans & Run Backend (5 Minutes)
From the `backend/` directory:

```bash
# Run backend in development watch mode
pnpm dev
```

You will see:
```
[INFO] Server running in development mode on port 5000
[INFO] Connected to MongoDB database: nanobrowser_saas
[INFO] ⏰ Trial expiration background cron worker initialized (schedule: every 15m)
[INFO] Default plans verified and seeded.
```

Verify health check in your browser or terminal:
```bash
curl http://localhost:5000/health
# Response: {"status":"ok","timestamp":"...","uptime":...}
```

---

## Step 4: Build the Chrome Extension (5 Minutes)
Open a new terminal window at the repository root:

```bash
# Build all packages and extension
pnpm build
```

This will generate the unpacked extension in:
```
nanobrowser/dist/
```

---

## Step 5: Load Unpacked Extension in Chrome (5 Minutes)
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** toggle in the top-right corner.
3. Click the **Load unpacked** button in the top-left.
4. Select the `nanobrowser/dist` directory.
5. You will see **JobPilot** (or NanoBrowser) appear in your extensions list.
6. Click the Extension icon in Chrome's toolbar to open the **Side Panel**.

---

## Step 6: Verify End-to-End Operation (5 Minutes)
1. In the Side Panel, register a new account (e.g., `developer@test.com`, password: `Password123!`).
2. Notice the automatic 7-day Free Trial activation with 50 allocated credits.
3. Upload a sample resume PDF (`test_run.pdf` is in the root directory) in the **Profile** tab.
4. Verify parsed candidate name, email, skills, and golden screening answers appear.
5. In the **LinkedIn** tab, type a target role (e.g. `Frontend Developer`), set Location to `Remote`, choose **Tab Mode**, and hit **Start**.
6. A new tab opens, navigates to the job portal, and starts autonomous discovery.

Congratulations! Your local development environment is fully operational.
