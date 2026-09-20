"""Run the fixed Jev evaluation gates and save their measured results."""
from __future__ import annotations

import json
import math
import argparse
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from statistics import mean, median

from doom import play


def run_chunk(scenario: str, controller: str, first_seed: int, episodes: int) -> dict:
    return play(scenario, controller, episodes, first_seed, False)


def evaluate(name: str, scenario: str, controller: str, first_seed: int, episodes: int, workers: int = 5) -> dict:
    size = math.ceil(episodes / workers)
    chunks = [(scenario, controller, first_seed + offset, min(size, episodes - offset)) for offset in range(0, episodes, size)]
    with ProcessPoolExecutor(max_workers=len(chunks)) as pool:
        runs = list(pool.map(run_chunk, *zip(*chunks)))
    history = sorted((episode for run in runs for episode in run["history"]), key=lambda episode: episode["seed"])
    decisions = sum(episode["decisions"] for episode in history)
    summary = {
        "name": name, "scenario": scenario, "controller": controller,
        "first_seed": first_seed, "last_seed": first_seed + episodes - 1,
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
    parser = argparse.ArgumentParser()
    parser.add_argument("scenario", nargs="?", choices=["defend", "corridor"], default="defend")
    args = parser.parse_args()
    config = {
        "defend": {"seeds": (100, 200, 1000), "rules": 2000, "stress": ("defend_stress", 3000), "kills": 3, "cost": .002, "output": "jev-evaluation.json"},
        "corridor": {"seeds": (400, 500, 1500), "rules": 2500, "stress": ("corridor_stress", 4000), "kills": 5, "cost": .003, "output": "corridor-evaluation.json"},
    }[args.scenario]
    results = {
        "rule_baseline": evaluate("rule_baseline", args.scenario, "rules", config["rules"], 100),
        "development": evaluate("development", args.scenario, "jev", config["seeds"][0], 10),
        "validation": evaluate("validation", args.scenario, "jev", config["seeds"][1], 20),
        "final": evaluate("final", args.scenario, "jev", config["seeds"][2], 50),
    }
    final = results["final"]
    results["standard_gate_passed"] = (
        final["survival_rate"] >= .7 and final["median_kills"] >= config["kills"] and
        final["fallback_rate"] < .02 and final["mean_cost_usd"] < config["cost"] and
        final["median_p95_latency_ms"] < 500
    )
    stress_scenario, stress_seed = config["stress"]
    results["stress"] = evaluate("stress", stress_scenario, "jev", stress_seed, 10) if results["standard_gate_passed"] else {"status": "skipped"}
    Path(__file__).with_name(config["output"]).write_text(json.dumps(results, indent=2) + "\n")
