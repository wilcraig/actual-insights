#!/usr/bin/env node
// Mints a DEV-ONLY Apple-style proof for Chipmunk's subscription check and can
// POST it to an Insights server. It is not signed by Apple: only a server
// started with CHIPMUNK_ENTITLEMENT_MODE=dev accepts it (a strict server
// answers reason 'unverified'). See docs/chipmunk-mode.md.
//
//   node api/tools/mint-dev-proof.js [--product monthly|yearly] [--days 30]
//        [--txn ID] [--post http://127.0.0.1:5181] [--token TOKEN]
//
// The device token (Insights > Mobile app) is read from --token or, better,
// the CHIPMUNK_DEVICE_TOKEN environment variable. It is never printed.
const BUNDLE_ID = 'app.chipmunkbudget.chipmunk';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (!['product', 'days', 'txn', 'post', 'token', 'help'].includes(key)) throw new Error(`unknown option ${a}`);
    if (key === 'help') { out.help = true; continue; }
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    out[key] = argv[++i];
  }
  return out;
}

const b64url = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');

function mint({ product = 'monthly', days = 30, txn, now = Date.now() } = {}) {
  const productId = product.startsWith('chipmunk.') ? product : `chipmunk.${product}`;
  if (!['chipmunk.monthly', 'chipmunk.yearly'].includes(productId)) throw new Error('product must be monthly or yearly');
  const n = Number(days);
  if (!Number.isFinite(n)) throw new Error('days must be a number');
  const payload = {
    transactionId: `dev-${now}`,
    originalTransactionId: txn || 'dev-original-1',
    bundleId: BUNDLE_ID,
    productId,
    purchaseDate: now,
    expiresDate: now + Math.round(n * 24 * 3600 * 1000),
    signedDate: now,
    environment: 'Sandbox',
    type: 'Auto-Renewable Subscription',
  };
  return `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url(payload)}.${Buffer.from('dev-unsigned').toString('base64url')}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: mint-dev-proof.js [--product monthly|yearly] [--days N] [--txn ID] [--post BASE_URL] [--token TOKEN]\n(token: CHIPMUNK_DEVICE_TOKEN env preferred)');
    return;
  }
  const proof = mint({ product: args.product, days: args.days, txn: args.txn });
  if (!args.post) {
    console.log(proof);
    return;
  }
  const token = args.token || process.env.CHIPMUNK_DEVICE_TOKEN;
  if (!token) throw new Error('no device token: set CHIPMUNK_DEVICE_TOKEN (or pass --token)');
  const res = await fetch(`${args.post.replace(/\/+$/, '')}/api/mobile/v1/entitlement`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'apple', proof }),
  });
  console.log(`HTTP ${res.status}`);
  console.log(await res.text());
  if (!res.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`mint-dev-proof: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { mint };
