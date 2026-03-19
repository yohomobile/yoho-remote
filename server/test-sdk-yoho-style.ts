import { query } from '@anthropic-ai/claude-agent-sdk';

const litellmEnv = {
  ANTHROPIC_AUTH_TOKEN: 'sk-litellm-41e2a2d4d101255ea6e76fd59f96548a',
  ANTHROPIC_BASE_URL: 'http://localhost:4000',
  API_TIMEOUT_MS: '300000',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
};

async function test() {
  console.log('=== SDK 测试 ===\n');
  console.log('ENV:', JSON.stringify(litellmEnv));

  const q = query({
    prompt: '回复 OK 即可',
    options: {
      cwd: '/tmp',
      model: 'claude-sonnet-4-5-20250929',
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      env: {
        ...process.env,
        ...litellmEnv,
      },
    },
  });

  const timeout = setTimeout(() => {
    console.error('TIMEOUT after 15s');
    process.exit(1);
  }, 15000);

  for await (const message of q) {
    console.log('[MSG]', message.type);
    if (message.type === 'assistant') {
      const msg = message as any;
      const content = msg.message?.content?.find((c: any) => c.type === 'text')?.text;
      if (content) {
        console.log('[内容]', content);
        clearTimeout(timeout);
        process.exit(0);
      }
    }
    if (message.type === 'result') {
      const result = message as any;
      console.log('[结果]', result.subtype);
      clearTimeout(timeout);
      process.exit(result.subtype === 'success' ? 0 : 1);
    }
  }
}

test();
