"""迅雷云盘的"浏览器内执行器" —— 子进程入口（都需要 pywebview）

## 为什么要有这个文件

迅雷分享接口对**每个**请求都要求带 `captcha_token`，而它要 `captcha_sign`（设备签名）
才会被接受。旧签名算法（Gopeed 扩展里那套 14 轮盐值 MD5）已经失效，实测服务端直接回：

    {"error":"captcha_invalid","error_code":9,
     "error_details":[{"detail":"no client info found"}]}

网页版自己却能正常调 —— 它在 localStorage 里存着算好的 `captcha_token`。所以这里不逆向
签名，而是**借网页自己的手**：加载分享页 → 在同源上下文里 `fetch` 同样的接口 →
captcha 由页面自己算好。这条路实测 200 OK。

## 为什么必须是独立进程

pywebview 的 `webview.start()` 会接管**主线程**的消息循环。tkinter 也在主线程上跑
`mainloop()`，两者放一起必然互相卡死。所以本文件单独成进程：父进程（`xunlei.py`）
用 `subprocess` 调起，结果走 `-o <json>` 文件 —— 比解析 stdout 稳（pythonw 下
stdout 不一定可用）。

## 四种模式

| 模式 | 窗口 | 干什么 |
| --- | --- | --- |
| `resolve` | 隐藏 | 打开分享页 → 递归列目录 → 逐个取直链（免登录） |
| `restore` | 隐藏 | 转存到自己云盘 → 轮询任务 → 取直链 → 清理（需要登录） |
| `login` | **可见** | 打开迅雷网盘官方页，等用户扫码，成功后写登录标记 |
| `status` | 隐藏 | 读 localStorage，报告"有没有登录态" |

只依赖标准库 + `pywebview`（复用系统 WebView2，不下载浏览器）。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

# 不在程序目录里写 __pycache__：这个目录会跟着安装包一起分发
sys.dont_write_bytecode = True

# 迅雷网页版的 client_id。captcha / 登录态 / 设备 id 在 localStorage 里都按它分键名
CLIENT_ID = "Xqp0kJBXWhwaTpB6"
API_BASE = "https://api-pan.xunlei.com/drive/v1"
PAN_URL = "https://pan.xunlei.com/"
# 统一登录服务。续期端点是 **`/v1/auth/token`**（实测 2026-10）：
#   `POST /v1/auth/token {"client_id","grant_type":"refresh_token","refresh_token"}`
#   → `{"access_token","refresh_token","expires_in",...}`
# 注意：旧「迅雷下载器」里写的是 `/v1/auth/refresh`，那条路径现在返回
# `404 {"error":"not_found"}` —— 换端点时别照抄老代码，实测过再写。
AUTH_BASE = "https://xluser-ssl.xunlei.com/v1"
AUTH_REFRESH_PATH = "/auth/token"

# 直链下载用的 UA（这里只用来发续期请求，和网页身份保持一致）
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

DEFAULT_SETTLE = 4.0        # 页面脚本要先跑一会儿才能算出 captcha
POLL_INTERVAL = 0.4         # 轮询 window.__XL_* 的间隔
LOGIN_POLL = 1.5            # 登录窗口轮询 storage 的间隔
# 整棵树最多往下翻多少层（注入进 JS_RESOLVE 的 `__MAX_DEPTH__`）。
# 本文件是**独立子进程**，不能 import 同包的 xunlei.py，所以这里再写一份；
# tools/smoke_xunlei.py 会断言它和 xunlei.MAX_TREE_DEPTH 相等（防止两边跑偏）。
MAX_TREE_DEPTH = 24
# 离过期还有这么久就先续一次。refresh_token 可能是轮换的（用一次换一个），
# 所以只在**确实快过期**时才动它；过期时间未知时压根不续，等 401 再说。
REFRESH_MARGIN = 600.0
CACHE_DIRS = ("Cache", "Code Cache", "GPUCache", "DawnCache", "ShaderCache", "GraphiteDawnCache")


# ---------------------------------------------------------------------------
# 过期时间：数字 / 数字字符串 / ISO 8601 都要认
# ---------------------------------------------------------------------------
# 本文件是**独立子进程**（`python bridge_worker.py`），不能 import 同包的 core，
# 所以这里再写一份 `netdisk/core.py::epoch_seconds` 的等价实现；
# `tools/smoke_xunlei.py` 会断言两边对同一批输入给出相同结果（防止跑偏）。
def to_epoch(value: object) -> float:
    """把各种形状的"过期时间"换成 epoch 秒；认不出来返回 0（= 不知道）。

    真实故障：迅雷网页版 localStorage 里存的是 `2026-10-31T19:15:39.367Z`，
    以前这里 `float()` 直接抛
        ValueError: could not convert string to float: '2026-10-31T19:15:39.367Z'
    它发生在"转存前先判断要不要续期"，于是整单转存被判死，
    界面报的是"部分文件没能开始下载"—— 看起来跟时间毫无关系。
    """
    if value is None or isinstance(value, bool):
        return 0.0
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value).strip()
        if not text:
            return 0.0
        try:
            number = float(text)
        except ValueError:
            return _iso_epoch(text)
    if number <= 0:
        return 0.0
    if number > 1e12:                   # 毫秒时间戳
        number /= 1000.0
    return number


def _iso_epoch(text: str) -> float:
    raw = text.strip()
    if raw[-1:] in ("Z", "z"):          # Python 3.10 的 fromisoformat 还不认 Z
        raw = raw[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(raw)
    except ValueError:
        return 0.0
    if moment.tzinfo is None:           # 没写时区：网盘接口一律是 UTC
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.timestamp()


def _iso_text(epoch: float) -> str:
    """写回页面时用页面自己的风格（`2026-10-31T19:15:39.367Z`）。"""
    moment = datetime.fromtimestamp(epoch, timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def _is_iso_style(value: object) -> bool:
    """页面里原本存的是 ISO 字符串还是数字 —— 写回时跟着用同一种。"""
    return isinstance(value, str) and "-" in value


# ---------------------------------------------------------------------------
# 存储目录（登录态就在这里面，必须跨次、跨进程复用）
# ---------------------------------------------------------------------------
def prepare_storage(storage: Path, legacy: Path | None, legacy_login: Path | None, marker: Path | None) -> None:
    """建好 WebView 的 user-data-dir；顺手从旧的「迅雷下载器」搬一次登录态。

    为什么要搬：迅雷登录态只存在 WebView2 的 profile 里（localStorage + Cookies），
    换一个 `storage_path` 就等于换了一台"新浏览器"，用户得重新扫码。
    父程序之前那份实现把 profile 放在 `%LOCALAPPDATA%\\XunleiDL\\webview`，
    合并进来之后默认目录变了 —— 这里复制一次，免得白扫一次码。

    搬完之后还要补一个**登录标记**：主程序靠标记判断"已登录"（它不会为了显示状态
    去开一次 WebView）。旧程序有没有登录过，看它自己那份 DPAPI 凭证文件在不在 ——
    在就说明登录过，标记着 `migrated`；真过期了下次转存会明确报出来，标记会被清掉。
    """
    storage.mkdir(parents=True, exist_ok=True)
    copied = False
    if legacy is not None and legacy.is_dir() and storage != legacy and not any(storage.iterdir()):
        try:
            shutil.copytree(
                legacy,
                storage,
                dirs_exist_ok=True,
                ignore=shutil.ignore_patterns(*CACHE_DIRS),
            )
            copied = True
        except Exception:
            pass        # 搬不动就算了，大不了重扫一次码

    if copied and marker is not None and not marker.exists():
        if legacy_login is not None and legacy_login.is_file():
            try:
                marker.parent.mkdir(parents=True, exist_ok=True)
                marker.write_text(json.dumps({
                    "user_id": "",
                    "migrated": True,
                    "saved_at": time.time(),
                }, ensure_ascii=False, indent=2), "utf-8")
            except Exception:
                pass


def write_marker(marker: Path | None, data: dict) -> None:
    if marker is None:
        return
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    except Exception:
        pass


def sync_marker(marker: Path | None, mode: str, data: dict) -> None:
    """按登录/检查的结果同步本地标记。

    主程序不会为了显示状态去开 WebView，它只认这个标记 —— 所以标记必须跟着
    真实结果走：登录成功/检查确认有效 → 写（合并，别把 user_id 冲掉）；
    **检查发现没登录 → 删**。不删的话界面会一直说"已登录"，直到用户点了下载才被服务端打脸。

    只认 login / status 两个模式。续期（refresh）不同步：它失败可能只是这次没续上，
    拿它去删标记 = "点一下刷新，结果变成未登录"。
    """
    if marker is None or mode not in ("login", "status") or data.get("state") != "done":
        return
    if data.get("logged_in", True) is False:
        try:
            marker.unlink(missing_ok=True)
        except OSError:
            pass
        return
    _merge_marker(
        marker,
        user_id=data.get("user_id") or "",
        nickname=data.get("nickname") or "",
        expires_at=data.get("expires_at") or 0,
    )


def write_json(path: Path | None, data: dict) -> None:
    text = json.dumps(data, ensure_ascii=False)
    if path is None:
        print(text)
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, "utf-8")
    except Exception:
        print(text)


def humanize_error(err: str) -> str:
    """把页面里抛上来的错误翻成人话。

    页面里的 `fetch` 失败时抛的是 `HTTP 400 {"error":"invalid_argument",...}` ——
    一整段 JSON 直接甩给用户等于没说。这里挑几种常见的说清楚该怎么改，
    剩下的至少把 `error_description` / `detail` 摘出来。
    """
    text = (err or "").strip()
    low = text.lower()
    if "captcha" in low:
        return (
            "页面没能拿到 captcha（可能被风控，或者登录态不完整）。"
            "先「设置 → 迅雷 → 扫码登录」，再试一次"
        )
    if "share_id can not be empty" in low or "share_id invalid" in low:
        return "分享链接不对：迅雷说 share_id 无效（链接可能抄漏了字符，或分享已被删除）"
    if "pass_code" in low:
        return "提取码不对或缺失：把链接里那 4 位提取码一起粘进来（或填进「提取码」框）"
    if "share_not_found" in low or "not_exist" in low or "不存在" in text:
        return "分享不存在或已被删除"
    if "not_logged_in" in low:
        return "这个操作需要登录迅雷：设置 → 迅雷 → 扫码登录"

    m = re.search(r'"error_description"\s*:\s*"([^"]{1,80})"', text)
    if not m:
        m = re.search(r'"detail"\s*:\s*"([^"]{1,80})"', text)
    if m:
        return f"迅雷拒绝了请求：{m.group(1)}（原始信息：{text[:120]}）"
    return text[:300]


def humanize_error_in(data: dict) -> dict:
    if data.get("state") == "error" and data.get("error"):
        data = dict(data)
        data["error"] = humanize_error(str(data["error"]))
    return data


# ---------------------------------------------------------------------------
# 注入到页面里的脚本
#
# 占位符用 `__名字__` + str.replace，不用 `%` 格式化：JS 里到处都是 `%`
# （encodeURIComponent、取余、CSS 字符串），一不小心就是 ValueError。
# ---------------------------------------------------------------------------
JS_RESOLVE = r"""
(function () {
  var SHARE_ID = __SHARE_ID__;
  var PASS_CODE = __PASS_CODE__;
  var CLIENT = '__CLIENT_ID__';
  var BASE = '__API_BASE__';
  // 目录最多往下翻多少层（与 netdisk/xunlei.py 的 MAX_TREE_DEPTH 保持一致，
  // 由渲染时注入）。原来写死 6 —— 第 7 层的文件在整棵树里**根本没有节点**，
  // 界面上下不了，报的却是"目录在解析时没有展开"。
  var MAX_DEPTH = __MAX_DEPTH__;
  window.__XL_OUT = {state: 'running', step: 'init'};

  // 页面自己算好的 captcha，以及它自己的设备 id —— 两个都从 localStorage 里取，
  // 这样服务端看到的"客户端信息"和网页完全一致
  function capToken() {
    try {
      var c = JSON.parse(localStorage.getItem('captcha_' + CLIENT) || '{}');
      return c.token || '';
    } catch (e) { return ''; }
  }
  function deviceId() { return localStorage.getItem('deviceid') || ''; }
  function headers() {
    return {
      'x-client-id': CLIENT,
      'x-device-id': deviceId(),
      'accept': 'application/json, text/plain, */*'
    };
  }
  function qs(obj) {
    var p = new URLSearchParams();
    Object.keys(obj).forEach(function (k) {
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') p.set(k, obj[k]);
    });
    var t = capToken();
    if (t) p.set('captcha_token', t);
    return p.toString();
  }
  function get(path, params) {
    return fetch(BASE + path + '?' + qs(params), {headers: headers(), credentials: 'omit'})
      .then(function (r) {
        return r.text().then(function (t) {
          if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 300));
          try { return JSON.parse(t); }
          catch (e) { throw new Error('非 JSON 响应: ' + t.slice(0, 160)); }
        });
      });
  }
  function pickLink(obj) {
    if (!obj) return '';
    var cand = obj.file_info || obj.info || obj;
    return cand.web_content_link || cand.web_content_link_kd || cand.content_link ||
           ((cand.medias && cand.medias[0] && cand.medias[0].link && cand.medias[0].link.url) || '');
  }
  function slim(f) {
    return {
      id: f.id,
      name: f.name,
      kind: f.kind,
      size: parseInt(f.size || '0', 10),
      link: f.web_content_link || '',
      md5: f.md5_checksum || '',
      children: []
    };
  }

  (async function () {
    try {
      window.__XL_OUT = {state: 'running', step: 'root'};
      // 坑一：/share 不接受 parent_id，传了会被静默忽略、永远返回根目录。
      // 子目录只能走 /share/detail。
      var info = await get('/share', {
        share_id: SHARE_ID, pass_code: PASS_CODE, limit: 100,
        space: '', thumbnail_size: 'SIZE_MEDIUM', scene: 'NORMAL'
      });
      var pct = info.pass_code_token || '';
      var root = (info.files || []).map(slim);
      var fileTotal = 0;

      async function listFolder(folderId) {
        var collected = [];
        var pageToken = null;
        for (var page = 0; page < 60; page++) {
          var params = {
            share_id: SHARE_ID, parent_id: folderId,
            pass_code_token: pct, limit: 100,
            space: '', thumbnail_size: 'SIZE_MEDIUM', scene: 'NORMAL'
          };
          if (pageToken) params.page_token = pageToken;
          var sub = await get('/share/detail', params);
          (sub.files || []).forEach(function (c) { collected.push(slim(c)); });
          pageToken = sub.next_page_token;
          if (!pageToken) break;
        }
        return collected;
      }

      async function walk(nodes, parentId, depth) {
        if (depth >= MAX_DEPTH) return;
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          var isFolder = n.kind && n.kind.indexOf('folder') >= 0;
          if (isFolder) {
            window.__XL_OUT = {state: 'running', step: 'dir:' + n.name, found: fileTotal};
            n.children = await listFolder(n.id);
            await walk(n.children, n.id, depth + 1);
          } else {
            fileTotal += 1;
            if (!n.link) {
              window.__XL_OUT = {state: 'running', step: 'link:' + n.name, found: fileTotal};
              try {
                // 小文件在这一步就能拿到直链；大文件返回空，得靠转存（restore）
                var fi = await get('/share/file_info', {
                  share_id: SHARE_ID, file_id: n.id, pass_code: PASS_CODE,
                  pass_code_token: pct, folder_id: parentId || '',
                  space: '', scene: 'NORMAL'
                });
                n.link = pickLink(fi);
              } catch (e) {
                n.link = '';
                n.linkError = String(e).slice(0, 120);
              }
            }
          }
        }
      }

      await walk(root, '', 0);

      window.__XL_OUT = {
        state: 'done',
        title: info.title || '',
        share_status: info.share_status || '',
        pass_code_token: pct,
        files: root,
        user: info.user_info || {}
      };
    } catch (e) {
      window.__XL_OUT = {state: 'error', error: String(e)};
    }
  })();

  return 'started';
})()
"""

JS_RESTORE = r"""
(function () {
  var SHARE_ID = __SHARE_ID__;
  var PASS_CODE = __PASS_CODE__;
  var FILE_IDS = __FILE_IDS__;
  var CLEANUP = __CLEANUP__;
  var CLIENT = '__CLIENT_ID__';
  var BASE = '__API_BASE__';
  window.__XL_R = {state: 'running', step: 'init'};

  function capToken() {
    try { return JSON.parse(localStorage.getItem('captcha_' + CLIENT) || '{}').token || ''; }
    catch (e) { return ''; }
  }
  function deviceId() { return localStorage.getItem('deviceid') || ''; }
  function accessToken() {
    try {
      var c = JSON.parse(localStorage.getItem('credentials_' + CLIENT) || '{}');
      return c.access_token || '';
    } catch (e) { return ''; }
  }
  function headers(withAuth) {
    var h = {
      'x-client-id': CLIENT,
      'x-device-id': deviceId(),
      'accept': 'application/json, text/plain, */*'
    };
    if (withAuth) {
      var t = accessToken();
      if (!t) throw new Error('NOT_LOGGED_IN');
      h['Authorization'] = 'Bearer ' + t;
    }
    return h;
  }
  function qs(obj) {
    var p = new URLSearchParams();
    Object.keys(obj || {}).forEach(function (k) {
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') p.set(k, obj[k]);
    });
    var t = capToken();
    if (t) p.set('captcha_token', t);
    return p.toString();
  }
  function req(method, path, opts) {
    opts = opts || {};
    return fetch(BASE + path + '?' + qs(opts.params), {
      method: method,
      headers: headers(opts.auth !== false),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'omit'
    }).then(function (r) {
      return r.text().then(function (t) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + t.slice(0, 300));
        try { return JSON.parse(t); } catch (e) { return {}; }
      });
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 转存任务把「源文件 id → 云盘新 id」放在 params.trace_file_ids 里，
  // 而且值是 **JSON 字符串**（不是对象）—— 照对象用会拿到 undefined
  function extractMap(d) {
    var cand = (d && d.params && (d.params.trace_file_ids || d.params.restore_file_ids))
            || (d && (d.trace_file_ids || d.restore_file_ids))
            || {};
    if (typeof cand === 'string') { try { cand = JSON.parse(cand); } catch (e) { cand = {}; } }
    var out = {};
    Object.keys(cand || {}).forEach(function (k) {
      var v = cand[k];
      if (Array.isArray(v)) v = v[0];
      else if (v && typeof v === 'object') v = v.file_id || v.id || '';
      if (v) out[k] = String(v);
    });
    if (!Object.keys(out).length && d && d.file_id) out[FILE_IDS[0]] = String(d.file_id);
    return out;
  }
  function taskIdOf(d) { return d.restore_task_id || d.task_id || (typeof d.id === 'string' ? d.id : ''); }
  function taskDone(d) {
    var s = String(d.phase || d.status || d.task_status || '').toUpperCase();
    return s.indexOf('COMPLETE') >= 0 || s.indexOf('SUCCESS') >= 0
        || d.progress === 100 || s === 'OK';
  }
  function taskFailed(d) {
    var s = String(d.phase || d.status || d.task_status || '').toUpperCase();
    return s.indexOf('FAIL') >= 0 || s.indexOf('ERROR') >= 0 || s.indexOf('CANCEL') >= 0;
  }
  function pickLink(d) {
    if (!d) return '';
    var c = d.file_info || d.info || d;
    var direct = c.web_content_link || c.web_content_link_kd || c.content_link;
    if (direct) return direct;
    if (c.links && typeof c.links === 'object') {
      var ks = Object.keys(c.links);
      for (var i = 0; i < ks.length; i++) {
        var v = c.links[ks[i]];
        if (typeof v === 'string' && v) return v;
        if (v && v.url) return v.url;
      }
    }
    if (c.medias && c.medias[0] && c.medias[0].link) return c.medias[0].link.url || '';
    return '';
  }

  (async function () {
    try {
      if (!accessToken()) {
        window.__XL_R = {state: 'error', error: 'NOT_LOGGED_IN'};
        return;
      }
      window.__XL_R = {state: 'running', step: 'share'};
      var info = await req('GET', '/share', {
        params: {share_id: SHARE_ID, pass_code: PASS_CODE, limit: 100, space: '', scene: 'NORMAL'},
        auth: false
      });
      var pct = info.pass_code_token || '';

      window.__XL_R = {state: 'running', step: 'restore'};
      var resp = await req('POST', '/share/restore', {
        body: {
          parent_id: '',
          share_id: SHARE_ID,
          pass_code_token: pct,
          ancestor_ids: [],
          file_ids: FILE_IDS,
          specify_parent_id: true
        },
        auth: true
      });

      var map = extractMap(resp);
      var taskId = taskIdOf(resp);
      for (var i = 0; i < 60 && (!Object.keys(map).length || taskId); i++) {
        if (Object.keys(map).length && !taskId) break;
        if (!taskId) break;
        await sleep(1000);
        var td = await req('GET', '/tasks/' + encodeURIComponent(taskId), {auth: true});
        var m = extractMap(td);
        Object.keys(m).forEach(function (k) { map[k] = m[k]; });
        if (taskFailed(td)) throw new Error('转存任务失败: ' + JSON.stringify(td).slice(0, 200));
        if (taskDone(td) && Object.keys(map).length) break;
        window.__XL_R = {state: 'running', step: 'restore-poll:' + i, map: map};
      }

      if (!Object.keys(map).length) {
        throw new Error('转存没有返回文件 id: ' + JSON.stringify(resp).slice(0, 300));
      }

      window.__XL_R = {state: 'running', step: 'links', map: map};
      var results = [];
      for (var j = 0; j < FILE_IDS.length; j++) {
        var srcId = FILE_IDS[j];
        var newId = map[srcId] || '';
        var item = {source_id: srcId, restored_id: newId, link: '', size: 0, name: ''};
        if (newId) {
          try {
            // 坑二：云盘文件取直链时**不能**带 usage 参数
            // （带了 web_content_link 会变成空串，links 也空掉；不带反而正常）
            var fi = await req('GET', '/files/' + encodeURIComponent(newId),
                               {params: {space: ''}, auth: true});
            item.link = pickLink(fi);
            item.size = parseInt((fi.file_info || fi || {}).size || '0', 10);
            item.name = (fi.file_info || fi || {}).name || '';
          } catch (e) {
            item.error = String(e).slice(0, 160);
          }
        }
        results.push(item);
      }

      if (CLEANUP) {
        var ids = results.map(function (r) { return r.restored_id; }).filter(Boolean);
        if (ids.length) {
          try {
            await req('POST', '/files:batchDelete', {body: {ids: ids, space: ''}, auth: true});
            results.forEach(function (r) { r.deleted = true; });
          } catch (e) { /* 清理失败不该让整单失败 */ }
        }
      }

      window.__XL_R = {state: 'done', results: results, map: map};
    } catch (e) {
      window.__XL_R = {state: 'error', error: String(e)};
    }
  })();
  return 'started';
})()
"""

# 把当前 origin 的所有可读存储 dump 出来（登录态就在里面）
JS_DUMP = r"""
(function () {
  function dump(store) {
    var out = {};
    try {
      for (var i = 0; i < store.length; i++) {
        var k = store.key(i);
        out[k] = store.getItem(k);
      }
    } catch (e) { out.__error = String(e); }
    return out;
  }
  return JSON.stringify({
    href: location.href,
    origin: location.origin,
    local: dump(localStorage),
    session: dump(sessionStorage)
  });
})()
"""

JS_LOGIN_HINT = r"""
(function () {
  if (document.getElementById('__xl_hint')) return 'exists';
  var d = document.createElement('div');
  d.id = '__xl_hint';
  d.textContent = '扫码成功后窗口会自动关闭';
  d.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;' +
    'background:#2E6BE6;color:#fff;font:13px/32px "Microsoft YaHei",sans-serif;' +
    'text-align:center;opacity:.92;pointer-events:none';
  document.documentElement.appendChild(d);
  return 'ok';
})()
"""

# 读出页面里的登录态。access_token 是 JWT，过期时间在 Python 那边解（这边只负责原样带出去）。
JS_READ_CREDS = r"""
(function () {
  try {
    var raw = localStorage.getItem('credentials_' + '__CLIENT_ID__') || '{}';
    var c = JSON.parse(raw);
    return JSON.stringify({
      access_token: c.access_token || c.token || '',
      refresh_token: c.refresh_token || '',
      expires_at: c.expires_at || c.expire_at || 0,
      device_id: localStorage.getItem('deviceid') || ''
    });
  } catch (e) {
    return JSON.stringify({error: String(e)});
  }
})()
"""

# 把续期拿到的新 token 写回页面，**保留对象里其它字段**（站点自己还存了别的东西）。
# 写回之后，后面注入的脚本再读 localStorage 就是新的 —— 不用重开窗口。
JS_WRITE_CREDS = r"""
(function () {
  try {
    var key = 'credentials_' + '__CLIENT_ID__';
    var c = JSON.parse(localStorage.getItem(key) || '{}');
    c.access_token = __ACCESS__;
    if (__REFRESH__) c.refresh_token = __REFRESH__;
    if (__EXPIRES__) c.expires_at = __EXPIRES__;
    localStorage.setItem(key, JSON.stringify(c));
    return 'ok';
  } catch (e) {
    return 'error: ' + String(e);
  }
})()
"""


# ---------------------------------------------------------------------------
# 登录态提取
# ---------------------------------------------------------------------------
def looks_like_jwt(value: object) -> bool:
    return (
        isinstance(value, str)
        and value.count(".") == 2
        and value[:3] == "eyJ"
        and len(value) > 60
    )


def jwt_payload(token: str) -> dict:
    try:
        seg = token.split(".")[1]
        seg += "=" * (-len(seg) % 4)
        payload = json.loads(base64.urlsafe_b64decode(seg))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def walk_strings(node: object, path: str = ""):
    """递归遍历任意 JSON 结构，产出 (路径, 字符串值)。"""
    if isinstance(node, str):
        yield path, node
        stripped = node.strip()
        if stripped.startswith("{") or stripped.startswith("["):
            try:
                yield from walk_strings(json.loads(stripped), path + "[]")
            except Exception:
                pass
    elif isinstance(node, dict):
        for k, v in node.items():
            yield from walk_strings(v, f"{path}.{k}" if path else str(k))
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from walk_strings(v, f"{path}[{i}]")


def extract_login(snapshot_raw: object) -> dict | None:
    """从 storage dump 里找 access_token / device_id / user_id。

    返回 None 表示"还没登录"。这个判断是登录窗口能自动关闭的关键：
    页面上任何一个 JWT 都可能是 access_token，所以用路径打分挑最像的那个
    （access/token 加分，refresh 大幅减分）。
    """
    if not snapshot_raw:
        return None
    try:
        snap = json.loads(snapshot_raw) if isinstance(snapshot_raw, str) else snapshot_raw
    except Exception:
        return None
    if not isinstance(snap, dict):
        return None

    blobs = [snap.get("local") or {}, snap.get("session") or {}]
    candidates: list[tuple[str, str]] = []
    for blob in blobs:
        for path, value in walk_strings(blob):
            if looks_like_jwt(value):
                candidates.append((path, value))
    if not candidates:
        return None

    def score(item: tuple[str, str]) -> int:
        path = item[0].lower()
        s = 0
        if "access" in path:
            s += 100
        if "token" in path:
            s += 50
        if "refresh" in path:
            s -= 200
        if "auth" in path:
            s += 20
        return s

    candidates.sort(key=score, reverse=True)
    access_path, access_token = candidates[0]

    refresh_token = ""
    device_id = ""
    user_id = ""
    nickname = ""
    for blob in blobs:
        for path, value in walk_strings(blob):
            low = path.lower()
            if not isinstance(value, str):
                continue
            if "refresh" in low and "token" in low and len(value) > 10:
                refresh_token = value
            elif "device" in low and "id" in low and 8 <= len(value) <= 128:
                device_id = device_id or value
            elif low.endswith("userid") or low.endswith("user_id") or low == "uid":
                user_id = user_id or value
            elif "nickname" in low or "username" in low:
                nickname = nickname or value

    payload = jwt_payload(access_token)
    user_id = user_id or str(payload.get("sub") or payload.get("uid") or "")
    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "device_id": device_id,
        "user_id": user_id,
        "nickname": nickname,
        "expires_at": to_epoch(payload.get("exp")),
        "found_at": access_path,
        "href": str(snap.get("href") or ""),
    }


# ---------------------------------------------------------------------------
# 登录态续期（refresh_token → 新 access_token）
#
# 为什么值得做：扫码一次只能撑一个 access_token 的有效期，过期后转存就 401，
# 用户得再扫一次。而网页版自己就是拿 refresh_token 静默续期的 —— 同一套东西，
# 我们照做即可，用户感知不到"续期"，只会觉得"登录一直有效"。
#
# 两个刻意的取舍：
# 1. **只在快过期或撞上 401 时才续**。refresh_token 可能是轮换的（用一次换一个），
#    每次下载都续一遍属于白白缩短登录寿命。
# 2. **续期失败不阻断下载**。老 token 有可能其实还能用；真不行，后面会以
#    "登录态已过期"这种能指导用户的错误收场，而不是整单直接崩。
# ---------------------------------------------------------------------------
def needs_refresh(expires_at: float, margin: float = REFRESH_MARGIN, now: float | None = None) -> bool:
    """要不要提前续期。

    `expires_at` 为 0 表示"不知道什么时候过期" —— 这时返回 False：
    宁可等真的 401 再续，也别为了保险把轮换型 refresh_token 白白用掉。
    """
    if not expires_at:
        return False
    return (expires_at - (time.time() if now is None else now)) < margin


def _post_json(url: str, payload: dict, headers: dict, timeout: float) -> dict:
    """发一个 JSON POST（独立成函数，自测里可以整个换掉）。"""
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        # 登录服务的错误也带 JSON（invalid_grant 之类），要把它读出来才能说清原因
        raw = e.read()
        try:
            data = json.loads(raw.decode("utf-8", "replace") or "{}")
        except Exception:
            data = {}
        reason = data.get("error_description") or data.get("error") or f"HTTP {e.code}"
        raise RuntimeError(str(reason)[:160]) from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"连不上登录服务（{e.reason}）") from e
    try:
        data = json.loads(raw.decode("utf-8", "replace") or "{}")
    except Exception:
        data = {}
    return data if isinstance(data, dict) else {}


def humanize_refresh_error(reason: str) -> str:
    """续期失败的原因翻译。原始文案是英文的 google-rpc 风格，直接给用户看没意义。

    实测这个端点的拒绝姿势有好几种（都不是文档里的）：
        invalid_grant / invalidate refresh token illegal base64 data at input byte 28
        invalidate refresh token bad uuid
    对用户来说它们的含义完全一样：这个 refresh_token 不能用了，只能重扫。
    """
    low = (reason or "").lower()
    rejected = (
        "invalid_grant",
        "invalid refresh",
        "invalidate refresh",
        "bad uuid",
        "illegal base64",
        "expired",
        "token expired",
    )
    if any(marker in low for marker in rejected):
        return "refresh_token 已失效（服务端拒绝），只能重新扫码登录"
    if "not_found" in low or "not found" in low or "404" in low:
        return "续期端点不存在（迅雷可能改了接口，这次只能重新扫码）"
    if "device" in low:
        return f"续期被拒：设备信息和登录时不一致（{reason[:80]}）"
    if "grant" in low:
        return f"续期被拒：{reason[:100]}"
    return (reason or "续期失败")[:160]


def refresh_access_token(
    refresh_token: str,
    device_id: str = "",
    *,
    timeout: float = 15.0,
    post=None,
) -> dict:
    """用 refresh_token 换一套新的 token。

    返回 `{"access_token", "refresh_token", "expires_at"}`；失败抛 RuntimeError
    （消息可以直接给用户看）。`post` 只为自测注入 —— 生产走 `_post_json`。
    """
    if not refresh_token:
        raise RuntimeError("没有 refresh_token（只能重新扫码登录）")

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "User-Agent": UA,
        "Referer": PAN_URL,
        "Origin": "https://pan.xunlei.com",
        "x-client-id": CLIENT_ID,
    }
    if device_id:
        # 登录服务会核对设备；本地有这个值就带上，和页面身份保持一致
        headers["x-device-id"] = device_id

    try:
        data = (post or _post_json)(
            f"{AUTH_BASE}{AUTH_REFRESH_PATH}",
            {"client_id": CLIENT_ID, "grant_type": "refresh_token", "refresh_token": refresh_token},
            headers,
            timeout,
        )
    except RuntimeError as e:
        # 服务端拒绝（400 invalid_grant 之类）走这里：翻成人话再抛
        raise RuntimeError(humanize_refresh_error(str(e))) from e

    # 返回形态见过两种：字段在顶层，或者包一层 data/result —— 都吃得下
    for key in ("data", "result"):
        nested = data.get(key)
        if isinstance(nested, dict) and (nested.get("access_token") or nested.get("token")):
            data = {**data, **nested}
            break

    token = str(data.get("access_token") or data.get("token") or "")
    if not token:
        reason = str(data.get("error_description") or data.get("error") or "服务器没有返回 access_token")
        raise RuntimeError(humanize_refresh_error(reason))

    expires_at = 0.0
    for key in ("expires_at", "expire_at"):
        expires_at = to_epoch(data.get(key))
        if expires_at:
            break
    if not expires_at and data.get("expires_in"):
        try:
            expires_at = time.time() + float(data["expires_in"])
        except (TypeError, ValueError):
            expires_at = 0.0
    if not expires_at:
        # 兜底：access_token 是 JWT，exp 就在载荷里
        expires_at = to_epoch(jwt_payload(token).get("exp"))

    return {
        "access_token": token,
        "refresh_token": str(data.get("refresh_token") or refresh_token),
        "expires_at": expires_at,
    }


def read_page_creds(window) -> dict:
    """读页面里的登录态；顺带把"什么时候过期"补上（站点不一定存它）。

    返回的 `expires_at` 一律是 **epoch 秒（float）**：页面的原始写法可能是
    ISO 字符串，谁读谁炸过一次，所以在这里就收敛掉（原因见 `to_epoch`）。
    同时留一个 `expires_at_iso` 标记，写回时按页面原来的样式写（别把字符串改成数字）。
    """
    try:
        raw = window.evaluate_js(JS_READ_CREDS.replace("__CLIENT_ID__", CLIENT_ID))
    except Exception:
        return {}
    try:
        data = json.loads(raw or "{}")
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    original = data.get("expires_at")
    data["expires_at_iso"] = _is_iso_style(original)
    data["expires_at"] = to_epoch(original)
    if not data["expires_at"]:
        data["expires_at"] = to_epoch(jwt_payload(str(data.get("access_token") or "")).get("exp"))
    return data


def write_page_creds(window, tokens: dict, iso_style: bool = False) -> bool:
    """把新 token 写回页面 localStorage，后续请求立刻用上。

    `iso_style`：页面原本把过期时间存成 ISO 字符串时，写回去也用 ISO
    （站点自己可能 `new Date(...)` 它，数字和字符串混着写属于给自己找麻烦）。
    """
    expires = to_epoch(tokens.get("expires_at"))
    rendered: object = _iso_text(expires) if (iso_style and expires) else expires
    js = (
        JS_WRITE_CREDS.replace("__CLIENT_ID__", CLIENT_ID)
        .replace("__ACCESS__", json.dumps(tokens.get("access_token") or ""))
        .replace("__REFRESH__", json.dumps(tokens.get("refresh_token") or ""))
        .replace("__EXPIRES__", json.dumps(rendered))
    )
    try:
        return str(window.evaluate_js(js)) == "ok"
    except Exception:
        return False


def _merge_marker(marker: Path | None, **fields) -> None:
    """更新标记时保留已有字段（比如 user_id / migrated），别整份覆盖。"""
    existing: dict = {}
    if marker is not None and marker.exists():
        try:
            loaded = json.loads(marker.read_text("utf-8"))
            existing = loaded if isinstance(loaded, dict) else {}
        except Exception:
            existing = {}
    for key, value in fields.items():
        if value in (None, ""):
            continue
        existing[key] = value
    existing["saved_at"] = time.time()
    write_marker(marker, existing)


def _looks_like_usable_token(tokens: dict) -> bool:
    """新拿到的 access_token 像不像能用。

    为什么要有这道闸：写回是**破坏性**的 —— 把一份还能用的登录态覆盖成一串垃圾，
    用户就从"偶尔要重扫"变成"立刻要重扫"。所以宁可拒绝写入、保留旧的。
    认两种：JWT 形态（迅雷实际就是这个），或者服务端明确给了未来的过期时间。
    """
    token = str(tokens.get("access_token") or "")
    if not token:
        return False
    if looks_like_jwt(token):
        return True
    return to_epoch(tokens.get("expires_at")) > time.time()


def maybe_refresh(
    window,
    *,
    force: bool = False,
    marker: Path | None = None,
    margin: float = REFRESH_MARGIN,
    timeout: float = 15.0,
) -> dict:
    """看情况续期；返回一段给上层看的说明。

    `{"state": "done", "refreshed": bool, "reason": str, "expires_at": float, "logged_in": bool}`
    —— **永远返回 done**：续期失败只是"这次没续上"，不该把整个解析/转存判死。
    """
    creds = read_page_creds(window)
    if not creds or creds.get("error"):
        return {
            "state": "done",
            "refreshed": False,
            "logged_in": False,
            "reason": "页面里没有登录态",
            "expires_at": 0.0,
        }

    expires_at = to_epoch(creds.get("expires_at"))
    iso_style = bool(creds.get("expires_at_iso"))
    if not creds.get("access_token"):
        # 页面读通了，但里面没有登录态 —— 别把"没有 token"说成"续期失败"
        return {
            "state": "done",
            "refreshed": False,
            "logged_in": False,
            "reason": "页面里没有登录态（需要扫码登录）",
            "expires_at": expires_at,
        }
    if not force and not needs_refresh(expires_at, margin):
        return {
            "state": "done",
            "refreshed": False,
            "logged_in": True,
            "reason": "登录态还有效",
            "expires_at": expires_at,
        }

    if not creds.get("refresh_token"):
        return {
            "state": "done",
            "refreshed": False,
            "logged_in": True,
            "reason": "没有 refresh_token（只能重新扫码）",
            "expires_at": expires_at,
        }

    try:
        tokens = refresh_access_token(
            str(creds["refresh_token"]), str(creds.get("device_id") or ""), timeout=timeout
        )
    except Exception as e:  # noqa: BLE001 —— 续不上就算了，老 token 也许还能用
        return {
            "state": "done",
            "refreshed": False,
            "logged_in": True,
            "reason": f"续期失败：{e}",
            "expires_at": expires_at,
        }

    if not _looks_like_usable_token(tokens):
        # 宁可留着旧的，也别把还能用的登录态覆盖成认不出的东西
        return {
            "state": "done",
            "refreshed": False,
            "logged_in": True,
            "reason": "续期返回的 token 格式不认识，已保持原样",
            "expires_at": expires_at,
        }

    if not write_page_creds(window, tokens, iso_style=iso_style):
        return {
            "state": "done",
            "refreshed": False,
            "logged_in": True,
            "reason": "续期成功但没能写回页面",
            "expires_at": expires_at,
        }

    _merge_marker(marker, expires_at=to_epoch(tokens.get("expires_at")))
    return {
        "state": "done",
        "refreshed": True,
        "logged_in": True,
        "reason": "已自动续期",
        "expires_at": to_epoch(tokens.get("expires_at")),
    }


def _looks_like_unauthorized(err: str) -> bool:
    """页面抛上来的 401/403 —— 大概率就是 access_token 过期了。"""
    low = (err or "").lower()
    return "http 401" in low or "http 403" in low or "unauthorized" in low


# ---------------------------------------------------------------------------
# WebView 驱动
#
# 一个窗口 + 一段 "scenario" 函数。为什么不再是一个"跑脚本然后轮询"的小工具：
# 续期需要在**同一个窗口**里做三段动作（读 token → Python 续期 → 写回 → 再跑业务），
# 每段之间还要看结果决定下一步。把窗口生命周期和业务逻辑分开，这些就能各写各的。
# ---------------------------------------------------------------------------
class _Ctx:
    """给 scenario 用的窗口工具箱：注入、读一次 JSON、轮询进度。"""

    def __init__(self, window, deadline: float, timeout: float) -> None:
        self.window = window
        self.deadline = deadline
        self.timeout = timeout
        self.last: dict = {"state": "running", "step": "init"}

    @property
    def remaining(self) -> float:
        return self.deadline - time.time()

    def inject(self, js: str) -> None:
        self.window.evaluate_js(js)

    def dump(self) -> str:
        """读整页 storage（登录态就在里面）。失败返回空串。"""
        try:
            return str(self.window.evaluate_js(JS_DUMP) or "")
        except Exception:
            return ""

    def eval_json(self, js: str) -> dict:
        try:
            raw = self.window.evaluate_js(js)
        except Exception:
            return {}
        try:
            data = json.loads(raw or "{}")
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    def poll(self, key: str) -> dict | None:
        """读一次 window.<key>；读不到返回 None（页面切域/重载时会短暂失败）。"""
        try:
            raw = self.window.evaluate_js(f"JSON.stringify(window.{key} || null)")
        except Exception:
            return None
        if not raw or raw == "null":
            return None
        try:
            data = json.loads(raw)
        except Exception:
            return None
        if not isinstance(data, dict):
            return None
        self.last = data
        return data

    def wait(self, key: str, noun: str = "解析") -> dict:
        """等到 done/error；超时用最后一次快照里的 step 说明卡在哪。"""
        while time.time() < self.deadline:
            time.sleep(POLL_INTERVAL)
            data = self.poll(key)
            if data and data.get("state") in ("done", "error"):
                return data
        step = self.last.get("step") or "未知阶段"
        return {
            "state": "error",
            "error": f"{noun}超时（{int(self.timeout)} 秒）停在：{step}。"
                     "常见原因：网络不通 / 分享需要提取码 / 迅雷网页版接口有变",
        }


def _drive(
    url: str,
    *,
    storage: Path,
    timeout: float,
    settle: float,
    hidden: bool,
    title: str,
    scenario: Callable[["_Ctx"], dict],
    size: tuple[int, int] = (900, 680),
) -> dict:
    """开一个 WebView，把控制权交给 `scenario`；窗口在这里保证被关掉。"""
    box = {"result": {"state": "error", "error": "worker 异常退出"}}
    state = {"destroyed": False}
    deadline = time.time() + max(1.0, timeout)

    def runner(window) -> None:
        time.sleep(settle)
        try:
            box["result"] = scenario(_Ctx(window, deadline, timeout))
        except Exception as e:  # noqa: BLE001
            box["result"] = {"state": "error", "error": f"{type(e).__name__}: {e}"}
        finally:
            _destroy(window, state)

    window = _create_window(url, hidden=hidden, title=title, size=size)
    _start(window, runner, storage)
    return box["result"]


def _create_window(url: str, *, hidden: bool, title: str, size: tuple[int, int]):
    import webview

    return webview.create_window(
        title,
        url,
        width=size[0],
        height=size[1],
        hidden=hidden,
        background_color="#FFFFFF",
        text_select=True,
    )


def _destroy(window, state: dict) -> None:
    if state.get("destroyed"):
        return
    state["destroyed"] = True
    try:
        window.destroy()
    except Exception:
        pass


def _start(window, worker, storage: Path) -> None:
    import webview

    webview.start(
        lambda: threading.Thread(target=worker, args=(window,), daemon=True).start(),
        gui="edgechromium",
        # private_mode=False 是硬要求：要留住登录态与页面算好的 captcha
        private_mode=False,
        storage_path=str(storage),
    )


def _share_url(share_id: str, pwd: str = "") -> str:
    url = f"{PAN_URL}s/{share_id}"
    return url + (f"?pwd={pwd}" if pwd else "")


def _login_payload(found: dict) -> dict:
    return {
        "state": "done",
        "user_id": found.get("user_id") or "",
        "nickname": found.get("nickname") or "",
        "expires_at": found.get("expires_at") or 0,
    }


def run_resolve(args, storage: Path) -> dict:
    script = (
        JS_RESOLVE.replace("__SHARE_ID__", json.dumps(args.share_id))
        .replace("__PASS_CODE__", json.dumps(args.pwd or ""))
        .replace("__CLIENT_ID__", CLIENT_ID)
        .replace("__API_BASE__", API_BASE)
        .replace("__MAX_DEPTH__", str(MAX_TREE_DEPTH))
    )

    def scenario(ctx: _Ctx) -> dict:
        ctx.inject(script)
        return ctx.wait("__XL_OUT", "解析")

    data = _drive(
        _share_url(args.share_id, args.pwd or ""),
        storage=storage,
        timeout=args.timeout,
        settle=args.settle,
        hidden=not args.show,
        title="解析中…",
        scenario=scenario,
    )
    return humanize_error_in(data) if data.get("state") == "error" else data


def run_restore(args, storage: Path) -> dict:
    ids = [x.strip() for x in (args.ids or "").split(",") if x.strip()]
    if not ids:
        return {"state": "error", "error": "没有要转存的文件 id"}

    script = (
        JS_RESTORE.replace("__SHARE_ID__", json.dumps(args.share_id))
        .replace("__PASS_CODE__", json.dumps(args.pwd or ""))
        .replace("__FILE_IDS__", json.dumps(ids))
        .replace("__CLEANUP__", "true" if args.cleanup else "false")
        .replace("__CLIENT_ID__", CLIENT_ID)
        .replace("__API_BASE__", API_BASE)
    )
    marker = Path(args.marker) if args.marker else None

    def scenario(ctx: _Ctx) -> dict:
        notes: dict = {}
        # 1) 已知快过期 → 先续一次（省得白发一轮会 401 的请求）
        pre = maybe_refresh(ctx.window, force=False, marker=marker)
        if pre.get("refreshed"):
            notes["refresh"] = "登录态快过期，已自动续期"
        elif pre.get("logged_in") is False:
            return {
                "state": "error",
                "error": "NOT_LOGGED_IN: 转存需要先登录迅雷（设置 → 迅雷 → 扫码登录）",
            }

        # 2) 转存
        ctx.inject(script)
        data = ctx.wait("__XL_R", "转存")

        # 3) 真撞上 401/403（token 在我们看不见的时候过期了）→ 续期后重试**一次**
        err = str(data.get("error") or "")
        if data.get("state") == "error" and _looks_like_unauthorized(err) and ctx.remaining > 5:
            again = maybe_refresh(ctx.window, force=True, marker=marker)
            if again.get("refreshed"):
                notes["refresh"] = "登录态已过期，已自动续期并重试"
                ctx.inject(script)
                data = ctx.wait("__XL_R", "转存")
            else:
                notes["refresh"] = f"自动续期没成功：{again.get('reason') or '未知原因'}"

        if notes:
            data = {**data, **notes}
        return data

    data = _drive(
        _share_url(args.share_id, args.pwd or ""),
        storage=storage,
        timeout=args.timeout,
        settle=args.settle,
        hidden=not args.show,
        title="转存中…",
        scenario=scenario,
    )
    if data.get("state") == "error":
        if data.get("error") == "NOT_LOGGED_IN":
            # 带上机器可判定的前缀：父程序据此清掉本地"已登录"标记
            return {
                "state": "error",
                "error": "NOT_LOGGED_IN: 转存需要先登录迅雷（设置 → 迅雷 → 扫码登录）",
            }
        return humanize_error_in(data)
    return data


def run_status(args, storage: Path) -> dict:
    """读一次 localStorage，报告有没有登录态（不开新窗口给用户看）。

    "没登录"必须**尽快**返回：这里最多等 4 次轮询（约 6 秒），
    不能像 resolve 那样等到超时 —— 用户点的是「检查」，不是在等解析。

    但"页面压根没加载出来"要跟"确认没登录"分开：前者返回 error（主程序据此**不删**
    登录标记），后者才说 logged_in=False。混在一起的话，断网点一下「检查」就会
    把"已登录"翻成"未登录"，还会连带清掉标记。
    """
    deadline = time.time() + min(args.timeout, 24)
    read_ok = {"n": 0}

    def scenario(ctx: _Ctx) -> dict:
        for _ in range(4):
            if time.time() >= deadline:
                break
            raw = ctx.dump()
            if raw:
                read_ok["n"] += 1
            found = extract_login(raw)
            if found:
                return _login_payload(found)
            time.sleep(LOGIN_POLL)
        if read_ok["n"] == 0:
            return {
                "state": "error",
                "error": "没能从页面读到登录态（页面可能没加载出来，检查一下网络再试）",
            }
        return {"state": "done", "logged_in": False}

    return _drive(
        PAN_URL,
        storage=storage,
        timeout=min(args.timeout, 24),
        settle=args.settle,
        hidden=True,
        title="检查登录态…",
        size=(480, 360),
        scenario=scenario,
    )


def run_refresh(args, storage: Path) -> dict:
    """用 refresh_token 换新 token（设置里的「刷新登录态」按钮，也是转存的自愈兜底）。"""

    def scenario(ctx: _Ctx) -> dict:
        return maybe_refresh(ctx.window, force=True, marker=Path(args.marker) if args.marker else None)

    return _drive(
        PAN_URL,
        storage=storage,
        timeout=min(args.timeout, 60),
        settle=args.settle,
        hidden=True,
        title="刷新登录态…",
        size=(480, 360),
        scenario=scenario,
    )


def run_login(args, storage: Path) -> dict:
    """可见窗口 + 轮询扫码结果。成功只写"标记"，token 留在 WebView 自己的存储里。"""
    hint = {"injected": False}

    def scenario(ctx: _Ctx) -> dict:
        while ctx.remaining > 0:
            found = extract_login(ctx.dump())
            if found:
                return _login_payload(found)
            if not hint["injected"]:
                try:
                    ctx.inject(JS_LOGIN_HINT)
                    hint["injected"] = True
                except Exception:
                    pass
            time.sleep(LOGIN_POLL)
        return {"state": "error", "error": "没等到扫码（超时）"}

    return _drive(
        PAN_URL,
        storage=storage,
        timeout=args.timeout,
        settle=args.settle,
        hidden=False,
        title="迅雷扫码登录 — 扫码后自动完成",
        size=(520, 760),
        scenario=scenario,
    )


# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="迅雷云盘 WebView 执行器（子进程）")
    ap.add_argument("--mode", required=True, choices=["resolve", "restore", "login", "status", "refresh"])
    ap.add_argument("--share-id", default="")
    ap.add_argument("--pwd", default="")
    ap.add_argument("--ids", default="", help="逗号分隔的文件 id（restore）")
    ap.add_argument("--cleanup", action=argparse.BooleanOptionalAction, default=True,
                    help="转存取链成功后从自己云盘删掉（默认开）")
    ap.add_argument("--storage", default="", help="WebView user-data-dir")
    ap.add_argument("--marker", default="", help="登录标记文件（登录/检查成功时写）")
    ap.add_argument("--legacy-storage", default="", help="旧版程序的 profile（只读，搬一次）")
    ap.add_argument("--legacy-login", default="", help="旧版程序的凭证文件（存在即认为登录过）")
    ap.add_argument("-o", "--out", default="")
    ap.add_argument("--show", action="store_true", help="显示窗口（排查用）")
    ap.add_argument("--settle", type=float, default=DEFAULT_SETTLE)
    ap.add_argument("--timeout", type=float, default=240)
    args = ap.parse_args()

    out = Path(args.out) if args.out else None
    local = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "netdisk-downloader"
    storage = Path(args.storage) if args.storage else local / "webview"
    legacy = Path(args.legacy_storage) if args.legacy_storage else None
    legacy_login = Path(args.legacy_login) if args.legacy_login else None
    marker = Path(args.marker) if args.marker else None

    try:
        import webview  # noqa: F401
    except Exception as e:  # noqa: BLE001
        write_json(out, {
            "state": "error",
            "error": f"迅雷解析需要 pywebview（{type(e).__name__}: {e}）。"
                     "装一次即可：python -m pip install pywebview",
        })
        return 3

    prepare_storage(storage, legacy, legacy_login, marker)

    try:
        if args.mode == "resolve":
            if not args.share_id:
                return _fail(out, "缺少 --share-id")
            data = run_resolve(args, storage)
        elif args.mode == "restore":
            if not args.share_id:
                return _fail(out, "缺少 --share-id")
            data = run_restore(args, storage)
        elif args.mode == "login":
            data = run_login(args, storage)
        elif args.mode == "refresh":
            data = run_refresh(args, storage)
        else:
            data = run_status(args, storage)
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        data = {"state": "error", "error": f"{type(e).__name__}: {e}"}

    # 登录成功、以及"检查确认还有效"都写标记；检查发现没登录就删掉。
    # 主程序靠标记显示状态，不然每次启动都要开一次 WebView 才知道自己登没登录。
    sync_marker(marker, args.mode, data)

    write_json(out, data)
    return 0 if data.get("state") == "done" else 1


def _fail(out: Path | None, message: str) -> int:
    write_json(out, {"state": "error", "error": message})
    return 1


if __name__ == "__main__":
    sys.exit(main())
