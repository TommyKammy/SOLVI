// NFR-SEC-011 / ADR-0027: browser security headers (CSP with a per-request nonce, HSTS etc.).
// Threats T-27 (XSS) and T-28 (clickjacking / downgrade).
import { describe, expect, it } from 'vitest';
import {
  CSP_MODE,
  HSTS_MAX_AGE_SECONDS,
  attachmentUploadSource,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
  cspHeaderName,
  generateNonce,
  isHttpsRequest,
} from '../../apps/web/src/lib/security-headers';

const directives = (csp: string): Map<string, string[]> =>
  new Map(
    csp
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name!, values];
      }),
  );

const NONCE = 'dGVzdC1ub25jZS0xMjM0NQ==';

describe('Content-Security-Policy (ADR-0027 §2)', () => {
  it('matches the ADR-0027 initial policy in production', () => {
    const csp = directives(buildContentSecurityPolicy(NONCE, { development: false, https: true }));
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('script-src')).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"]);
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
    expect(csp.get('font-src')).toEqual(["'self'"]);
    expect(csp.get('connect-src')).toEqual(["'self'"]);
    expect(csp.get('form-action')).toEqual(["'self'"]);
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('base-uri')).toEqual(["'none'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.has('upgrade-insecure-requests')).toBe(true);
    expect(csp.has('report-uri')).toBe(false);
    expect(csp.has('report-to')).toBe(false);
  });

  it('sends upgrade-insecure-requests on HTTPS only (like HSTS)', () => {
    const http = directives(
      buildContentSecurityPolicy(NONCE, { development: false, https: false }),
    );
    expect(http.has('upgrade-insecure-requests')).toBe(false);
    // Everything else is identical to the HTTPS policy.
    const https = directives(
      buildContentSecurityPolicy(NONCE, { development: false, https: true }),
    );
    https.delete('upgrade-insecure-requests');
    expect(http).toEqual(https);
  });

  it('never allows unsafe-inline, unsafe-eval, * or https: in production script-src', () => {
    for (const https of [true, false]) {
      const scriptSrc =
        directives(buildContentSecurityPolicy(NONCE, { development: false, https })).get(
          'script-src',
        ) ?? [];
      for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", '*', 'https:', 'http:']) {
        expect(scriptSrc).not.toContain(forbidden);
      }
    }
  });

  it("adds 'unsafe-eval' only in development (next dev needs it)", () => {
    const dev = directives(buildContentSecurityPolicy(NONCE, { development: true, https: false }));
    expect(dev.get('script-src')).toContain("'unsafe-eval'");
    expect(dev.get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('allows no external origin anywhere without an upload source', () => {
    const csp = buildContentSecurityPolicy(NONCE, { development: false, https: true });
    expect(csp).not.toMatch(/https?:\/\//);
    expect(csp).not.toMatch(/\*/);
  });

  it('rejects a nonce that could break out of the header value', () => {
    for (const bad of ["abc'; script-src *", 'abc def', '', 'abc;']) {
      expect(() => buildContentSecurityPolicy(bad, { development: false, https: true })).toThrow();
    }
  });
});

describe('attachment upload source in connect-src (ADR-0029)', () => {
  const prod = { production: true };
  const dev = { production: false };

  it('builds <origin>/<bucket>/ from the storage settings', () => {
    expect(
      attachmentUploadSource(
        {
          publicEndpoint: 'https://s3.ap-northeast-1.amazonaws.com',
          bucket: 'solvi-attachments',
        },
        prod,
      ),
    ).toBe('https://s3.ap-northeast-1.amazonaws.com/solvi-attachments/');
  });

  it('prefers the public endpoint and falls back to the endpoint (same rule as the API)', () => {
    expect(
      attachmentUploadSource(
        {
          publicEndpoint: 'http://127.0.0.1:9100',
          endpoint: 'http://seaweedfs:8333',
          bucket: 'solvi-attachments',
        },
        dev,
      ),
    ).toBe('http://127.0.0.1:9100/solvi-attachments/');
    expect(
      attachmentUploadSource(
        { endpoint: 'http://localhost:9100', bucket: 'solvi-attachments' },
        dev,
      ),
    ).toBe('http://localhost:9100/solvi-attachments/');
  });

  it('drops any path on the endpoint and keeps only its origin', () => {
    expect(
      attachmentUploadSource(
        { publicEndpoint: 'https://storage.example.test/prefix/', bucket: 'solvi-attachments' },
        prod,
      ),
    ).toBe('https://storage.example.test/solvi-attachments/');
  });

  it('adds nothing when the settings are missing or invalid (fail closed)', () => {
    const cases: Array<[Record<string, string | undefined>, { production: boolean }]> = [
      [{ bucket: 'solvi-attachments' }, prod],
      [{ publicEndpoint: 'https://s3.ap-northeast-1.amazonaws.com' }, prod],
      [
        { publicEndpoint: 'http://s3.ap-northeast-1.amazonaws.com', bucket: 'solvi-attachments' },
        prod,
      ],
      [{ publicEndpoint: 'http://127.0.0.1:9100', bucket: 'solvi-attachments' }, prod],
      [{ publicEndpoint: 'http://storage.example.test', bucket: 'solvi-attachments' }, dev],
      [{ publicEndpoint: 'https://*.amazonaws.com', bucket: 'solvi-attachments' }, prod],
      [
        { publicEndpoint: 'https://user:pw@storage.example.test', bucket: 'solvi-attachments' },
        prod,
      ],
      [{ publicEndpoint: 'https://storage.example.test/?a=1', bucket: 'solvi-attachments' }, prod],
      [{ publicEndpoint: 'https://storage.example.test/#x', bucket: 'solvi-attachments' }, prod],
      [{ publicEndpoint: 'ftp://storage.example.test', bucket: 'solvi-attachments' }, prod],
      [{ publicEndpoint: 'not a url', bucket: 'solvi-attachments' }, prod],
      [{ publicEndpoint: 'https://storage.example.test', bucket: 'Solvi_Attachments' }, prod],
      [{ publicEndpoint: 'https://storage.example.test', bucket: 'a' }, prod],
      [{ publicEndpoint: 'https://storage.example.test', bucket: "x'; script-src *" }, prod],
      [{ publicEndpoint: 'https://storage.example.test', bucket: 'bucket/../other' }, prod],
    ];
    for (const [settings, mode] of cases) {
      expect(attachmentUploadSource(settings, mode), JSON.stringify(settings)).toBeNull();
    }
  });

  it('puts only that one source into connect-src and nothing else changes', () => {
    const source = 'https://s3.ap-northeast-1.amazonaws.com/solvi-attachments/';
    const withUpload = directives(
      buildContentSecurityPolicy(NONCE, { development: false, https: true, uploadSource: source }),
    );
    const without = directives(
      buildContentSecurityPolicy(NONCE, { development: false, https: true }),
    );
    expect(withUpload.get('connect-src')).toEqual(["'self'", source]);
    for (const [name, values] of without) {
      if (name !== 'connect-src') expect(withUpload.get(name)).toEqual(values);
    }
  });

  it('rejects an upload source that is not a bucket path', () => {
    for (const bad of [
      'https://s3.ap-northeast-1.amazonaws.com',
      'https://s3.ap-northeast-1.amazonaws.com/',
      "https://x.test/b/; script-src 'unsafe-inline'",
      '*',
    ]) {
      expect(() =>
        buildContentSecurityPolicy(NONCE, { development: false, https: true, uploadSource: bad }),
      ).toThrow();
    }
  });
});

describe('nonce generation', () => {
  it('is base64 of 16 random bytes and differs per call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const nonce = generateNonce();
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      seen.add(nonce);
    }
    expect(seen.size).toBe(1000);
  });
});

describe('fixed headers (ADR-0027 §3)', () => {
  it('sets the fixed headers with the ADR values', () => {
    const headers = buildSecurityHeaders({ https: true });
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['Permissions-Policy']).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(headers['X-Frame-Options']).toBe('DENY');
  });

  it('sends HSTS on HTTPS only, without includeSubDomains or preload', () => {
    expect(buildSecurityHeaders({ https: true })['Strict-Transport-Security']).toBe(
      `max-age=${HSTS_MAX_AGE_SECONDS}`,
    );
    expect(buildSecurityHeaders({ https: false })).not.toHaveProperty('Strict-Transport-Security');
  });

  it('starts HSTS at one of the staged values', () => {
    expect([300, 604800, 31536000]).toContain(HSTS_MAX_AGE_SECONDS);
  });
});

describe('rollout mode', () => {
  it('chooses the header name from the code constant, not from the environment', () => {
    expect(cspHeaderName('report-only')).toBe('Content-Security-Policy-Report-Only');
    expect(cspHeaderName('enforce')).toBe('Content-Security-Policy');
    expect(['report-only', 'enforce']).toContain(CSP_MODE);
  });
});

describe('HTTPS detection', () => {
  it('trusts the forwarded protocol set by the load balancer, else the URL', () => {
    expect(isHttpsRequest('http:', 'https')).toBe(true);
    expect(isHttpsRequest('http:', 'https, http')).toBe(true);
    expect(isHttpsRequest('http:', null)).toBe(false);
    expect(isHttpsRequest('https:', null)).toBe(true);
    expect(isHttpsRequest('http:', 'http')).toBe(false);
  });
});
