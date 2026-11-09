const express = require('express');

const { badRequest } = require('../mobile/v1/common');
const { currentResponse, submitProof } = require('../chipmunk/entitlement');

// /api/mobile/v1/entitlement, mounted by mobile-v1.js with its shared helpers.
// Any valid device token may call it (read scope is enough: it proves a
// purchase, it changes no budget data). POST counts against the write rate
// limit. A proof or signature is never echoed, logged or stored.
//
// A proof is up to 16384 characters (a Play purchase JSON is escaped inside
// the body, so allow generous room for that); the router-wide 2kb parser is
// too small for it.
const parseProofJson = express.json({ limit: '64kb' });

const MAX_PROOF = 16384;
const MAX_SIGNATURE = 2048;
const isText = (v, max) => typeof v === 'string' && v.length >= 1 && v.length <= max;

// Exactly entitlementRequest: apple {platform, proof} or google {platform, proof, signature}.
function parseRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest();
  const keys = Object.keys(body).sort().join(',');
  if (body.platform === 'apple' && keys === 'platform,proof' && isText(body.proof, MAX_PROOF)) {
    return { platform: 'apple', proof: body.proof };
  }
  if (body.platform === 'google' && keys === 'platform,proof,signature' && isText(body.proof, MAX_PROOF) && isText(body.signature, MAX_SIGNATURE)) {
    return { platform: 'google', proof: body.proof, signature: body.signature };
  }
  throw badRequest();
}

module.exports = function mountEntitlement(router, { readLimit, writeLimit, fail, touchToken }) {
  router.get('/entitlement', readLimit, async (req, res) => {
    try {
      if (Object.keys(req.query).length) throw badRequest();
      res.status(200).json(await currentResponse());
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/entitlement', writeLimit, parseProofJson, async (req, res) => {
    try {
      const request = parseRequest(req.body);
      const response = await submitProof(request);
      touchToken(req.deviceToken.id).catch(() => {});
      res.status(200).json(response);
    } catch (err) {
      fail(res, err);
    }
  });
};
