const assert = require('node:assert/strict');
const https = require('node:https');
const dns = require('node:dns');
const { mock, test } = require('node:test');
const direct = require('./direct-connect');

function lookup(hostname, options = {}) {
  return new Promise((resolve, reject) => {
    const settings = direct.directAxiosOptions(`https://${hostname}/service/2/device_register/?tt_data=a`);
    assert.equal(typeof settings.lookup, 'function');
    assert.equal(settings.proxy, undefined);
    settings.lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve(options.all ? address : { address, family });
    });
  });
}

function answerDns(payload, onCall) {
  mock.method(https, 'get', (url, options, callback) => {
    onCall(url);
    const response = {
      statusCode: 200,
      setEncoding() {},
      on(event, fn) {
        if (event === 'data') fn(JSON.stringify(payload));
        if (event === 'end') fn();
        return this;
      },
    };
    callback(response);
    return { on() { return this; }, destroy() {} };
  });
}

test('registration keeps a normal system answer and asks public DNS only for a sinkholed applog host', async () => {
  direct.setDirectConnect(false);
  try {
    assert.deepEqual(direct.directAxiosOptions(), {});
    assert.deepEqual(direct.directAxiosOptions('https://api5-normal-lf.fqnovel.com/novel/player/multi_video_model/player/v1'), {});
    assert.deepEqual(direct.directAxiosOptions('https://log.snssdk.com/service/2/device_register/?tt_data=a'), {});

    let publicLookups = 0;
    mock.method(dns, 'lookup', (hostname, options, callback) => {
      assert.equal(options.all, true);
      if (hostname === 'log0-applog-lf.fqnovel.com') callback(null, [{ address: '9.9.9.9', family: 4 }]);
      else if (hostname === 'log5-applog-lf.fqnovel.com') callback(Object.assign(new Error('blocked'), { code: 'ENOENT' }));
      else callback(null, [{ address: '0.0.0.0', family: 4 }]);
    });
    answerDns({ Answer: [{ type: 1, data: '1.2.3.4' }] }, () => { publicLookups += 1; });

    assert.deepEqual(await lookup('log0-applog-lf.fqnovel.com'), { address: '9.9.9.9', family: 4 });
    assert.equal(publicLookups, 0);
    assert.deepEqual(await lookup('log5-applog-lf.fqnovel.com'), { address: '1.2.3.4', family: 4 });
    const listed = await lookup('log5-applog-hl.fqnovel.com', { all: true });
    assert.deepEqual(listed, [{ address: '1.2.3.4', family: 4 }]);
    assert.equal(publicLookups, 2);

    direct.setDirectConnect(true);
    const forced = direct.directAxiosOptions('https://log3-applog.fqnovel.com/service/2/device_register/?tt_data=a');
    assert.equal(forced.proxy, false);
    assert.equal(typeof forced.lookup, 'function');
  } finally {
    direct.setDirectConnect(false);
    mock.restoreAll();
  }
});
