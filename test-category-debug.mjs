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
  console.log('=== RAW RESPONSE ===');
  console.log(data.toString());
  console.log('=== END RAW ===');
});

setTimeout(() => {
  console.log('Sending request...');
  server.stdin.write(JSON.stringify(testRequest) + '\n');
}, 500);

setTimeout(() => {
  console.log('Timeout - closing');
  server.kill();
}, 8000);
