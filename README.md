<h1 align="center">
    <img src="https://github.com/user-attachments/assets/ec60b0c4-87ba-48f4-981a-c55ed0e8497b" height="100" width="375" alt="banner" /><br>
    JobPilot AI — Autonomous Multi-Platform Job Application Agent
</h1>

<div align="center">

[![Extension](https://img.shields.io/badge/Chrome_Extension-Manifest_V3-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](#-manually-install-latest-version)
[![Backend](https://img.shields.io/badge/Backend-Google_Cloud_Run-34A853?style=for-the-badge&logo=googlecloud&logoColor=white)](./docs/GOOGLE_CLOUD_DEPLOYMENT_GUIDE.md)
[![Database](https://img.shields.io/badge/Database-Firebase_RTDB-FFCA28?style=for-the-badge&logo=firebase&logoColor=black)](./docs/DATABASE.md)
[![LLM](https://img.shields.io/badge/LLM-AWS_Bedrock_Nova_Lite-FF9900?style=for-the-badge&logo=amazonwebservices&logoColor=white)](./docs/AI-SYSTEM.md)
[![Tests](https://img.shields.io/badge/Tests-Vitest_Passing-brightgreen?style=for-the-badge&logo=vitest&logoColor=white)](./docs/TESTING.md)

</div>

## 🌐 JobPilot AI (Powered by NanoBrowser)

**JobPilot AI** is an autonomous, open-source AI job application and web automation suite that runs directly inside your browser. Built on top of NanoBrowser's multi-agent architecture (Planner + Navigator), JobPilot AI automates end-to-end job discovery, form filling, questionnaire solving, and 1-click applications across major job portals.

📦 **Ready-to-Use Extension Artifact:** [`JobPilot-AI-Extension-Latest.zip`](./JobPilot-AI-Extension-Latest.zip) (No build required — unzip and load directly into Chrome!)

<div align="center">
<img src="https://github.com/user-attachments/assets/112c4385-7b03-4b81-a352-4f348093351b" width="600" alt="JobPilot AI Demo GIF" />
<p><em>Autonomous agent analyzing job forms in real-time: Planner intelligently extracts experience & CTC from candidate profile and instructs Navigator to fill modals with sub-second precision.</em></p>
</div>

## 🔥 Why JobPilot AI?

- **Multi-Platform Automation**: Native support for **LinkedIn Easy Apply**, **Naukri.com (1-Click & Custom Questionnaires)**, **Indeed**, and **Wellfound / AngelList**.
- **High Throughput Batching**: Scale applications up to **40 jobs per batch** with automated progressive scrolling and smart duplicate skipping.
- **Intelligent Questionnaire Resolver**: Accurately computes experience for specific technical skills (e.g. FastAPI, MLOps, Kubernetes, Docker, AWS), notice periods, current/expected CTC, and relocation preferences directly from candidate profiles.
- **Privacy-Focused & Hybrid AI**: Extension runs locally in your browser. Connect directly to AWS Bedrock, OpenAI, Anthropic, Gemini, Groq, Ollama, or our dedicated Cloud Run backend.
- **Production-Ready Backend**: Complete SaaS backend deployed on Google Cloud Run with Firebase Realtime Database and Razorpay billing.

## 📊 Key Features

- **🚀 LinkedIn Easy Apply Engine**: Multi-step modal navigation, contact verification, document upload, and questionnaire auto-fill.
- **⚡ Naukri Fast Apply & Questionnaire Resolver**: 1-Click fast apply combined with deep form resolvers that handle skill-specific experience calculations, radio buttons, dropdowns, and numeric inputs with 20ms human-like micro-delays and DOM state settlement.
- **📈 Scalable Batch Runner (40 Jobs/Batch)**: High-speed queue processing that progressively scrolls job feeds, collects listings, and applies without manual intervention.
- **🧠 Multi-Agent System**: Specialized Planner and Navigator agents collaborate to handle unexpected modal dialogs and dynamic UI states.
- **💬 Interactive Side Panel**: Intuitive Chrome side panel with live job counters, progress bars, real-time logs, and history tracking.
- **💳 SaaS Infrastructure**: Google Cloud Run backend, Firebase Realtime Database for real-time sync, JWT authentication, and Razorpay subscription tiers.

## 🌐 Browser Support

**Officially Supported:**
- **Google Chrome** (Recommended) — Full support with Chrome Manifest V3
- **Microsoft Edge** — Full Chromium compatibility

## 🚀 Quick Start: Install Extension

### ⚡ Option 1: Load Pre-Built Package (Instant — No Build Needed)

1. **Download:** Download [`JobPilot-AI-Extension-Latest.zip`](./JobPilot-AI-Extension-Latest.zip) from this repository root.
2. **Extract:** Unzip the `.zip` file into a folder on your computer.
3. **Open Extensions Page:** Open Google Chrome and navigate to `chrome://extensions/`.
4. **Enable Developer Mode:** Toggle **Developer mode** in the top-right corner.
5. **Load Unpacked:** Click **Load unpacked** (top-left) and select the extracted folder.
6. **Open Side Panel:** Click the JobPilot AI icon in your browser toolbar to open the automation panel.

### 🛠️ Option 2: Build from Source

If you prefer to build Nanobrowser yourself, follow these steps:

1. **Prerequisites**:
   * [Node.js](https://nodejs.org/) (v22.12.0 or higher)
   * [pnpm](https://pnpm.io/installation) (v9.15.1 or higher)

2. **Clone the Repository**:
   ```bash
   git clone https://github.com/nanobrowser/nanobrowser.git
   cd nanobrowser
   ```

3. **Install Dependencies**:
   ```bash
   pnpm install
   ```

4. **Build the Extension**:
   ```bash
   pnpm build
   ```

5. **Load the Extension**:
   * The built extension will be in the `dist` directory
   * Follow the installation steps from the Manually Install section to load the extension into your browser

6. **Development Mode** (optional):
   ```bash
   pnpm dev
   ```

## 🤖 Choosing Your Models

Nanobrowser allows you to configure different LLM models for each agent to balance performance and cost. Here are recommended configurations:

### Better Performance
- **Planner**: Claude Sonnet 4
  - Better reasoning and planning capabilities
- **Navigator**: Claude Haiku 3.5
  - Efficient for web navigation tasks
  - Good balance of performance and cost

### Cost-Effective Configuration
- **Planner**: Claude Haiku or GPT-4o
  - Reasonable performance at lower cost
  - May require more iterations for complex tasks
- **Navigator**: Gemini 2.5 Flash or GPT-4o-mini
  - Lightweight and cost-efficient
  - Suitable for basic navigation tasks

### Local Models
- **Setup Options**:
  - Use Ollama or other custom OpenAI-compatible providers to run models locally
  - Zero API costs and complete privacy with no data leaving your machine

- **Recommended Models**:
  - **Qwen3-30B-A3B-Instruct-2507**
  - **Falcon3 10B**
  - **Qwen 2.5 Coder 14B**
  - **Mistral Small 24B**
  - [Latest test results from community](https://gist.github.com/maximus2600/75d60bf3df62986e2254d5166e2524cb) 
  - We welcome community experience sharing with other local models in our [Discord](https://discord.gg/NN3ABHggMK)

- **Prompt Engineering**:
  - Local models require more specific and cleaner prompts
  - Avoid high-level, ambiguous commands
  - Break complex tasks into clear, detailed steps
  - Provide explicit context and constraints

> **Note**: The cost-effective configuration may produce less stable outputs and require more iterations for complex tasks.

> **Tip**: Feel free to experiment with your own model configurations! Found a great combination? Share it with the community in our [Discord](https://discord.gg/NN3ABHggMK) to help others optimize their setup.

## 💡 See It In Action

Here are some powerful tasks you can accomplish with just a sentence:

1. **News Summary**:
   > "Go to TechCrunch and extract top 10 headlines from the last 24 hours"

2. **GitHub Research**:
   > "Look for the trending Python repositories on GitHub with most stars"

3. **Shopping Research**:
   > "Find a portable Bluetooth speaker on Amazon with a water-resistant design, under $50. It should have a minimum battery life of 10 hours"

## 🛠️ Roadmap

We're actively developing Nanobrowser with exciting features on the horizon, welcome to join us! 

Check out our detailed roadmap and upcoming features in our [GitHub Discussions](https://github.com/nanobrowser/nanobrowser/discussions/85). 

## 🤝 Contributing

**We need your help to make Nanobrowser even better!**  Contributions of all kinds are welcome:

*  **Share Prompts & Use Cases** 
   * Join our [Discord server](https://discord.gg/NN3ABHggMK).
   * share how you're using Nanobrowser.  Help us build a library of useful prompts and real-world use cases.
*  **Provide Feedback** 
   * Try Nanobrowser and give us feedback on its performance or suggest improvements in our [Discord server](https://discord.gg/NN3ABHggMK).
* **Contribute Code**
   * Check out our [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute code to the project.
   * Submit pull requests for bug fixes, features, or documentation improvements.


We believe in the power of open source and community collaboration.  Join us in building the future of web automation!


## 🔒 Security

If you discover a security vulnerability, please **DO NOT** disclose it publicly through issues, pull requests, or discussions.

Instead, please create a [GitHub Security Advisory](https://github.com/nanobrowser/nanobrowser/security/advisories/new) to report the vulnerability responsibly. This allows us to address the issue before it's publicly disclosed.

We appreciate your help in keeping Nanobrowser and its users safe!

## 💬 Community

Join our growing community of developers and users:

- [Discord](https://discord.gg/NN3ABHggMK) - Chat with team and community
- [Twitter](https://x.com/nanobrowser_ai) - Follow for updates and announcements
- [GitHub Discussions](https://github.com/nanobrowser/nanobrowser/discussions) - Share ideas and ask questions

## 👏 Acknowledgments

Nanobrowser builds on top of other awesome open-source projects:

- [Browser Use](https://github.com/browser-use/browser-use)
- [Puppeteer](https://github.com/EmergenceAI/Agent-E)
- [Chrome Extension Boilerplate](https://github.com/Jonghakseo/chrome-extension-boilerplate-react-vite)
- [LangChain](https://github.com/langchain-ai/langchainjs)

Huge thanks to their creators and contributors!

## 🧪 Testing & Verification

JobPilot AI includes comprehensive Vitest unit test coverage for job form question resolution, platform adapters, and profile experience calculations:

```bash
# Run Naukri questionnaire resolver test suite (26 tests passing)
pnpm vitest run src/background/agent/__tests__/naukriQuestionnaire.test.ts

# Run full project type checking
pnpm type-check

# Run all unit tests
pnpm test
```

## 📚 Engineering Documentation

Detailed architectural specifications, system diagrams, and deployment guides for engineers and reviewers are available in the [`docs/`](./docs/README.md) directory:
- [Master Documentation Index](./docs/README.md)
- [System Architecture](./docs/ARCHITECTURE.md)
- [Google Cloud Deployment Guide](./docs/GOOGLE_CLOUD_DEPLOYMENT_GUIDE.md)
- [Backend Specification](./docs/BACKEND.md)
- [Database (Firebase Realtime Database)](./docs/DATABASE.md)
- [MongoDB → Firebase RTDB Migration](./docs/FIREBASE_RTDB_MIGRATION.md)
- [Security Audit & Controls](./docs/SECURITY-AUDIT.md)
- [Testing & QA Suite](./docs/TESTING.md)

---

## 👨‍💻 Author & Engineering Portfolio

Developed and maintained by **Mubasshir Ali** as an advanced full-stack AI engineering and autonomous browser automation project.

* **GitHub:** [@MUBASSHIRALI0710](https://github.com/MUBASSHIRALI0710)
* **Repository:** [nanobrowser-saas](https://github.com/MUBASSHIRALI0710/nanobrowser-saas)
* **Email:** [mubasshirali0710@gmail.com](mailto:mubasshirali0710@gmail.com)

### 🏆 Key Engineering Achievements Demonstrated:
1. **Multi-Agent Orchestration:** Implemented a two-tiered Planner + Navigator autonomous architecture capable of dynamic reasoning, self-correction, and state settlement.
2. **High-Performance Automation:** Scaled job batch throughput from 10 to **40 jobs per batch** with automated infinite scrolling and DOM hydration.
3. **Resilient Form Question Resolver:** Solved complex technical questionnaires (FastAPI, Kubernetes, MLOps, AWS, notice periods, and CTC) matching candidate profile data with 20ms human-like micro-delays.
4. **Cloud-Native SaaS Infrastructure:** Google Cloud Run backend with Firebase Realtime Database for sub-50ms synchronization, Razorpay subscription billing, and AWS Bedrock LLM inference.
5. **Production Quality:** 100% test pass rate across 26 Vitest test suites, full TypeScript strict mode across 16 monorepo packages.

## 📄 License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

