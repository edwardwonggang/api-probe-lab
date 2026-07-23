const { execFileSync } = require('child_process');

function normalizeProxy(proxy) {
  const p = String(proxy || '').trim();
  if (!p) return '';
  if (/^(https?|socks5?h?):\/\//i.test(p)) return p;
  if (/^[\w.-]+:\d+$/.test(p)) return `http://${p}`;
  if (/^[^@\s]+@[\w.-]+:\d+$/.test(p)) return `http://${p}`;
  return p;
}

function fromEnv() {
  const keys = [
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
    'ALL_PROXY',
    'all_proxy',
  ];
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim()) {
      return {
        proxy: normalizeProxy(String(v).trim()),
        source: `env:${k}`,
        raw: String(v).trim(),
      };
    }
  }
  return null;
}

function parseScutilProxy(text) {
  const get = (key) => {
    const re = new RegExp(`${key}\\s*:\\s*(.+)`, 'i');
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };
  const httpEnable = get('HTTPEnable') === '1';
  const httpsEnable = get('HTTPSEnable') === '1';
  const socksEnable = get('SOCKSEnable') === '1';

  if (httpsEnable) {
    const host = get('HTTPSProxy');
    const port = get('HTTPSPort');
    if (host && port) {
      return { proxy: normalizeProxy(`http://${host}:${port}`), source: 'system:https', raw: `${host}:${port}` };
    }
  }
  if (httpEnable) {
    const host = get('HTTPProxy');
    const port = get('HTTPPort');
    if (host && port) {
      return { proxy: normalizeProxy(`http://${host}:${port}`), source: 'system:http', raw: `${host}:${port}` };
    }
  }
  if (socksEnable) {
    const host = get('SOCKSProxy');
    const port = get('SOCKSPort');
    if (host && port) {
      return { proxy: normalizeProxy(`socks5://${host}:${port}`), source: 'system:socks', raw: `${host}:${port}` };
    }
  }

  const pacEnable = get('ProxyAutoConfigEnable') === '1';
  const pacUrl = get('ProxyAutoConfigURLString');
  if (pacEnable && pacUrl) {
    return {
      proxy: '',
      source: 'system:pac',
      raw: pacUrl,
      note: '检测到 PAC 自动代理，无法直接解析为固定地址，请手动填写或开启系统 HTTP/SOCKS 代理',
    };
  }
  return null;
}

function detectMacSystemProxy() {
  try {
    const out = execFileSync('scutil', ['--proxy'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseScutilProxy(out);
  } catch {
    return null;
  }
}

function detectWindowsSystemProxy() {
  try {
    const ps = `
$ErrorActionPreference='Stop';
$path='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
$en=(Get-ItemProperty -Path $path -Name ProxyEnable -ErrorAction SilentlyContinue).ProxyEnable;
$server=(Get-ItemProperty -Path $path -Name ProxyServer -ErrorAction SilentlyContinue).ProxyServer;
$auto=(Get-ItemProperty -Path $path -Name AutoConfigURL -ErrorAction SilentlyContinue).AutoConfigURL;
Write-Output ("ENABLE=" + [int]($en -eq 1));
Write-Output ("SERVER=" + $server);
Write-Output ("PAC=" + $auto);
`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const enable = /ENABLE=1/.test(out);
    const server = (out.match(/SERVER=(.*)/) || [])[1]?.trim() || '';
    const pac = (out.match(/PAC=(.*)/) || [])[1]?.trim() || '';
    if (enable && server) {
      let chosen = server;
      if (server.includes('=')) {
        const parts = Object.fromEntries(
          server.split(';').map((p) => {
            const [k, v] = p.split('=');
            return [String(k || '').toLowerCase(), v];
          })
        );
        chosen = parts.https || parts.http || parts.socks || Object.values(parts)[0] || server;
      }
      let proxy = chosen;
      if (!/^https?:\/\//i.test(proxy) && !/^socks/i.test(proxy)) {
        proxy = `http://${proxy}`;
      }
      return { proxy: normalizeProxy(proxy), source: 'system:win-registry', raw: server };
    }
    if (pac) {
      return {
        proxy: '',
        source: 'system:pac',
        raw: pac,
        note: '检测到 Windows PAC 自动代理，请手动填写固定代理地址',
      };
    }
  } catch {
    // ignore
  }
  return null;
}

function detectSystemProxy() {
  const envHit = fromEnv();
  if (envHit) {
    return {
      ...envHit,
      enabled: true,
      note: '',
    };
  }

  let sys = null;
  if (process.platform === 'darwin') sys = detectMacSystemProxy();
  else if (process.platform === 'win32') sys = detectWindowsSystemProxy();

  if (sys) {
    return {
      proxy: sys.proxy || '',
      source: sys.source,
      raw: sys.raw || '',
      note: sys.note || '',
      enabled: !!sys.proxy,
    };
  }

  return {
    proxy: '',
    source: 'none',
    raw: '',
    note: '未检测到系统代理',
    enabled: false,
  };
}

module.exports = {
  detectSystemProxy,
  parseScutilProxy,
  fromEnv,
  normalizeProxy,
};
