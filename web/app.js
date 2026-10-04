const loginPanel = document.querySelector('#login-panel');
const resultsPanel = document.querySelector('#results-panel');
const loginForm = document.querySelector('#login-form');
const loginButton = document.querySelector('#login-button');
const loginStatus = document.querySelector('#login-status');
const resultsStatus = document.querySelector('#results-status');
const captchaPanel = document.querySelector('#captcha-panel');
const captchaImage = document.querySelector('#captcha-image');
const captchaCode = document.querySelector('#captcha-code');

const state = {
  captchaKey: '',
  loginAvailable: false,
  hasSession: false,
  lastFetchAt: 0,
  interval: 0,
  timer: null,
  retryTimer: null,
  inFlight: null
};

const setStatus = (element, text, kind = '') => {
  element.textContent = text;
  element.className = `status${kind ? ` ${kind}` : ''}`;
};

const apiJson = async (url, options = {}) => {
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.headers || {}) }
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    /* handled as a generic service error */
  }
  return { response, data };
};

const loadCaptcha = async () => {
  const { response, data } = await apiJson('/api/auth/captcha');
  if (!response.ok || typeof data.key !== 'string' || typeof data.image !== 'string') {
    const error = new Error(
      data.code === 'UPSTREAM_UNAVAILABLE'
        ? 'UPSTREAM_UNAVAILABLE'
        : '验证码暂时无法获取，请稍后再试。'
    );
    throw error;
  }
  state.captchaKey = data.key;
  captchaImage.src = data.image;
  captchaCode.value = '';
  captchaPanel.hidden = false;
};

const setLoginAvailability = (available) => {
  state.loginAvailable = available;
  loginButton.disabled = !available;
  document.querySelector('#username').disabled = !available;
  document.querySelector('#password').disabled = !available;
  document.querySelector('#captcha-refresh').disabled = !available;
  document.querySelector('#connection-retry').hidden = available;
  if (!available) {
    document.querySelector('#password').value = '';
    captchaPanel.hidden = true;
    captchaImage.removeAttribute('src');
    captchaCode.value = '';
    state.captchaKey = '';
    setStatus(loginStatus, '当前服务器无法连接华工一卡通，请勿继续输入密码。', 'error');
  }
};

const checkLoginConnection = async () => {
  setLoginAvailability(false);
  document.querySelector('#connection-retry').hidden = true;
  setStatus(loginStatus, '正在检查一卡通连接…');
  try {
    await loadCaptcha();
    setLoginAvailability(true);
    setStatus(loginStatus, '一卡通连接正常，可以登录。');
  } catch {
    setLoginAvailability(false);
    document.querySelector('#connection-retry').hidden = false;
  }
};

const formatBalance = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `¥${number.toFixed(2)}`;
};

const formatTime = (value) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
};

const stopAutoRefresh = () => {
  if (state.timer) clearInterval(state.timer);
  if (state.retryTimer) clearTimeout(state.retryTimer);
  state.timer = null;
  state.retryTimer = null;
  state.interval = 0;
  document.querySelector('input[name="refresh"][value="0"]').checked = true;
};

const showLogin = (message = '') => {
  stopAutoRefresh();
  state.hasSession = false;
  resultsPanel.hidden = true;
  loginPanel.hidden = false;
  if (message) setStatus(loginStatus, message, 'error');
};

const handleReauth = () => {
  showLogin('登录状态已失效，请重新认证。');
  void checkLoginConnection();
};

const applyBills = (bills) => {
  document.querySelector('#room-name').textContent = bills.room || '宿舍';
  document.querySelector('#electric-value').textContent = formatBalance(bills.electric);
  document.querySelector('#water-value').textContent = formatBalance(bills.water);
  document.querySelector('#ac-value').textContent =
    bills.ac == null ? '不支持' : formatBalance(bills.ac);
  document.querySelector('#ac-unit').textContent =
    bills.ac == null ? '大学城校区暂无空调费数据' : '平台返回余额 · 元';
  document.querySelector('#updated-at').textContent = formatTime(bills.updatedAt);
};

const scheduleSingleRetry = () => {
  if (state.retryTimer || !state.interval || document.visibilityState !== 'visible') return;
  state.retryTimer = setTimeout(() => {
    state.retryTimer = null;
    if (state.interval && document.visibilityState === 'visible' && navigator.onLine) {
      void fetchBills({ automatic: true, retry: false });
    }
  }, 15000);
};

const fetchBills = ({ automatic = false, retry = true } = {}) => {
  if (state.inFlight) return state.inFlight;
  if (automatic && (document.visibilityState !== 'visible' || !navigator.onLine)) {
    return Promise.resolve(false);
  }

  const button = document.querySelector('#query-button');
  button.disabled = true;
  document.querySelector('#query-state').textContent = automatic ? '自动查询中' : '查询中';
  setStatus(resultsStatus, '正在连接校园一卡通…');

  state.inFlight = (async () => {
    try {
      const { response, data } = await apiJson('/api/bills');
      state.lastFetchAt = Date.now();
      if (response.status === 401 || data.code === 'REAUTH_REQUIRED') {
        handleReauth();
        return false;
      }
      if (!response.ok) throw new Error('本次查询失败，请稍后手动重试。');
      applyBills(data);
      state.hasSession = true;
      setStatus(resultsStatus, '余额已更新。', 'success');
      return true;
    } catch (error) {
      state.lastFetchAt = Date.now();
      setStatus(
        resultsStatus,
        error instanceof Error ? error.message : '网络暂时不可用。',
        'error'
      );
      if (automatic && retry) scheduleSingleRetry();
      return false;
    } finally {
      state.inFlight = null;
      button.disabled = false;
      document.querySelector('#query-state').textContent = '';
    }
  })();

  return state.inFlight;
};

const startAutoRefresh = (interval) => {
  if (state.timer) clearInterval(state.timer);
  if (state.retryTimer) clearTimeout(state.retryTimer);
  state.timer = null;
  state.retryTimer = null;
  state.interval = interval;
  if (!interval) return;
  state.timer = setInterval(
    () => {
      if (document.visibilityState !== 'visible' || !state.hasSession) return;
      if (Date.now() - state.lastFetchAt >= state.interval) {
        void fetchBills({ automatic: true });
      }
    },
    Math.min(interval, 60000)
  );
};

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (loginButton.disabled || !state.loginAvailable) return;
  const body = {
    username: document.querySelector('#username').value.trim(),
    password: document.querySelector('#password').value,
    campus: document.querySelector('#campus').value
  };
  if (captchaPanel.hidden === false) {
    body.captchaKey = state.captchaKey;
    body.captchaCode = captchaCode.value.trim();
  }
  loginButton.disabled = true;
  setStatus(loginStatus, '正在登录…');

  try {
    const { response, data } = await apiJson('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    body.password = '';

    if (data.code === 'CAPTCHA_REQUIRED') {
      try {
        await loadCaptcha();
        captchaCode.focus({ preventScroll: true });
        setStatus(loginStatus, '请输入一卡通验证码后继续。');
      } catch (error) {
        if (error.message === 'UPSTREAM_UNAVAILABLE') {
          setLoginAvailability(false);
        } else {
          setStatus(loginStatus, error.message || '验证码暂时无法获取。', 'error');
        }
      }
      return;
    }
    if (data.code === 'CAPTCHA_INVALID') {
      try {
        await loadCaptcha();
        captchaCode.focus({ preventScroll: true });
        setStatus(loginStatus, '验证码不正确，请重新输入。', 'error');
      } catch (error) {
        if (error.message === 'UPSTREAM_UNAVAILABLE') {
          setLoginAvailability(false);
        } else {
          setStatus(loginStatus, error.message || '验证码暂时无法获取。', 'error');
        }
      }
      return;
    }
    if (!response.ok || !data.ok) {
      document.querySelector('#password').value = '';
      if (data.code === 'UPSTREAM_UNAVAILABLE') {
        setLoginAvailability(false);
        return;
      }
      const message =
        data.code === 'INVALID_CREDENTIALS'
          ? '账号或密码不正确。'
          : data.code === 'UPSTREAM_UNAVAILABLE'
            ? '一卡通服务暂时不可用，请稍后再试。'
            : '登录暂时失败，请稍后再试。';
      setStatus(loginStatus, message, 'error');
      return;
    }

    state.hasSession = true;
    document.querySelector('#password').value = '';
    document.querySelector('#user-name').textContent = data.user?.name || data.user?.sno || '';
    loginPanel.hidden = true;
    resultsPanel.hidden = false;
    setStatus(loginStatus, '');
    captchaPanel.hidden = true;
    state.captchaKey = '';
    await fetchBills();
  } catch {
    body.password = '';
    setLoginAvailability(false);
  } finally {
    loginButton.disabled = !state.loginAvailable;
  }
});

document.querySelector('#captcha-refresh').addEventListener('click', async () => {
  try {
    await loadCaptcha();
    setStatus(loginStatus, '验证码已更新。');
  } catch (error) {
    if (error.message === 'UPSTREAM_UNAVAILABLE') {
      setLoginAvailability(false);
      document.querySelector('#connection-retry').hidden = false;
    } else {
      setStatus(loginStatus, error.message || '验证码暂时无法获取。', 'error');
    }
  }
});

document.querySelector('#connection-retry').addEventListener('click', () => {
  void checkLoginConnection();
});

document.querySelector('#query-button').addEventListener('click', () => {
  void fetchBills();
});

document.querySelectorAll('input[name="refresh"]').forEach((input) => {
  input.addEventListener('change', () => startAutoRefresh(Number(input.value)));
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  stopAutoRefresh();
  try {
    await apiJson('/api/auth/logout', { method: 'POST' });
  } catch {
    /* cookie expires with the page */
  }
  document.querySelector('#password').value = '';
  showLogin('已退出登录。');
  void checkLoginConnection();
});

document.addEventListener('visibilitychange', () => {
  if (
    document.visibilityState === 'visible' &&
    state.interval &&
    state.hasSession &&
    Date.now() - state.lastFetchAt >= state.interval
  ) {
    void fetchBills({ automatic: true });
  }
});

window.addEventListener('online', () => {
  if (
    document.visibilityState === 'visible' &&
    state.interval &&
    state.hasSession &&
    Date.now() - state.lastFetchAt >= state.interval
  ) {
    void fetchBills({ automatic: true });
  }
});

const restoreSession = async () => {
  try {
    const { response, data } = await apiJson('/api/auth/session');
    if (!response.ok || !data.ok) return false;
    state.hasSession = true;
    document.querySelector('#user-name').textContent = data.user?.name || data.user?.sno || '';
    loginPanel.hidden = true;
    resultsPanel.hidden = false;
    await fetchBills();
    return true;
  } catch {
    /* show sign-in form when the session cannot be checked */
    return false;
  }
};

void restoreSession().then((restored) => {
  if (!restored) void checkLoginConnection();
});
