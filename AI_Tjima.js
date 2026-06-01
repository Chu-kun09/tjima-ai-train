#!/usr/bin/env node
/* ============================================================================
 *  AI_Tjima.js  —  Tジマ CPU パラメータ自動学習シミュレータ
 * ----------------------------------------------------------------------------
 *  目的:
 *    画面を描画せず（DOM/FX/setTimeout を全てスタブ化）、CPU同士を高速対戦させ、
 *    勝率の高いスコア設定（CPU_W パラメータ＝「遺伝子」）を自動で割り出す。
 *
 *  仕組み:
 *    既存ゲーム本体 tjima_cpu.html のゲームロジック（ターン進行・召喚・攻撃・
 *    防御・7連鎖・エクTジア判定など）をそのまま読み込んで流用する。二重メンテを
 *    避けるため、AIの思考ロジック(cpuScoreCard 等)も本体のものを共用する。
 *    プレイヤー1/2 がそれぞれ別パラメータで思考できるよう、本体の CPU_W を
 *    「現在の手番プレイヤーのパラメータを返す」動的オブジェクトに差し替える。
 *
 *  使い方:
 *    node AI_Tjima.js                  … デフォルト動作（学習を1回実行）
 *    node AI_Tjima.js match            … 既定パラメータ同士を500回対戦
 *    node AI_Tjima.js evolve [世代数] [対戦数]  … 世代交代で自動学習
 *    node AI_Tjima.js --html path.html … 読み込む本体HTMLを指定
 *
 *  出力:
 *    学習結果（最良パラメータ）を ./AI_Tjima_result.json に保存する。
 *    このJSONをゲーム本体の CPU_W 初期値に貼れば、学習結果を反映できる。
 * ==========================================================================*/

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ════════════════════════════════════════════════════════════════════════
 *  0. 設定
 * ══════════════════════════════════════════════════════════════════════ */
const args = process.argv.slice(2);
const htmlArgIdx = args.indexOf('--html');
// 読み込む本体HTML。--html で明示指定がなければ、同ディレクトリの候補を順に探す。
function findDefaultHtml() {
  const candidates = ['tjima_cpu0601.html', 'tjima_cpu.html', 'tjima_cpu_merged.html'];
  for (const name of candidates) {
    const full = path.join(__dirname, name);
    if (fs.existsSync(full)) return full;
  }
  // 見つからなければ最初の候補名（エラーメッセージ用）
  return path.join(__dirname, candidates[0]);
}
const HTML_PATH = htmlArgIdx >= 0 ? args[htmlArgIdx + 1] : findDefaultHtml();
const RESULT_PATH = path.join(__dirname, 'AI_Tjima_result.json');
const MAX_TURNS = 200; // 1ゲームの安全上限（無限ループ防止）

/* ════════════════════════════════════════════════════════════════════════
 *  1. AIパラメータ（遺伝子）の構造定義
 * ----------------------------------------------------------------------------
 *  これは本体の CPU_W と同じキー空間。学習ではこの数値を変異させて最適化する。
 *  下記は「状況に応じたボーナス倍率（重み）」の意味づけ:
 * ══════════════════════════════════════════════════════════════════════ */
const DEFAULT_PARAMS = {
  // ── 基礎評価 ──
  body:        0.6,   // 場に残る戦闘力1あたりの価値
  breaker:     3.0,   // シールドを1枚多く割れる価値
  aggro:       4.0,   // 相手シールドが薄いほど攻撃を後押し
  removal:     1.4,   // 相手1体除去あたりの価値係数
  blocker:     2.5,   // ブロッカー1体の防御価値
  defenseNeed: 3.0,   // 自分シールドが薄いほど防御を重視
  link:        4.0,   // リンク成立ボーナス
  costEff:     0.25,  // コスト効率（高コストを微減点）
  freeBonus:   3.0,   // コスト0(おTーじ様)で出せる価値
  extjia:      6.0,   // 0で4色を揃えエクTジアに近づく価値
  manaHit:     0.5,   // 相手マナ破壊の価値（場の半分）
  sevenChain:  5.0,   // 7連鎖1枚あたりの追加価値
  mana4:       1.5,   // 4をチャージする価値（破壊→マナ送り）
  atkShield:   4.0,   // シールド攻撃の基礎価値
  atkAggro:    5.0,   // 相手シールドが薄いほどシールド攻撃を後押し
  stRisk:      0.6,   // ST被弾リスクの軽い減点
  defShield:   3.0,   // 守備側：シールドを守れる価値
  bigNum:      0.4,   // 大きい数字（強カード）の召喚優先
  // ── 追加調整パラメータ（本体 CPU_W と同期。シミュレータで学習する）──
  exTjiaDeny:  3.0,   // 2のヒラボンで相手0を割るときのエクTジア妨害価値（1枚/1色あたり）
  zeroStackRisk: 13,  // 0を場に並べたとき2で一掃されるリスク減点の係数
  takeSingle:  1.0,   // シングルブレイカー攻撃を「受け得」と見て消極ブロックする度合い（0で常時ブロック）
  tripleBlock: 0.7,   // 0(トリプル)攻撃を受けると1枚墓地送りになる損失のブロック加点係数
};

/* ════════════════════════════════════════════════════════════════════════
 *  2. ヘッドレス実行環境（DOM/FX/setTimeout をスタブ化して本体を読み込む）
 * ══════════════════════════════════════════════════════════════════════ */
function buildSandbox() {
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  const blocks = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[2]);
  // blocks[0] = Firebase module(import含む・不要) / blocks[1] = 本体 / blocks[2] = CPUモジュール
  const mainCode = blocks[1];
  let   cpuCode  = blocks[2];
  if (!mainCode || !cpuCode) throw new Error('HTMLからゲームスクリプトを抽出できませんでした');

  // 本体CPUモジュールの `const CPU_W = { ... };` を、プレイヤー別パラメータを返す
  // 動的オブジェクト宣言に置き換える（const→可変getterオブジェクト）。
  // これにより cpuScoreCard 等の CPU_W.x 参照(34箇所)が手番プレイヤーの遺伝子を見る。
  const dParams = JSON.stringify(DEFAULT_PARAMS);
  const cpuwReplacement =
    `const CPU_W = (function(){` +
    `var __def=${dParams};` +
    `var keys=Object.keys(__def);` +
    `var o={};` +
    `keys.forEach(function(k){Object.defineProperty(o,k,{enumerable:true,get:function(){` +
    `var pp=(globalThis.__SIMP&&globalThis.__SIMP[globalThis.__SIMA])||null;` +
    `return (pp&&pp[k]!==undefined)?pp[k]:__def[k];}});});` +
    `return o;})();`;
  // 元の `const CPU_W = { ... };`（複数行）を一括置換
  cpuCode = cpuCode.replace(/const\s+CPU_W\s*=\s*\{[\s\S]*?\};/, cpuwReplacement);

  const noop = () => {};
  // FX・描画・モーダル・音などビジュアル系を全てnoop化（ロジックのみ実行）
  const visualStubs = [
    'adjustLayout','setBar','toast','clearFx','closeModal','showSimpleModal',
    'showCustomModal','showCardPicker','fxParticles','fxWord','fxFlash','fxRing',
    'fxCharge','fxSummon','fxDraw','fxSpell','fxAttack','fxBlock','fxShieldBreak',
    'fxDirectAttack','fxHirabon','fxExTjia','fxEffect','updateStats',
    'updateBarForOnline','playExTBGM','startBGM','updateBGM','showWinScreen',
    'applyModalDir','renderAll','renderHand','renderField','renderMana',
    'renderShields','renderDeckGrave','cardHTML','showManaSelectModal'
  ].map(n => `try{${n}=function(){};}catch(e){}`).join('\n');

  // setTimeout を同期キューに（タイマー遅延を排除して即時実行）
  const bridge = `
;(function(){
  var Q=[];
  setTimeout=function(fn){ if(typeof fn==='function')Q.push(fn); return 0; };
  clearTimeout=function(){};
  requestAnimationFrame=function(fn){ if(typeof fn==='function')Q.push(fn); return 0; };
  ${visualStubs}

  // プレイヤー別パラメータ: __SIMP[player] が遺伝子, __SIMA が現在の手番。
  // CPU_W の getter（上で置換済み）がこれらを参照する。
  globalThis.__SIMP = { 1:null, 2:null };
  globalThis.__SIMA = 1;

  globalThis.__sim = {
    drain:function(max){ var s=0; while(Q.length&&s<(max||100000)){ var fn=Q.shift(); s++; try{fn();}catch(e){ if(globalThis.__sim._debug)console.error('queue err',e&&e.message); } } return s; },
    qlen:function(){ return Q.length; },
    clearQueue:function(){ Q.length=0; },
    setParams:function(p1,p2){ globalThis.__SIMP[1]=p1; globalThis.__SIMP[2]=p2; },
    setActive:function(p){ globalThis.__SIMA=p; },
    getActive:function(){ return globalThis.__SIMA; },
    G:function(){ return G; },
    CPU:function(){ return CPU; },
    ONLINE:function(){ return ONLINE; },
    initGame:function(){ initGame(); },
    chooseBestPlay:function(p){ globalThis.__SIMA=p; return cpuChooseBestPlay(p); },
    chooseManaCharge:function(p){ globalThis.__SIMA=p; return cpuChooseManaCharge(p); },
    chooseAttack:function(p){ globalThis.__SIMA=p; return cpuChooseAttack(p); },
    evalBoard:function(p){ globalThis.__SIMA=p; return cpuEvalBoard(p); },
    hasLethal:function(p){ globalThis.__SIMA=p; return cpuHasLethal(p,cpuEvalBoard(p)); },
    _debug:false
  };
})();
`;

  // window/document/Audio など最低限のグローバル
  const fakeEl = {
    style:{}, classList:{ add:noop, remove:noop, toggle:noop, contains:()=>false },
    appendChild:noop, removeChild:noop, addEventListener:noop, removeEventListener:noop,
    setAttribute:noop, dataset:{}, innerHTML:'', textContent:'', value:'',
    children:{length:0}, onclick:null, focus:noop, remove:noop
  };
  const sandbox = {
    console: {
      log:()=>{}, error:()=>{}, warn:()=>{}, info:()=>{}  // 本体のconsole出力は抑制
    },
    Math, Date, JSON, Array, Object, Number, String, Boolean, Set, Map, WeakSet, RegExp,
    parseInt, parseFloat, isNaN, Promise,
    setTimeout: (fn)=>{ if(typeof fn==='function') sandbox.__queue.push(fn); return 0; },
    clearTimeout: noop, requestAnimationFrame: noop,
    document: {
      getElementById: () => fakeEl, createElement: () => Object.assign({}, fakeEl),
      body: fakeEl, addEventListener: noop, querySelector: () => fakeEl, querySelectorAll: () => []
    },
    window: { addEventListener: noop, innerWidth:400, innerHeight:800,
              location:{reload:noop}, _fbReady:Promise.resolve({}), _fbResolve:noop },
    navigator: {},
    Audio: function(){ return { play:()=>Promise.resolve(), pause:noop, currentTime:0, cloneNode(){return this;} }; },
    __queue: []
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(mainCode + '\n' + cpuCode + '\n' + bridge, sandbox, { filename: 'tjima_combined.js' });
  return sandbox;
}

/* ════════════════════════════════════════════════════════════════════════
 *  3. ① 画面非表示の高速対戦  simulateOneGame(paramA, paramB)
 * ----------------------------------------------------------------------------
 *  プレイヤー1 = paramA、プレイヤー2 = paramB で対戦し、勝者(1 or 2)を返す。
 *  本体のターン進行(phaseUntap→Draw→Charge→Summon→Attack→endTurn)をCPU化して回す。
 *  盤面評価ロジック（相手の0/7/リンク検知, ピンチ判定）は本体 cpuScoreCard /
 *  cpuEvalBoard の dangerLevel・enemyHasKeyCard 加点をそのまま使用する。
 * ══════════════════════════════════════════════════════════════════════ */
function simulateOneGame(sim, paramA, paramB) {
  const api = sim;            // sim は __sim のメソッド＋本体関数を持つ bundle
  const G  = () => api.G();
  const CPU = api.CPU();
  const ONLINE = api.ONLINE();

  // 両者CPU化（CPUモジュールはplayer==CPU.playerのみ自動化するので、
  // ここでは両プレイヤーを手動で回すためCPU.enabledはfalseのまま、思考関数を直接呼ぶ）
  CPU.enabled = false;
  ONLINE.enabled = false;
  api.setParams(paramA, paramB);

  api.initGame();
  let g = G();
  g.phase = 'untap';
  let turnCount = 0;

  // 1プレイヤーの1ターンを完全実行する（charge → summon(複数) → attack(複数) → end）
  function runTurn(p) {
    g = G();
    if (g.gameOver) return;
    // --- アンタップ ---
    const pl = g.players[p];
    pl.field.forEach(c => { c.tapped = false; c.summonedThisTurn = false; });
    pl.mana.forEach(c => c.tapped = false);
    // --- ドロー（先手1ターン目はスキップ） ---
    if (!(g.isFirstTurn && p === 1)) {
      if (pl.deck.length === 0) { // 山札切れ＝デッキアウト負け
        g.gameOver = true; g._winner = (p === 1 ? 2 : 1); return;
      }
      pl.hand.push(pl.deck.pop());
    }
    g.isFirstTurn = false;
    g.turn = p;
    g.phase = 'charge';

    // --- チャージ ---
    api.setActive(p);
    const charge = api.chooseManaCharge(p);
    if (charge) {
      const card = charge.card;
      pl.hand = pl.hand.filter(c => c.id !== card.id);
      card.tapped = false;
      pl.mana.push(card);
    }
    if (g.gameOver) return;

    // --- 召喚（出せるだけ出す。リンク自動成立含む） ---
    g.phase = 'summon';
    runSummonPhase(p);
    if (g.gameOver) return;

    // --- 攻撃（攻撃できるだけ行う） ---
    g.phase = 'attack';
    runAttackPhase(p);
  }

  // 召喚フェーズ：エクTジア宣言 → リンク → ベスト召喚 を繰り返す
  function runSummonPhase(p) {
    let guard = 0;
    while (guard++ < 30) {
      g = G();
      if (g.gameOver) return;
      // エクTジア(0の4色)成立で即勝利
      if (sim.hasExTjia && sim.hasExTjia(p)) { g.gameOver = true; g._winner = p; return; }
      // リンク自動成立
      if (tryLink(p)) continue;
      api.setActive(p);
      const pick = api.chooseBestPlay(p);
      if (!pick) break;
      execSummon(p, pick);
    }
  }

  // リンク可能なペアがあれば1組リンクする
  function tryLink(p) {
    const f = g.players[p].field.filter(c => !c.linkedWith);
    for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) {
      if (sim.validLink && sim.validLink(f[i], f[j])) {
        sim.doLink(f[i], f[j], p);
        return true;
      }
    }
    return false;
  }

  // 召喚の実行（マナ消費 → completeSummon。7/2/6等の召喚時効果も本体ロジックで解決）
  function execSummon(p, pick) {
    const card = pick.card, plan = pick.plan || {};
    const cost = getSummonCost(p, card);
    payMana(p, cost);
    // 召喚時効果用の plan を CPU 状態にセット（本体のモーダル自動化が参照）
    CPU.enabled = true; CPU.player = p;  // モーダル自動化を一時的に有効化
    CPU._plan = plan;
    if (card.num === 7) CPU._7plan = {
      chain: [...(plan.chain7Ids || [])],
      final: (plan.finalMoveTargetId != null) ? plan.finalMoveTargetId : null
    };
    sim.completeSummon(p, card);
    api.drain();            // 召喚時効果(7連鎖/2破壊/6バウンス/5回収等)の非同期処理を消化
    CPU.enabled = false;    // 自動モーダルを無効化に戻す
    api.setActive(p);
  }

  // マナ支払い（軽い順にタップ。9は2扱い）
  function payMana(p, cost) {
    if (cost <= 0) return;
    const un = g.players[p].mana.filter(c => !c.tapped)
      .sort((a, b) => (a.num === 9 ? 2 : 1) - (b.num === 9 ? 2 : 1));
    let paid = 0;
    for (const m of un) { if (paid >= cost) break; m.tapped = true; paid += (m.num === 9 ? 2 : 1); }
  }

  // 攻撃フェーズ：最善の攻撃を null になるまで実行
  function runAttackPhase(p) {
    let guard = 0;
    while (guard++ < 30) {
      g = G();
      if (g.gameOver) return;
      api.setActive(p);
      const a = api.chooseAttack(p);
      if (!a) return;
      execAttack(p, a);
      api.drain();
      if (g.gameOver) return;
    }
  }

  // 攻撃の実行（シールド/ダイレクト/クリーチャー）。防御側もCPUとして自動処理。
  function execAttack(p, a) {
    const atk = a.attacker, opp = p === 1 ? 2 : 1;
    // 防御側を一時的にCPU化（ブロック/ST自動判断のため）
    CPU.enabled = true; CPU.player = opp;
    if (a.target.type === 'shield') {
      sim.execShieldAttack(atk, p);
    } else if (a.target.type === 'direct') {
      const bl = g.players[opp].field.filter(c => (c.num === 1 || c.num === 3) && !c.tapped && (!c.linkedWith || c.linkRoot));
      sim.execDirectWithBlock(atk, p, bl);
    } else {
      const t = g.players[opp].field.find(c => c.id === a.target.card.id);
      if (t) sim.execCreatureAttack(atk, t, p);
    }
    api.drain();
    CPU.enabled = false;
    api.setActive(p);
  }

  // 本体関数への参照を取得（sandbox上のグローバル）
  const getSummonCost = sim.getSummonCost;

  // ── メインループ：先手1 → 後手2 → ... ──
  let current = 1;
  while (!G().gameOver && turnCount < MAX_TURNS) {
    runTurn(current);
    api.drain();
    turnCount++;
    current = (current === 1) ? 2 : 1;
  }

  g = G();
  if (g.gameOver && g._winner) return g._winner;
  // 時間切れ：シールドが多い方を勝ちとする（引き分け回避）
  const s1 = g.players[1].shields.filter(Boolean).length;
  const s2 = g.players[2].shields.filter(Boolean).length;
  if (s1 !== s2) return s1 > s2 ? 1 : 2;
  return Math.random() < 0.5 ? 1 : 2; // 完全同値はランダム
}

/* ════════════════════════════════════════════════════════════════════════
 *  4. ② 統計的勝率検証  runMatchSession(paramA, paramB, count)
 * ----------------------------------------------------------------------------
 *  simulateOneGame を count 回繰り返し、A/Bの勝率を返す。
 *  100回ごとに await で処理を逃がし、進捗をconsoleに出力（ブラウザフリーズ防止）。
 *  先手有利を打ち消すため、半分は手番を入れ替えて対戦する。
 * ══════════════════════════════════════════════════════════════════════ */
async function runMatchSession(sim, paramA, paramB, count = 500, opts = {}) {
  const verbose = opts.verbose !== false;
  let winA = 0, winB = 0;
  for (let i = 0; i < count; i++) {
    // 偶数回はA=先手, 奇数回はB=先手（先手有利の補正）
    let winner;
    if (i % 2 === 0) {
      winner = simulateOneGame(sim, paramA, paramB); // P1=A, P2=B
      if (winner === 1) winA++; else winB++;
    } else {
      winner = simulateOneGame(sim, paramB, paramA); // P1=B, P2=A
      if (winner === 1) winB++; else winA++;
    }
    if (verbose && (i + 1) % 100 === 0) {
      console.log(`  ${count}回中 ${i + 1}回完了... (A: ${winA}勝 / B: ${winB}勝)`);
      await new Promise(r => setTimeout(r, 0)); // イベントループに処理を逃がす
    }
  }
  const rateA = winA / count, rateB = winB / count;
  return { winA, winB, rateA, rateB, count };
}

/* ════════════════════════════════════════════════════════════════════════
 *  5. ③ パラメータ自動調整（世代交代）
 * ----------------------------------------------------------------------------
 *  親パラメータから数値をランダムに少し変異させた子を作り、親子で対戦。
 *  勝率の高い方を次世代の親とする。これを generations 世代繰り返す。
 * ══════════════════════════════════════════════════════════════════════ */
// 親を変異させて子を作る（各キーを ±mutationRate の範囲でランダムに揺らす）
function mutate(parent, mutationRate = 0.25, mutateProb = 0.5) {
  const child = {};
  for (const k of Object.keys(parent)) {
    if (Math.random() < mutateProb) {
      const factor = 1 + (Math.random() * 2 - 1) * mutationRate; // 0.75〜1.25
      let v = parent[k] * factor;
      v = Math.max(0, Math.round(v * 100) / 100); // 負値禁止・小数2桁
      child[k] = v;
    } else {
      child[k] = parent[k];
    }
  }
  return child;
}

async function evolve(sim, generations = 10, matchCount = 500, opts = {}) {
  let parent = Object.assign({}, opts.seed || DEFAULT_PARAMS);
  let history = [];
  console.log(`\n=== 世代交代スタート（${generations}世代 × ${matchCount}対戦）===\n`);

  for (let gen = 1; gen <= generations; gen++) {
    const child = mutate(parent, opts.mutationRate || 0.25, opts.mutateProb || 0.5);
    console.log(`【第${gen}世代】親 vs 子（変異体）を ${matchCount}回対戦...`);
    const res = await runMatchSession(sim, parent, child, matchCount, { verbose: true });

    // 子の勝率が親を上回れば交代（A=parent, B=child）
    const childWon = res.rateB > res.rateA;
    const winnerRate = childWon ? res.rateB : res.rateA;
    console.log(`  → 親勝率 ${(res.rateA * 100).toFixed(1)}% / 子勝率 ${(res.rateB * 100).toFixed(1)}%  ⇒ ${childWon ? '★子が勝利！世代交代' : '親が防衛'}\n`);

    if (childWon) parent = child;
    history.push({ gen, parentRate: res.rateA, childRate: res.rateB, adopted: childWon });
  }

  return { best: parent, history };
}

/* ════════════════════════════════════════════════════════════════════════
 *  6. エントリポイント
 * ══════════════════════════════════════════════════════════════════════ */
async function main() {
  console.log('AI_Tjima シミュレータ起動');
  console.log('本体HTML:', HTML_PATH);
  const sim = buildSandbox();

  // simulateOneGame に渡す bundle = __sim のメソッド + 本体グローバル関数
  const bundle = Object.assign({}, sim.__sim);
  ['getSummonCost','completeSummon','execShieldAttack','execDirectWithBlock',
   'execCreatureAttack','validLink','doLink','hasExTjia'].forEach(n => { bundle[n] = sim[n]; });

  const mode = args.find(a => !a.startsWith('--') && a !== HTML_PATH && !/^\d+$/.test(a)) || 'evolve';

  if (mode === 'match') {
    console.log('\n=== 既定パラメータ同士の対戦（500回）===');
    const res = await runMatchSession(bundle, DEFAULT_PARAMS, DEFAULT_PARAMS, 500);
    console.log(`\n結果: A ${(res.rateA*100).toFixed(1)}% / B ${(res.rateB*100).toFixed(1)}%`);
  } else { // evolve
    const nums = args.filter(a => /^\d+$/.test(a)).map(Number);
    const gens = nums[0] || 10;
    const cnt  = nums[1] || 500;
    const { best, history } = await evolve(bundle, gens, cnt);
    console.log('\n════════ 学習完了 ════════');
    console.log('最良パラメータ:');
    console.log(JSON.stringify(best, null, 2));
    fs.writeFileSync(RESULT_PATH, JSON.stringify({ best, history, generatedAt: new Date().toISOString() }, null, 2));
    console.log(`\n結果を保存: ${RESULT_PATH}`);
    console.log('このbestの値を tjima_cpu.html の CPU_W に反映すると学習結果が使えます。');
  }
}

if (require.main === module) {
  main().catch(e => { console.error('エラー:', e); process.exit(1); });
}

module.exports = { buildSandbox, simulateOneGame, runMatchSession, evolve, mutate, DEFAULT_PARAMS };
