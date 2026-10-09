# Authentication & Authorization Architecture

> Website sign-in / sign-out sync with JobForm Automator, token refresh and account isolation: see [JOBFORM_WEBSITE_SESSION.md](./JOBFORM_WEBSITE_SESSION.md).

## 1. Authentication Mechanisms
The application employs a secure, stateless **JWT (JSON Web Token)** architecture with cryptographically hashed, rotating refresh tokens and Google OAuth v3 integration.

```mermaid
sequenceDiagram
    autonumber
    actor Client as Extension / Web Client
    participant AuthAPI as Auth Routes (/api/v1/auth)
    participant AuthService as AuthService
    participant RefreshCol as RefreshToken Collection
    participant UserCol as User Collection

    Client->>AuthAPI: POST /login (email, password)
    AuthAPI->>AuthService: loginUser()
    AuthService->>UserCol: findOne({ email }).select('+passwordHash')
    AuthService->>AuthService: bcrypt.compare(password, passwordHash)
    AuthService->>AuthService: Generate Access Token (HS256, 15m)
    AuthService->>AuthService: Generate Refresh Token (UUID jti, 7d)
    AuthService->>RefreshCol: Save SHA-256 hash of refresh token
    AuthService-->>Client: { token, refreshToken, user }

    Note over Client,AuthAPI: 15 Minutes Later (Token Expired)
    Client->>AuthAPI: POST /refresh (refreshToken)
    AuthAPI->>AuthService: refreshTokens(rawToken)
    AuthService->>AuthService: jwt.verify(rawToken, JWT_REFRESH_SECRET)
    AuthService->>RefreshCol: findOne({ tokenHash })
    alt Token was already revoked
        AuthService->>RefreshCol: Revoke ALL tokens for this userId (Breach Detection)
        AuthService-->>Client: 401 Unauthorized (REFRESH_TOKEN_REUSED)
    else Token is valid
        AuthService->>RefreshCol: Mark old token revoked & record replacement
        AuthService->>AuthService: Generate new Access + Refresh token pair
        AuthService-->>Client: { token, refreshToken }
    end
```

---

## 2. Password Handling & Security
- Passwords are encrypted using **bcryptjs** with a cost factor of **12** (`bcrypt.hash(password, 12)`).
- `passwordHash` field has `select: false` on the Mongoose schema, preventing inadvertent exposure in API responses.
- Login failures return a generic error: `"Invalid email or password"` (Code: `INVALID_CREDENTIALS`) to eliminate account enumeration vectors.

---

## 3. Refresh Token Rotation & Breach Detection
- Every refresh operation issues a brand new access token AND a new refresh token.
- The previous refresh token is marked with `revokedAt = new Date()` and `replacedByTokenHash`.
- If an attacker uses an already-revoked refresh token, the server immediately triggers **Reuse Detection**: all tokens belonging to that `userId` are instantly invalidated, requiring the legitimate user to log in again.
- Expired tokens are purged automatically by MongoDB using a TTL index (`expiresAt: { expires: 0 }`).

---

## 4. Authorization & RBAC
- **Roles**:
  - `user`: Standard account. Allowed to manage own profile, run jobs within quota, checkout plans.
  - `admin`: Elevated role. Access to administrative overrides and metrics.
- **Middleware**:
  - `authenticate` (`backend/src/middleware/auth.middleware.ts`): Validates Bearer token, decodes `sub` (userId) and `role`.
  - `checkEntitlement` (`backend/src/middleware/entitlement.middleware.ts`): Ensures user has status `ACTIVE` or `TRIALING` before accessing premium features.
