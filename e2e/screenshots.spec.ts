import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// Drives the built app and captures one full-page screenshot per system into
// /screens. Each system is left running for a moment so patterns develop.

const OUT = 'screens';

test('capture a screenshot of every system', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.goto('/');
  await page.waitForSelector('.viv-gallery-item');

  const ids = await page.$$eval('.viv-gallery-item', (els) =>
    els.map((e) => e.getAttribute('data-system-id') ?? ''),
  );

  for (const id of ids) {
    if (!id) continue;
    await page.click(`.viv-gallery-item[data-system-id="${id}"]`);
    // Let the simulation evolve into something visually interesting.
    await page.waitForTimeout(2800);
    await page.screenshot({ path: `${OUT}/${id}.png` });
  }

  // A hero shot on the first system for the README.
  if (ids[0]) {
    await page.click(`.viv-gallery-item[data-system-id="${ids[0]}"]`);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/_hero.png` });
  }
});
