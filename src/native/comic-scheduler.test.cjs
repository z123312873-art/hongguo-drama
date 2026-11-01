// SPDX-License-Identifier: GPL-3.0-only
// The scheduler runs against a fake chapter service that reproduces the measured limit: each device gets a
// fixed number of calls per window and then answers with empty bodies. Time is compressed 100x.
const assert = require('node:assert/strict');
const test = require('node:test');
const { ApiScheduler, PRIORITY } = require('./comic-scheduler');

const empty = () => Object.assign(new Error('empty'), { code: 'EMPTY_RESPONSE' });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeService({ quota = 100, windowMs = 400, burnFirst = false, alwaysEmpty = false } = {}) {
    const devices = [];
    const service = {
        devices, calls: 0, empties: 0,
        async createSession() {
            const device = { id: devices.length + 1, windowStart: Date.now(), used: burnFirst && devices.length === 0 ? quota : 0 };
            devices.push(device);
            return device;
        },
        async call(device, input) {
            service.calls += 1;
            if (Date.now() - device.windowStart >= windowMs) { device.windowStart = Date.now(); device.used = 0; }
            device.used += 1;
            await delay(2);
            if (alwaysEmpty || device.used > quota) { service.empties += 1; throw empty(); }
            return { input, device: device.id };
        },
    };
    return service;
}

const fast = { rate: 140, burst: 10, concurrency: 2, backoff: [4, 12, 30, 60], rotationCooldownMs: 20, maxAttempts: 6, rejectionPauseMs: 5 };

test('a long sustained run stays under the device allowance: no empty body at all', async () => {
    const service = fakeService();
    const scheduler = new ApiScheduler({ ...fast, call: service.call, createSession: service.createSession });
    const results = await Promise.all(Array.from({ length: 220 }, (_, index) => scheduler.run(`ch-${index}`, PRIORITY.background, index)));
    assert.equal(results.length, 220);
    assert.equal(service.empties, 0, 'the throttle prevents the empty-body failure instead of reacting to it');
    assert.equal(service.devices.length, Math.ceil(220 / scheduler.callsPerSession), 'each device is retired before it can be refused');
    assert.equal(scheduler.snapshot().failures, 0);
});

test('an exhausted device is replaced after a few empty bodies and the work still completes', async () => {
    const service = fakeService({ burnFirst: true });
    const scheduler = new ApiScheduler({ ...fast, call: service.call, createSession: service.createSession });
    const results = await Promise.all(Array.from({ length: 40 }, (_, index) => scheduler.run(`ch-${index}`, PRIORITY.click, index)));
    assert.equal(results.length, 40);
    assert.ok(service.devices.length >= 2, 'rotated to a new device');
    assert.ok(service.devices.length <= 3);
    assert.equal(scheduler.snapshot().failures, 0);
    assert.equal(scheduler.snapshot().rotations, service.devices.length - 1);
});

test('simultaneous empty bodies from one device trigger a single rotation', async () => {
    const service = fakeService({ burnFirst: true });
    const scheduler = new ApiScheduler({ ...fast, concurrency: 4, burst: 4, call: service.call, createSession: service.createSession });
    await Promise.all(Array.from({ length: 8 }, (_, index) => scheduler.run(`ch-${index}`, PRIORITY.click, index)));
    assert.equal(service.devices.length, 2, 'late answers from the retired device do not rotate again');
});

test('the same key shares one request and one result', async () => {
    const service = fakeService();
    const scheduler = new ApiScheduler({ ...fast, call: service.call, createSession: service.createSession });
    const [a, b, c] = await Promise.all([scheduler.run('same', PRIORITY.prefetch, 1), scheduler.run('same', PRIORITY.click, 1), scheduler.run('same', PRIORITY.background, 1)]);
    assert.equal(service.calls, 1);
    assert.equal(a, b);
    assert.equal(b, c);
    await scheduler.run('same', PRIORITY.click, 1);
    assert.equal(service.calls, 2, 'a finished key can be requested again');
});

test('a click jumps ahead of queued background work', async () => {
    const order = [];
    const scheduler = new ApiScheduler({
        ...fast, concurrency: 1, rate: 1000, burst: 1,
        createSession: async () => ({}), call: async (_session, input) => { order.push(input); await delay(3); return input; },
    });
    const background = Array.from({ length: 5 }, (_, index) => scheduler.run(`bg-${index}`, PRIORITY.background, `bg-${index}`));
    await delay(1);
    const click = scheduler.run('click', PRIORITY.click, 'click');
    await Promise.all([...background, click]);
    assert.ok(order.indexOf('click') <= 2, `click ran early: ${order.join(',')}`);
});

test('raising a queued job to click priority moves it forward', async () => {
    const order = [];
    const scheduler = new ApiScheduler({
        ...fast, concurrency: 1, rate: 1000, burst: 1,
        createSession: async () => ({}), call: async (_session, input) => { order.push(input); await delay(3); return input; },
    });
    const jobs = ['a', 'b', 'c', 'd', 'e'].map((id) => scheduler.run(id, PRIORITY.background, id));
    await delay(1);
    jobs.push(scheduler.run('e', PRIORITY.click, 'e'));
    await Promise.all(jobs);
    assert.ok(order.indexOf('e') <= 2, order.join(','));
});

test('queued work can be cancelled; running work is left alone', async () => {
    const scheduler = new ApiScheduler({
        ...fast, concurrency: 1, rate: 1000, burst: 1,
        createSession: async () => ({}), call: async (_session, input) => { await delay(10); return input; },
    });
    const first = scheduler.run('prefetch:1', PRIORITY.prefetch, 1);
    const second = scheduler.run('prefetch:2', PRIORITY.prefetch, 2);
    const third = scheduler.run('keep', PRIORITY.click, 3);
    await delay(2);
    assert.equal(scheduler.cancel((key) => key.startsWith('prefetch:')), 1);
    await assert.rejects(second, (error) => error.code === 'CANCELLED');
    assert.equal(await first, 1);
    assert.equal(await third, 3);
});

test('when every device is exhausted the caller gets a rate-limit error after a bounded number of tries', async () => {
    const service = fakeService({ alwaysEmpty: true });
    const scheduler = new ApiScheduler({ ...fast, maxRotations: 2, call: service.call, createSession: service.createSession });
    // With maxRotations reached the scheduler waits 15 s per retry in production; keep the test short.
    scheduler.maxAttempts = 4;
    const outcome = scheduler.run('doomed', PRIORITY.click, 1);
    await assert.rejects(outcome, (error) => error.code === 'RATE_LIMITED' && /限流/.test(error.message));
    assert.ok(service.devices.length <= 3, 'device registration is capped');
    assert.ok(service.calls <= 4);
});

test('a request-level business code is final: no retry, no new device', async () => {
    let calls = 0;
    const scheduler = new ApiScheduler({ ...fast, createSession: async () => ({}), call: async () => { calls += 1; throw Object.assign(new Error('bad id'), { code: 'BUSINESS_REJECTED', apiCode: 101104 }); } });
    await assert.rejects(scheduler.run('x', PRIORITY.click, 1), (error) => error.code === 'BUSINESS_REJECTED');
    assert.equal(calls, 1);
    assert.equal(scheduler.snapshot().rotations, 0);
});

test('a device refused with a business code is replaced and the request still succeeds', async () => {
    const devices = [];
    const scheduler = new ApiScheduler({ ...fast, rotationCooldownMs: 5,
        createSession: async () => { const device = { id: devices.length + 1 }; devices.push(device); return device; },
        call: async (device, input) => { if (device.id === 1) throw Object.assign(new Error('refused'), { code: 'BUSINESS_REJECTED', apiCode: 101021 }); return { input, device: device.id }; } });
    const results = await Promise.all([scheduler.run('a', PRIORITY.click, 1), scheduler.run('b', PRIORITY.click, 2), scheduler.run('c', PRIORITY.click, 3)]);
    assert.deepEqual(results.map((entry) => entry.device), [2, 2, 2]);
    assert.equal(devices.length, 2, 'simultaneous refusals from one device rotate once');
    assert.equal(scheduler.snapshot().failures, 0);
});

test('a service that refuses every device ends with the original code after bounded tries', async () => {
    let created = 0;
    const scheduler = new ApiScheduler({ ...fast, rotationCooldownMs: 5, maxRotations: 2,
        createSession: async () => { created += 1; return {}; },
        call: async () => { throw Object.assign(new Error('refused'), { code: 'BUSINESS_REJECTED', apiCode: 101021 }); } });
    scheduler.maxAttempts = 4;
    await assert.rejects(scheduler.run('x', PRIORITY.click, 1), (error) => error.code === 'BUSINESS_REJECTED' && error.apiCode === 101021);
    assert.ok(created <= 3, `devices registered: ${created}`);
});

test('transient network failures retry and then succeed', async () => {
    let calls = 0;
    const scheduler = new ApiScheduler({ ...fast, createSession: async () => ({}), call: async () => { calls += 1; if (calls < 3) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); return 'ok'; } });
    assert.equal(await scheduler.run('x', PRIORITY.click, 1), 'ok');
    assert.equal(calls, 3);
    assert.equal(scheduler.snapshot().rotations, 0, 'network trouble is not a device problem');
});

test('a failed device registration is retried and the request recovers', async () => {
    let attempts = 0;
    const scheduler = new ApiScheduler({ ...fast, rotationCooldownMs: 10, call: async (_s, input) => input,
        createSession: async () => { attempts += 1; if (attempts === 1) throw Object.assign(new Error('register'), { code: 'DEVICE_REGISTRATION_FAILED' }); return {}; } });
    assert.equal(await scheduler.run('a', PRIORITY.click, 1), 1);
    assert.equal(attempts, 2);
});

test('a registration that keeps failing ends after a few tries instead of hanging the click', async () => {
    let attempts = 0;
    const scheduler = new ApiScheduler({ ...fast, rotationCooldownMs: 5, call: async (_s, input) => input,
        createSession: async () => { attempts += 1; throw Object.assign(new Error('register'), { code: 'DEVICE_REGISTRATION_FAILED' }); } });
    await assert.rejects(scheduler.run('a', PRIORITY.click, 1), (error) => error.code === 'DEVICE_REGISTRATION_FAILED');
    assert.equal(attempts, 3);
});

test('the sustained rate never exceeds the configured token bucket', async () => {
    const stamps = [];
    const scheduler = new ApiScheduler({ ...fast, rate: 50, burst: 5, concurrency: 8, createSession: async () => ({}), call: async () => { stamps.push(Date.now()); return 1; } });
    const started = Date.now();
    await Promise.all(Array.from({ length: 55 }, (_, index) => scheduler.run(`k${index}`, PRIORITY.background, index)));
    const elapsed = Date.now() - started;
    // 5 burst + 50 more at 50/s needs about one second.
    assert.ok(elapsed >= 850, `elapsed ${elapsed}ms`);
});

test('constructor rejects missing collaborators', () => {
    assert.throws(() => new ApiScheduler({}), TypeError);
});

test('a refusal right after registration is retried on the same device before it is replaced', async () => {
    const devices = [];
    let refused = 0;
    const scheduler = new ApiScheduler({ ...fast, rotationCooldownMs: 5,
        createSession: async () => { const device = { id: devices.length + 1 }; devices.push(device); return device; },
        call: async (device, input) => { if (refused < 1) { refused += 1; throw Object.assign(new Error('not known yet'), { code: 'BUSINESS_REJECTED', apiCode: 101021 }); } return { input, device: device.id }; } });
    const outcome = await scheduler.run('a', PRIORITY.click, 1);
    assert.equal(outcome.device, 1, 'one early refusal does not cost a new device');
    assert.equal(devices.length, 1);
});
