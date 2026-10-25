const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  isAgent37Configured,
  resolveAgent37Endpoint,
  sanitizeErrorMessage,
  buildMentorInput,
  parseAgent37Response,
  matchRecommendedResource,
  callAgent37MessagingAPI
} = require('../services/agent37Service');

describe('Agent37 AI Project Mentor Test Suite', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env vars before each test
    delete process.env.AGENT37_ENABLED;
    delete process.env.AGENT37_API_KEY;
    delete process.env.AGENT37_INSTANCE_ID;
    delete process.env.AGENT37_INSTANCE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('1. Configuration & Flag Validation Gate', () => {
    test('should report unconfigured and disabled when AGENT37_ENABLED is not true', () => {
      process.env.AGENT37_ENABLED = 'false';
      process.env.AGENT37_API_KEY = 'sk_live_test_key_123';
      process.env.AGENT37_INSTANCE_ID = 'inst_test_abc';

      const config = isAgent37Configured();
      assert.equal(config.enabled, false);
      assert.equal(config.configured, false);
      assert.match(config.reason, /Feature disabled/);
    });

    test('should report unconfigured when enabled but API key is missing', () => {
      process.env.AGENT37_ENABLED = 'true';
      delete process.env.AGENT37_API_KEY;
      process.env.AGENT37_INSTANCE_ID = 'inst_test_abc';

      const config = isAgent37Configured();
      assert.equal(config.enabled, true);
      assert.equal(config.configured, false);
      assert.match(config.reason, /Missing AGENT37_API_KEY/);
    });

    test('should report unconfigured when enabled and key present but instance endpoint missing', () => {
      process.env.AGENT37_ENABLED = 'true';
      process.env.AGENT37_API_KEY = 'sk_live_test_key_123';
      delete process.env.AGENT37_INSTANCE_ID;
      delete process.env.AGENT37_INSTANCE_URL;

      const config = isAgent37Configured();
      assert.equal(config.enabled, true);
      assert.equal(config.configured, false);
      assert.match(config.reason, /Missing AGENT37_INSTANCE_URL/);
    });

    test('should report configured when enabled with API key and instance ID', () => {
      process.env.AGENT37_ENABLED = 'true';
      process.env.AGENT37_API_KEY = 'sk_live_test_key_123';
      process.env.AGENT37_INSTANCE_ID = 'inst_demo_987';

      const config = isAgent37Configured();
      assert.equal(config.enabled, true);
      assert.equal(config.configured, true);
      assert.equal(config.instanceId, 'inst_demo_987');
      assert.equal(config.reason, null);
    });

    test('should reject callAgent37MessagingAPI immediately if not configured', async () => {
      process.env.AGENT37_ENABLED = 'false';
      await assert.rejects(
        async () => {
          await callAgent37MessagingAPI({ input: 'Help me debug my milestone' });
        },
        {
          code: 'AGENT37_NOT_CONFIGURED'
        }
      );
    });
  });

  describe('2. Endpoint Resolution & URL Normalization', () => {
    test('should construct standard instance URL from AGENT37_INSTANCE_ID', () => {
      process.env.AGENT37_INSTANCE_ID = 'prod-mentor-42';
      const endpoint = resolveAgent37Endpoint();
      assert.equal(endpoint, 'https://prod-mentor-42.agent37.app/v1/responses');
    });

    test('should normalize custom AGENT37_INSTANCE_URL with trailing slash', () => {
      process.env.AGENT37_INSTANCE_URL = 'https://custom-gateway.agent37.app/';
      const endpoint = resolveAgent37Endpoint();
      assert.equal(endpoint, 'https://custom-gateway.agent37.app/v1/responses');
    });

    test('should normalize custom AGENT37_INSTANCE_URL ending with /v1', () => {
      process.env.AGENT37_INSTANCE_URL = 'https://custom-gateway.agent37.app/v1';
      const endpoint = resolveAgent37Endpoint();
      assert.equal(endpoint, 'https://custom-gateway.agent37.app/v1/responses');
    });

    test('should preserve custom AGENT37_INSTANCE_URL already containing /v1/responses', () => {
      process.env.AGENT37_INSTANCE_URL = 'https://custom-gateway.agent37.app/v1/responses';
      const endpoint = resolveAgent37Endpoint();
      assert.equal(endpoint, 'https://custom-gateway.agent37.app/v1/responses');
    });
  });

  describe('3. Credential Sanitization & Secret Redaction', () => {
    test('should redact API key from error strings', () => {
      const secretKey = 'sk_live_secret_token_abcdef123456';
      const rawError = `Request failed to ${secretKey} at server`;
      const sanitized = sanitizeErrorMessage(rawError, secretKey);

      assert.equal(sanitized.includes(secretKey), false);
      assert.match(sanitized, /\[REDACTED_API_KEY\]/);
    });

    test('should redact X-Agent37-Key headers in query strings or logs', () => {
      const raw = 'Failed with X-Agent37-Key: sk_live_xyz999 during handshake';
      const sanitized = sanitizeErrorMessage(raw, '');
      assert.equal(sanitized.includes('sk_live_xyz999'), false);
      assert.match(sanitized, /X-Agent37-Key: \[REDACTED\]/);
    });

    test('should redact Bearer auth tokens in error messages', () => {
      const raw = 'Authorization failed for Bearer eyJhbGciOiJIUzI1NiJ9';
      const sanitized = sanitizeErrorMessage(raw, '');
      assert.equal(sanitized.includes('eyJhbGciOiJIUzI1NiJ9'), false);
      assert.match(sanitized, /Bearer \[REDACTED\]/);
    });
  });

  describe('4. Context-Rich Mentor Prompt Construction', () => {
    test('should incorporate project title, milestone, criteria, and learner question', () => {
      const prompt = buildMentorInput({
        projectTitle: 'E-Commerce Microservices',
        techStack: ['Node.js', 'Express', 'MongoDB'],
        skillLevel: 'intermediate',
        milestoneIndex: 1,
        milestoneTitle: 'User Authentication & JWT Middleware',
        taskInstructions: 'Implement signup, login, and verifyToken middleware',
        evaluationCriteria: ['Passwords hashed with bcrypt', 'JWT tokens validated on protected routes'],
        userQuestion: 'How should I handle token expiry gracefully?'
      });

      assert.match(prompt, /E-Commerce Microservices/);
      assert.match(prompt, /Node\.js, Express, MongoDB/);
      assert.match(prompt, /CURRENT MILESTONE \(#2\)/);
      assert.match(prompt, /User Authentication & JWT Middleware/);
      assert.match(prompt, /Passwords hashed with bcrypt/);
      assert.match(prompt, /How should I handle token expiry gracefully\?/);
      assert.match(prompt, /EduVerse AI Project Mentor/);
    });

    test('should bound user question length to prevent prompt overflow', () => {
      const longQuestion = 'A'.repeat(5000);
      const prompt = buildMentorInput({
        projectTitle: 'Demo App',
        milestoneTitle: 'M1',
        userQuestion: longQuestion
      });

      // Question is capped to 2000 chars
      assert.equal(prompt.includes('A'.repeat(2500)), false);
      assert.equal(prompt.includes('A'.repeat(2000)), true);
    });

    test('should include verified candidate resources in prompt', () => {
      const prompt = buildMentorInput({
        projectTitle: 'Chat App',
        milestoneTitle: 'WebSockets',
        availableResources: [
          { title: 'Socket.IO Official Documentation', type: 'documentation', url: 'https://socket.io/docs/v4/' },
          { title: 'Fullstack Chat Playlist', type: 'skill_hub', url: null }
        ],
        userQuestion: 'How to emit broadcast events?'
      });

      assert.match(prompt, /Socket\.IO Official Documentation/);
      assert.match(prompt, /Fullstack Chat Playlist/);
    });
  });

  describe('5. Response Parsing & Normalization', () => {
    test('should parse valid output_text and session_id from documented Agent37 response', () => {
      const payload = {
        id: 'resp_abc123',
        status: 'completed',
        output_text: 'To handle token expiration, create a 401 response interceptor in Axios that catches token_expired errors and redirects to /login.',
        session_id: 'sess_999888',
        usage: { prompt_tokens: 120, completion_tokens: 45 }
      };

      const parsed = parseAgent37Response(payload);
      assert.equal(parsed.outputText, payload.output_text);
      assert.equal(parsed.sessionId, 'sess_999888');
      assert.equal(parsed.rawId, 'resp_abc123');
    });

    test('should fall back gracefully to output, response, or content fields if output_text missing', () => {
      const payload1 = { status: 'completed', output: 'Guidance text via output field' };
      const parsed1 = parseAgent37Response(payload1);
      assert.equal(parsed1.outputText, 'Guidance text via output field');

      const payload2 = { status: 'completed', response: 'Guidance text via response field' };
      const parsed2 = parseAgent37Response(payload2);
      assert.equal(parsed2.outputText, 'Guidance text via response field');

      const payload3 = { status: 'completed', content: 'Guidance text via content field' };
      const parsed3 = parseAgent37Response(payload3);
      assert.equal(parsed3.outputText, 'Guidance text via content field');
    });

    test('should reject non-object or empty responses', () => {
      assert.throws(() => parseAgent37Response(null), { code: 'AGENT37_MALFORMED_RESPONSE' });
      assert.throws(() => parseAgent37Response('plain string'), { code: 'AGENT37_MALFORMED_RESPONSE' });
    });

    test('should reject responses with status: failed and extract error code', () => {
      const failedPayload = {
        status: 'failed',
        error: { code: 'agent_unavailable', message: 'Harness container is restarting' }
      };

      assert.throws(
        () => parseAgent37Response(failedPayload),
        (err) => err.code === 'agent_unavailable' && err.message.includes('Harness container is restarting')
      );
    });

    test('should reject responses with completely empty output', () => {
      assert.throws(
        () => parseAgent37Response({ status: 'completed', output_text: '   ' }),
        { code: 'AGENT37_EMPTY_OUTPUT' }
      );
    });
  });

  describe('6. Messaging API Invocation via Mock Client', () => {
    test('should send correct headers, endpoint, and payload structure', async () => {
      process.env.AGENT37_ENABLED = 'true';
      process.env.AGENT37_API_KEY = 'sk_live_verified_12345';
      process.env.AGENT37_INSTANCE_ID = 'instance-test-node';

      let capturedCall = null;
      const mockHttpClient = {
        post: async (url, data, config) => {
          capturedCall = { url, data, config };
          return {
            status: 200,
            data: {
              status: 'completed',
              output_text: 'Here is your architectural advice: break down the schemas into modular files.',
              session_id: 'sess_new_turn_01'
            }
          };
        }
      };

      const result = await callAgent37MessagingAPI({
        input: 'How to structure mongoose models?',
        sessionId: 'sess_prev_turn_00',
        httpClient: mockHttpClient
      });

      assert.equal(capturedCall.url, 'https://instance-test-node.agent37.app/v1/responses');
      assert.equal(capturedCall.config.headers['X-Agent37-Key'], 'sk_live_verified_12345');
      assert.equal(capturedCall.config.headers['Content-Type'], 'application/json');
      assert.equal(capturedCall.data.input, 'How to structure mongoose models?');
      assert.equal(capturedCall.data.session_id, 'sess_prev_turn_00');
      assert.equal(capturedCall.data.stream, false);

      assert.equal(result.outputText, 'Here is your architectural advice: break down the schemas into modular files.');
      assert.equal(result.sessionId, 'sess_new_turn_01');
    });

    test('should handle HTTP 401 with sanitized authentication failure', async () => {
      process.env.AGENT37_ENABLED = 'true';
      process.env.AGENT37_API_KEY = 'sk_live_invalid_key';
      process.env.AGENT37_INSTANCE_ID = 'inst-123';

      const mockHttpClient = {
        post: async () => {
          const err = new Error('Request failed with status code 401');
          err.response = { status: 401, data: { error: { message: 'Unauthorized key sk_live_invalid_key' } } };
          throw err;
        }
      };

      await assert.rejects(
        async () => {
          await callAgent37MessagingAPI({ input: 'Test', httpClient: mockHttpClient });
        },
        (err) => err.code === 'AGENT37_AUTH_FAILED' && !err.message.includes('sk_live_invalid_key')
      );
    });

    test('should handle HTTP 409 session busy error', async () => {
      process.env.AGENT37_ENABLED = 'true';
      process.env.AGENT37_API_KEY = 'sk_live_key';
      process.env.AGENT37_INSTANCE_ID = 'inst-123';

      const mockHttpClient = {
        post: async () => {
          const err = new Error('Conflict');
          err.response = { status: 409, data: { error: { code: 'session_busy' } } };
          throw err;
        }
      };

      await assert.rejects(
        async () => {
          await callAgent37MessagingAPI({ input: 'Test', httpClient: mockHttpClient });
        },
        { code: 'AGENT37_SESSION_BUSY' }
      );
    });

    test('should handle HTTP 429 rate limit error', async () => {
      process.env.AGENT37_ENABLED = 'true';
      process.env.AGENT37_API_KEY = 'sk_live_key';
      process.env.AGENT37_INSTANCE_ID = 'inst-123';

      const mockHttpClient = {
        post: async () => {
          const err = new Error('Too Many Requests');
          err.response = { status: 429, data: {} };
          throw err;
        }
      };

      await assert.rejects(
        async () => {
          await callAgent37MessagingAPI({ input: 'Test', httpClient: mockHttpClient });
        },
        { code: 'AGENT37_RATE_LIMIT' }
      );
    });

    test('should handle network timeout gracefully', async () => {
      process.env.AGENT37_ENABLED = 'true';
      process.env.AGENT37_API_KEY = 'sk_live_key';
      process.env.AGENT37_INSTANCE_ID = 'inst-123';

      const mockHttpClient = {
        post: async () => {
          const err = new Error('timeout of 25000ms exceeded');
          err.code = 'ECONNABORTED';
          throw err;
        }
      };

      await assert.rejects(
        async () => {
          await callAgent37MessagingAPI({ input: 'Test', timeoutMs: 25000, httpClient: mockHttpClient });
        },
        { code: 'AGENT37_TIMEOUT' }
      );
    });
  });

  describe('7. Verified Resource Matching for Skills Hub Linkage', () => {
    const candidates = [
      {
        title: 'Mongoose Validation Guide',
        url: 'https://mongoosejs.com/docs/validation.html',
        type: 'documentation',
        skillId: null,
        destination: 'https://mongoosejs.com/docs/validation.html'
      },
      {
        title: 'Fullstack React & Node.js',
        url: 'https://youtube.com/playlist?list=PL12345',
        type: 'skill_hub',
        skillId: '6501a2b3c4d5e6f7a8b9c0d1',
        destination: '/skills/6501a2b3c4d5e6f7a8b9c0d1/learn'
      }
    ];

    test('should match candidate resource when mentor output references it', () => {
      const mentorText = 'I recommend reading the Mongoose Validation Guide to understand custom validators.';
      const match = matchRecommendedResource(mentorText, candidates);

      assert.equal(match.title, 'Mongoose Validation Guide');
      assert.equal(match.type, 'documentation');
      assert.equal(match.destination, 'https://mongoosejs.com/docs/validation.html');
    });

    test('should match enrolled Skills Hub skill when mentor output mentions it', () => {
      const mentorText = 'You should check your Fullstack React & Node.js course in Skills Hub to review JWT setup.';
      const match = matchRecommendedResource(mentorText, candidates);

      assert.equal(match.title, 'Fullstack React & Node.js');
      assert.equal(match.type, 'skill_hub');
      assert.equal(match.destination, '/skills/6501a2b3c4d5e6f7a8b9c0d1/learn');
      assert.equal(match.label, 'Open in Skills Hub');
    });

    test('should return default Skills Hub navigation when candidate list is empty', () => {
      const mentorText = 'General conceptual advice without specific resource matches.';
      const match = matchRecommendedResource(mentorText, []);

      assert.equal(match.type, 'skill_hub');
      assert.equal(match.destination, '/skills');
      assert.equal(match.title, 'EduVerse Skills Hub');
    });
  });
});
