import { spawn } from 'child_process';

const server = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit']
});

// カテゴリ提案テスト
const testRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "ebay_suggest_category",
    arguments: {
      query: "Nambu Ironware Trivet Cast Iron Japanese"
    }
  }
};

server.stdout.on('data', (data) => {
  const lines = data.toString().split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const response = JSON.parse(line);
      if (response.result) {
        console.log('=== カテゴリ提案結果 ===');
        const content = JSON.parse(response.result.content[0].text);
        console.log(JSON.stringify(content, null, 2));
        server.kill();
      }
    } catch {}
  }
});

setTimeout(() => {
  server.stdin.write(JSON.stringify(testRequest) + '\n');
}, 500);

setTimeout(() => server.kill(), 5000);
