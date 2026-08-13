import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  API_CONTENT_SECURITY_POLICY,
  appContentSecurityPolicy,
  firebaseAuthDomains,
  inlineScriptHashes,
  securityHeadersFor,
} from '../src/security-headers.ts';

/**
 * The policy is the risky half of this feature: a CSP that blocks Firebase is a
 * sign-in screen that never returns, and that is worse than shipping no policy
 * at all. So the directives Firebase Auth depends on are asserted by name here,
 * and any future tightening has to walk past them.
 */

/** `"script-src 'self' https://x; img-src 'self'"` → `{ 'script-src': [...] }`. */
function directives(policy: string): Record<string, string[]> {
  const parsed: Record<string, string[]> = {};
  for (const clause of policy.split(';')) {
    const parts = clause.trim().split(/\s+/).filter(Boolean);
    const name = parts.shift();
    if (name) parsed[name] = parts;
  }
  return parsed;
}

const AUTH_DOMAIN = 'tally-demo.firebaseapp.com';

describe('appContentSecurityPolicy', () => {
  const policy = directives(appContentSecurityPolicy({ authDomains: [AUTH_DOMAIN] }));

  it('falls back to same-origin for anything not named', () => {
    assert.deepEqual(policy['default-src'], ["'self'"]);
  });

  it('lets Firebase load the gapi bridge the popup flow needs', () => {
    // firebase/auth pulls https://apis.google.com/js/api.js to build the hidden
    // iframe behind signInWithPopup and signInWithRedirect. Without this, Google
    // sign-in fails and nothing else does, so it is easy to miss in testing.
    assert.ok(policy['script-src']?.includes('https://apis.google.com'));
  });

  it('keeps script-src free of unsafe-inline and unsafe-eval', () => {
    assert.ok(!policy['script-src']?.includes("'unsafe-inline'"));
    assert.ok(!policy['script-src']?.includes("'unsafe-eval'"));
  });

  it('permits the identity and token-refresh endpoints', () => {
    // securetoken is the hourly ID-token refresh: block it and sign-in appears
    // to work, then everyone is signed out an hour later.
    assert.ok(policy['connect-src']?.includes('https://identitytoolkit.googleapis.com'));
    assert.ok(policy['connect-src']?.includes('https://securetoken.googleapis.com'));
  });

  it('keeps the API and the SSE stream reachable', () => {
    assert.ok(policy['connect-src']?.includes("'self'"));
  });

  it('frames the auth domain, and only the auth domain', () => {
    assert.deepEqual(policy['frame-src'], ["'self'", `https://${AUTH_DOMAIN}`]);
  });

  it('lists every configured auth domain', () => {
    const many = directives(
      appContentSecurityPolicy({ authDomains: ['tally.example', AUTH_DOMAIN] }),
    );
    assert.deepEqual(many['frame-src'], ["'self'", 'https://tally.example', `https://${AUTH_DOMAIN}`]);
  });

  it('omits third-party frames entirely when no auth domain is configured', () => {
    const bare = directives(appContentSecurityPolicy({}));
    assert.deepEqual(bare['frame-src'], ["'self'"]);
  });

  it('refuses to be framed, embedded or rebased', () => {
    assert.deepEqual(policy['frame-ancestors'], ["'none'"]);
    assert.deepEqual(policy['object-src'], ["'none'"]);
    assert.deepEqual(policy['base-uri'], ["'self'"]);
    assert.deepEqual(policy['form-action'], ["'self'"]);
  });

  it('allows the service worker and the web manifest', () => {
    assert.ok(policy['worker-src']?.includes("'self'"));
    assert.ok(policy['manifest-src']?.includes("'self'"));
  });

  it('allows avatars from whatever https host the identity provider used', () => {
    // photo_url comes from the token's `picture` claim — lh3.googleusercontent.com
    // today, something else the moment another provider is enabled.
    assert.ok(policy['img-src']?.includes('https:'));
    assert.ok(policy['img-src']?.includes('data:'));
  });

  it('carries inline script hashes into script-src', () => {
    const withHash = directives(
      appContentSecurityPolicy({ scriptHashes: ["'sha256-abc123'"] }),
    );
    assert.ok(withHash['script-src']?.includes("'sha256-abc123'"));
  });

  it('only asks for upgrade-insecure-requests when told to', () => {
    assert.ok(!('upgrade-insecure-requests' in policy));
    const upgraded = directives(appContentSecurityPolicy({ upgradeInsecureRequests: true }));
    assert.ok('upgrade-insecure-requests' in upgraded);
  });
});

describe('API_CONTENT_SECURITY_POLICY', () => {
  const policy = directives(API_CONTENT_SECURITY_POLICY);

  it('lets a JSON endpoint load nothing at all', () => {
    // Nothing legitimately renders from an API response, so the loosest policy
    // the app needs does not have to apply here.
    assert.deepEqual(policy['default-src'], ["'none'"]);
    assert.deepEqual(policy['frame-ancestors'], ["'none'"]);
    assert.deepEqual(policy['base-uri'], ["'none'"]);
  });
});

describe('inlineScriptHashes', () => {
  it('matches the hash a browser computes', () => {
    // The vector from the CSP documentation for `alert('Hello, world.');`.
    const hashes = inlineScriptHashes(`<script>alert('Hello, world.');</script>`);
    assert.deepEqual(hashes, ["'sha256-qznLcsROx4GACP2dm0UCKCzCG+HiZ1guq6ZZDob/Tng='"]);
  });

  it('hashes the script body byte for byte, whitespace included', () => {
    // A browser hashes exactly what sits between the tags. Trimming here would
    // produce a hash that never matches and a blank screen on first paint.
    const [padded] = inlineScriptHashes('<script>\n  var a = 1;\n</script>');
    const [tight] = inlineScriptHashes('<script>var a = 1;</script>');
    assert.notEqual(padded, tight);
  });

  it('ignores scripts with a src — those are covered by self', () => {
    assert.deepEqual(inlineScriptHashes('<script type="module" src="/assets/app.js"></script>'), []);
  });

  it('ignores an empty script', () => {
    assert.deepEqual(inlineScriptHashes('<script>\n</script>'), []);
  });

  it('finds every inline script in a document, without duplicates', () => {
    const html = `<html><head><script>var a = 1;</script>
      <script src="/x.js"></script></head>
      <body><script>var a = 1;</script><script>var b = 2;</script></body></html>`;
    assert.equal(inlineScriptHashes(html).length, 2);
  });

  it('handles attributes and odd casing on the tag', () => {
    assert.equal(inlineScriptHashes('<SCRIPT type="text/javascript">var a = 1;</SCRIPT>').length, 1);
  });
});

describe('firebaseAuthDomains', () => {
  it('derives the default Firebase domain from the project id', () => {
    // The web build's VITE_FIREBASE_AUTH_DOMAIN is not visible to the server, so
    // the common case has to work off the project id it already needs.
    assert.deepEqual(firebaseAuthDomains('tally-demo', ''), ['tally-demo.firebaseapp.com']);
  });

  it('keeps an explicit custom domain first and the default alongside it', () => {
    assert.deepEqual(firebaseAuthDomains('tally-demo', 'auth.tally.example'), [
      'auth.tally.example',
      'tally-demo.firebaseapp.com',
    ]);
  });

  it('does not repeat itself when the explicit domain is the default one', () => {
    assert.deepEqual(firebaseAuthDomains('tally-demo', 'tally-demo.firebaseapp.com'), [
      'tally-demo.firebaseapp.com',
    ]);
  });

  it('strips a scheme or trailing slash someone pasted in', () => {
    assert.deepEqual(firebaseAuthDomains('', 'https://auth.tally.example/'), ['auth.tally.example']);
  });

  it('returns nothing when Firebase is not configured', () => {
    assert.deepEqual(firebaseAuthDomains('', ''), []);
  });
});

describe('securityHeadersFor', () => {
  const forPath = (path: string, extra: Record<string, unknown> = {}) =>
    securityHeadersFor({ authDomains: [AUTH_DOMAIN], ...extra }, { path, secure: false });

  it('sends the always-on headers on every response', () => {
    const headers = forPath('/api/lists');
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['X-Frame-Options'], 'DENY');
    assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
    assert.equal(headers['X-Permitted-Cross-Domain-Policies'], 'none');
    assert.ok(headers['Permissions-Policy']?.includes('camera=()'));
  });

  it('keeps the referrer off invite tokens without breaking same-origin links', () => {
    // Invite links carry the token in the path (/j/<token>). strict-origin-when-
    // cross-origin sends only the origin to another site, so the token cannot
    // leak through a Referer header, while same-origin navigation still works.
    assert.equal(forPath('/j/token')['Referrer-Policy'], 'strict-origin-when-cross-origin');
  });

  it('allows popups through COOP, because signInWithPopup depends on it', () => {
    // 'same-origin' would sever window.opener and the Google popup would hang
    // forever on a blank page.
    assert.equal(forPath('/')['Cross-Origin-Opener-Policy'], 'same-origin-allow-popups');
  });

  it('serves the strict policy to API paths and the app policy to everything else', () => {
    assert.equal(forPath('/api/lists')['Content-Security-Policy'], API_CONTENT_SECURITY_POLICY);
    assert.ok(forPath('/')['Content-Security-Policy']?.includes('https://apis.google.com'));
    assert.ok(forPath('/j/abc')['Content-Security-Policy']?.includes('https://apis.google.com'));
  });

  it('does not mistake an app route that merely starts with "api" for the API', () => {
    assert.ok(forPath('/apiary')['Content-Security-Policy']?.includes('https://apis.google.com'));
  });

  it('can report instead of enforce, so a policy can be trialled before it bites', () => {
    const headers = forPath('/', { reportOnly: true });
    assert.ok(headers['Content-Security-Policy-Report-Only']);
    assert.equal(headers['Content-Security-Policy'], undefined);
  });

  it('withholds HSTS from plaintext requests', () => {
    // A max-age pinned from a local http run would lock a developer out of
    // http://localhost for two years.
    const headers = securityHeadersFor({ hsts: true }, { path: '/', secure: false });
    assert.equal(headers['Strict-Transport-Security'], undefined);
  });

  it('sends HSTS over TLS when enabled', () => {
    const headers = securityHeadersFor({ hsts: true }, { path: '/', secure: true });
    assert.match(headers['Strict-Transport-Security'] ?? '', /^max-age=\d+; includeSubDomains$/);
    assert.ok(Number(/max-age=(\d+)/.exec(headers['Strict-Transport-Security'] ?? '')?.[1]) >= 15552000);
  });

  it('leaves HSTS off entirely when it is not enabled', () => {
    const headers = securityHeadersFor({ hsts: false }, { path: '/', secure: true });
    assert.equal(headers['Strict-Transport-Security'], undefined);
  });

  it('does not set COEP, which would break the Firebase auth iframe', () => {
    assert.equal(forPath('/')['Cross-Origin-Embedder-Policy'], undefined);
  });
});
