'use strict';

const { createSharedRateLimiter } = require('../utils/sharedRateLimiter');

function response() {
  const res = {};
  res.setHeader = jest.fn();
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

test('shares a bucket between limiter factories', async () => {
  const startedAt = new Date().toISOString();
  const pool = {
    query: jest.fn()
      .mockResolvedValueOnce({ rows: [{ request_count: 1, window_started_at: startedAt }] })
      .mockResolvedValueOnce({ rows: [{ request_count: 2, window_started_at: startedAt }] }),
  };
  const options = { key: () => 'same-client', windowMs: 60_000, limit: 1, message: 'Too many requests' };
  const first = createSharedRateLimiter(pool).middleware(options);
  const second = createSharedRateLimiter(pool).middleware(options);
  const next = jest.fn();

  await first({}, response(), next);
  const blocked = response();
  await second({}, blocked, next);

  expect(next).toHaveBeenCalledTimes(1);
  expect(pool.query).toHaveBeenCalledTimes(2);
  expect(pool.query.mock.calls[0][1]).toEqual(['same-client', 60_000]);
  expect(blocked.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
  expect(blocked.status).toHaveBeenCalledWith(429);
  expect(blocked.json).toHaveBeenCalledWith({ sucesso: false, erro: 'Too many requests' });
});
