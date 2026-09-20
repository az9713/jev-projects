from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    errors = []
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)
    page.goto("http://127.0.0.1:3006", wait_until="domcontentloaded")
    page.locator("#stats").filter(has_text="0/60").wait_for()
    page.select_option("#driver", "rules")
    page.fill("#seed", "42")
    page.click("#go")
    page.locator("#stats").filter(has_text="done").wait_for(timeout=15000)
    assert "collisions 0" in page.locator("#stats").inner_text()
    assert not errors, errors
    browser.close()
print("lane browser flow passed")
