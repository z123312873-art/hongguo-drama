// SPDX-License-Identifier: GPL-3.0-only
// Request scheduler for the per-device-limited comic chapter API.
//
// Measured behaviour of the service: one device may call the chapter endpoint about a hundred times per
// 30-50 seconds. After that it answers with empty bodies until the window passes, while a fresh device has a
// fresh allowance. This scheduler keeps a sustained rate well below that, backs off with jitter when an empty
// body shows up anyway, and only then moves to a new device. It knows nothing about HTTP or comics: the
// caller supplies `call(session, input)` and `createSession()`.
//
// Two further failure shapes are handled: a device the service refuses with a business code (not an empty
// body) is replaced like an exhausted one, and every device is retired after a fixed number of calls so it
// never reaches the point where the service starts refusing it.
const EMPTY = 'EMPTY_RESPONSE';
const REJECTED = 'BUSINESS_REJECTED';
// Business codes that look like a property of the request (an unknown book). They can also be what a service
// answers to a client it routes elsewhere, so they get a few fresh devices and routes before they are final.
const PERMANENT_CODES = [101104];
const PERMANENT_ATTEMPTS = 5;
// A device that cannot even be registered is not retried for long: the person is waiting on a click.
const REGISTRATION_ATTEMPTS = 3;
// A request refused by this many different devices is not going to be served; say so instead of waiting.
const REJECTED_ATTEMPTS = 3;
const RETRYABLE_NETWORK = new Set(['ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET', 'ERR_NETWORK', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']);

const PRIORITY = Object.freeze({ click: 0, prefetch: 1, background: 2 });

function fail(message, code, extra = {}) {
    return Object.assign(new Error(message), { code, ...extra });
}

class ApiScheduler {
    constructor({
        call, createSession,
        rate = 1.4, burst = 10, concurrency = 2,
        emptiesToRotate = 3, maxRotations = 3, rotationWindowMs = 10 * 60 * 1000, rotationCooldownMs = 5000,
        rejectionsToRotate = 2, rejectionPauseMs = 1500, callsPerSession = 70, permanentCodes = PERMANENT_CODES, permanentAttempts = PERMANENT_ATTEMPTS,
        backoff = [400, 1200, 3000, 6000], maxAttempts = 6,
        now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), random = Math.random,
    } = {}) {
        if (typeof call !== 'function' || typeof createSession !== 'function') throw new TypeError('call and createSession are required');
        Object.assign(this, { call, createSession, rate, burst, concurrency, emptiesToRotate, maxRotations, rotationWindowMs,
            rotationCooldownMs, rejectionsToRotate, rejectionPauseMs, callsPerSession, permanentAttempts, backoff, maxAttempts, now, sleep, random });
        this.permanentCodes = new Set(permanentCodes);
        this.consecutiveRejections = 0;
        this.tokens = burst;
        this.refilledAt = now();
        this.pausedUntil = 0;
        this.active = 0;
        this.queue = [];
        this.jobs = new Map();
        this.session = null;
        this.sessionPromise = null;
        this.generation = 0;
        this.rotationReason = 'initial';
        this.consecutiveEmpties = 0;
        this.rotations = [];
        this.lastSessionAt = 0;
        this.pumping = false;
        this.timer = null;
        this.stats = { calls: 0, empties: 0, rejections: 0, rotations: 0, retired: 0, retries: 0, failures: 0 };
    }

    // Same key while queued or running: share the result. A more urgent caller raises the priority.
    run(key, priority, input) {
        const existing = this.jobs.get(key);
        if (existing) {
            if (priority < existing.priority) {
                existing.priority = priority;
                this.sortQueue();
            }
            return existing.promise;
        }
        const job = { key, priority, input, attempt: 0, cancelled: false, enqueuedAt: this.now() };
        job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
        // A caller that gave up must not leave an unhandled rejection behind.
        job.promise.catch(() => {});
        this.jobs.set(key, job);
        this.queue.push(job);
        this.sortQueue();
        this.pump();
        return job.promise;
    }

    // Queued work can be withdrawn; a request already on the wire is allowed to finish.
    cancel(matcher) {
        const test = typeof matcher === 'function' ? matcher : (key) => key === matcher;
        let cancelled = 0;
        for (const job of [...this.queue]) {
            if (!test(job.key, job)) continue;
            this.queue.splice(this.queue.indexOf(job), 1);
            this.jobs.delete(job.key);
            job.reject(fail('请求已取消', 'CANCELLED'));
            cancelled += 1;
        }
        return cancelled;
    }

    sortQueue() {
        this.queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
    }

    refill() {
        const at = this.now();
        this.tokens = Math.min(this.burst, this.tokens + Math.max(0, at - this.refilledAt) * this.rate / 1000);
        this.refilledAt = at;
    }

    schedule(ms) {
        if (this.timer) return;
        this.timer = setTimeout(() => { this.timer = null; this.pump(); }, Math.max(1, Math.ceil(ms)));
    }

    pump() {
        if (this.pumping) return;
        this.pumping = true;
        try {
            while (this.queue.length && this.active < this.concurrency) {
                const at = this.now();
                if (at < this.pausedUntil) { this.schedule(this.pausedUntil - at); return; }
                this.refill();
                if (this.tokens < 1) { this.schedule((1 - this.tokens) * 1000 / this.rate); return; }
                this.tokens -= 1;
                this.active += 1;
                const job = this.queue.shift();
                this.attemptJob(job).finally(() => { this.active -= 1; this.pump(); });
            }
        } finally { this.pumping = false; }
    }

    async currentSession() {
        if (this.session) return this.session;
        if (!this.sessionPromise) {
            this.sessionPromise = (async () => {
                const wait = this.lastSessionAt + this.rotationCooldownMs - this.now();
                if (this.lastSessionAt && wait > 0) await this.sleep(wait);
                try {
                    const reason = this.rotationReason;
                    this.rotationReason = 'initial';
                    const session = await this.createSession({ reason });
                    this.consecutiveEmpties = 0;
                    this.consecutiveRejections = 0;
                    this.session = { value: session, generation: this.generation, calls: 0 };
                    return this.session;
                } finally { this.lastSessionAt = this.now(); this.sessionPromise = null; }
            })();
        }
        return this.sessionPromise;
    }

    canRotate() {
        const at = this.now();
        this.rotations = this.rotations.filter((time) => at - time < this.rotationWindowMs);
        return this.rotations.length < this.maxRotations;
    }

    async attemptJob(job) {
        let session;
        try { session = await this.currentSession(); }
        catch (error) { return this.retryWithoutSession(job, error); }
        session.calls += 1;
        // Retire the device before the service has a reason to refuse it. This call still uses it.
        if (session.calls >= this.callsPerSession && this.session === session) {
            this.session = null;
            this.generation += 1;
            this.rotationReason = 'retired';
            this.stats.retired += 1;
        }
        let result;
        try {
            this.stats.calls += 1;
            result = await this.call(session.value, job.input);
        } catch (error) {
            return this.handleError(job, session, error);
        }
        if (session.generation === this.generation) { this.consecutiveEmpties = 0; this.consecutiveRejections = 0; }
        return this.finish(job, result);
    }

    retire(reason = 'rejected') {
        this.session = null;
        this.generation += 1;
        this.rotationReason = reason;
        this.rotations.push(this.now());
        this.stats.rotations += 1;
    }

    // Drop the current device so the next call registers a new one. Counted as a rotation only when asked.
    replaceSession(counted = false, reason = 'rejected') {
        this.session = null;
        this.generation += 1;
        this.rotationReason = reason;
        if (counted) this.stats.rotations += 1;
    }

    // Registering a device can fail for a moment (network, service). It is retried like any other call.
    retryWithoutSession(job, error) {
        job.attempt += 1;
        this.stats.retries += 1;
        if (job.attempt >= Math.min(this.maxAttempts, REGISTRATION_ATTEMPTS)) {
            this.stats.failures += 1;
            return this.finish(job, null, error);
        }
        return this.requeue(job, this.backoff[Math.min(job.attempt - 1, this.backoff.length - 1)]);
    }

    requeue(job, delay) {
        const wait = delay * (0.75 + this.random() * 0.5);
        if (wait > 0) this.pausedUntil = Math.max(this.pausedUntil, this.now() + wait);
        // Back of its priority class, not the head: other work must not starve behind a failing request.
        job.enqueuedAt = this.now() + wait;
        this.queue.push(job);
        this.sortQueue();
        return undefined;
    }

    async handleError(job, session, error) {
        const code = String(error?.code || '');
        const empty = code === EMPTY;
        const network = RETRYABLE_NETWORK.has(code);
        const rejected = code === REJECTED;
        const permanent = rejected && this.permanentCodes.has(Number(error?.apiCode));
        if (!empty && !network && !rejected) return this.finish(job, null, error);
        job.attempt += 1;
        if (rejected) job.rejected = (job.rejected || 0) + 1;
        this.stats.retries += 1;
        if (job.attempt >= this.maxAttempts || (rejected && job.rejected >= (permanent ? this.permanentAttempts : REJECTED_ATTEMPTS))) {
            this.stats.failures += 1;
            if (rejected) return this.finish(job, null, error);
            return this.finish(job, null, empty
                ? fail('漫画服务暂时限流，请稍后再试', 'RATE_LIMITED', { cause: error })
                : fail('漫画服务连接失败，请检查网络后重试', network ? code : 'ERR_NETWORK', { cause: error }));
        }
        let delay = this.backoff[Math.min(job.attempt - 1, this.backoff.length - 1)];
        // A device the service has only just registered may not be known everywhere yet. Give it a moment
        // before deciding it is the problem.
        if (rejected && !permanent) delay = Math.max(delay, this.rejectionPauseMs);
        if (permanent) {
            // Another device on another route right away; a stale answer from a retired device changes nothing.
            this.stats.rejections += 1;
            if (session.generation === this.generation) this.replaceSession(true);
            delay = 0;
        } else if (empty || rejected) {
            if (empty) this.stats.empties += 1; else this.stats.rejections += 1;
            // Only the session that is still current counts: a late answer from a retired device means nothing.
            if (session.generation === this.generation) {
                const streak = empty ? ++this.consecutiveEmpties : ++this.consecutiveRejections;
                if (streak >= (empty ? this.emptiesToRotate : this.rejectionsToRotate)) {
                    if (this.canRotate()) {
                        this.retire(empty ? 'empty' : 'rejected');
                        delay = 0;
                    } else if (rejected) {
                        this.stats.failures += 1;
                        return this.finish(job, null, error);
                    } else {
                        // Too many devices already: wait out the window instead of registering more.
                        delay = Math.max(delay, 15000);
                    }
                }
            } else delay = 0;
        }
        return this.requeue(job, delay);
    }

    finish(job, result, error) {
        this.jobs.delete(job.key);
        if (error) job.reject(error);
        else job.resolve(result);
    }

    snapshot() {
        return { ...this.stats, queued: this.queue.length, active: this.active, tokens: Math.floor(this.tokens), generation: this.generation };
    }
}

module.exports = { ApiScheduler, PRIORITY };
