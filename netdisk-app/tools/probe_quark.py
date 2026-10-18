"""协议探测：用无效的分享 ID 打一次真实接口。

不能证明"能下载"，但能证明三件事（这几件恰好是最容易写错的）：
  1. 主机 / 路径对不对（错误的路径会返回 HTML 404 而不是结构化 JSON）
  2. 请求体字段名对不对（字段名错通常会被参数校验挡下来）
  3. 响应结构与业务码在哪一层（网盘的业务错误码在 HTTP 200 的 body 里）

用法：python tools/probe_quark.py
"""

import json
import sys
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from netdisk.adapters import API, QuarkAdapter, _headers  # noqa: E402
from netdisk.core import Client  # noqa: E402


def probe(label: str, fn) -> None:
    print(f"\n--- {label} ---")
    try:
        result = fn()
        print(json.dumps(result, ensure_ascii=False, indent=2)[:900])
    except Exception as e:
        print(f"异常：{type(e).__name__}: {e}")


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
    for url in [
        "https://pan.quark.cn/s/abcdef123456",
        "https://pan.quark.cn/s/abcdef123456?pwd=1234",
        "https://pan.quark.cn/s/abcdef123456#/list/share",
        "https://example.com/s/xyz",
    ]:
        print(f"  {url:<52} -> {QuarkAdapter.quark_pwd_id(url) if hasattr(QuarkAdapter, 'quark_pwd_id') else ''}"
              f"{quark_id(url)}")

    return 0


def quark_id(url: str) -> str:
    from netdisk.adapters import quark_pwd_id

    return quark_pwd_id(url)


if __name__ == "__main__":
    raise SystemExit(main())
