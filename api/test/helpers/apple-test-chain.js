const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// A throwaway Apple-shaped certificate chain (root -> intermediate -> leaf,
// with the two Apple marker extensions the verifier requires) made with the
// openssl CLI, plus a StoreKit-2-style ES256 JWS signer. No network, nothing
// of Apple's.
const APPLE_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';
const APPLE_LEAF_OID = '1.2.840.113635.100.6.11.1';

function openssl(cwd, ...args) {
  execFileSync('openssl', args, { cwd, stdio: 'pipe' });
}

function makeChain(name = 'test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `apple-chain-${name}-`));
  const w = (file, text) => fs.writeFileSync(path.join(dir, file), text);
  w('ca.cnf', 'basicConstraints=critical,CA:TRUE\n');
  w('mid.cnf', `basicConstraints=critical,CA:TRUE\n${APPLE_INTERMEDIATE_OID}=ASN1:NULL\n`);
  w('leaf.cnf', `basicConstraints=CA:FALSE\n${APPLE_LEAF_OID}=ASN1:NULL\n`);
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  openssl(dir, 'req', '-x509', ...ec, '-keyout', 'root.key', '-out', 'root.pem', '-subj', `/CN=Test Root ${name}`, '-days', '3000', '-addext', 'basicConstraints=critical,CA:TRUE');
  for (const [file, cnf, serial] of [['mid', 'mid.cnf', '11'], ['leaf', 'leaf.cnf', '12']]) {
    const issuer = file === 'mid' ? 'root' : 'mid';
    openssl(dir, 'req', '-new', ...ec, '-keyout', `${file}.key`, '-out', `${file}.csr`, '-subj', `/CN=Test ${file} ${name}`);
    openssl(dir, 'x509', '-req', '-in', `${file}.csr`, '-CA', `${issuer}.pem`, '-CAkey', `${issuer}.key`, '-set_serial', serial, '-days', '2000', '-extfile', cnf, '-out', `${file}.pem`);
  }
  const der = (file) => new crypto.X509Certificate(fs.readFileSync(path.join(dir, `${file}.pem`))).raw;
  const key = crypto.createPrivateKey(fs.readFileSync(path.join(dir, 'leaf.key')));
  const b64 = (buf) => Buffer.from(buf).toString('base64');
  return { rootDer: der('root'), x5c: [b64(der('leaf')), b64(der('mid')), b64(der('root'))], key };
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

// A signed transaction. `payload` overrides the defaults.
function signTransaction(chain, payload = {}, { alg = 'ES256' } = {}) {
  const signedDate = Date.now();
  const body = {
    transactionId: '2000000000000001',
    originalTransactionId: '2000000000000000',
    bundleId: 'app.chipmunkbudget.chipmunk',
    productId: 'chipmunk.monthly',
    purchaseDate: signedDate - 1000,
    originalPurchaseDate: signedDate - 1000,
    expiresDate: signedDate + 30 * 24 * 3600 * 1000,
    quantity: 1,
    type: 'Auto-Renewable Subscription',
    inAppOwnershipType: 'PURCHASED',
    signedDate,
    environment: 'Production',
    ...payload,
  };
  const signingInput = `${b64url({ alg, x5c: chain.x5c })}.${b64url(body)}`;
  const sig = crypto.sign('sha256', Buffer.from(signingInput), { key: chain.key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${sig.toString('base64url')}`;
}

module.exports = { makeChain, signTransaction, b64url };
