const rateLimit = require('express-rate-limit');
const { limiterCache } = require('@librechat/api');
const { ViolationTypes } = require('librechat-data-provider');
const { removePorts } = require('~/server/utils');
const { logViolation } = require('~/cache');

const { LOGIN_WINDOW = 5, LOGIN_MAX = 1000, LOGIN_VIOLATION_SCORE: score } = process.env;
const windowMs = LOGIN_WINDOW * 60 * 1000;
const max = LOGIN_MAX;
const windowInMinutes = windowMs / 60000;
const message = `Too many login attempts, please try again after ${windowInMinutes} minutes.`;

const handler = async (req, res) => {
  const type = ViolationTypes.LOGINS;
  const errorMessage = {
    type,
    max,
    windowInMinutes,
  };

  await logViolation(req, res, type, errorMessage, score);
  return res.status(429).json({ message });
};

/**
 * Use email as the rate-limit key when available (local login: per-user, not per-IP).
 * OAuth callbacks have no email in the body at limiter time, so fall back to IP.
 */
const keyGenerator = (req) => req.body?.email ?? removePorts(req);

const limiterOptions = {
  windowMs,
  max,
  handler,
  keyGenerator,
  store: limiterCache('login_limiter'),
};

const loginLimiter = rateLimit(limiterOptions);

module.exports = loginLimiter;
