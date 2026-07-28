/* global apiProbe */

const state = {
  models: [],
  selectedModel: '',
  probeResult: null,
  keyVisible: false,
  messages: [], // {role, content}
  lastSuccessFormat: null,
  protocolInfo: null,
  sending: false,
  activeRequestId: null, // 当前流式请求 id，用于中途停止
  stopping: false, // 用户是否已主动请求停止本次对话
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
  let result;
  try {
    result = await apiProbe.extractCredentials(raw);
  } catch (err) {
    log(`❌ 提取失败：${err.message || err}`);
    console.error('extract error:', err);
    return;
  }
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

const FORMAT_LABELS = {
  auto: '自动探测',
  chat_completions: 'Chat Completions',
  responses: 'Responses',
  messages: 'Messages',
  models: 'Models List',
};

function formatLabel(format) {
  return FORMAT_LABELS[format] || format || '未知';
}

function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text == null || text === '' ? '-' : String(text);
}

function compactAttempts(attempts = []) {
  return attempts.slice(0, 20).map((a) => ({
    ok: !!a.ok,
    status: a.status,
    format: a.format,
    method: a.method || (a.path ? 'GET' : undefined),
    url: a.url,
    authStyle: a.authStyle,
    bodyKeys: a.bodyKeys,
    error: a.error,
    bodyPreview: a.bodyPreview,
    latencyMs: a.latencyMs,
  }));
}

function oneLinePreview(text, limit = 160) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function renderWireInfo(info, opts = {}) {
  const card = $('wireCard');
  if (!card) return;
  const isError = opts.kind === 'error';
  const isConfirmed = !!info && info.format && info.format !== 'models';
  card.classList.toggle('confirmed', isConfirmed);
  card.classList.toggle('error', isError);

  if (info) state.protocolInfo = info;
  if (!info && opts.reset) state.protocolInfo = null;

  const current = info || state.protocolInfo;
  const emptyText = opts.status || '尚未确认真实对话格式';
  if (!current) {
    setText('wireFormat', '待确认');
    setText('wireMethod', '-');
    setText('wireAuth', '-');
    setText('wireStream', '-');
    setText('wireUrl', '-');
    setText('wireBody', '-');
    setText('wireStatus', emptyText);
    return;
  }

  const bodyKeys = Array.isArray(current.bodyKeys) ? current.bodyKeys : [];
  setText('wireFormat', current.format === 'models' ? 'GET /models' : formatLabel(current.format));
  setText('wireMethod', current.method || 'POST');
  setText('wireAuth', current.authStyle || '-');
  setText('wireStream', current.stream === true ? 'true' : current.stream === false ? 'false' : '-');
  setText('wireUrl', current.url || '-');
  setText('wireBody', bodyKeys.length ? bodyKeys.join(', ') : '无');
  setText(
    'wireStatus',
    opts.status ||
      (current.format === 'models'
        ? '模型列表访问已确认；对话格式等待真实请求确认'
        : `最近成功：${formatLabel(current.format)}${current.latencyMs ? ` · ${current.latencyMs}ms` : ''}`)
  );
}

function setDetails(payload) {
  const box = $('chatDetails');
  if (!box) return;
  box.textContent = payload ? JSON.stringify(payload, null, 2) : '';
}

function renderModels(models, opts = {}) {
  const maxDisplay = opts.maxDisplay || 50;
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

  const shown = filtered.slice(0, maxDisplay);
  const remaining = filtered.length - shown.length;
  list.innerHTML = '';
  for (const model of shown) {
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
  if (remaining > 0) {
    const more = document.createElement('div');
    more.className = 'empty';
    more.textContent = `还有 ${remaining} 个模型（请在上方过滤框中搜索）`;
    list.appendChild(more);
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
  renderWireInfo(null, { reset: true, status: '正在探测模型列表端点…' });
  log(`开始探测：${cfg.baseUrl}`);

  try {
    const result = await apiProbe.probeEndpoint(cfg);
    state.probeResult = result;
    if (result.success) {
      const models = result.models || [];
      renderModels(models);
      state.selectedModel = models[0] || '';
      $('chatModel').value = models[0] || 'none';
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
      renderWireInfo(
        {
          format: 'models',
          method: 'GET',
          url: result.modelsUrl,
          authStyle: result.authStyle,
          bodyKeys: [],
          latencyMs: result.latencyMs,
        },
        { status: '模型列表访问已确认；对话格式等待真实请求确认' }
      );
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
      state.selectedModel = '';
      $('chatModel').value = 'none';
      $('probeMeta').textContent = '探测失败';
      renderWireInfo(null, {
        kind: 'error',
        reset: true,
        status: result.error || '模型列表未连通；可手动填模型后探测真实对话格式',
      });
      setDetails({ modelProbeAttempts: compactAttempts(result.attempts || []) });
      setStatus($('probeStatus'), result.error || '探测失败', 'err');
      log(result.error || '探测失败', 'error');
      (result.attempts || []).slice(0, 12).forEach((a) => {
        const preview = oneLinePreview(a.bodyPreview);
        log(`${a.url} · ${a.authStyle} · ${a.error || a.status}${preview ? ` · ${preview}` : ''}`, 'error');
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

async function onProbeFormat() {
  const cfg = currentConfig();
  const model = $('chatModel').value.trim();
  const format = $('chatFormat').value;
  const probe = state.probeResult || {};

  if (!cfg.baseUrl) {
    setStatus($('chatStatus'), '请先填写 Base URL', 'err');
    return;
  }
  if (!cfg.apiKey) {
    setStatus($('chatStatus'), '请先填写 API Key', 'err');
    return;
  }
  if (!model || model === 'none') {
    setStatus($('chatStatus'), '请先填写模型名', 'err');
    return;
  }

  const btn = $('btnProbeFormat');
  if (btn) btn.disabled = true;
  setStatus($('chatStatus'), '正在探测真实对话格式…', 'busy');
  renderWireInfo(state.protocolInfo, { status: '正在等待真实成功端点…' });
  log(`开始探测真实格式：format=${format} model=${model}`);

  try {
    const result = await apiProbe.chatTest({
      ...cfg,
      model,
      message: 'ping',
      history: [{ role: 'user', content: 'ping' }],
      format,
      effectiveBaseUrl: probe.effectiveBaseUrl || cfg.baseUrl,
      authStyle: probe.authStyle || 'bearer',
      lastSuccessFormat: state.lastSuccessFormat,
      timeoutMs: Math.max(cfg.timeoutMs || 0, 20000),
      maxTokens: 8,
      temperature: 0,
    });

    if (result.success) {
      const protocol = result.protocol || {
        format: result.format,
        method: 'POST',
        url: result.url,
        latencyMs: result.latencyMs,
      };
      state.lastSuccessFormat = protocol.format || result.format || state.lastSuccessFormat;
      renderWireInfo(protocol, { status: `格式探测成功 · ${formatLabel(protocol.format)} · ${result.latencyMs}ms` });
      setStatus($('chatStatus'), `格式：${formatLabel(protocol.format)} · ${result.latencyMs}ms`, 'ok');
      setDetails({
        protocol,
        replyPreview: (result.reply || '').slice(0, 500),
        attempts: compactAttempts(result.attempts || []),
      });
      log(`真实格式确认：${protocol.endpoint || `${protocol.method || 'POST'} ${protocol.url}`} · ${formatLabel(protocol.format)}`, 'ok');
    } else {
      renderWireInfo(null, {
        kind: 'error',
        reset: true,
        status: '真实对话格式探测失败',
      });
      setDetails({ chatProbeAttempts: compactAttempts(result.attempts || []) });
      setStatus($('chatStatus'), result.error || '格式探测失败', 'err');
      log(result.error || '格式探测失败', 'error');
    }
  } catch (err) {
    renderWireInfo(null, { kind: 'error', reset: true, status: '真实对话格式探测异常' });
    setStatus($('chatStatus'), err.message || String(err), 'err');
    log(err.message || String(err), 'error');
  } finally {
    if (btn) btn.disabled = false;
    persistConfig();
  }
}

function stopStream() {
  if (!state.sending || !state.activeRequestId) return;
  state.stopping = true;
  try { apiProbe.streamChatStop && apiProbe.streamChatStop(state.activeRequestId); } catch (_) {}
  log('已请求停止当前对话流');
  setStatus($('chatStatus'), '正在停止…', 'busy');
}

async function onChat() {
  if (state.sending) {
    // 正在发送时点击 = 停止
    stopStream();
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
  if (!model || model === 'none') {
    setStatus($('chatStatus'), '请先在右侧选择一个模型', 'err');
    appendMessage('error', '请先探测模型列表，再选择模型，或手动填写型号');
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
  state.stopping = false;
  state.activeRequestId = null;
  $('btnChat').disabled = false;
  $('btnChat').textContent = '停止';
  $('btnChat').classList.add('stop');
  if ($('btnProbeFormat')) $('btnProbeFormat').disabled = true;
  setStatus($('chatStatus'), '正在请求模型…', 'busy');
  renderWireInfo(state.protocolInfo, { status: '正在请求模型，成功后刷新真实访问格式…' });
  log(`对话发送 format=${format} model=${model} chars=${message.length}`);

  // create placeholder assistant message
  appendMessage('assistant', '▊', '流式输出…');
  const startTime = Date.now();

  try {
    if (!apiProbe || typeof apiProbe.streamChatStart !== 'function') {
      throw new Error('streamChatStart 不可用（preload 未注入）');
    }

    const payload = {
      ...cfg,
      model,
      message,
      history,
      format,
      effectiveBaseUrl: probe.effectiveBaseUrl || cfg.baseUrl,
      authStyle: probe.authStyle || 'bearer',
      lastSuccessFormat: state.lastSuccessFormat,
      timeoutMs: Math.max(cfg.timeoutMs || 0, 60000),
    };

    const requestId = apiProbe.streamChatStart(payload);
    state.activeRequestId = requestId;
    let fullContent = '';

    const chunkHandler = ({ requestId: rid, text }) => {
      if (rid !== requestId) return;
      fullContent = text;
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === 'assistant') {
        last.content = text + '▊';
        renderChat();
      }
    };

    const doneHandler = ({ requestId: rid, text, protocol }) => {
      if (rid !== requestId) return;
      cleanup();
      if (text) fullContent = text;
      const wasStopped = state.stopping;
      const latency = Date.now() - startTime;
      const protocolLabel = protocol?.format ? formatLabel(protocol.format) : '';
      if (protocol) {
        state.lastSuccessFormat = protocol.format || state.lastSuccessFormat;
        renderWireInfo(protocol, {
          status: `${wasStopped ? '停止前已确认' : '最近对话成功'} · ${protocolLabel} · ${protocol.latencyMs || latency}ms`,
        });
        setDetails({ protocol });
      }
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === 'assistant') {
        const noContent = last.content === '▊';
        if (noContent && !fullContent) {
          state.messages.pop();
        } else {
          last.content = fullContent || (noContent ? '(已停止，无内容)' : '(已停止)');
          last.meta = wasStopped
            ? `已停止 · ${protocolLabel || 'stream'} · ${latency}ms`
            : `${protocolLabel || '完成'} · ${latency}ms`;
        }
        renderChat();
      }
      setStatus(
        $('chatStatus'),
        wasStopped ? '已停止' : `成功 · ${protocolLabel || 'stream'} · ${latency}ms`,
        wasStopped ? 'busy' : 'ok'
      );
      log(
        protocol
          ? `对话完成：${protocol.endpoint || `${protocol.method || 'POST'} ${protocol.url}`} · ${protocolLabel} (${latency}ms)`
          : (wasStopped ? `对话已停止 (${latency}ms)` : `对话完成 (${latency}ms)`),
        wasStopped ? 'info' : 'ok'
      );
      finalize();
    };

    const errorHandler = ({ requestId: rid, error }) => {
      if (rid !== requestId) return;
      cleanup();
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === 'assistant' && last.content === '▊') {
        // only remove placeholder if no content was streamed
        state.messages.pop();
      }
      setStatus($('chatStatus'), error || '对话失败', 'err');
      appendMessage('error', error || '对话失败');
      log(error || '对话失败', 'error');
      finalize();
    };

    apiProbe.streamChatOnChunk(chunkHandler);
    apiProbe.streamChatOnDone(doneHandler);
    apiProbe.streamChatOnError(errorHandler);

    function cleanup() {
      apiProbe.streamChatOff();
    }

    function finalize() {
      state.sending = false;
      state.activeRequestId = null;
      state.stopping = false;
      $('btnChat').disabled = false;
      $('btnChat').textContent = '发送';
      $('btnChat').classList.remove('stop');
      if ($('btnProbeFormat')) $('btnProbeFormat').disabled = false;
    }
  } catch (err) {
    const msg = err?.message || String(err);
    const last = state.messages[state.messages.length - 1];
    if (last && last.role === 'assistant' && last.content === '▊') {
      state.messages.pop();
    }
    setStatus($('chatStatus'), msg, 'err');
    appendMessage('error', msg);
    log(msg, 'error');
    state.sending = false;
    state.activeRequestId = null;
    state.stopping = false;
    $('btnChat').disabled = false;
    $('btnChat').textContent = '发送';
    $('btnChat').classList.remove('stop');
    if ($('btnProbeFormat')) $('btnProbeFormat').disabled = false;
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
    document.body.innerHTML = '<div style="padding:40px;color:var(--text);font-family:sans-serif;max-width:640px;margin:60px auto;line-height:1.6">preload 失败：apiProbe 未注入。请用 npm start 或打包后的应用启动，不要直接打开 html。</div>';
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
  $('btnProbeFormat').addEventListener('click', onProbeFormat);
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
      last_success_format: state.lastSuccessFormat || undefined,
      wire_protocol: state.protocolInfo || undefined,
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
  renderWireInfo(null, { reset: true });
  log('API Probe Lab 已就绪 · 系统代理自动读取 · Enter 发送对话');
}

document.addEventListener('DOMContentLoaded', wire);
