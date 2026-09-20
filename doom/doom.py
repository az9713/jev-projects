"""Three-level ViZDoom stress suite with Jev, rule, and random controllers."""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from time import perf_counter

import vizdoom as vzd

ROOT = Path(__file__).resolve().parent.parent
HTML = Path(__file__).with_name("doom.html").read_bytes()
PORT = 3007
LOCK = threading.Lock()

SCENARIOS = {
    "basic": {
        "title": "Aim trainer", "config": "basic.cfg", "repeat": 4, "timeout": 300,
        "goal": "Align the one stationary monster with the crosshair and shoot it.",
        "instructions": "One stationary monster is visible. Move left or right until it is centered, then shoot.",
        "actions": {"left": [1, 0, 0], "right": [0, 1, 0], "shoot": [0, 0, 1]},
        "descriptions": {"left": "Strafe left to move the visible monster toward the crosshair", "right": "Strafe right to move the visible monster toward the crosshair", "shoot": "Fire when a monster is centered"},
    },
    "defend": {
        "title": "Defend the center", "config": "defend_the_center.cfg", "repeat": 8, "timeout": 420,
        "goal": "Survive attacks from every direction, conserve ammunition, and kill as many monsters as possible.",
        "instructions": "You stand in the center while monsters approach from all directions. Turn toward a visible monster and shoot when centered. Conserve limited ammunition.",
        "actions": {"turn_left": [1, 0, 0], "turn_right": [0, 1, 0], "shoot": [0, 0, 1]},
        "descriptions": {"turn_left": "Rotate left toward a monster on the left, or search left", "turn_right": "Rotate right toward a monster on the right, or search right", "shoot": "Fire at a monster centered in the crosshair"},
    },
    "corridor": {
        "title": "Deadly corridor", "config": "deadly_corridor.cfg", "repeat": 8, "timeout": 700,
        "goal": "Fight through the corridor and reach the green armor at the far end without dying.",
        "instructions": "Advance through a corridor containing multiple armed enemies. Aim and shoot visible monsters, move toward the green armor, and retreat when immediate danger is high.",
        "actions": {
            "strafe_left": [1, 0, 0, 0, 0, 0, 0], "strafe_right": [0, 1, 0, 0, 0, 0, 0],
            "shoot": [0, 0, 1, 0, 0, 0, 0], "forward": [0, 0, 0, 1, 0, 0, 0],
            "backward": [0, 0, 0, 0, 1, 0, 0], "turn_left": [0, 0, 0, 0, 0, 1, 0],
            "turn_right": [0, 0, 0, 0, 0, 0, 1],
        },
        "descriptions": {
            "strafe_left": "Sidestep left while keeping the current view direction", "strafe_right": "Sidestep right while keeping the current view direction",
            "shoot": "Fire at a monster centered in the crosshair", "forward": "Advance toward the goal when the route ahead is clear",
            "backward": "Retreat from a close centered threat", "turn_left": "Rotate left toward a target or the goal", "turn_right": "Rotate right toward a target or the goal",
        },
    },
}

VARIABLES = (
    vzd.GameVariable.KILLCOUNT, vzd.GameVariable.ITEMCOUNT, vzd.GameVariable.HEALTH,
    vzd.GameVariable.AMMO2, vzd.GameVariable.POSITION_X, vzd.GameVariable.POSITION_Y,
    vzd.GameVariable.ANGLE, vzd.GameVariable.DAMAGE_TAKEN,
)

STATE = {
    "running": False, "message": "Choose a level and controller.", "scenario": "basic",
    "controller": None, "episode": 0, "episodes": 0, "successes": 0, "failures": 0,
    "kills": 0, "decisions": 0, "errors": 0, "usd": 0, "ms": [], "last": None,
    "view": None, "history": [],
}


def publish(**values):
    with LOCK:
        STATE.update(values)


def make_game(scenario: str, visible: bool) -> vzd.DoomGame:
    spec = SCENARIOS[scenario]
    game = vzd.DoomGame()
    game.load_config(os.path.join(vzd.scenarios_path, spec["config"]))
    game.set_episode_timeout(spec["timeout"])
    game.set_labels_buffer_enabled(True)
    game.set_objects_info_enabled(True)
    for variable in VARIABLES:
        game.add_available_game_variable(variable)
    game.set_window_visible(visible)
    game.set_sound_enabled(False)
    game.init()
    return game


def value(game: vzd.DoomGame, variable: vzd.GameVariable) -> int:
    return int(game.get_game_variable(variable))


def side(center: int | None) -> str:
    return "unknown" if center is None else "left" if center < 145 else "right" if center > 175 else "centered"


def game_view(game: vzd.DoomGame, scenario: str) -> dict:
    state = game.get_state()
    targets = []
    for label in state.labels if state else ():
        if label.object_category == "Self":
            continue
        center = round(label.x + label.width / 2)
        targets.append({
            "name": label.object_name, "category": label.object_category,
            "screen_x": center, "screen_y": round(label.y + label.height / 2),
            "width": label.width, "height": label.height, "side": side(center),
        })
    targets.sort(key=lambda target: (target["category"] != "Monster", -(target["width"] * target["height"])))
    px, py = (float(game.get_game_variable(v)) for v in (vzd.GameVariable.POSITION_X, vzd.GameVariable.POSITION_Y))
    goal = next((obj for obj in state.objects if obj.name == "GreenArmor"), None) if state else None
    goal_distance = round(math.hypot(goal.position_x - px, goal.position_y - py)) if goal else None
    spec = SCENARIOS[scenario]
    return {
        "scenario": scenario, "level": spec["title"], "goal": spec["goal"],
        "health": value(game, vzd.GameVariable.HEALTH), "ammo": value(game, vzd.GameVariable.AMMO2),
        "kills": value(game, vzd.GameVariable.KILLCOUNT), "items": value(game, vzd.GameVariable.ITEMCOUNT),
        "damage_taken": value(game, vzd.GameVariable.DAMAGE_TAKEN),
        "position": {"x": round(px), "y": round(py), "heading_degrees": value(game, vzd.GameVariable.ANGLE)},
        "goal_distance": goal_distance, "visible_targets": targets[:8],
        "visible_monsters": sum(target["category"] == "Monster" for target in targets),
        "instructions": spec["instructions"], "action_descriptions": spec["descriptions"],
        "possible_actions": list(spec["actions"]),
    }


def primary(view: dict, category: str) -> dict | None:
    return next((target for target in view["visible_targets"] if target["category"] == category), None)


def rule_action(view: dict) -> str:
    scenario = view["scenario"]
    monster = primary(view, "Monster")
    if scenario == "basic":
        return "left" if monster and monster["side"] == "left" else "right" if monster and monster["side"] == "right" else "shoot"
    if scenario == "defend":
        if not monster:
            return "turn_right"
        return "turn_left" if monster["side"] == "left" else "turn_right" if monster["side"] == "right" else "shoot"
    if monster:
        if monster["side"] == "left":
            return "turn_left"
        if monster["side"] == "right":
            return "turn_right"
        return "backward" if view["health"] < 25 and monster["width"] > 80 else "shoot"
    armor = primary(view, "Armor")
    if armor:
        return "turn_left" if armor["side"] == "left" else "turn_right" if armor["side"] == "right" else "forward"
    return "forward"


class JevWorker:
    def __init__(self):
        self.process = subprocess.Popen(
            ["node", "--env-file=.env", "doom/jev-worker.mjs"], cwd=ROOT,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1,
        )

    def decide(self, current: dict) -> dict:
        assert self.process.stdin and self.process.stdout
        self.process.stdin.write(json.dumps(current) + "\n")
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("Jev worker stopped")
        result = json.loads(line)
        if result.get("error"):
            raise RuntimeError(result["error"])
        return result

    def close(self):
        self.process.terminate()


def episode_success(scenario: str, final: dict) -> bool:
    if scenario == "basic":
        return final["kills"] > 0
    if scenario == "defend":
        return final["health"] > 0 and final["kills"] > 0
    return final["items"] > 0 or final["position"]["x"] >= 1200


def play(scenario: str, controller: str, episodes: int, seed: int, visible: bool, notify=None) -> dict:
    spec = SCENARIOS[scenario]
    game = make_game(scenario, visible)
    worker = JevWorker() if controller == "jev" else None
    result = {
        "scenario": scenario, "scenario_title": spec["title"], "controller": controller,
        "episodes": episodes, "episode": 0, "successes": 0, "failures": 0, "kills": 0,
        "decisions": 0, "errors": 0, "usd": 0.0, "ms": [], "last": None,
        "view": None, "history": [],
    }
    try:
        for episode in range(episodes):
            game.set_seed(seed + episode)
            game.new_episode()
            rng = random.Random(seed + episode)
            episode_decisions = episode_errors = 0
            while not game.is_episode_finished():
                current = game_view(game, scenario)
                started = perf_counter()
                probabilities = None
                fallback = False
                try:
                    if controller == "rules":
                        action, elapsed, usd, attempts = rule_action(current), 0, 0, 0
                    elif controller == "random":
                        action, elapsed, usd, attempts = rng.choice(list(spec["actions"])), 0, 0, 0
                    else:
                        decision = worker.decide(current)
                        action, probabilities = decision["action"], decision["probabilities"]
                        elapsed, usd, attempts = decision["ms"], decision["usd"], decision["attempts"]
                except Exception as error:
                    action, fallback = rule_action(current), True
                    elapsed, usd, attempts = round((perf_counter() - started) * 1000), 0, 0
                    episode_errors += 1
                    result["errors"] += 1
                    result["last_error"] = str(error)
                game.make_action(spec["actions"][action], spec["repeat"])
                episode_decisions += 1
                result["decisions"] += 1
                result["usd"] += usd
                if elapsed:
                    result["ms"].append(elapsed)
                result["episode"] = episode + 1
                result["view"] = current
                result["last"] = {"action": action, "probabilities": probabilities, "ms": elapsed, "usd": usd, "attempts": attempts, "fallback": fallback}
                if notify:
                    notify(result)
            final = game_view(game, scenario)
            success = episode_success(scenario, final)
            result["successes"] += int(success)
            result["failures"] += int(not success)
            result["kills"] += final["kills"]
            result["view"] = final
            result["history"].append({
                "episode": episode + 1, "seed": seed + episode, "success": success,
                "kills": final["kills"], "health": final["health"], "items": final["items"],
                "decisions": episode_decisions, "reward": round(game.get_total_reward(), 1), "errors": episode_errors,
            })
            if notify:
                notify(result)
        return result
    finally:
        worker and worker.close()
        game.close()


def run_session(scenario: str, controller: str, episodes: int, seed: int, visible: bool):
    publish(running=True, message="Starting ViZDoom…", scenario=scenario, controller=controller,
            episode=0, episodes=episodes, successes=0, failures=0, kills=0, decisions=0,
            errors=0, usd=0, ms=[], last=None, view=None, history=[])
    try:
        result = play(scenario, controller, episodes, seed, visible, lambda current: publish(**current, running=True, message="Running"))
        publish(**result, running=False, message="Complete")
    except Exception as error:
        publish(running=False, message=f"Failed: {error}")


class Handler(BaseHTTPRequestHandler):
    def send(self, status: int, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/state":
            with LOCK:
                body = json.dumps(STATE).encode()
            self.send(200, body, "application/json")
        else:
            self.send(200, HTML, "text/html; charset=utf-8")

    def do_POST(self):
        if self.path != "/start":
            return self.send(404, b"{}", "application/json")
        try:
            length = int(self.headers.get("content-length", 0))
            request = json.loads(self.rfile.read(length) or b"{}")
            scenario = request.get("scenario", "basic")
            controller = request.get("controller", "rules")
            episodes = max(1, min(10, int(request.get("episodes", 3))))
            seed = int(request.get("seed", 42))
            if scenario not in SCENARIOS or controller not in {"jev", "rules", "random"}:
                raise ValueError("unknown level or controller")
            with LOCK:
                if STATE["running"]:
                    raise ValueError("a run is already in progress")
            threading.Thread(target=run_session, args=(scenario, controller, episodes, seed, True), daemon=True).start()
            self.send(200, b'{"ok":true}', "application/json")
        except Exception as error:
            self.send(400, json.dumps({"error": str(error)}).encode(), "application/json")

    def log_message(self, *_):
        pass


def check():
    basic_rules = play("basic", "rules", 10, 0, False)
    basic_random = play("basic", "random", 10, 0, False)
    assert basic_rules["successes"] == 10, basic_rules
    assert basic_rules["successes"] > basic_random["successes"], (basic_rules, basic_random)
    defend_rules = play("defend", "rules", 1, 42, False)
    corridor_rules = play("corridor", "rules", 1, 42, False)
    assert defend_rules["kills"] > 0, defend_rules
    assert corridor_rules["decisions"] > 0 and corridor_rules["errors"] == 0, corridor_rules
    print(f"doom check passed: basic rules {basic_rules['successes']}/10 vs random {basic_random['successes']}/10; "
          f"defend {defend_rules['kills']} kills; corridor {corridor_rules['kills']} kills, success {corridor_rules['successes']}/1")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--run", choices=["jev", "rules", "random"])
    parser.add_argument("--scenario", choices=SCENARIOS, default="basic")
    parser.add_argument("--episodes", type=int, default=3)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
    elif args.run:
        result = play(args.scenario, args.run, args.episodes, args.seed, not args.headless)
        print(json.dumps({key: result[key] for key in ("scenario", "controller", "episodes", "successes", "failures", "kills", "decisions", "errors", "usd", "ms", "history")}, indent=2))
    else:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
        print(f"http://localhost:{PORT}")
        server.serve_forever()
