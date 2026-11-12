# -*- coding: utf-8 -*-
"""
plot-decay.py —— 把 out/decay-curves.json 画成衰减曲线图
运行：python scripts/plot-decay.py
输出：out/decay-curves.png
"""
import json
import os
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DATA = ROOT / "out" / "decay-curves.json"
PNG = ROOT / "out" / "decay-curves.png"

# 中文字体：Windows 自带雅黑；没有就退回黑体，最后退回默认（可能显示方块）
for cand in ("msyh.ttc", "simhei.ttf", "simsun.ttc"):
    p = Path("C:/Windows/Fonts") / cand
    if p.exists():
        font_manager.fontManager.addfont(str(p))
        plt.rcParams["font.family"] = font_manager.FontProperties(fname=str(p)).get_name()
        break
plt.rcParams["axes.unicode_minus"] = False

data = json.loads(DATA.read_text(encoding="utf-8"))
days = data["days"]
series = data["series"]

fig, ax = plt.subplots(figsize=(9, 5.2), dpi=140)

colors = ["#9aa5b1", "#5b8def", "#f2994a", "#eb5757"]
for s, c in zip(series, colors):
    ax.plot(days, s["values"], label=f'{s["label"]} · 半衰期 {s["halfLifeDays"]} 天', color=c, linewidth=2)

# 两条决策线：低于 0.15 不进 prompt；低于 0.05 且不重要 → 归档
ax.axhline(0.15, color="#2f80ed", linestyle="--", linewidth=1)
ax.axhline(0.05, color="#828282", linestyle=":", linewidth=1)
ax.text(2, 0.17, "候选线 0.15（低于它不进 prompt）", fontsize=8, color="#2f80ed")
ax.text(2, 0.07, "归档线 0.05（不重要且低于它 → 软删除）", fontsize=8, color="#828282")

ax.set_xlim(0, 60)
ax.set_ylim(0, 1.02)
ax.set_xlabel("距离上次提及的天数")
ax.set_ylabel("记忆保留度 R")
ax.set_title("长时记忆衰减曲线：重要度 / 情绪 / 复述次数决定半衰期", fontsize=12)
ax.grid(alpha=0.25)
ax.legend(loc="upper right", fontsize=8, framealpha=0.9)

PNG.parent.mkdir(parents=True, exist_ok=True)
fig.tight_layout()
fig.savefig(PNG)
print(f"已生成 {PNG}")
