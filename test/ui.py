import asyncio, sys
from playwright.async_api import async_playwright

URL = 'http://localhost:8765/demo.html'

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                                  geolocation={'latitude': 45.0, 'longitude': -110.0}, permissions=['geolocation'])
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' else None)
        await pg.goto(URL)
        await pg.evaluate('localStorage.clear()')
        await pg.goto(URL)
        await pg.wait_for_timeout(600)

        # Admin sets doses and herds
        await pg.click('text=Christian Peterson')
        await pg.wait_for_timeout(400)
        await pg.click('nav >> text=More')
        await pg.wait_for_timeout(300)
        doses = await pg.query_selector_all('.dose-in')
        await doses[0].fill('1.1 mL per 100 lb, under the skin in the neck')
        await doses[1].fill('2.5 mL per 100 lb')
        await pg.screenshot(path='test/01-settings.png', full_page=True)
        await pg.click('text=Save settings')
        await pg.wait_for_timeout(300)
        await pg.click('nav >> text=Doctor')
        await pg.wait_for_timeout(300)
        await pg.screenshot(path='test/02-doctor.png')

        # Voice-style entry, any order, temp shorthand, pasture by name
        await pg.fill('#say', 'drax 4.2 north pens blue 42')
        await pg.press('#say', 'Enter')
        await pg.wait_for_timeout(300)
        await pg.screenshot(path='test/03-filled.png', full_page=True)
        assert await pg.input_value('#temp') == '104.2'
        assert await pg.input_value('#tagNum') == '42'
        await pg.click('button.save')
        await pg.wait_for_timeout(500)
        await pg.screenshot(path='test/04-saved.png')

        # Typed temp shortcut + no tag
        await pg.click('.chip.notag')
        await pg.fill('#temp', '38')
        await pg.wait_for_timeout(200)
        prev = await pg.text_content('#tempPreview')
        assert prev.strip() == '= 103.8°F', prev
        await pg.click('.chip:has-text("HR2 Baytril")')
        await pg.wait_for_timeout(200)
        await pg.screenshot(path='test/05-notag-dose.png', full_page=True)
        await pg.click('button.save')
        await pg.wait_for_timeout(400)
        assert 'No tag' in await pg.text_content('#recent'), 'no-tag entry missing'
        await pg.screenshot(path='test/05b-notag-saved.png')

        # Moved more than a quarter mile -> asked to confirm pasture
        await ctx.set_geolocation({'latitude': 45.01, 'longitude': -110.0})
        await pg.reload()
        await pg.wait_for_timeout(1500)
        await pg.fill('#say', 'blue 77 104.8 drax')
        await pg.press('#say', 'Enter')
        await pg.wait_for_timeout(300)
        await pg.click('button.save')
        await pg.wait_for_timeout(400)
        await pg.screenshot(path='test/06-moved.png')
        await pg.click('.modal .btn.big')
        await pg.wait_for_timeout(400)

        # Death report with herd, description, photo
        await pg.fill('#say', 'blue 51 dead wolf')
        await pg.press('#say', 'Enter')
        await pg.wait_for_timeout(300)
        await pg.select_option('.card select >> nth=0', 'Heifers')
        await pg.fill('textarea', 'Found in the willows by the creek, half eaten, tracks all around.')
        await pg.set_input_files('input[type=file]', 'public/icon-512.png')
        await pg.wait_for_timeout(400)
        await pg.screenshot(path='test/07-death.png', full_page=True)
        await pg.click('button.save')
        await pg.wait_for_timeout(1200)
        await pg.screenshot(path='test/08-after-death.png', full_page=True)

        # Typing hides the bottom menu
        await pg.click('#temp')
        await pg.wait_for_timeout(200)
        nav_hidden = await pg.evaluate("getComputedStyle(document.querySelector('nav.tabs')).display")
        assert nav_hidden == 'none', nav_hidden
        await pg.click('.brand')

        await pg.click('nav >> text=More')
        await pg.wait_for_timeout(300)
        await pg.screenshot(path='test/09-more.png', full_page=True)
        await pg.click('nav >> text=Reports')
        await pg.wait_for_timeout(300)
        await pg.screenshot(path='test/10-reports.png', full_page=True)

        # Cowboy view: dose shows, no settings
        await pg.evaluate("localStorage.setItem('calfdoctor-demo-v2-user', JSON.stringify('jake@example.com'))")
        await pg.goto(URL)
        await pg.wait_for_timeout(500)
        await pg.click('.chip:has-text("HR1 Draxxin")')
        await pg.wait_for_timeout(200)
        await pg.screenshot(path='test/11-cowboy.png', full_page=True)
        print('errors:', errs)
        await b.close()

asyncio.run(main())
