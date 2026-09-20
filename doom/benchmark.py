"""Run the fixed Jev evaluation gates and save their measured results."""
from __future__ import annotations

import json
import math
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from statistics import mean, median

from doom import play


def run_chunk(scenario: str, first_seed: int, episodes: int) -> dict:
    return play(scenario, "jev", episodes, first_seed, False)


def evaluate(name: str, scenario: str, first_seed: int, episodes: int, workers: int = 5) -> dict:
    size = math.ceil(episodes / workers)
    chunks = [(scenario, first_seed + offset, min(size, episodes - offset)) for offset in range(0, episodes, size)]
    with ProcessPoolExecutor(max_workers=len(chunks)) as pool:
        runs = list(pool.map(run_chunk, *zip(*chunks)))
    history = sorted((episode for run in runs for episode in run["history"]), key=lambda episode: episode["seed"])
    decisions = sum(episode["decisions"] for episode in history)
    summary = {
        "name": name, "scenario": scenario, "first_seed": first_seed, "last_seed": first_seed + episodes - 1,
        "episodes": episodes, "survived": sum(episode["success"] for episode in history),
        "survival_rate": round(mean(episode["success"] for episode in history), 3),
        "median_kills": median(episode["kills"] for episode in history),
        "mean_health": round(mean(episode["health"] for episode in history), 1),
        "mean_decisions": round(mean(episode["decisions"] for episode in history), 1),
        "fallbacks": sum(episode["fallbacks"] for episode in history),
        "fallback_rate": round(sum(episode["fallbacks"] for episode in history) / decisions, 4),
        "mean_cost_usd": round(mean(episode["usd"] for episode in history), 6),
        "median_mean_latency_ms": round(median(episode["mean_ms"] for episode in history)),
        "median_p95_latency_ms": round(median(episode["p95_ms"] for episode in history)),
        "episodes_detail": history,
    }
    print(json.dumps({key: value for key, value in summary.items() if key != "episodes_detail"}), flush=True)
    return summary


if __name__ == "__main__":
    results = {
        "development": evaluate("development", "defend", 100, 10),
        "validation": evaluate("validation", "defend", 200, 20),
        "final": evaluate("final", "defend", 1000, 50),
    }
    final = results["final"]
    results["standard_gate_passed"] = (
        final["survival_rate"] >= .7 and final["median_kills"] >= 3 and
        final["fallback_rate"] < .02 and final["mean_cost_usd"] < .002 and
        final["median_p95_latency_ms"] < 500
    )
    results["stress"] = evaluate("stress", "defend_stress", 3000, 10) if results["standard_gate_passed"] else {"status": "skipped"}
    Path(__file__).with_name("jev-evaluation.json").write_text(json.dumps(results, indent=2) + "\n")
