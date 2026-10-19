"""协议探测：打真实接口，验证路径 / 请求体字段 / 错误码层次。

默认用**无效**的分享 ID 探测（不碰任何人的分享），证明三件事：
  1. 主机 / 路径对不对（错误的路径会返回 HTML 404 而不是结构化 JSON）
  2. 请求体字段名对不对（字段名错通常会被参数校验挡下来）
  3. 响应结构与业务码在哪一层（网盘的业务错误码在 HTTP 200 的 body 里）

也可以带一个真实分享链接，把 parse → list_dir 跑一遍（**只读**：不发
download / save 请求，不下载、不往任何人网盘里写东西）：

    用法：python tools/probe_quark.py
          python tools/probe_quark.py "https://pan.quark.cn/s/xxxxxxxx"
"""

import json
import sys
import urllib.parse
from pathlib import Path

# 别在源码树里留 __pycache__（main.py 里同理）：自测工具不该污染仓库
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from netdisk.adapters import API, QuarkAdapter, _headers, quark_pwd_id  # noqa: E402
from netdisk.core import Client  # noqa: E402


def probe(label: str, fn) -> None:
    print(f"\n--- {label} ---")
    try:
        result = fn()
        print(json.dumps(result, ensure_ascii=False, indent=2)[:900])
    except Exception as e:
        print(f"异常：{type(e).__name__}: {e}")


def real_share(url: str) -> dict:
    """用真链接跑 parse → list_dir。**只读**：不发 download / save 请求"""
    adapter = QuarkAdapter()
    ctx, entries, title = adapter.parse(url, "")
    return {
        "title": title,
        "pwd_id": ctx["pwd_id"],
        "stoken": (ctx["stoken"][:8] + "…") if ctx["stoken"] else "",
        "logged_in": adapter.logged_in,
        "count": len(entries),
        "entries": [
            {"name": e.name, "size": e.size_text, "dir": e.is_dir} for e in entries[:20]
        ],
    }


def main() -> int:
    client = Client("quark")

    # 1) token 接口：用一个格式合法但不存在的分享 ID
    def token_probe():
        resp = client.post_json(
            f"{API}/1/clouddrive/share/sharepage/token?pr=ucpro&fr=pc&uc_param_str=",
            {"pwd_id": "000000000000", "passcode": ""},
            headers=_headers(),
        )
        body = resp.json()
        return {
            "http_status": resp.status,
            "content_type": resp.headers.get("content-type", ""),
            "parsed_json": body is not None,
            "body": body if body is not None else resp.text[:200],
        }

    probe("POST /share/sharepage/token（无效 ID）", token_probe)

    # 2) detail 接口：用假 stoken，看它是否也回结构化错误
    def detail_probe():
        query = urllib.parse.urlencode(
            {
                "pr": "ucpro",
                "fr": "pc",
                "uc_param_str": "",
                "pwd_id": "000000000000",
                "stoken": "invalid-stoken-for-probe",
                "pdir_fid": "0",
                "force": "0",
                "_page": "1",
                "_size": "50",
            }
        )
        resp = client.get(f"{API}/1/clouddrive/share/sharepage/detail?{query}", headers=_headers())
        body = resp.json()
        return {
            "http_status": resp.status,
            "parsed_json": body is not None,
            "body": body if body is not None else resp.text[:200],
        }

    probe("GET /share/sharepage/detail（无效 stoken）", detail_probe)

    # 3) 链接识别（纯本地逻辑，必测）
    print("\n--- 本地：分享 ID 提取 ---")
    for sample in [
        "https://pan.quark.cn/s/abcdef123456",
        "https://pan.quark.cn/s/abcdef123456?pwd=1234",
        "https://pan.quark.cn/s/abcdef123456#/list/share",
        "https://example.com/s/xyz",  # 只管形状，域名校验在 QuarkAdapter.match()
    ]:
        print(f"  {sample:<52} -> {quark_pwd_id(sample)}")

    # 4) 给了真实链接就跑一遍解析 + 列目录（可选，只读）
    url = sys.argv[1] if len(sys.argv) > 1 else ""
    if url:
        probe("真实链接：parse → list_dir（只读，不下载 / 不转存）", lambda: real_share(url))
    else:
        print("\n（想验证一个真实分享链接，加上参数再跑一次：python tools/probe_quark.py <链接>）")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
