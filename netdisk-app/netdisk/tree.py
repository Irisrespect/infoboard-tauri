"""把勾选的内容展开成「文件清单 + 落盘相对路径」

这段逻辑原来在 `main.py` 的 `App._walk()` 里，并且带着一个硬上限：

    if depth >= 6:
        raise NetdiskError("目录层级过深（超过 6 层），已停止展开")

于是夸克分享只要目录超过 6 层（`课程/第 1 章/第 1 节/素材/配图/…` 随手就 7 层），
**整个下载在"展开目录"这一步就失败了，一个文件都下不到** —— 用户看到的不是
"下得慢一点"，而是直接报错。

现在改成：

1. **按层并发**：夸克是「一层目录一次请求」，一个 500 个目录的分享串行展开要几分钟
   （每次 200~600ms）。同一层的目录现在一起列（默认 6 路），结果再按原顺序拼回去 ——
   **顺序完全稳定**，耗时接近除以并发数。
2. **显式队列而不是递归** —— 深度不再受 `sys.setrecursionlimit` 影响。
3. **上限只当保险丝**（默认 32 层，可在设置里调）：到顶的子树被**跳过并记一条提示**，
   同级的其它文件照常下载，不再"一票否决"。
4. **单个目录失败不连坐**：某个子目录列不出来（被删、风控、提取码过期），
   记一条提示继续展开别的目录。
5. **按 fid 去重**：万一同一个目录在树里出现两次（分享被套娃/异常数据），
   只展开一次，不会指数爆炸。
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable

from .core import FileEntry, NetdiskError, ShareCtx
from .downloader import safe_filename

# 默认最多展开多少层目录。这个数只用来挡病态分享，不是协议限制：
# 夸克一层目录一次请求，32 层正常分享根本碰不到；真要更深可以在设置里改。
DEFAULT_MAX_DEPTH = 32

# 再往上调就没意义了（文件系统单路径上限 32767 个字符，早就先炸了）
MAX_DEPTH_LIMIT = 1024

# 展开时的并发数（**每一层**同时列多少个目录）。
# 默认 6 而不是更大：这是**别人的分享接口**，同一瞬间几十个请求很容易被临时风控，
# 表现是整层失败、留下提示。想要更快可以在设置里往上调（上限 16）。
# 注意这跟下载用的「并发连接」是两码事：那个是拉文件字节，这个只是列目录。
DEFAULT_WORKERS = 6
MAX_WORKERS = 16

Progress = Callable[[str, int], None]


def clamp_depth(value: Any) -> int:
    """把配置里的 max_depth 收拾成一个能用的正整数（配置被手改坏也不至于炸）"""
    try:
        depth = int(value)
    except (TypeError, ValueError):
        return DEFAULT_MAX_DEPTH
    if depth <= 0:
        return DEFAULT_MAX_DEPTH
    return min(depth, MAX_DEPTH_LIMIT)


def clamp_workers(value: Any) -> int:
    """展开并发：坏值回默认，上限 MAX_WORKERS"""
    try:
        workers = int(value)
    except (TypeError, ValueError):
        return DEFAULT_WORKERS
    if workers <= 0:
        return DEFAULT_WORKERS
    return min(workers, MAX_WORKERS)


def _list_children(
    adapter: Any, ctx: ShareCtx, entry: FileEntry
) -> tuple[list[FileEntry], str]:
    """列一个目录。返回 `(子项, 错误消息)` —— **不抛异常**。

    并发时异常会从 future 里冒出来把整批展开带崩，所以在这里就地转成一句提示；
    单个目录列不出来只影响它自己的子树。
    """
    try:
        return adapter.list_dir(ctx, entry.id), ""
    except NetdiskError as e:
        return [], str(e)
    except Exception as e:  # noqa: BLE001 —— 协议外的意外（比如解析坏响应）
        return [], f"{type(e).__name__}: {e}"


def flatten(
    adapter: Any,
    ctx: ShareCtx,
    picked: list[FileEntry],
    max_depth: Any = DEFAULT_MAX_DEPTH,
    progress: Progress | None = None,
    workers: Any = DEFAULT_WORKERS,
) -> tuple[list[tuple[FileEntry, str]], list[str]]:
    """展开目录，返回 `([(文件, 相对路径)], [提示])`。

    相对路径用 `/` 分隔（`Path` 在 Windows 上会自己转过来），空串表示
    "就放在保存目录下"。**顺序与用户勾选的顺序一致**，同一层内按接口返回的顺序。

    并发是**按层**做的（BFS + 层内并发）：一层的目录全部列完后才进下一层。
    这样做的好处是结果顺序天然确定、失败可以逐层隔离；代价是每层要等最慢的那个
    目录 —— 但目录树通常又宽又浅，"层内并发"已经能拿到绝大部分收益。
    """
    cap = clamp_depth(max_depth)
    width = clamp_workers(workers)
    if getattr(adapter, "parallel_expand", True) is False:
        # 迅雷解析时整棵树已经在页面里抓回来了，list_dir 只是查字典 —— 并发没意义
        width = 1

    files: list[tuple[FileEntry, str]] = []
    notes: list[str] = []
    seen: set[str] = set()

    # 第一层：用户勾选的那些（文件直接收下，目录排队展开）
    level: list[tuple[FileEntry, str, int]] = []
    for entry in picked:
        if not entry.is_dir:
            files.append((entry, ""))
            continue
        if entry.id in seen:
            continue
        seen.add(entry.id)
        level.append((entry, safe_filename(entry.name), 0))

    pool = ThreadPoolExecutor(max_workers=width) if width > 1 else None
    try:
        while level:
            batch: list[tuple[FileEntry, str, int]] = []
            for entry, prefix, depth in level:
                if depth >= cap:
                    notes.append(f"{prefix}/：超过 {cap} 层，已跳过（可在设置里调高上限）")
                    continue
                batch.append((entry, prefix, depth))
            if not batch:
                break

            if pool is not None and len(batch) > 1:
                # map 保证结果顺序 == batch 顺序（不依赖"谁先回来"）
                outcomes = list(
                    pool.map(lambda item: _list_children(adapter, ctx, item[0]), batch)
                )
            else:
                outcomes = [_list_children(adapter, ctx, item[0]) for item in batch]

            following: list[tuple[FileEntry, str, int]] = []
            for (entry, prefix, depth), (children, error) in zip(batch, outcomes):
                if error:
                    notes.append(f"{prefix}/：{error}")
                    continue
                for child in children:
                    if not child.is_dir:
                        files.append((child, prefix))
                        continue
                    if child.id in seen:
                        continue
                    seen.add(child.id)
                    following.append(
                        (child, f"{prefix}/{safe_filename(child.name)}", depth + 1)
                    )
                if progress is not None:
                    progress(prefix, len(files))
            level = following
    finally:
        if pool is not None:
            pool.shutdown(wait=True)

    return files, notes
