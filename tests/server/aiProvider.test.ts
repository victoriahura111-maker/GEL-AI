/**
 * Exercises the REAL provider module (no module-level mock) against a mocked
 * global `fetch`, proving that:
 *   - the outbound request is built correctly (URL, Bearer auth, JSON mode);
 *   - non-OK HTTP, network, unreadable, and empty responses become typed
 *     `AiServiceError`s; and
 *   - the API key never leaks into thrown error messages.
 *
 * No real network access is performed.
 */

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

interface FetchResponseStub {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

type ProviderModule = typeof import('../../server/src/services/ai/provider');

const ORIGINAL_FETCH = globalThis.fetch;

const ORIGINAL_ENV = {
  AI_API_KEY: process.env.AI_API_KEY,
  AI_MODEL: process.env.AI_MODEL,
  AI_BASE_URL: process.env.AI_BASE_URL,
};

const fetchMock = jest.fn();

/** Sets the AI-related env then re-imports the provider with a clean registry. */
async function loadProvider(env: {
  apiKey: string;
  model: string;
  baseUrl?: string;
}): Promise<ProviderModule> {
  // Assign (never delete) so dotenv cannot repopulate from a local .env; an
  // empty string is coerced to `undefined` by the config loader.
  process.env.AI_API_KEY = env.apiKey;
  process.env.AI_MODEL = env.model;
  process.env.AI_BASE_URL = env.baseUrl ?? '';

  jest.resetModules();
  return import('../../server/src/services/ai/provider');
}

function lastFetchCall(): [string, FetchInit] {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [FetchInput, FetchInit];
  return [String(call[0]), call[1]];
}

/** Reads the thrown error without failing the individual assertion. */
async function captureError(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('Expected the promise to reject, but it resolved.');
    },
    (error: unknown) => error as Error
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ENV.AI_API_KEY === undefined) delete process.env.AI_API_KEY;
  else process.env.AI_API_KEY = ORIGINAL_ENV.AI_API_KEY;
  if (ORIGINAL_ENV.AI_MODEL === undefined) delete process.env.AI_MODEL;
  else process.env.AI_MODEL = ORIGINAL_ENV.AI_MODEL;
  if (ORIGINAL_ENV.AI_BASE_URL === undefined) delete process.env.AI_BASE_URL;
  else process.env.AI_BASE_URL = ORIGINAL_ENV.AI_BASE_URL;
  jest.resetModules();
});

describe('createChatCompletion configuration guard', () => {
  it('throws not_configured without calling fetch when AI is unconfigured', async () => {
    const provider = await loadProvider({ apiKey: '', model: '' });

    await expect(
      provider.createChatCompletion({ messages: [{ role: 'user', content: 'hello' }] })
    ).rejects.toMatchObject({ name: 'AiServiceError', code: 'not_configured' });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createChatCompletion request building', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '{"intent":"general"}' } }] }),
    } satisfies FetchResponseStub);
  });

  it('POSTs to ${base}/chat/completions with Bearer auth and JSON-mode body', async () => {
    const provider = await loadProvider({
      apiKey: 'sk-test-secret',
      model: 'gpt-test',
      baseUrl: 'https://api.example.test/v1/',
    });

    const content = await provider.createChatCompletion({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
      ],
      jsonMode: true,
    });

    expect(content).toBe('{"intent":"general"}');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = lastFetchCall();
    // Trailing slash on AI_BASE_URL is normalised.
    expect(url).toBe('https://api.example.test/v1/chat/completions');
    expect(init?.method).toBe('POST');

    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test-secret');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.model).toBe('gpt-test');
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('uses the default OpenAI base URL and omits response_format when jsonMode is false', async () => {
    const provider = await loadProvider({ apiKey: 'sk-test', model: 'gpt-test', baseUrl: '' });

    await provider.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] });

    const [url, init] = lastFetchCall();
    expect(url).toBe('https://api.openai.com/v1/chat/completions');

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('response_format');
    expect(body.temperature).toBe(0);
  });
});

describe('createChatCompletion error mapping', () => {
  it('maps a non-OK HTTP response to provider_error without leaking the key', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'sk-test-secret quota exceeded' } }),
    } satisfies FetchResponseStub);

    const provider = await loadProvider({ apiKey: 'sk-test-secret', model: 'gpt-test' });
    const error = await captureError(
      provider.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })
    );

    expect(error).toMatchObject({ name: 'AiServiceError', code: 'provider_error' });
    expect(error.message).not.toContain('sk-test-secret');
  });

  it('maps a network failure to network_error without surfacing the cause', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED sk-test-secret'));

    const provider = await loadProvider({ apiKey: 'sk-test-secret', model: 'gpt-test' });
    const error = await captureError(
      provider.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })
    );

    expect(error).toMatchObject({ name: 'AiServiceError', code: 'network_error' });
    expect(error.message).not.toMatch(/ECONNREFUSED|sk-test-secret/);
  });

  it('maps an unreadable JSON payload to provider_error', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('invalid json');
      },
    } satisfies FetchResponseStub);

    const provider = await loadProvider({ apiKey: 'sk-test-secret', model: 'gpt-test' });

    await expect(
      provider.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ name: 'AiServiceError', code: 'provider_error' });
  });

  it('maps an empty completion payload to provider_error', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
    } satisfies FetchResponseStub);

    const provider = await loadProvider({ apiKey: 'sk-test-secret', model: 'gpt-test' });

    await expect(
      provider.createChatCompletion({ messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toMatchObject({ name: 'AiServiceError', code: 'provider_error' });
  });
});
