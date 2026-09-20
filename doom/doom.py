"""ViZDoom basic arena with Jev, rule, and random controllers."""
from __future__ import annotations

import argparse
import json
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
FRAME_REPEAT = 4
ACTIONS = {"left": [1, 0, 0], "right": [0, 1, 0], "shoot": [0, 0, 1]}
LOCK = threading.Lock()
STATE = {
    "running": False, "message": "Choose a controller and start.", "controller": None,
    "episode": 0, "episodes": 0, "wins": 0, "timeouts": 0, "decisions": 0,
    "errors": 0, "usd": 0, "ms": [], "last": None, "view": None, "history": [],
}


def publish(**values):
    with LOCK:
        STATE.update(values)


def make_game(visible: bool) -> vzd.DoomGame:
    game = vzd.DoomGame()
    game.load_config(os.path.join(vzd.scenarios_path, "basic.cfg"))
    game.set_labels_buffer_enabled(True)
    game.add_available_game_variable(vzd.GameVariable.KILLCOUNT)
    game.set_window_visible(visible)
    game.set_sound_enabled(False)
    game.init()
    return game


def view(game: vzd.DoomGame) -> dict:
    state = game.get_state()
    monster = next((label for label in state.labels if label.object_category == "Monster"), None)
    center = round(monster.x + monster.width / 2) if monster else None
    position = "unknown" if center is None else "left" if center < 145 else "right" if center > 175 else "centered"
    return {
        "ammo": int(game.get_game_variable(vzd.GameVariable.AMMO2)),
        "enemy_visible": monster is not None,
        "enemy_position": position,
        "enemy_screen_x": center,
        "screen_width": 320,
        "goal": "align the monster with the center of the screen, then shoot",
        "possible_actions": list(ACTIONS),
    }


def rule_action(current: dict) -> str:
    return "left" if current["enemy_position"] == "left" else "right" if current["enemy_position"] == "right" else "shoot"


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


def play(controller: str, episodes: int, seed: int, visible: bool, notify=None) -> dict:
    game = make_game(visible)
    worker = JevWorker() if controller == "jev" else None
    result = {"controller": controller, "episodes": episodes, "episode": 0, "wins": 0, "timeouts": 0,
              "decisions": 0, "errors": 0, "usd": 0.0, "ms": [], "last": None, "view": None, "history": []}
    try:
        for episode in range(episodes):
            game.set_seed(seed + episode)
            game.new_episode()
            rng = random.Random(seed + episode)
            episode_decisions = 0
            episode_errors = 0
            while not game.is_episode_finished():
                current = view(game)
                started = perf_counter()
                probabilities = None
                fallback = False
                try:
                    if controller == "rules":
                        action = rule_action(current)
                        elapsed, usd, attempts = 0, 0, 0
                    elif controller == "random":
                        action = rng.choice(list(ACTIONS))
                        elapsed, usd, attempts = 0, 0, 0
                    else:
                        decision = worker.decide(current)
                        action = decision["action"]
                        probabilities = decision["probabilities"]
                        elapsed, usd, attempts = decision["ms"], decision["usd"], decision["attempts"]
                except Exception as error:
                    action = rule_action(current)
                    fallback = True
                    elapsed, usd, attempts = round((perf_counter() - started) * 1000), 0, 0
                    episode_errors += 1
                    result["errors"] += 1
                    result["last_error"] = str(error)
                game.make_action(ACTIONS[action], FRAME_REPEAT)
                episode_decisions += 1
                result["decisions"] += 1
                result["usd"] += usd
                if elapsed:
                    result["ms"].append(elapsed)
                result["episode"] = episode + 1
                result["view"] = current
                result["last"] = {"action": action, "probabilities": probabilities, "ms": elapsed,
                                  "usd": usd, "attempts": attempts, "fallback": fallback}
                if notify:
                    notify(result)
            won = int(game.get_game_variable(vzd.GameVariable.KILLCOUNT)) > 0
            result["wins"] += int(won)
            result["timeouts"] += int(not won)
            result["history"].append({"episode": episode + 1, "seed": seed + episode, "won": won,
                                      "decisions": episode_decisions, "reward": round(game.get_total_reward(), 1),
                                      "errors": episode_errors})
            if notify:
                notify(result)
        return result
    finally:
        worker and worker.close()
        game.close()


def run_session(controller: str, episodes: int, seed: int, visible: bool):
    publish(running=True, message="Starting ViZDoom…", controller=controller, episode=0, episodes=episodes,
            wins=0, timeouts=0, decisions=0, errors=0, usd=0, ms=[], last=None, view=None, history=[])
    try:
        result = play(controller, episodes, seed, visible, lambda current: publish(**current, running=True, message="Running"))
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
            return self.send(404, b'{}', "application/json")
        try:
            length = int(self.headers.get("content-length", 0))
            request = json.loads(self.rfile.read(length) or b"{}")
            controller = request.get("controller", "rules")
            episodes = max(1, min(10, int(request.get("episodes", 5))))
            seed = int(request.get("seed", 42))
            if controller not in {"jev", "rules", "random"}:
                raise ValueError("unknown controller")
            with LOCK:
                if STATE["running"]:
                    raise ValueError("a run is already in progress")
            threading.Thread(target=run_session, args=(controller, episodes, seed, True), daemon=True).start()
            self.send(200, b'{"ok":true}', "application/json")
        except Exception as error:
            self.send(400, json.dumps({"error": str(error)}).encode(), "application/json")

    def log_message(self, *_):
        pass


def check():
    rules = play("rules", 10, 0, False)
    random_result = play("random", 10, 0, False)
    assert rules["wins"] == 10, rules
    assert rules["wins"] > random_result["wins"], (rules, random_result)
    print(f"doom check passed: rules {rules['wins']}/10, random {random_result['wins']}/10")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--run", choices=["jev", "rules", "random"])
    parser.add_argument("--episodes", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--headless", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
    elif args.run:
        result = play(args.run, args.episodes, args.seed, not args.headless)
        print(json.dumps({key: result[key] for key in ("controller", "episodes", "wins", "timeouts", "decisions", "errors", "usd", "ms", "history")}, indent=2))
    else:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
        print(f"http://localhost:{PORT}")
        server.serve_forever()
