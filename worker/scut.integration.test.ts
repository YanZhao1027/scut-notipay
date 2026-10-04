import assert from 'node:assert/strict';
import test from 'node:test';
import { getCaptcha } from './auth.js';

const enabled = process.env.SCUT_INTEGRATION_TEST === '1';

test(
  'SCUT returns a captcha challenge when integration tests are enabled',
  { skip: !enabled },
  async () => {
    const challenge = await getCaptcha();
    assert.ok(challenge.key.length > 0);
    assert.match(challenge.image, /^data:image\//);
  }
);
