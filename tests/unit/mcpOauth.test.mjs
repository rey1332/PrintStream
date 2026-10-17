import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorizationServerMetadata,
  protectedResourceMetadata,
  redirectAllowed,
  s256,
  validVerifier,
} from '../../src/server/mcp/oauth.ts';

test("redirect addresses: Claude's callback, this machine, and what the server adds", () => {
  assert.equal(redirectAllowed('https://claude.ai/api/mcp/auth_callback', {}), true);
  assert.equal(redirectAllowed('https://claude.com/api/mcp/auth_callback', {}), true);
  // Claude Code and other local clients listen on a loopback port.
  assert.equal(redirectAllowed('http://localhost:33418/callback', {}), true);
  assert.equal(redirectAllowed('http://127.0.0.1:8080/oauth/callback', {}), true);
  // Anything else is refused unless the administrator allows it.
  assert.equal(redirectAllowed('https://evil.example/cb', {}), false);
  assert.equal(redirectAllowed('https://claude.ai.evil.example/api/mcp/auth_callback', {}), false);
  assert.equal(redirectAllowed('https://claude.ai/api/mcp/auth_callback/../x', {}), false);
  assert.equal(redirectAllowed('http://claude.ai/api/mcp/auth_callback', {}), false);
  assert.equal(redirectAllowed('https://claude.ai/api/mcp/auth_callback#x', {}), false);
  assert.equal(redirectAllowed('http://user:pw@localhost/cb', {}), false);
  assert.equal(redirectAllowed('javascript:alert(1)', {}), false);
  const env = {
    ETNA_MCP_OAUTH_REDIRECTS: 'cursor://anysphere.cursor-retrieval/, https://mcp.example.com/cb',
  };
  assert.equal(redirectAllowed('cursor://anysphere.cursor-retrieval/oauth/callback', env), true);
  assert.equal(redirectAllowed('https://mcp.example.com/cb', env), true);
  assert.equal(redirectAllowed('https://mcp.example.com/cb2', env), false);
});

test('discovery documents point at this server', () => {
  const issuer = 'https://printstream.example.id';
  const resource = protectedResourceMetadata(issuer);
  assert.equal(resource.resource, `${issuer}/api/mcp`);
  assert.deepEqual(resource.authorization_servers, [issuer]);
  const as = authorizationServerMetadata(issuer);
  assert.equal(as.issuer, issuer);
  assert.equal(as.authorization_endpoint, `${issuer}/oauth/authorize`);
  assert.equal(as.token_endpoint, `${issuer}/api/oauth/token`);
  assert.equal(as.registration_endpoint, `${issuer}/api/oauth/register`);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
});

test('PKCE S256 as RFC 7636 computes it', () => {
  // The example of RFC 7636, appendix B.
  assert.equal(
    s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
  );
  assert.equal(validVerifier('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), true);
  assert.equal(validVerifier('too-short'), false);
});
