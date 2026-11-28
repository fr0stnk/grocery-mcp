import crypto from 'node:crypto';

const JWKS_TTL_MS = 10 * 60_000;
const JWKS_RETRY_MS = 30_000;
const CLOCK_SKEW_S = 60;
// openid and email let the server look up a new person's verified email at userinfo; Pocket ID 2.19 puts no email in access tokens.
export const SCOPES = ['openid', 'email'];

// Asymmetric algorithms only: "none" and the HMAC family would let anyone who knows a shared secret, or nothing, mint tokens.
const ALGORITHMS = {
  RS256: { hash: 'sha256' }, RS384: { hash: 'sha384' }, RS512: { hash: 'sha512' },
  PS256: { hash: 'sha256', pss: true }, PS384: { hash: 'sha384', pss: true }, PS512: { hash: 'sha512', pss: true },
  ES256: { hash: 'sha256', ec: true }, ES384: { hash: 'sha384', ec: true }, ES512: { hash: 'sha512', ec: true },
  EdDSA: { hash: null },
};

export class AuthError extends Error {
  constructor(message, code = 'invalid_token') {
    super(message);
    this.code = code;
  }
}

/**
 * Sign-in for the public listener, or null when it is not configured. Every
 * value is required once GROCERY_PUBLIC_HTTP is set, so a half-configured
 * server refuses to start rather than serving without sign-in.
 */
export function oauthConfig(env = process.env) {
  if (!env.GROCERY_PUBLIC_HTTP) return null;
  const missing = ['GROCERY_PUBLIC_URL', 'GROCERY_OAUTH_ISSUER'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`GROCERY_PUBLIC_HTTP needs ${missing.join(' and ')}`);
  const publicUrl = new URL(env.GROCERY_PUBLIC_URL);
  if (publicUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(publicUrl.hostname)) throw new Error('GROCERY_PUBLIC_URL must be https');
  const base = publicUrl.origin;
  const issuer = env.GROCERY_OAUTH_ISSUER.replace(/\/+$/, '');
  return {
    listen: env.GROCERY_PUBLIC_HTTP,
    publicHost: publicUrl.host,
    issuer,
    resource: `${base}/mcp`,
    audience: env.GROCERY_OAUTH_AUDIENCE || `${base}/mcp`,
    metadataUrl: `${base}/.well-known/oauth-protected-resource/mcp`,
  };
}

/** RFC 9728 protected-resource metadata: where clients find the authorization server. */
export function protectedResourceMetadata(config) {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: SCOPES,
    resource_name: 'Grocery',
  };
}

/** The WWW-Authenticate value for a 401: always names the metadata, and the error when a token was sent. */
export function challenge(config, error = null) {
  const parts = [`Bearer resource_metadata="${config.metadataUrl}"`, `scope="${SCOPES.join(' ')}"`];
  if (error) parts.push(`error="${error.code}"`, `error_description="${error.message.replace(/["\\]/g, '')}"`);
  return parts.join(', ');
}

export function bearerToken(req) {
  const m = /^Bearer\s+([A-Za-z0-9\-._~+/]+=*)\s*$/i.exec(req.headers.authorization ?? '');
  return m ? m[1] : null;
}

const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/**
 * Verifies JWT access tokens from one issuer: signature against the issuer's
 * published keys, then iss, aud, exp and nbf. Keys are found through the
 * issuer's discovery document and cached; an unknown key id refetches them,
 * at most every 30 seconds, so a key rotation is picked up.
 */
export function createTokenVerifier({ issuer, audience, fetchJson = defaultFetchJson, now = () => Date.now() }) {
  let keys = null;
  let fetchedAt = 0;
  let meta = null;

  async function loadKeys() {
    try {
      await fetchKeys();
    } catch (error) {
      throw error instanceof AuthError ? error : new AuthError(`the issuer's keys cannot be fetched: ${error.cause?.code ?? error.message}`, 'server_error');
    }
  }

  async function discovery() {
    if (!meta) {
      const found = await fetchJson(`${issuer}/.well-known/openid-configuration`).catch(() => fetchJson(`${issuer}/.well-known/oauth-authorization-server`));
      if (found?.issuer?.replace(/\/+$/, '') !== issuer || !found.jwks_uri) throw new AuthError('the issuer\'s discovery document does not match it', 'server_error');
      meta = found;
    }
    return meta;
  }

  async function fetchKeys() {
    const jwks = await fetchJson((await discovery()).jwks_uri);
    keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
    fetchedAt = now();
  }

  async function keyFor(kid, alg) {
    if (!keys || now() - fetchedAt > JWKS_TTL_MS) await loadKeys();
    const find = () => (kid ? keys.find((k) => k.kid === kid) : keys.length === 1 ? keys[0] : null);
    let jwk = find();
    if (!jwk && now() - fetchedAt > JWKS_RETRY_MS) {
      await loadKeys();
      jwk = find();
    }
    if (!jwk) throw new AuthError('the token was signed with an unknown key');
    if (jwk.alg && jwk.alg !== alg) throw new AuthError('the token\'s algorithm does not match its key');
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  }

  async function verify(token) {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3) throw new AuthError('the access token is not a JWT');
    let header;
    let claims;
    try {
      header = decode(parts[0]);
      claims = decode(parts[1]);
    } catch {
      throw new AuthError('the access token cannot be read');
    }
    const alg = ALGORITHMS[header.alg];
    if (!alg) throw new AuthError(`the token's algorithm ${JSON.stringify(header.alg)} is not accepted`);
    const key = await keyFor(header.kid, header.alg);
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2], 'base64url');
    const options = { key, ...(alg.ec ? { dsaEncoding: 'ieee-p1363' } : {}), ...(alg.pss ? { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST } : {}) };
    let valid = false;
    try {
      valid = crypto.verify(alg.hash, signed, options, signature);
    } catch {
      valid = false;
    }
    if (!valid) throw new AuthError('the token\'s signature is not valid');

    const t = Math.floor(now() / 1000);
    if (String(claims.iss ?? '').replace(/\/+$/, '') !== issuer) throw new AuthError('the token is from another issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new AuthError('the token is not for this server');
    if (!Number.isFinite(claims.exp) || claims.exp + CLOCK_SKEW_S < t) throw new AuthError('the token has expired');
    if (Number.isFinite(claims.nbf) && claims.nbf - CLOCK_SKEW_S > t) throw new AuthError('the token is not valid yet');
    if (!claims.sub) throw new AuthError('the token names no subject');
    return claims;
  }

  /**
   * The verified email of the person a valid token belongs to: from the token
   * when it carries one, otherwise from the issuer's userinfo endpoint, which
   * must name the same subject. An email the issuer has not verified is never
   * used, since it is what links a first sign-in to a person.
   */
  verify.email = async function email(token, claims) {
    if (claims.email && claims.email_verified === true) return claims.email;
    let endpoint;
    try {
      endpoint = (await discovery()).userinfo_endpoint;
    } catch (error) {
      throw error instanceof AuthError ? error : new AuthError(`the issuer cannot be reached: ${error.message}`, 'server_error');
    }
    if (!endpoint) return null;
    let info;
    try {
      info = await fetchJson(endpoint, { authorization: `Bearer ${token}` });
    } catch {
      return null;
    }
    if (info?.sub !== claims.sub) return null;
    return info.email && info.email_verified === true ? info.email : null;
  };

  return verify;
}

async function defaultFetchJson(url, headers = {}) {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new AuthError(`${new URL(url).host} answered HTTP ${response.status}`, 'server_error');
  return response.json();
}
