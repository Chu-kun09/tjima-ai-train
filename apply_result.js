// 学習結果(AI_Tjima_result.json)を tjima_cpu.html の CPU_W に反映する
const fs = require('fs');
const result = JSON.parse(fs.readFileSync('AI_Tjima_result.json', 'utf8')).best;
let html = fs.readFileSync('tjima_cpu.html', 'utf8');
const newBlock = 'const CPU_W = ' + JSON.stringify(result, null, 2) + ';';
const replaced = html.replace(/const\s+CPU_W\s*=\s*\{[\s\S]*?\};/, newBlock);
if (replaced === html) { console.error('CPU_W が見つかりません'); process.exit(1); }
fs.writeFileSync('tjima_cpu.html', replaced);
console.log('tjima_cpu.html を更新しました');