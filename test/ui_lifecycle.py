import asyncio, sys
from playwright.async_api import async_playwright

URL = 'http://localhost:8765/demo.html'
OUT = sys.argv[1] if len(sys.argv) > 1 else 'test'

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = await b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('console', lambda m: errs.append('console:' + m.text) if m.type == 'error' else None)
        await pg.goto(URL)
        await pg.evaluate('localStorage.clear()')
        await pg.goto(URL)
        await pg.wait_for_timeout(800)
        await pg.click('text=Christian Peterson')
        await pg.wait_for_timeout(600)
        shot = lambda n, full=True: pg.screenshot(path=f'{OUT}/{n}.png', full_page=full)

        # --- Processing: new group from Worland, temp the first head ---
        await pg.evaluate('document.activeElement && document.activeElement.blur()'); await pg.wait_for_timeout(100); await pg.click('nav >> text=Chute')
        await pg.wait_for_timeout(300)
        await pg.fill('#purchaseDate', '2026-11-14')
        await pg.click('.chip:has-text("Worland")')
        await pg.select_option('.card select >> nth=0', 'East pasture')
        await pg.fill('#startTag', '1001')
        await shot('l01-process-setup')
        await pg.click('text=Start processing')
        await pg.wait_for_timeout(300)
        assert await pg.input_value('#chuteTag') == '1001'
        # weight, temp, Enter saves; tag goes up by one
        for w, t in [('512', '4.6'), ('488', '5.1'), ('530', '2.8'), ('470', '4.4'), ('505', '4.9'), ('499', '3.2'), ('521', '4.5'), ('480', '4.8'), ('515', '4.2'), ('490', '5.0')]:
            await pg.fill('#chuteWeight', w)
            await pg.press('#chuteWeight', 'Enter')
            await pg.fill('#chuteTemp', t)
            await pg.press('#chuteTemp', 'Enter')
            await pg.wait_for_timeout(120)
        assert await pg.input_value('#chuteTag') == '1011', await pg.input_value('#chuteTag')
        await shot('l02-process-running')
        assert 'Mass treat the rest' in await pg.text_content('main'), 'no mass-treat suggestion'
        await pg.click('text=Mass treat the rest')
        await pg.wait_for_timeout(200)
        assert await pg.query_selector('#chuteTemp') is None
        # Scale-as-keyboard: weight + Enter saves straight away
        await pg.fill('#chuteWeight', '501')
        await pg.press('#chuteWeight', 'Enter')
        await pg.wait_for_timeout(200)
        # Run of tags without weights, with a dropped tag skipped
        await pg.click('summary:has-text("Add a run of tags")')
        await pg.fill('details textarea', '1012-1040, 1042-1050')
        await pg.click('text=Add these calves')
        await pg.wait_for_timeout(200)
        await shot('l03-bulk-confirm', False)
        await pg.click('.modal .btn.primary')
        await pg.wait_for_timeout(300)
        await shot('l04-after-bulk')
        await pg.click('text=Finish')
        await pg.wait_for_timeout(300)
        await shot('l05-groups')

        # --- Doctor: a mass-treated calf shows it, and the pull is still a first treatment ---
        await pg.evaluate('document.activeElement && document.activeElement.blur()'); await pg.wait_for_timeout(100); await pg.click('nav >> text=Doctor')
        await pg.wait_for_timeout(300)
        await pg.fill('#tagNum', '1015')
        await pg.wait_for_timeout(200)
        panel = await pg.text_content('#tagPanel')
        assert ': HR1 Draxxin' in panel and 'first treatment' in panel, panel
        await shot('l06-doctor-mass-note', False)
        await pg.click('.brand')

        # --- Reimplant at the chute ---
        await pg.evaluate('document.activeElement && document.activeElement.blur()'); await pg.wait_for_timeout(100); await pg.click('nav >> text=Chute')
        await pg.click('.job:has-text("Implant")')
        await pg.click('.chip:has-text("Synovex")')
        await pg.click('text=Start reimplant')
        await pg.wait_for_timeout(200)
        await pg.fill('#chuteTag', '1001')
        await pg.press('#chuteTag', 'Enter')
        await pg.fill('#chuteWeight', '640')
        await pg.press('#chuteWeight', 'Enter')
        await pg.wait_for_timeout(200)
        await shot('l07-reimplant')
        await pg.click('text=Finish')

        # --- Mass treat everyone in a pasture ---
        await pg.click('.job:has-text("Mass treat")')
        await pg.click('.seg-btn:has-text("Everyone in a pasture")')
        await pg.select_option('.card select >> nth=0', 'East pasture')
        await pg.wait_for_timeout(200)
        await shot('l08-mass-pasture')
        await pg.click('text=Save mass treatment')
        await pg.click('.modal .btn.primary')
        await pg.wait_for_timeout(300)

        # --- Scale file import ---
        await pg.click('.job:has-text("Scale file")')
        open(f'{OUT}/scale.csv', 'w').write('EID,VID,Weight\n982000123,1001,655\n982000124,1002,610\n,,\n')
        await pg.set_input_files('input[type=file]', f'{OUT}/scale.csv')
        await pg.wait_for_timeout(300)
        await pg.click('.chip:has-text("Other")')
        await shot('l09-import')
        await pg.click('button:has-text("Import 2 weights")')
        await pg.wait_for_timeout(300)

        # --- Calf history ---
        await pg.evaluate('document.activeElement && document.activeElement.blur()'); await pg.wait_for_timeout(100); await pg.click('nav >> text=Lookup')
        await pg.fill('#lookupNum', '1001')
        await pg.wait_for_timeout(300)
        txt = await pg.text_content('#lookupResults')
        assert 'Worland' in txt and 'Synovex' in txt and '655 lb' in txt, txt[:400]
        await shot('l10-calf-history')
        await pg.fill('#lookupNum', '12')
        await pg.wait_for_timeout(300)
        assert 'lb/day' in await pg.text_content('#lookupResults')
        await shot('l11-calf-seeded')

        # --- Pastures: feed with a head-count check ---
        await pg.evaluate('document.activeElement && document.activeElement.blur()'); await pg.wait_for_timeout(100); await pg.click('nav >> text=Pastures')
        await pg.wait_for_timeout(300)
        await shot('l12-feed')
        await pg.click('.pasture-btn:has-text("East pasture")')
        await pg.fill('#feedLbs', '1000')
        await pg.fill('#feedHead', '20')
        await pg.click('.modal .btn.primary')
        await pg.wait_for_timeout(300)
        await shot('l13-feed-check', False)
        await pg.click('.modal .btn.primary')
        await pg.wait_for_timeout(300)
        # Head counts + transfer
        await pg.click('.seg-btn:has-text("Head counts")')
        await pg.wait_for_timeout(200)
        await pg.select_option('section:has-text("Move cattle") select >> nth=0', 'River lot')
        await pg.wait_for_timeout(200)
        await pg.select_option('section:has-text("Move cattle") select >> nth=1', 'East pasture')
        await pg.fill('section:has-text("Move cattle") input.tagnum', '60')
        await pg.click('section:has-text("Move cattle") button.save')
        await pg.wait_for_timeout(300)
        await shot('l14-counts')

        await pg.evaluate('document.activeElement && document.activeElement.blur()'); await pg.wait_for_timeout(100); await pg.click('nav >> text=Reports')
        await pg.wait_for_timeout(300)
        await shot('l15-reports')
        print('errors:', errs)
        await b.close()

asyncio.run(main())
