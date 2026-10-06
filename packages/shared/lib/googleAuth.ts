import { GOOGLE_CLIENT_ID } from './config';
import { backendApiClient } from './backend-api-client';

function generateRandomString(length: number = 32): string {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  let result = '';
  for (let i = 0; i < array.length; i++) {
    result += charset[array[i] % charset.length];
  }
  return result;
}

export interface GoogleSignInResult {
  token: string;
  refreshToken?: string;
  user: any;
  subscription?: any;
}

/**
 * Initiates Google OAuth2 Web Auth Flow using chrome.identity.launchWebAuthFlow,
 * verifies the returned state, and exchanges the id_token and nonce with the backend.
 */
let isFlowInProgress = false;

export async function launchGoogleWebAuthFlow(): Promise<GoogleSignInResult> {
  if (isFlowInProgress) {
    throw new Error('A Google sign-in window is already open. Please check your open windows or taskbar.');
  }

  if (!GOOGLE_CLIENT_ID) {
    throw new Error('Google Client ID is not configured. Please set VITE_GOOGLE_CLIENT_ID in your environment.');
  }

  if (typeof chrome === 'undefined' || !chrome.identity?.launchWebAuthFlow) {
    throw new Error('Google Sign-In is only available within the Chrome extension environment.');
  }

  isFlowInProgress = true;
  try {
    const nonce = generateRandomString(32);
    const state = generateRandomString(32);
    const redirectUri = chrome.identity.getRedirectURL();

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('response_type', 'id_token');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('prompt', 'select_account');
    authUrl.searchParams.set('nonce', nonce);
    authUrl.searchParams.set('state', state);

    const responseUrl = await new Promise<string>((resolve, reject) => {
      chrome.identity.launchWebAuthFlow(
        {
          url: authUrl.toString(),
          interactive: true,
        },
        redirectUrl => {
          if (chrome.runtime.lastError) {
            const rawMsg = chrome.runtime.lastError.message || '';
            if (rawMsg.includes('Only one web auth flow is allowed')) {
              return reject(
                new Error(
                  'A Google sign-in window is already open. Check your open windows or taskbar, or reload the extension.',
                ),
              );
            }
            return reject(new Error(rawMsg || 'Google sign-in flow failed'));
          }
          if (!redirectUrl) {
            return reject(new Error('No redirect URL returned from Google sign-in'));
          }
          resolve(redirectUrl);
        },
      );
    });

    const parsedUrl = new URL(responseUrl);
    // Parse fragment (#id_token=...&state=...)
    const fragment = parsedUrl.hash.startsWith('#') ? parsedUrl.hash.slice(1) : parsedUrl.hash;
    const fragmentParams = new URLSearchParams(fragment);

    const error = fragmentParams.get('error') || parsedUrl.searchParams.get('error');
    if (error) {
      const errorDescription =
        fragmentParams.get('error_description') || parsedUrl.searchParams.get('error_description') || error;
      throw new Error(`Google Sign-In error: ${errorDescription}`);
    }

    const returnedState = fragmentParams.get('state') || parsedUrl.searchParams.get('state');
    if (!returnedState || returnedState !== state) {
      throw new Error('Google Sign-In security check failed: state parameter mismatch.');
    }

    const idToken = fragmentParams.get('id_token') || parsedUrl.searchParams.get('id_token');
    if (!idToken) {
      throw new Error('Google Sign-In failed: id_token not found in redirect response.');
    }

    const res = await backendApiClient.loginWithGoogle({ idToken, nonce });
    if (!res.data) {
      throw new Error(res.error?.code || res.message || 'Backend Google authentication failed.');
    }

    return res.data;
  } finally {
    isFlowInProgress = false;
  }
}
