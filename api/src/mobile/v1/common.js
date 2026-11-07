// Small helpers shared by the v1 read and write code.

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MONTH_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

const MAX_MONEY = 10000000000000;
// A budgeted amount (a write's input or result) stays within 0..1e12 cents.
const MAX_BUDGETED = 1000000000000;
const MAX_NAME = 200;
const MAX_NOTE = 500;
// "Within 5 years of today", counted in whole months either way.
const MONTH_WINDOW = 60;

// A failure with an HTTP status and one of the schema's error codes. The body
// sent is only ever `{ error: code }`, never the message or any input.
class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const badRequest = () => new HttpError(400, 'bad_request');
const notFound = () => new HttpError(404, 'not_found');

const clip = (value, max = MAX_NAME) => String(value ?? '').slice(0, max);
const isValidId = (value) => typeof value === 'string' && ID_PATTERN.test(value);

// Money is integer cents end to end: a non-integer from Actual reads as 0
// rather than leaking a float, and anything outside the schema's range is clamped.
function money(value) {
  if (!Number.isInteger(value)) return 0;
  // `+ 0` turns -0 into 0.
  return Math.max(-MAX_MONEY, Math.min(MAX_MONEY, value)) + 0;
}

const monthIndex = (month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;

function monthWithinWindow(month, now = new Date()) {
  return Math.abs(monthIndex(month) - (now.getFullYear() * 12 + now.getMonth())) <= MONTH_WINDOW;
}

// Hidden group or hidden category: neither is offered to the phone.
const isHidden = (group, category) => Boolean(group.hidden || (category && category.hidden));

// A category belongs to an income group (Actual flags both).
const isIncome = (group, category) => Boolean(group.is_income || (category && category.is_income));

module.exports = {
  ID_PATTERN,
  MONTH_PATTERN,
  DATE_PATTERN,
  MAX_MONEY,
  MAX_BUDGETED,
  MAX_NAME,
  MAX_NOTE,
  MONTH_WINDOW,
  HttpError,
  badRequest,
  notFound,
  clip,
  isValidId,
  money,
  monthWithinWindow,
  isHidden,
  isIncome,
};
