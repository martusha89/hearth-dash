import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { applicationHandler, isOAuthRoute, oauthApiHandler, oauthDefaultHandler, withinRateLimit } from './worker.js';

const OAUTH_SCOPES = ['hearth:read', 'hearth:write'];

function createOAuthProvider(request, env) {
  const origin = new URL(request.url).origin;
  const resource = `${origin}/mcp`;
  return new OAuthProvider({
    apiRoute: '/mcp',
    apiHandler: oauthApiHandler,
    defaultHandler: oauthDefaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    async clientRegistrationCallback({ request: registrationRequest }) {
      const allowed = await withinRateLimit(env, registrationRequest, 'oauth-register', 20, 3600);
      if (!allowed) {
        return { code: 'access_denied', description: 'Too many client registrations. Try again later.', status: 429 };
      }
    },
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: OAUTH_SCOPES,
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    clientRegistrationTTL: 90 * 24 * 60 * 60,
    resourceMetadata: {
      resource,
      authorization_servers: [origin],
      scopes_supported: ['hearth:read'],
      bearer_methods_supported: ['header'],
      resource_name: 'Hearth Dash',
    },
  });
}

export default {
  fetch(request, env, ctx) {
    // Keep ordinary dashboard traffic out of the OAuth provider. Besides being
    // unnecessary, wrapping /login and /api requests can obscure the browser's
    // public origin on some Cloudflare routes and make valid CSRF checks fail.
    if (!isOAuthRoute(new URL(request.url).pathname)) {
      return applicationHandler.fetch(request, env, ctx);
    }
    return createOAuthProvider(request, env).fetch(request, env, ctx);
  },
};
