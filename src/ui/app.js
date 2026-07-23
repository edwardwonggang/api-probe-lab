/* global apiProbe */

const state = {
  models: [],
  selectedModel: '',
  probeResult: null,
  keyVisible: false,
  messages: [], // {role, content}
  lastSuccessFormat: null,
  sending: false,
  showDetails: false,
  systemProxy: null,
  proxyManualOverride: false,
};

const $ = (id) => document.getElementById(id);

function log(msg, level = 'info') {
  const box = $('logBox');
  if (!box) return;
  const ts = new Date().toLocaleTimeString();
  const prefix = level === 'error' ? '✖' : level === 'ok' ? '✔' : '•';
  box.textContent += `[${ts}] ${prefix} ${msg}\n`;
  box.scrollTop = box.scrollHeight;
}

function setStatus(el, text, kind = '') {
  if (!el) return;
  el.textContent = text || '';
  el.className = 'status-line' + (kind ? ` ${kind}` : '');
}

function renderNotes(notes) {
  const el = $('extractNotes');
  if (!notes || !notes.length) {
    el.textContent = '';
    return;
  }
  el.innerHTML = notes.map((n) => `• ${escapeHtml(n)}`).join('<br/>');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function resolveProxyForRequest() {
  const manual = $('proxy').value.trim();
  const useSystem = $('useSystemProxy') ? $('useSystemProxy').checked : true;
  if (!useSystem) return manual;
  // If user typed something different from last auto value, prefer manual
  if (manual) return manual;
  return state.systemProxy?.proxy || '';
}

function currentConfig() {
  const v1 = $('v1Policy').value;
  return {
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    proxy: resolveProxyForRequest(),
    timeoutMs: Number($('timeoutMs').value) || 60000,
    preferV1: v1 === 'auto' ? undefined : v1 === 'with',
  };
}

function applySystemProxyResult(info, { force = false } = {}) {
  state.systemProxy = info || null;
  const badge = $('proxyBadge');
  const hint = $('proxyHint');
  if (!info) {
    if (badge) badge.classList.add('hide');
    if (hint) hint.textContent = '未检测到系统代理，可手动填写';
    return;
  }
  const label = info.enabled
    ? `系统代理 · ${info.source}`
    : (info.note ? 'PAC/无固定代理' : '无系统代理');
  if (badge) {
    badge.textContent = label;
    badge.classList.toggle('hide', !info.enabled && !info.note);
  }
  if (hint) {
    hint.textContent = info.enabled
      ? `已自动读取：${info.proxy}（来源 ${info.source}），可手动修改后生效`
      : (info.note || info.raw || '未检测到可用系统代理');
  }
  const input = $('proxy');
  if (!input) return;
  const shouldFill = force || !input.value.trim() || !state.proxyManualOverride;
  if (info.proxy && shouldFill) {
    input.value = info.proxy;
  }
}

async function loadSystemProxy({ force = false } = {}) {
  try {
    if (!apiProbe.detectSystemProxy) {
      log('当前版本不支持系统代理检测', 'error');
      return null;
    }
    const info = await apiProbe.detectSystemProxy();
    applySystemProxyResult(info, { force });
    if (info?.enabled) log(`系统代理：${info.proxy} (${info.source})`, 'ok');
    else log(info?.note || '未检测到系统代理');
    return info;
  } catch (err) {
    log(err.message || String(err), 'error');
    return null;
  }
}

function renderChat() {
  const box = $('chatMessages');
  if (!box) return;
  if (!state.messages.length) {
    box.innerHTML = '<div class="chat-bubble system">先探测模型，再在下方输入问题。Enter 发送，Shift+Enter 换行。</div>';
    return;
  }
  box.innerHTML = state.messages
    .map((m) => {
      const role = m.role === 'user' ? 'user' : m.role === 'error' ? 'error' : m.role === 'system' ? 'system' : 'assistant';
      const label =
        role === 'user' ? '你' : role === 'assistant' ? '模型' : role === 'error' ? '错误' : '系统';
      const meta = m.meta ? `<span class="meta">${escapeHtml(m.meta)}</span>` : `<span class="meta">${label}</span>`;
      return `<div class="chat-bubble ${role}">${meta}${escapeHtml(m.content)}</div>`;
    })
    .join('');
  box.scrollTop = box.scrollHeight;
}

function appendMessage(role, content, meta) {
  state.messages.push({ role, content, meta });
  renderChat();
}

async function onExtract() {
  const raw = $('rawInput').value;
  const result = await apiProbe.extractCredentials(raw);
  if (result.baseUrl) $('baseUrl').value = result.baseUrl;
  if (result.apiKey) $('apiKey').value = result.apiKey;
  $('keyBadge').classList.toggle('hide', !result.apiKeyDecoded);
  renderNotes(result.notes);
  persistConfig();
  log(
    `提取完成：baseUrl=${result.baseUrl || '(空)'} key=${result.apiKey ? mask(result.apiKey) : '(空)'}` +
      (result.apiKeyDecoded ? ' [base64解码]' : '')
  );
  return result;
}

function mask(key) {
  if (!key) return '';
  if (key.length <= 10) return '*'.repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function renderModels(models) {
  state.models = models || [];
  const filter = ($('modelFilter').value || '').toLowerCase();
  const list = $('modelsList');
  const options = $('modelOptions');
  options.innerHTML = '';
  const filtered = state.models.filter((m) => String(m).toLowerCase().includes(filter));

  if (!filtered.length) {
    list.innerHTML = `<div class="empty">${state.models.length ? '无匹配模型' : '探测成功后将显示可用模型'}</div>`;
    return;
  }

  list.innerHTML = '';
  for (const model of filtered) {
    const opt = document.createElement('option');
    opt.value = model;
    options.appendChild(opt);

    const item = document.createElement('div');
    item.className = 'model-item' + (model === state.selectedModel ? ' active' : '');
    item.innerHTML = `<span>${escapeHtml(model)}</span><span class="use">使用</span>`;
    item.addEventListener('click', () => {
      state.selectedModel = model;
      $('chatModel').value = model;
      persistConfig();
      renderModels(state.models);
      log(`已选择模型：${model}`);
    });
    list.appendChild(item);
  }
}

async function onProbe() {
  const cfg = currentConfig();
  if (!cfg.baseUrl) {
    setStatus($('probeStatus'), '请先填写 Base URL', 'err');
    return;
  }
  if (!cfg.apiKey) {
    setStatus($('probeStatus'), '请先填写 API Key', 'err');
    return;
  }

  $('btnProbe').disabled = true;
  $('btnExtractAndProbe').disabled = true;
  setStatus($('probeStatus'), '正在探测 /models …', 'busy');
  log(`开始探测：${cfg.baseUrl}`);

  try {
    const result = await apiProbe.probeEndpoint(cfg);
    state.probeResult = result;
    if (result.success) {
      const models = result.models || [];
      renderModels(models);
      if (models[0] && !$('chatModel').value) {
        state.selectedModel = models[0];
        $('chatModel').value = models[0];
      }
      const meta = [
        `有效 Base：${result.effectiveBaseUrl}`,
        `鉴权：${result.authStyle}`,
        `模型数：${models.length}`,
        `延迟：${result.latencyMs}ms`,
        result.modelsUrl ? `URL：${result.modelsUrl}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      $('probeMeta').textContent = meta;
      setStatus(
        $('probeStatus'),
        result.partial
          ? '接口可访问，但模型列表为空（可手动指定模型测试）'
          : `探测成功，共 ${models.length} 个模型`,
        'ok'
      );
      log(`探测成功：${models.length} models @ ${result.modelsUrl}`, 'ok');
      if (result.notes) result.notes.forEach((n) => log(n));
      appendMessage('system', `模型探测完成，共 ${models.length} 个。可在中间区域开始对话。`);
    } else {
      renderModels([]);
      $('probeMeta').textContent = '探测失败';
      setStatus($('probeStatus'), result.error || '探测失败', 'err');
      log(result.error || '探测失败', 'error');
      (result.attempts || []).slice(0, 12).forEach((a) => {
        log(`${a.url} · ${a.authStyle} · ${a.error || a.status}`, 'error');
      });
    }
  } catch (err) {
    setStatus($('probeStatus'), err.message || String(err), 'err');
    log(err.message || String(err), 'error');
  } finally {
    $('btnProbe').disabled = false;
    $('btnExtractAndProbe').disabled = false;
    persistConfig();
  }
}

async function onChat() {
  if (state.sending) {
    log('正在发送中，请稍候…');
    return;
  }

  const cfg = currentConfig();
  const model = $('chatModel').value.trim();
  const format = $('chatFormat').value;
  const message = $('chatMessage').value.trim();
  const probe = state.probeResult || {};

  if (!cfg.baseUrl) {
    setStatus($('chatStatus'), '请先填写 Base URL', 'err');
    appendMessage('error', '请先填写 Base URL');
    return;
  }
  if (!cfg.apiKey) {
    setStatus($('chatStatus'), '请先填写 API Key', 'err');
    appendMessage('error', '请先填写 API Key');
    return;
  }
  if (!model) {
    setStatus($('chatStatus'), '请选择或填写模型', 'err');
    appendMessage('error', '请先选择模型（右侧列表点击，或手动填写）');
    return;
  }
  if (!message) {
    setStatus($('chatStatus'), '请输入要发送的问题', 'err');
    return;
  }

  // push user message into conversation
  appendMessage('user', message);
  $('chatMessage').value = '';
  persistConfig();

  // history for API: only user/assistant roles
  const history = state.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  state.sending = true;
  $('btnChat').disabled = true;
  $('btnChat').textContent = '发送中…';
  setStatus($('chatStatus'), '正在请求模型…', 'busy');
  log(`对话发送 format=${format} model=${model} chars=${message.length}`);

  try {
    if (!apiProbe || typeof apiProbe.chatTest !== 'function') {
      throw new Error('apiProbe.chatTest 不可用（preload 未注入）');
    }

    const result = await apiProbe.chatTest({
      ...cfg,
      model,
      message,
      history,
      format,
      effectiveBaseUrl: probe.effectiveBaseUrl || cfg.baseUrl,
      authStyle: probe.authStyle || 'bearer',
      lastSuccessFormat: state.lastSuccessFormat,
      timeoutMs: Math.max(cfg.timeoutMs || 0, 60000),
    });

    if (result.success) {
      state.lastSuccessFormat = result.format;
      if ($('chatFormat').value === 'auto') {
        // keep auto, but remember
      } else if (!format || format === 'auto') {
        // noop
      }
      setStatus(
        $('chatStatus'),
        `成功 · ${result.format} · ${result.latencyMs}ms`,
        'ok'
      );
      appendMessage(
        'assistant',
        result.reply || '(空回复)',
        `${result.format} · ${result.latencyMs}ms · ${result.url}`
      );
      $('chatDetails').textContent = result.raw || '';
      log(`对话成功：${result.format} @ ${result.url} (${result.latencyMs}ms)`, 'ok');
    } else {
      setStatus($('chatStatus'), result.error || '对话失败', 'err');
      const detail = (result.attempts || [])
        .slice(0, 12)
        .map((a) => `- [${a.format}] ${a.status || 0} ${a.url}\n  ${a.error || ''}`)
        .join('\n');
      appendMessage('error', `${result.error || '对话失败'}\n\n${detail}`);
      $('chatDetails').textContent = detail;
      log(result.error || '对话失败', 'error');
      (result.attempts || []).slice(0, 8).forEach((a) => {
        log(`[${a.format}] ${a.url} => ${a.error || a.status}`, 'error');
      });
    }
  } catch (err) {
    const msg = err?.message || String(err);
    setStatus($('chatStatus'), msg, 'err');
    appendMessage('error', msg);
    $('chatDetails').textContent = msg;
    log(msg, 'error');
  } finally {
    state.sending = false;
    $('btnChat').disabled = false;
    $('btnChat').textContent = '发送';
  }
}

async function onTestProxy() {
  const proxy = resolveProxyForRequest();
  setStatus($('probeStatus'), proxy ? '测试代理中…' : '测试直连中…', 'busy');
  log(proxy ? `测试代理：${proxy}` : '测试直连（无代理）');
  try {
    const res = await apiProbe.testProxy(proxy);
    if (res.ok) {
      setStatus($('probeStatus'), `代理可用：${res.body}`, 'ok');
      log(`代理可用：${res.body}`, 'ok');
    } else {
      setStatus($('probeStatus'), `代理失败：${res.error || res.body || res.status}`, 'err');
      log(`代理失败：${res.error || res.body || res.status}`, 'error');
    }
  } catch (err) {
    setStatus($('probeStatus'), err.message || String(err), 'err');
    log(err.message || String(err), 'error');
  }
}

function loadPersisted() {
  try {
    const raw = localStorage.getItem('api-probe-lab:config');
    if (!raw) return;
    const cfg = JSON.parse(raw);
    if (cfg.baseUrl) $('baseUrl').value = cfg.baseUrl;
    if (cfg.apiKey) $('apiKey').value = cfg.apiKey;
    if (cfg.proxy) $('proxy').value = cfg.proxy;
    if (cfg.timeoutMs) $('timeoutMs').value = cfg.timeoutMs;
    if (cfg.v1Policy) $('v1Policy').value = cfg.v1Policy;
    if (cfg.chatFormat) $('chatFormat').value = cfg.chatFormat;
    if (cfg.chatModel) $('chatModel').value = cfg.chatModel;
    if (typeof cfg.useSystemProxy === 'boolean' && $('useSystemProxy')) {
      $('useSystemProxy').checked = cfg.useSystemProxy;
    }
    if (cfg.proxyManualOverride) state.proxyManualOverride = true;
  } catch (_) {}
}

function persistConfig() {
  try {
    localStorage.setItem(
      'api-probe-lab:config',
      JSON.stringify({
        baseUrl: $('baseUrl').value,
        apiKey: $('apiKey').value,
        proxy: $('proxy').value,
        timeoutMs: $('timeoutMs').value,
        v1Policy: $('v1Policy').value,
        chatFormat: $('chatFormat').value,
        chatModel: $('chatModel').value,
        useSystemProxy: $('useSystemProxy') ? $('useSystemProxy').checked : true,
        proxyManualOverride: state.proxyManualOverride,
      })
    );
  } catch (_) {}
}

function wire() {
  if (typeof apiProbe === 'undefined') {
    document.body.innerHTML = '<div style="padding:40px;color:#fff;font-family:sans-serif">preload 失败：apiProbe 未注入。请用 npm start 或打包后的应用启动，不要直接打开 html。</div>';
    return;
  }

  if (apiProbe.platform === 'win32') document.body.classList.add('win');
  $('platformPill').textContent = apiProbe.platform || 'desktop';

  $('btnExtract').addEventListener('click', onExtract);
  $('btnExtractAndProbe').addEventListener('click', async () => {
    await onExtract();
    await onProbe();
  });
  $('btnProbe').addEventListener('click', onProbe);
  $('btnChat').addEventListener('click', (e) => {
    e.preventDefault();
    onChat();
  });
  $('btnTestProxy').addEventListener('click', onTestProxy);
  const btnDetect = $('btnDetectProxy');
  if (btnDetect) {
    btnDetect.addEventListener('click', async () => {
      state.proxyManualOverride = false;
      await loadSystemProxy({ force: true });
      persistConfig();
    });
  }
  const proxyInput = $('proxy');
  if (proxyInput) {
    proxyInput.addEventListener('input', () => {
      state.proxyManualOverride = true;
      const badge = $('proxyBadge');
      if (badge && proxyInput.value.trim() && state.systemProxy?.proxy && proxyInput.value.trim() !== state.systemProxy.proxy) {
        badge.textContent = '手动代理';
        badge.classList.remove('hide');
      }
    });
  }
  const useSys = $('useSystemProxy');
  if (useSys) {
    useSys.addEventListener('change', async () => {
      if (useSys.checked) {
        state.proxyManualOverride = false;
        await loadSystemProxy({ force: false });
      } else {
        const badge = $('proxyBadge');
        if (badge) {
          badge.textContent = '手动/直连';
          badge.classList.remove('hide');
        }
      }
      persistConfig();
    });
  }

  $('btnClearPaste').addEventListener('click', () => {
    $('rawInput').value = '';
    renderNotes([]);
  });
  $('btnClearChat').addEventListener('click', () => {
    state.messages = [];
    renderChat();
    setStatus($('chatStatus'), '');
    $('chatDetails').textContent = '';
  });
  $('btnToggleDetails').addEventListener('click', () => {
    state.showDetails = !state.showDetails;
    $('chatDetails').classList.toggle('show', state.showDetails);
  });
  $('btnClearLog').addEventListener('click', () => {
    $('logBox').textContent = '';
  });
  $('btnToggleKey').addEventListener('click', () => {
    state.keyVisible = !state.keyVisible;
    $('apiKey').type = state.keyVisible ? 'text' : 'password';
    $('btnToggleKey').textContent = state.keyVisible ? '隐藏' : '显示';
  });
  $('modelFilter').addEventListener('input', () => renderModels(state.models));
  $('btnCopyModels').addEventListener('click', async () => {
    if (!state.models.length) return;
    await apiProbe.clipboardWrite(state.models.join('\n'));
    log(`已复制 ${state.models.length} 个模型到剪贴板`, 'ok');
  });
  $('btnCopyConfig').addEventListener('click', async () => {
    const cfg = currentConfig();
    const payload = {
      base_url: state.probeResult?.effectiveBaseUrl || cfg.baseUrl,
      api_key: cfg.apiKey,
      models: state.models,
      auth_style: state.probeResult?.authStyle || 'bearer',
      proxy: cfg.proxy || undefined,
    };
    await apiProbe.clipboardWrite(JSON.stringify(payload, null, 2));
    log('已复制配置 JSON', 'ok');
  });

  $('rawInput').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      $('btnExtractAndProbe').click();
    }
  });

  // Enter to send chat, Shift+Enter newline
  $('chatMessage').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onChat();
    }
  });

  loadPersisted();
  loadSystemProxy({ force: false }).then(() => persistConfig());
  ['baseUrl', 'apiKey', 'proxy', 'timeoutMs', 'v1Policy', 'chatFormat', 'chatModel'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('change', persistConfig);
    el.addEventListener('input', persistConfig);
  });

  renderChat();
  log('API Probe Lab 已就绪 · 系统代理自动读取 · Enter 发送对话');
}

document.addEventListener('DOMContentLoaded', wire);
