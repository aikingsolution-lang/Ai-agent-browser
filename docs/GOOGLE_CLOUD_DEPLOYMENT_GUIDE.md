# 🚀 NanoBrowser — Google Cloud Deployment & Terminal Guide

Yeh guide future reference ke liye hai jab bhi aap kisi **naye Google Cloud account** ya **naye project** par NanoBrowser ka backend deploy karenge.

---

## 📑 Table of Contents
1. [Prerequisites](#1-prerequisites)
2. [Step 1: Project Setup & Enable APIs](#step-1-project-setup--enable-apis)
3. [Step 2: Service Account Create Karna](#step-2-service-account-create-karna)
4. [Step 3: Google Secret Manager Setup](#step-3-google-secret-manager-setup)
5. [Step 4: Repository Clone & Cloud Run Deployment](#step-4-repository-clone--cloud-run-deployment)
6. [Step 5: Code Update / Re-deploy Command (Future Changes Ke Liye)](#step-5-code-update--re-deploy-command)
7. [Step 6: Chrome Extension Me Naya Backend URL Link Karna](#step-6-chrome-extension-me-naya-backend-url-link-karna)
8. [Useful Debugging Commands (Logs & Health Check)](#useful-debugging-commands)

---

## 1. Prerequisites
- Google Cloud Console access ([https://console.cloud.google.com/](https://console.cloud.google.com/))
- Top-right corner me **Cloud Shell Terminal (`>_`)** open karein.

---

## Step 1: Project Setup & Enable APIs

Cloud Shell Terminal me apne project ko select karein aur zaruri APIs enable karein:

```bash
# 1. Apna Project ID set karein (replace YOUR_PROJECT_ID)
gcloud config set project YOUR_PROJECT_ID

# 2. Zaruri Google Cloud APIs enable karein
gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com
```

---

## Step 2: Service Account Create Karna

Cloud Run container ko Secret Manager access karne ke liye ek dedicated Service Account banayein:

```bash
# Service Account create karein
gcloud iam service-accounts create nanobrowser-backend \
  --display-name="NanoBrowser Backend Service Account"
```

---

## Step 3: Google Secret Manager Setup

Apne sensitive credentials ko Google Cloud Secret Manager me store karein:

```bash
# 1. Secrets create karein (apni actual values se replace karein):
# Firebase Admin private key (JobForm Automator Firebase project ka service-account JSON se):
jq -r .private_key service-account.json | gcloud secrets create FIREBASE_ADMIN_PRIVATE_KEY --data-file=-
echo -n "YOUR_JWT_SECRET_MIN_32_CHARS" | gcloud secrets create JWT_SECRET --data-file=-
echo -n "YOUR_RAZORPAY_KEY_SECRET" | gcloud secrets create RAZORPAY_KEY_SECRET --data-file=-
echo -n "YOUR_RAZORPAY_WEBHOOK_SECRET" | gcloud secrets create RAZORPAY_WEBHOOK_SECRET --data-file=-
echo -n "YOUR_AWS_BEDROCK_BEARER_TOKEN" | gcloud secrets create AWS_BEDROCK_API_KEY --data-file=-

# NOTE: Backend ab MongoDB use nahi karta (data Firebase Realtime Database me hai).
# Purana MONGO_URI secret DELETE mat karein jab tak Mongo → RTDB data migration verify na ho jaye
# (docs/FIREBASE_RTDB_MIGRATION.md). Bas deploy command me use mount karna band kar diya gaya hai.

# 2. Service Account ko in Secrets ko read karne ki permission dein:
PROJECT_ID=$(gcloud config get-value project)
SA_EMAIL="nanobrowser-backend@${PROJECT_ID}.iam.gserviceaccount.com"

for SECRET in FIREBASE_ADMIN_PRIVATE_KEY JWT_SECRET RAZORPAY_KEY_SECRET RAZORPAY_WEBHOOK_SECRET AWS_BEDROCK_API_KEY; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor"
done
```

---

## Step 4: Repository Clone & Cloud Run Deployment

Cloud Shell me repository clone karein aur deploy command chalayein:

```bash
# 1. Repository clone karein aur folder ke andar jayein
git clone https://github.com/aikingsolution-lang/Ai-agent-browser.git
cd Ai-agent-browser

# 2. Project ID aur Service Account email fetch karein
PROJECT_ID=$(gcloud config get-value project)
SA_EMAIL="nanobrowser-backend@${PROJECT_ID}.iam.gserviceaccount.com"

# 3. Google Cloud Run par deploy karein
gcloud run deploy nanobrowser-backend \
  --source . \
  --region asia-south1 \
  --platform managed \
  --allow-unauthenticated \
  --service-account="${SA_EMAIL}" \
  --set-env-vars="NODE_ENV=production,CORS_ORIGIN=*,GOOGLE_CLIENT_ID=336340854879-i6hj15oe17se379u6k377slo7pvbvh3v.apps.googleusercontent.com,RAZORPAY_KEY_ID=rzp_test_TZudy51Zrf7t8w,AWS_BEDROCK_REGION=us-east-1,LLM_DEFAULT_MODEL=amazon.nova-lite-v1:0,FIREBASE_PROJECT_ID=jobform-automator-website,FIREBASE_DATABASE_URL=https://jobform-automator-website-default-rtdb.firebaseio.com,FIREBASE_ADMIN_CLIENT_EMAIL=YOUR_SERVICE_ACCOUNT_CLIENT_EMAIL,NANOBROWSER_RTDB_ROOT=nanobrowser" \
  --set-secrets="FIREBASE_ADMIN_PRIVATE_KEY=FIREBASE_ADMIN_PRIVATE_KEY:latest,JWT_SECRET=JWT_SECRET:latest,RAZORPAY_KEY_SECRET=RAZORPAY_KEY_SECRET:latest,RAZORPAY_WEBHOOK_SECRET=RAZORPAY_WEBHOOK_SECRET:latest,AWS_BEDROCK_API_KEY=AWS_BEDROCK_API_KEY:latest"
```

Deployment complete hone ke baad terminal me **Service URL** dikhega:
```text
Service URL: https://nanobrowser-backend-xxxxxxxxxx.asia-south1.run.app
```

---

## Step 5: Code Update / Re-deploy Command

Jab bhi aap local computer se koi code change karke GitHub par push karenge aur Cloud Run ko update karna ho:

```bash
# Cloud Shell me repository folder ke andar jayein:
cd Ai-agent-browser

# Latest code pull karein:
git pull origin main

# Wahi deploy command dobara chalayein:
PROJECT_ID=$(gcloud config get-value project)
SA_EMAIL="nanobrowser-backend@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud run deploy nanobrowser-backend \
  --source . \
  --region asia-south1 \
  --platform managed \
  --allow-unauthenticated \
  --service-account="${SA_EMAIL}" \
  --set-env-vars="NODE_ENV=production,CORS_ORIGIN=*,GOOGLE_CLIENT_ID=336340854879-i6hj15oe17se379u6k377slo7pvbvh3v.apps.googleusercontent.com,RAZORPAY_KEY_ID=rzp_test_TZudy51Zrf7t8w,AWS_BEDROCK_REGION=us-east-1,LLM_DEFAULT_MODEL=amazon.nova-lite-v1:0,FIREBASE_PROJECT_ID=jobform-automator-website,FIREBASE_DATABASE_URL=https://jobform-automator-website-default-rtdb.firebaseio.com,FIREBASE_ADMIN_CLIENT_EMAIL=YOUR_SERVICE_ACCOUNT_CLIENT_EMAIL,NANOBROWSER_RTDB_ROOT=nanobrowser" \
  --set-secrets="FIREBASE_ADMIN_PRIVATE_KEY=FIREBASE_ADMIN_PRIVATE_KEY:latest,JWT_SECRET=JWT_SECRET:latest,RAZORPAY_KEY_SECRET=RAZORPAY_KEY_SECRET:latest,RAZORPAY_WEBHOOK_SECRET=RAZORPAY_WEBHOOK_SECRET:latest,AWS_BEDROCK_API_KEY=AWS_BEDROCK_API_KEY:latest"
```

---

## Step 6: Chrome Extension Me Naya Backend URL Link Karna

Agar aapka backend URL change hota hai:

1. Apne local computer par project root ke `.env` file me naya URL daalein:
   ```env
   VITE_BACKEND_API_URL=https://nanobrowser-backend-xxxxxxxxxx.asia-south1.run.app
   ```
2. `packages/shared/lib/config.ts` me default fallback URL naya URL set karein.
3. Terminal me extension rebuild karein:
   ```bash
   pnpm zip
   ```
4. Chrome me `chrome://extensions` par jakar **NanoBrowser** ko reload karein.

---

## Useful Debugging Commands

### Live Logs Dekhna:
Agar kabhi koi error aye ya backend logs check karne ho:
```bash
gcloud run services logs tail nanobrowser-backend --region asia-south1
```

### Health Check Test:
```bash
curl https://YOUR_SERVICE_URL/health
# Response: {"status":"ok","service":"nanobrowser-backend"}

curl https://YOUR_SERVICE_URL/ready
# Response: {"status":"ready","database":{"isConnected":true,"state":"connected"}}
```
